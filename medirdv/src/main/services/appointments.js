'use strict';
/**
 * Appointments + multi-department booking engine.
 *
 * Business rules (configurable globally in Settings or per Department):
 *  - a day is bookable only if its weekday is in `working_days` (clinic or department);
 *  - each department (or solo clinic) holds at most `daily_capacity` active
 *    appointments per day (cancelled rows release their slot);
 *  - queue numbers are compact per (day, department) and existing booked
 *    patients never have their queue_number renumbered;
 *  - WhatsApp bookings take the *first free day* inside the booking horizon
 *    for the selected department (or general clinic).
 */

const { getDb } = require('../db');
const { CANCEL_COOLDOWN_MINUTES, formatAlgeriaTime } = require('../config');
const license = require('./license');
const settings = require('./settings');
const departments = require('./departments');
const operations = require('./operations');
const chat = require('./chat');
const { message } = require('../whatsapp/messages');
const { AppError, money, cleanText, nowLocal, requireId, phoneKey } = require('../utils/common');
const { isValidISODate, addDays, toISODate, diffDays, formatLong } = require('../utils/dates');

const AGENDA_SQL = `
  SELECT a.*,
    p.full_name, p.phone, p.phone_norm, p.birth_date, p.allergies, p.blood_group, p.chronic_conditions,
    d.name_fr AS dept_name_fr, d.name_ar AS dept_name_ar,
    d.doctor_name AS dept_doctor_name, d.room AS dept_room,
    d.specialty AS dept_specialty, d.instructions AS dept_instructions,
    pi.id AS intake_id, pi.status AS intake_status, pi.source AS intake_source,
    pi.age_years AS intake_age_years, pi.weight_kg AS intake_weight_kg, pi.height_cm AS intake_height_cm,
    pi.chief_complaint AS intake_complaint, pi.known_allergies AS intake_allergies,
    pi.is_pregnant AS intake_pregnant, pi.is_breastfeeding AS intake_breastfeeding,
    COALESCE((SELECT SUM(pay.amount) FROM payments pay WHERE pay.appointment_id = a.id), 0) AS paid
  FROM appointments a
  JOIN patients p ON p.id = a.patient_id
  LEFT JOIN departments d ON d.id = a.department_id
  LEFT JOIN patient_intake pi ON pi.id = (
    SELECT i.id FROM patient_intake i
    WHERE (i.appointment_id = a.id OR (i.patient_id = a.patient_id AND i.status IN ('pending', 'reviewed')))
      AND i.status <> 'rejected'
    ORDER BY CASE WHEN i.appointment_id = a.id THEN 0 ELSE 1 END, i.id DESC
    LIMIT 1
  )`;

function deptKey(departmentId) {
  const num = Number.parseInt(departmentId, 10);
  return Number.isInteger(num) && num > 0 ? num : 0;
}

function decorate(row) {
  if (!row) return null;
  const paid = money(row.paid ?? 0);
  const price = money(row.price ?? 0);
  const settled = Boolean(row.is_paid) || (price > 0 && paid >= price - 0.009);
  return {
    ...row,
    paid,
    balance: money(Math.max(0, price - paid)),
    is_paid: settled ? 1 : 0,
  };
}

