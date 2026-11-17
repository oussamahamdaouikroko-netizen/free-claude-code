'use strict';
/**
 * Appointment engine (Part 6).
 *
 * - Availability is computed server-side from doctor_schedules + blocked_dates
 *   + existing appointments; the frontend never decides availability.
 * - Double bookings are prevented by a partial UNIQUE index
 *   (doctor_id, day, time) over active statuses + IMMEDIATE transactions.
 * - State machine: draft → pending_payment → payment_verification →
 *   pending_doctor_approval → confirmed | rejected | rescheduling_requested |
 *   cancelled | completed | expired. Invalid transitions are rejected.
 */
const { getDb, withTransaction, utcNow } = require('../db');
const { AppError, validation, notFound, conflict } = require('../errors');
const { requireId, requireISODate, requireTime, isValidISODate } = require('../validate');

const ACTIVE_STATUSES = ['pending_payment', 'payment_verification', 'pending_doctor_approval', 'confirmed', 'rescheduling_requested'];

const TRANSITIONS = {
  draft: ['pending_payment', 'cancelled'],
  pending_payment: ['payment_verification', 'pending_doctor_approval', 'cancelled', 'expired'],
  payment_verification: ['pending_doctor_approval', 'pending_payment', 'cancelled', 'expired'],
  pending_doctor_approval: ['confirmed', 'rejected', 'rescheduling_requested', 'cancelled', 'expired'],
  confirmed: ['completed', 'cancelled', 'rescheduling_requested'],
  rejected: [],
  rescheduling_requested: ['confirmed', 'cancelled', 'rejected'],
  cancelled: [],
  completed: [],
  expired: [],
};

function canTransition(from, to) {
  return (TRANSITIONS[from] || []).includes(to);
}

function assertTransition(from, to) {
  if (!canTransition(from, to)) {
    throw conflict('INVALID_STATE', `Cannot move appointment from ${from} to ${to}`);
  }
}