/** How many active patients a (day, department) already holds. */
function usedCapacity(day, departmentId = null) {
  return getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM appointments
       WHERE day = ? AND COALESCE(department_id, 0) = ?
         AND status IN ('booked', 'done', 'no_show')`,
    )
    .get(day, deptKey(departmentId)).n;
}

/** @returns {{day: string, department_id: number|null, capacity: number, used: number, left: number, working: boolean}} */
function dayInfo(day, departmentId = null) {
  if (!isValidISODate(day)) throw new AppError('INVALID_DATE');
  const dKey = deptKey(departmentId);
  const capacity = departments.capacityFor(dKey || null);
  const used = usedCapacity(day, dKey || null);
  const working = departments.isWorkingDay(dKey || null, day);
  return {
    day,
    department_id: dKey || null,
    capacity,
    used,
    left: Math.max(0, capacity - used),
    working,
  };
}

/** First queue number not used by an active appointment of that (day, department). */
function nextQueueNumber(day, departmentId = null) {
  const dKey = deptKey(departmentId);
  const rows = getDb()
    .prepare(
      `SELECT queue_number FROM appointments
       WHERE day = ? AND COALESCE(department_id, 0) = ?
         AND status IN ('booked', 'done', 'no_show')`,
    )
    .all(day, dKey);
  const taken = new Set(rows.map((r) => r.queue_number));
  const capacity = departments.capacityFor(dKey || null);
  for (let n = 1; n <= capacity; n += 1) if (!taken.has(n)) return n;
  return capacity + 1;
}

/**
 * First day with a free slot in the requested department (or clinic), starting
 * today (if allowed) or tomorrow.
 * @returns {string|null} ISO day or null when the horizon is full
 */
function findNextFreeDay(options = {}) {
  const today = options.fromDate || toISODate();
  const allowSameDay =
    options.allowSameDay !== undefined
      ? Boolean(options.allowSameDay)
      : settings.getBool('allow_same_day_booking');
  const horizon = options.horizonDays || settings.getInt('booking_horizon_days');
  const dKey = deptKey(options.departmentId);
  const cap = departments.capacityFor(dKey || null);
  const start = allowSameDay ? today : addDays(today, 1);

  for (let offset = 0; offset <= horizon; offset += 1) {
    const day = addDays(start, offset);
    if (!departments.isWorkingDay(dKey || null, day)) continue;
    if (usedCapacity(day, dKey || null) < cap) return day;
  }
  return null;
}

function assertBookableDay(day, departmentId = null) {
  if (!isValidISODate(day)) throw new AppError('INVALID_DATE');
  const today = toISODate();
  if (diffDays(today, day) < 0) throw new AppError('DATE_IN_PAST');
  const dKey = deptKey(departmentId);
  if (!departments.isWorkingDay(dKey || null, day)) {
    throw new AppError('NOT_WORKING_DAY', 'Clinic closed', { day, department_id: dKey || null });
  }
  if (dayInfo(day, dKey || null).left <= 0) {
    throw new AppError('DAY_FULL', 'Day is full', { day, department_id: dKey || null });
  }
}

function get(id) {
  const row = getDb().prepare(`${AGENDA_SQL} WHERE a.id = ?`).get(requireId(id));
  if (!row) throw new AppError('APPOINTMENT_NOT_FOUND');
  return decorate(row);
}

/**
 * Book an appointment.
 * @param {{patient_id:number, day?:string, department_id?:number|null,
 *          treatment_id?:number|null, price?:number, notes?:string, source?:string}} input
 */
function create(input = {}) {
  license.requireValidLicense(
    input.nowMs !== undefined ? { nowMs: input.nowMs } : undefined,
  );
  const patientId = requireId(input.patient_id, 'patient_id');
  const patient = getDb().prepare('SELECT id FROM patients WHERE id = ?').get(patientId);
  if (!patient) throw new AppError('PATIENT_NOT_FOUND');

  if (input.source === 'whatsapp' || input.enforceCooldown === true) {
    const check = canUserBook(patientId, input.nowMs ?? Date.now());
    if (!check.allowed) {
      throw new AppError('BOOKING_COOLDOWN', 'Patient is temporarily blocked after cancellation', check);
    }
  }

  let dept = null;
  if (input.department_id) {
    dept = departments.get(input.department_id);
  }
  const dKey = dept ? dept.id : 0;

  const day = input.day || findNextFreeDay({ allowSameDay: false, departmentId: dKey || null });
  if (!day) throw new AppError('HORIZON_REACHED');

  if (input.historical === true) {
    if (!isValidISODate(day)) throw new AppError('INVALID_DATE');
  } else {
    assertBookableDay(day, dKey || null);
  }

  const db = getDb();
  const duplicate = db
    .prepare(
      `SELECT * FROM appointments
       WHERE patient_id = ? AND day = ? AND COALESCE(department_id, 0) = ?
         AND status IN ('booked', 'done') LIMIT 1`,
    )
    .get(patientId, day, dKey);
  if (duplicate) {
    throw new AppError('ALREADY_BOOKED', 'Already booked', { id: duplicate.id, day });
  }

  let treatmentName = null;
  let price = input.price;
  const treatmentId = input.treatment_id ?? null;
  if (treatmentId) {
    const treatment = db.prepare('SELECT * FROM treatments WHERE id = ?').get(treatmentId);
    if (!treatment) throw new AppError('TREATMENT_NOT_FOUND');
    treatmentName = treatment.name_fr;
    if (price === undefined || price === null || price === '') price = treatment.default_price;
  } else if ((price === undefined || price === null || price === '') && dept && dept.consultation_fee > 0) {
    price = dept.consultation_fee;
  }
  price = money(Math.max(0, Number(price) || 0));

  const queue = nextQueueNumber(day, dKey || null);
  const priority = ['normal', 'walk_in', 'urgent'].includes(input.priority)
    ? input.priority
    : 'normal';
  let slotTime = cleanText(input.slot_time, 8);
  if (dept && dept.scheduling_mode === 'slots') {
    if (slotTime) {
      const takenSlot = db
        .prepare(
          `SELECT id FROM appointments
           WHERE day = ? AND department_id = ? AND slot_time = ?
             AND status IN ('booked', 'done', 'no_show') LIMIT 1`,
        )
        .get(day, dept.id, slotTime);
      if (takenSlot) throw new AppError('SLOT_TAKEN', 'Time slot already booked', { slot_time: slotTime });
    } else {
      slotTime = operations.nextFreeSlot(day, dept.id);
      if (!slotTime && input.historical !== true) {
        throw new AppError('DAY_FULL', 'No free time slot', { day, department_id: dept.id });
      }
    }
  }

  const now = nowLocal();
  const info = db
    .prepare(
      `INSERT INTO appointments
        (patient_id, day, queue_number, status, source,
         department_id, department_name,
         treatment_id, treatment_name, price, notes,
         slot_time, priority, confirmation_status, created_at, updated_at)
       VALUES
        (@patient_id, @day, @queue, 'booked', @source,
         @department_id, @department_name,
         @treatment_id, @treatment_name, @price, @notes,
         @slot_time, @priority, 'pending', @now, @now)`,
    )
    .run({
      patient_id: patientId,
      day,
      queue,
      source: input.source === 'whatsapp' || input.source === 'waiting' ? input.source : 'manual',
      department_id: dept ? dept.id : null,
      department_name: dept ? dept.name_fr : null,
      treatment_id: treatmentId,
      treatment_name: treatmentName,
      price,
      notes: cleanText(input.notes, 500) || null,
      slot_time: slotTime || '',
      priority,
      now,
    });
  return get(info.lastInsertRowid);
}

/** Change the day (or department) of an appointment, re-assigning the queue. */
function reschedule(input = {}) {
  license.requireValidLicense(
    input.nowMs !== undefined ? { nowMs: input.nowMs } : undefined,
  );
  const appointment = get(input.id);
  const day = input.day;
  if (!day) throw new AppError('INVALID_DATE');
  const nextDept =
    input.department_id !== undefined
      ? (input.department_id ? departments.get(input.department_id) : null)
      : departments.getOptional(appointment.department_id);
  const nextDeptId = nextDept ? nextDept.id : null;

  if (day === appointment.day && deptKey(nextDeptId) === deptKey(appointment.department_id)) {
    return appointment;
  }
  assertBookableDay(day, nextDeptId);
  const now = nowLocal();
  getDb()
    .prepare(
      `UPDATE appointments
       SET day = ?, department_id = ?, department_name = ?, queue_number = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(
      day,
      nextDeptId,
      nextDept ? nextDept.name_fr : null,
      nextQueueNumber(day, nextDeptId),
      now,
      appointment.id,
    );
  return get(appointment.id);
}