function weekdayOf(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function addDays(isoDate, days) {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function getDoctor(doctorId) {
  const doctor = getDb().prepare('SELECT * FROM doctors WHERE id = ?').get(doctorId);
  if (!doctor) throw notFound('Doctor');
  return doctor;
}

function assertBookableDoctor(doctor) {
  if (doctor.status !== 'active') {
    throw conflict('INVALID_STATE', 'This doctor is not currently accepting bookings');
  }
}

function isBlocked(doctorId, clinicId, day) {
  const row = getDb()
    .prepare(
      `SELECT id FROM blocked_dates
       WHERE doctor_id = ? AND day = ?
         AND (clinic_id IS NULL OR clinic_id = ?)`
    )
    .get(doctorId, day, clinicId ?? null);
  return Boolean(row);
}

function schedulesFor(doctorId, clinicId, weekday) {
  return getDb()
    .prepare(
      `SELECT * FROM doctor_schedules
       WHERE doctor_id = ? AND weekday = ? AND is_active = 1
         AND (clinic_id IS NULL OR clinic_id = ?)
       ORDER BY start_time`
    )
    .all(doctorId, weekday, clinicId ?? null);
}

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function toHHMM(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Compute available slots for a doctor on a day.
 * Returns [] when the doctor does not work that day / is blocked / day is past.
 */
function availableSlots(doctorId, day, clinicId = null) {
  const doctor = getDoctor(doctorId);
  assertBookableDoctor(doctor);
  requireISODate(day, 'day');
  if (day < todayISO()) return [];
  if (isBlocked(doctorId, clinicId, day)) return [];

  const weekday = weekdayOf(day);
  const windows = schedulesFor(doctorId, clinicId, weekday);
  if (windows.length === 0) return [];

  const taken = new Set(
    getDb()
      .prepare(
        `SELECT time FROM appointments
         WHERE doctor_id = ? AND day = ? AND status IN (${ACTIVE_STATUSES.map(() => '?').join(',')})
           AND (clinic_id IS NULL OR clinic_id = ?)`
      )
      .all(doctorId, day, ...ACTIVE_STATUSES, clinicId ?? null)
      .map((r) => r.time)
  );

  const dayCount = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM appointments
       WHERE doctor_id = ? AND day = ? AND status IN (${ACTIVE_STATUSES.map(() => '?').join(',')})`
    )
    .get(doctorId, day, ...ACTIVE_STATUSES).n;
  if (dayCount >= doctor.max_daily) return [];

  const step = doctor.appointment_minutes || 15;
  const slots = [];
  for (const window of windows) {
    for (let t = toMinutes(window.start_time); t + step <= toMinutes(window.end_time); t += step) {
      const time = toHHMM(t);
      if (!taken.has(time)) slots.push(time);
    }
  }
  return [...new Set(slots)].sort();
}

function assertSlotAvailable(doctor, day, time, clinicId) {
  const slots = availableSlots(doctor.id, day, clinicId);
  if (!slots.includes(time)) {
    throw conflict('SLOT_TAKEN', 'The selected time slot is not available');
  }
}

function nextBookingRef() {
  // MR-YYYY-NNNNNN from the appointments rowid sequence (unique, monotonic).
  const row = getDb().prepare('SELECT COALESCE(MAX(id), 0) AS max_id FROM appointments').get();
  const year = new Date().getUTCFullYear();
  return `MR-${year}-${String((row.max_id || 0) + 1).padStart(6, '0')}`;
}

function recordEvent(appointmentId, kind, { fromStatus = null, toStatus = null, actor = 'system', note = '' } = {}) {
  getDb()
    .prepare(
      `INSERT INTO appointment_events (appointment_id, kind, from_status, to_status, actor, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(appointmentId, kind, fromStatus, toStatus, actor, String(note).slice(0, 500), utcNow());
}

function getAppointmentByRef(publicRef) {
  const row = getDb().prepare('SELECT * FROM appointments WHERE public_ref = ?').get(publicRef);
  if (!row) throw notFound('Appointment');
  return row;
}

function getAppointmentById(id) {
  const row = getDb().prepare('SELECT * FROM appointments WHERE id = ?').get(id);
  if (!row) throw notFound('Appointment');
  return row;
}

function transition(appointmentId, toStatus, { actor = 'system', note = '' } = {}) {
  return withTransaction(() => {
    const appointment = getAppointmentById(appointmentId);
    assertTransition(appointment.status, toStatus);
    const now = utcNow();
    // Entering the doctor-response stage starts the configurable deadline (Part 6.2).
    let expiresAt = appointment.expires_at;
    if (toStatus === 'pending_doctor_approval') {
      const doctor = getDoctor(appointment.doctor_id);
      const hours = Number(doctor.response_deadline_hours) || 24;
      expiresAt = new Date(Date.now() + hours * 3600000).toISOString();
    }
    getDb()
      .prepare('UPDATE appointments SET status = ?, expires_at = ?, updated_at = ? WHERE id = ?')
      .run(toStatus, expiresAt, now, appointmentId);
    recordEvent(appointmentId, 'status_change', { fromStatus: appointment.status, toStatus, actor, note });
    return getAppointmentById(appointmentId);
  });
}

/**
 * Create a booking. Idempotent on `idempotencyKey`: a retry with the same key
 * returns the existing appointment instead of creating a duplicate (Part 4).
 */
function createBooking({
  patientId = null,
  patientName,
  patientPhone,
  patientPhoneNorm,
  doctorId,
  clinicId = null,
  day,
  time,
  source = 'web',
  idempotencyKey = null,
}) {
  const doctor = getDoctor(doctorId);
  assertBookableDoctor(doctor);
  requireISODate(day, 'day');
  requireTime(time, 'time');
  if (day < todayISO()) throw validation('day must not be in the past');

  if (idempotencyKey) {
    const existing = getDb()
      .prepare('SELECT * FROM appointments WHERE idempotency_key = ?')
      .get(idempotencyKey);
    if (existing) return { appointment: existing, created: false };
  }

  const serviceFee = Number(process.env.MEDIRDV_SERVICE_FEE_DZD || 0) || 0;
  const publicRef = nextBookingRef();
  const now = utcNow();

  try {
    return withTransaction(() => {
      assertSlotAvailable(doctor, day, time, clinicId);
      const result = getDb()
        .prepare(
          `INSERT INTO appointments
             (public_ref, idempotency_key, patient_id, patient_name, patient_phone, patient_phone_norm,
              doctor_id, clinic_id, day, time, status, source, consultation_fee, service_fee, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_payment', ?, ?, ?, ?, ?)`
        )
        .run(
          publicRef,
          idempotencyKey,
          patientId,
          patientName,
          patientPhone,
          patientPhoneNorm,
          doctorId,
          clinicId,
          day,
          time,
          source,
          doctor.consultation_fee,
          serviceFee,
          now,
          now
        );
      const appointment = getAppointmentById(result.lastInsertRowid);
      recordEvent(appointment.id, 'created', { toStatus: 'pending_payment', actor: 'patient', note: `Booking ${publicRef} created` });
      return { appointment, created: true };
    });
  } catch (error) {    // Partial unique index race → slot was taken concurrently.
    if (error instanceof AppError) throw error;
    if (String(error.message || '').includes('UNIQUE constraint failed')) {
      throw conflict('SLOT_TAKEN', 'The selected time slot is not available');
    }
    throw error;
  }
}

function cancelBooking(appointmentId, { actor = 'patient', note = '' } = {}) {
  const appointment = getAppointmentById(appointmentId);
  if (appointment.status === 'cancelled') return appointment;
  // Enforce cancellation deadline when configured.
  const doctor = getDoctor(appointment.doctor_id);
  if (doctor.cancel_deadline_hours > 0 && appointment.status === 'confirmed') {
    const slotAt = new Date(`${appointment.day}T${appointment.time}:00Z`).getTime();
    const hoursLeft = (slotAt - Date.now()) / 3600000;
    if (hoursLeft < doctor.cancel_deadline_hours) {
      throw conflict('INVALID_STATE', 'The cancellation deadline for this appointment has passed');
    }
  }
  return transition(appointmentId, 'cancelled', { actor, note });
}

/** Expire stale pending bookings (called by the expiry sweeper). */
function expireStaleBookings(beforeISO) {
  const rows = getDb()
    .prepare(
      `SELECT id FROM appointments
       WHERE status IN ('pending_payment','payment_verification','pending_doctor_approval')
         AND expires_at IS NOT NULL AND expires_at < ?`
    )
    .all(beforeISO);
  for (const row of rows) {
    try {
      transition(row.id, 'expired', { actor: 'system', note: 'Response deadline expired' });
    } catch {
      // Already transitioned concurrently; safe to ignore.
    }
  }
  return rows.length;
}

function listAppointments({ doctorId = null, status = null, day = null, limit = 100 } = {}) {
  const clauses = [];
  const params = [];
  if (doctorId) { clauses.push('doctor_id = ?'); params.push(requireId(doctorId, 'doctorId')); }
  if (status) { clauses.push('status = ?'); params.push(status); }
  if (day) { clauses.push('day = ?'); params.push(requireISODate(day, 'day')); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const n = Math.min(500, Math.max(1, Number(limit) || 100));
  return getDb()
    .prepare(`SELECT * FROM appointments ${where} ORDER BY day, time, id LIMIT ?`)
    .all(...params, n);
}

module.exports = {
  ACTIVE_STATUSES,
  TRANSITIONS,
  canTransition,
  assertTransition,
  weekdayOf,
  addDays,
  todayISO,
  getDoctor,
  availableSlots,
  assertSlotAvailable,
  nextBookingRef,
  recordEvent,
  getAppointmentByRef,
  getAppointmentById,
  transition,
  createBooking,
  cancelBooking,
  expireStaleBookings,
  listAppointments,
  isValidISODate,
};