/** Update department/treatment/price/notes of an appointment. */
function updateDetails(input = {}) {
  const appointment = get(input.id);
  const db = getDb();
  let treatmentId = appointment.treatment_id;
  let treatmentName = appointment.treatment_name;
  let price = appointment.price;

  if (input.treatment_id !== undefined) {
    treatmentId = input.treatment_id || null;
    if (treatmentId) {
      const treatment = db.prepare('SELECT * FROM treatments WHERE id = ?').get(treatmentId);
      if (!treatment) throw new AppError('TREATMENT_NOT_FOUND');
      treatmentName = treatment.name_fr;
      if (input.price === undefined) price = treatment.default_price;
    } else {
      treatmentName = cleanText(input.treatment_name, 120) || null;
    }
  }
  if (input.price !== undefined) price = money(Math.max(0, Number(input.price) || 0));

  const paid = money(
    db.prepare('SELECT COALESCE(SUM(amount), 0) AS total FROM payments WHERE appointment_id = ?')
      .get(appointment.id).total,
  );
  if (price < paid - 0.009) {
    throw new AppError('PRICE_BELOW_PAID', 'Price below paid amount', { paid, price });
  }

  let deptId = appointment.department_id;
  let deptName = appointment.department_name;
  let queueNum = appointment.queue_number;
  if (input.department_id !== undefined && deptKey(input.department_id) !== deptKey(appointment.department_id)) {
    const dept = input.department_id ? departments.get(input.department_id) : null;
    deptId = dept ? dept.id : null;
    deptName = dept ? dept.name_fr : null;
    queueNum = nextQueueNumber(appointment.day, deptId);
  }

  db.prepare(
    `UPDATE appointments SET
       department_id = ?, department_name = ?, queue_number = ?,
       treatment_id = ?, treatment_name = ?, price = ?, notes = ?,
       updated_at = ?
     WHERE id = ?`,
  ).run(
    deptId,
    deptName,
    queueNum,
    treatmentId,
    treatmentName,
    price,
    input.notes !== undefined ? cleanText(input.notes, 500) || null : appointment.notes,
    nowLocal(),
    appointment.id,
  );
  return get(appointment.id);
}

/** Keep the displayed name in sync when the catalog entry gets renamed. */
function syncTreatmentName(treatmentId, nameFr) {
  getDb()
    .prepare(
      `UPDATE appointments SET treatment_name = ? WHERE treatment_id = ? AND status = 'booked'`,
    )
    .run(nameFr, treatmentId);
}

function setStatus(id, status) {
  if (!['booked', 'done', 'cancelled', 'no_show'].includes(status)) {
    throw new AppError('INVALID_STATUS');
  }
  const appointment = get(id);
  getDb()
    .prepare('UPDATE appointments SET status = ?, updated_at = ? WHERE id = ?')
    .run(status, nowLocal(), appointment.id);
  if (status === 'done' && appointment.status !== 'done' && appointment.treatment_id) {
    operations.consumeForTreatment(appointment.treatment_id, appointment.id);
  }
  return get(appointment.id);
}

function confirmAppointment(id) {
  const appointment = get(id);
  getDb()
    .prepare("UPDATE appointments SET confirmation_status = 'confirmed', updated_at = ? WHERE id = ?")
    .run(nowLocal(), appointment.id);
  return get(appointment.id);
}

/** Remove any pending waiting-list entry matching a phone number. */
function cancelWaitingByPhone(phone) {
  const key = phoneKey(phone);
  if (!key) return 0;
  const rows = getDb()
    .prepare('SELECT id, phone FROM waiting_list WHERE handled = 0')
    .all();
  let cleared = 0;
  const mark = getDb().prepare('UPDATE waiting_list SET handled = 1 WHERE id = ?');
  for (const row of rows) {
    if (phoneKey(row.phone) === key) {
      mark.run(row.id);
      cleared += 1;
    }
  }
  return cleared;
}

function cancel(id) {
  const cancelled = setStatus(id, 'cancelled');
  if (cancelled?.phone) cancelWaitingByPhone(cancelled.phone);
  return cancelled;
}

/**
 * Shared cooldown check for all patient booking entry points.
 * Accepts a numeric `patientId`, a phone string, or `{ patientId, phone }`.
 *
 * @returns {{ allowed: boolean, remainingMinutes: number, unlockTimeLocal: string, blockedUntilUtc: string|null }}
 */
function canUserBook(target, nowMs = Date.now()) {
  const db = getDb();
  let row = null;

  if (typeof target === 'number' || (typeof target === 'string' && /^\d+$/.test(target) && target.length < 8)) {
    row = db.prepare('SELECT id, blocked_until FROM patients WHERE id = ?').get(Number(target));
  } else if (target && typeof target === 'object') {
    if (target.patientId) {
      row = db.prepare('SELECT id, blocked_until FROM patients WHERE id = ?').get(Number(target.patientId));
    }
    if (!row && target.phone) {
      const pKey = phoneKey(target.phone);
      if (pKey) {
        row = db
          .prepare('SELECT id, blocked_until FROM patients WHERE phone_norm = ?')
          .get(pKey);
      }
    }
  } else if (typeof target === 'string' && target.trim()) {
    const pKey = phoneKey(target);
    if (pKey) {
      row = db.prepare('SELECT id, blocked_until FROM patients WHERE phone_norm = ?').get(pKey);
    }
  }

  if (!row || !row.blocked_until) {
    return { allowed: true, remainingMinutes: 0, unlockTimeLocal: '', blockedUntilUtc: null };
  }

  const untilMs = Date.parse(row.blocked_until);
  if (Number.isNaN(untilMs) || nowMs >= untilMs) {
    return { allowed: true, remainingMinutes: 0, unlockTimeLocal: '', blockedUntilUtc: null };
  }

  const remainingMinutes = Math.max(1, Math.ceil((untilMs - nowMs) / 60000));
  return {
    allowed: false,
    remainingMinutes,
    unlockTimeLocal: formatAlgeriaTime(untilMs),
    blockedUntilUtc: row.blocked_until,
  };
}

/**
 * Patient self-cancellation after explicit confirmation.
 * Atomically verifies:
 *  - appointment exists;
 *  - appointment belongs to `patientId` (ownership);
 *  - appointment is still `booked` (idempotent on double-click / stale callback);
 *  - sets `patients.blocked_until` in UTC (`now + cooldownMinutes`).
 *
 * Secretary / staff cancellations call `cancel(id)` directly and NEVER apply a cooldown.
 */
function cancelByPatient({
  appointmentId,
  patientId,
  phone = '',
  nowMs = Date.now(),
  cooldownMinutes = CANCEL_COOLDOWN_MINUTES,
} = {}) {
  const db = getDb();
  const apptId = Number.parseInt(appointmentId, 10);
  if (!Number.isInteger(apptId) || apptId <= 0) {
    return { status: 'stale' };
  }
  const existing = db.prepare('SELECT * FROM appointments WHERE id = ?').get(apptId);
  if (!existing) {
    return { status: 'stale' };
  }
  if (!patientId || Number(existing.patient_id) !== Number(patientId)) {
    return { status: 'forbidden' };
  }
  if (existing.status !== 'booked') {
    return { status: 'stale' };
  }

  const blockedUntilUtc = new Date(nowMs + cooldownMinutes * 60 * 1000).toISOString();
  const updatedLocal = nowLocal();

  const tx = db.transaction(() => {
    const info = db
      .prepare(
        `UPDATE appointments
         SET status = 'cancelled', updated_at = ?
         WHERE id = ? AND patient_id = ? AND status = 'booked'`,
      )
      .run(updatedLocal, apptId, patientId);
    if (info.changes !== 1) return false;

    db.prepare('UPDATE patients SET blocked_until = ?, updated_at = ? WHERE id = ?').run(
      blockedUntilUtc,
      updatedLocal,
      patientId,
    );
    return true;
  });

  const didCancel = tx();
  if (!didCancel) {
    return { status: 'stale' };
  }

  const cancelled = get(apptId);
  if (phone || cancelled?.phone) {
    cancelWaitingByPhone(phone || cancelled.phone);
  }
  return {
    status: 'cancelled',
    appointment: cancelled,
    blockedUntilUtc,
    rebookTime: formatAlgeriaTime(blockedUntilUtc),
    cooldownMinutes,
  };
}

/**
 * Live queue position for a booked appointment inside its department (or general queue).
 */
function queuePosition(appointment) {
  if (!appointment || appointment.status !== 'booked') {
    return { ahead: null, etaMinutes: null };
  }
  const ahead = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM appointments
       WHERE day = ? AND COALESCE(department_id, 0) = ?
         AND status = 'booked' AND queue_number < ?`,
    )
    .get(appointment.day, deptKey(appointment.department_id), appointment.queue_number).n;
  const avgMinutes = Math.max(5, settings.getInt('avg_session_minutes') || 15);
  return { ahead, etaMinutes: ahead * avgMinutes };
}

/**
 * Secretary action: confirm the patient finished consultation, then notify
 * waiting patients in the SAME department (or general clinic queue):
 *  - immediately next patient (`turn_now`)
 *  - further waiting patients (`queue_ahead`) with remaining count & ETA.
 */
function completeAndAdvance(id, options = {}) {
  const current = get(id);
  const updated = setStatus(current.id, 'done');
  const today = options.today || toISODate();
  const avgMinutes = Math.max(5, settings.getInt('avg_session_minutes') || 15);

  if (updated.day !== today) {
    return {
      appointment: updated,
      next_patient: null,
      waiting_count: 0,
      distant_count: 0,
      avg_session_minutes: avgMinutes,
      notifications: [],
    };
  }

  const dKey = deptKey(updated.department_id);
  const dept = departments.getOptional(dKey);
  const waiting = getDb()
    .prepare(
      `${AGENDA_SQL}
       WHERE a.day = ? AND COALESCE(a.department_id, 0) = ? AND a.status = 'booked'
       ORDER BY a.queue_number ASC`,
    )
    .all(updated.day, dKey)
    .map(decorate);

  const notifications = [];
  const canQueueWa = Boolean(options.waConnected) && settings.getBool('queue_notify_enabled');

  waiting.slice(0, 20).forEach((entry, index) => {
    const lang =
      typeof options.resolveLanguage === 'function'
        ? options.resolveLanguage(entry.phone, entry.full_name)
        : chat.detectLanguage(entry.full_name);

    const deptLabel = dept ? departments.labelFor(dept, lang) : '';
    const isNext = index === 0;
    const ahead = index;
    const etaMinutes = ahead * avgMinutes;
    const body = isNext
      ? message(lang, 'turnNow', chat.clinicSettings(), {
          name: entry.full_name,
          queue: entry.queue_number,
          department: deptLabel,
          room: dept?.room || '',
        })
      : message(lang, 'queueAhead', chat.clinicSettings(), {
          name: entry.full_name,
          queue: entry.queue_number,
          ahead,
          etaMinutes,
          department: deptLabel,
        });

    const delivery = canQueueWa && entry.phone ? 'queued' : 'local';
    const logged = chat.record({
      kind: isNext ? 'turn_now' : 'queue_ahead',
      direction: 'out',
      patient_id: entry.patient_id,
      appointment_id: entry.id,
      patient_name: entry.full_name,
      phone: entry.phone || null,
      day: entry.day,
      queue_number: entry.queue_number,
      ahead_count: ahead,
      eta_minutes: etaMinutes,
      body,
      delivery,
      read: Boolean(options.markRead),
    });

    notifications.push({
      event_id: logged.id,
      kind: logged.kind,
      appointment_id: entry.id,
      patient_id: entry.patient_id,
      patient_name: entry.full_name,
      phone: entry.phone || null,
      queue_number: entry.queue_number,
      department_id: entry.department_id || null,
      department_name: deptLabel || null,
      ahead_count: ahead,
      eta_minutes: etaMinutes,
      lang,
      body,
      delivery,
    });
  });

  const next = waiting[0] || null;
  return {
    appointment: updated,
    next_patient: next
      ? {
          id: next.patient_id,
          appointment_id: next.id,
          full_name: next.full_name,
          queue_number: next.queue_number,
          department_id: next.department_id || null,
          department_name: next.dept_name_fr || next.department_name || null,
          phone: next.phone || null,
        }
      : null,
    waiting_count: waiting.length,
    distant_count: Math.max(0, waiting.length - 1),
    avg_session_minutes: avgMinutes,
    notifications,
  };
}

/**
 * Notify waiting patients behind a removed/cancelled/absent slot on today's queue
 * that their turn has moved closer (without disturbing patients ahead of that slot).
 */
function advanceNotificationsAfterRemoval(removedAppointment, options = {}) {
  if (!removedAppointment) return [];
  const today = options.today || toISODate();
  if (removedAppointment.day !== today) return [];
  if (!settings.getBool('queue_notify_enabled')) return [];

  const avgMinutes = Math.max(5, settings.getInt('avg_session_minutes') || 15);
  const dKey = deptKey(removedAppointment.department_id);
  const dept = departments.getOptional(dKey);
  const waiting = getDb()
    .prepare(
      `${AGENDA_SQL}
       WHERE a.day = ? AND COALESCE(a.department_id, 0) = ? AND a.status = 'booked'
       ORDER BY a.queue_number ASC`,
    )
    .all(removedAppointment.day, dKey)
    .map(decorate);

  const removedQueue = Number(removedAppointment.queue_number) || 0;
  const canQueueWa = Boolean(options.waConnected) && settings.getBool('queue_notify_enabled');
  const notifications = [];

  waiting.slice(0, 20).forEach((entry, index) => {
    if (entry.queue_number <= removedQueue) return;

    const lang =
      typeof options.resolveLanguage === 'function'
        ? options.resolveLanguage(entry.phone, entry.full_name)
        : chat.detectLanguage(entry.full_name);

    const deptLabel = dept ? departments.labelFor(dept, lang) : '';
    const isNext = index === 0;
    const ahead = index;
    const etaMinutes = ahead * avgMinutes;
    const body = isNext
      ? message(lang, 'turnNow', chat.clinicSettings(), {
          name: entry.full_name,
          queue: entry.queue_number,
          department: deptLabel,
          room: dept?.room || '',
        })
      : message(lang, 'queueAhead', chat.clinicSettings(), {
          name: entry.full_name,
          queue: entry.queue_number,
          ahead,
          etaMinutes,
          department: deptLabel,
        });

    const delivery = canQueueWa && entry.phone ? 'queued' : 'local';
    const logged = chat.record({
      kind: isNext ? 'turn_now' : 'queue_ahead',
      direction: 'out',
      patient_id: entry.patient_id,
      appointment_id: entry.id,
      patient_name: entry.full_name,
      phone: entry.phone || null,
      day: entry.day,
      queue_number: entry.queue_number,
      ahead_count: ahead,
      eta_minutes: etaMinutes,
      body,
      delivery,
      read: Boolean(options.markRead),
    });

    notifications.push({
      event_id: logged.id,
      kind: logged.kind,
      appointment_id: entry.id,
      patient_id: entry.patient_id,
      patient_name: entry.full_name,
      phone: entry.phone || null,
      queue_number: entry.queue_number,
      department_id: entry.department_id || null,
      department_name: deptLabel || null,
      ahead_count: ahead,
      eta_minutes: etaMinutes,
      lang,
      body,
      delivery,
    });
  });

  return notifications;
}

/**
 * Agenda of one day, ordered by department then queue number (cancelled rows excluded).
 * Optionally filtered by `departmentId`.
 */
function agenda(day = toISODate(), departmentId = null) {
  if (!isValidISODate(day)) throw new AppError('INVALID_DATE');
  const avgMinutes = Math.max(5, settings.getInt('avg_session_minutes') || 15);
  const dKey = deptKey(departmentId);
  const rows = dKey
    ? getDb()
        .prepare(
          `${AGENDA_SQL}
           WHERE a.day = ? AND a.department_id = ? AND a.status <> 'cancelled'
           ORDER BY CASE WHEN a.status = 'booked' AND a.priority = 'urgent' THEN 0 ELSE 1 END ASC,
                    CASE WHEN a.slot_time <> '' THEN a.slot_time ELSE '99:99' END ASC,
                    a.queue_number ASC`,
        )
        .all(day, dKey)
        .map(decorate)
    : getDb()
        .prepare(
          `${AGENDA_SQL}
           WHERE a.day = ? AND a.status <> 'cancelled'
           ORDER BY COALESCE(a.department_id, 0) ASC,
                    CASE WHEN a.status = 'booked' AND a.priority = 'urgent' THEN 0 ELSE 1 END ASC,
                    CASE WHEN a.slot_time <> '' THEN a.slot_time ELSE '99:99' END ASC,
                    a.queue_number ASC`,
        )
        .all(day)
        .map(decorate);

  const bookedOrderByDept = new Map();
  return rows.map((row) => {
    const scope = deptKey(row.department_id);
    if (row.status === 'booked') {
      const ahead = bookedOrderByDept.get(scope) || 0;
      bookedOrderByDept.set(scope, ahead + 1);
      return {
        ...row,
        ahead_count: ahead,
        eta_minutes: ahead * avgMinutes,
        is_current_turn: ahead === 0,
      };
    }
    return {
      ...row,
      ahead_count: null,
      eta_minutes: null,
      is_current_turn: false,
    };
  });
}

/** Next appointment of a patient from a given day (used by the bot). */
function upcomingForPatient(patientId, fromDay = toISODate(), departmentId = null) {
  const pId = requireId(patientId, 'patient_id');
  const dKey = deptKey(departmentId);
  const row = dKey
    ? getDb()
        .prepare(
          `${AGENDA_SQL}
           WHERE a.patient_id = ? AND a.day >= ? AND a.department_id = ?
             AND a.status IN ('booked', 'done')
           ORDER BY CASE WHEN a.status = 'booked' THEN 0 ELSE 1 END, a.day ASC, a.queue_number ASC
           LIMIT 1`,
        )
        .get(pId, fromDay, dKey)
    : getDb()
        .prepare(
          `${AGENDA_SQL}
           WHERE a.patient_id = ? AND a.day >= ? AND a.status IN ('booked', 'done')
           ORDER BY CASE WHEN a.status = 'booked' THEN 0 ELSE 1 END, a.day ASC, a.queue_number ASC
           LIMIT 1`,
        )
        .get(pId, fromDay);
  return row ? decorate(row) : null;
}

function listRange(startDay, endDay) {
  if (!isValidISODate(startDay) || !isValidISODate(endDay)) throw new AppError('INVALID_DATE');
  return getDb()
    .prepare(
      `${AGENDA_SQL}
       WHERE a.day BETWEEN ? AND ? AND a.status <> 'cancelled'
       ORDER BY a.day ASC, COALESCE(a.department_id, 0) ASC, a.queue_number ASC`,
    )
    .all(startDay, endDay)
    .map(decorate);
}

/** Dashboard counters for one day (aggregates multi-department capacity when configured). */
function dayStats(day = toISODate(), departmentId = null) {
  const dKey = deptKey(departmentId);
  const row = dKey
    ? getDb()
        .prepare(
          `SELECT
            SUM(CASE WHEN status = 'booked'   THEN 1 ELSE 0 END) AS booked,
            SUM(CASE WHEN status = 'done'     THEN 1 ELSE 0 END) AS done,
            SUM(CASE WHEN status = 'no_show'  THEN 1 ELSE 0 END) AS no_show,
            COUNT(*) AS total
           FROM appointments WHERE day = ? AND department_id = ? AND status <> 'cancelled'`,
        )
        .get(day, dKey)
    : getDb()
        .prepare(
          `SELECT
            SUM(CASE WHEN status = 'booked'   THEN 1 ELSE 0 END) AS booked,
            SUM(CASE WHEN status = 'done'     THEN 1 ELSE 0 END) AS done,
            SUM(CASE WHEN status = 'no_show'  THEN 1 ELSE 0 END) AS no_show,
            COUNT(*) AS total
           FROM appointments WHERE day = ? AND status <> 'cancelled'`,
        )
        .get(day);

  if (dKey) {
    const info = dayInfo(day, dKey);
    return {
      day,
      department_id: dKey,
      day_label: { fr: formatLong(day, 'fr'), ar: formatLong(day, 'ar') },
      total: row.total || 0,
      booked: row.booked || 0,
      done: row.done || 0,
      no_show: row.no_show || 0,
      capacity: info.capacity,
      left: info.left,
      working: info.working,
    };
  }

  const activeDepts = departments.listActive();
  if (activeDepts.length > 0) {
    const workingDepts = activeDepts.filter((d) => departments.isWorkingDay(d.id, day));
    const capacity = workingDepts.reduce((sum, d) => sum + d.daily_capacity, 0);
    const used = getDb()
      .prepare(
        `SELECT COUNT(*) AS n FROM appointments
         WHERE day = ? AND status IN ('booked', 'done', 'no_show')`,
      )
      .get(day).n;
    return {
      day,
      department_id: null,
      day_label: { fr: formatLong(day, 'fr'), ar: formatLong(day, 'ar') },
      total: row.total || 0,
      booked: row.booked || 0,
      done: row.done || 0,
      no_show: row.no_show || 0,
      capacity: capacity || settings.getInt('daily_capacity'),
      left: Math.max(0, (capacity || settings.getInt('daily_capacity')) - used),
      working: workingDepts.length > 0 || settings.isWorkingDay(day),
    };
  }

  const info = dayInfo(day, null);
  return {
    day,
    department_id: null,
    day_label: { fr: formatLong(day, 'fr'), ar: formatLong(day, 'ar') },
    total: row.total || 0,
    booked: row.booked || 0,
    done: row.done || 0,
    no_show: row.no_show || 0,
    capacity: info.capacity,
    left: info.left,
    working: info.working,
  };
}

/* ------------------------------ waiting list ----------------------------- */

function addToWaitingList({ full_name, phone, note, enforceCooldown = false, nowMs }) {
  license.requireValidLicense(nowMs !== undefined ? { nowMs } : undefined);
  const effectiveNowMs = nowMs !== undefined ? nowMs : Date.now();
  if (enforceCooldown && phone) {
    const check = canUserBook({ phone }, effectiveNowMs);
    if (!check.allowed) {
      throw new AppError('BOOKING_COOLDOWN', 'Patient is temporarily blocked after cancellation', check);
    }
  }
  const name = cleanText(full_name, 80);
  if (name.length < 2) throw new AppError('PATIENT_NAME_REQUIRED');
  const info = getDb()
    .prepare(
      `INSERT INTO waiting_list (full_name, phone, note, created_at) VALUES (?, ?, ?, ?)`,
    )
    .run(name, cleanText(phone, 30), cleanText(note, 200) || null, nowLocal());
  return { id: info.lastInsertRowid };
}

function waitingList(onlyPending = true) {
  return getDb()
    .prepare(`SELECT * FROM waiting_list ${onlyPending ? 'WHERE handled = 0' : ''} ORDER BY id ASC`)
    .all();
}

function markWaitingHandled(id) {
  getDb().prepare('UPDATE waiting_list SET handled = 1 WHERE id = ?').run(requireId(id));
  return { ok: true };
}

module.exports = {
  dayInfo,
  usedCapacity,
  nextQueueNumber,
  findNextFreeDay,
  create,
  get,
  reschedule,
  updateDetails,
  syncTreatmentName,
  setStatus,
  confirmAppointment,
  cancel,
  cancelByPatient,
  canUserBook,
  can_user_book: canUserBook,
  cancelWaitingByPhone,
  queuePosition,
  completeAndAdvance,
  advanceNotificationsAfterRemoval,
  agenda,
  upcomingForPatient,
  listRange,
  dayStats,
  addToWaitingList,
  waitingList,
  markWaitingHandled,
};
