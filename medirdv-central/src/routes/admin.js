'use strict';
/**
 * Central administration API (Part 2, 8, 12).
 * All routes require an authenticated user with the matching permission;
 * checks run here on the backend, never only in the frontend.
 */
const { getDb, utcNow } = require('../db');
const { validation, notFound, conflict } = require('../errors');
const {
  requireText, optionalText, optionalEmail, requirePhoneDZ, normalizePhoneDZ,
  requireISODate, requireId, requireEnum, requireMoney, parseWeekdays, cleanText,
} = require('../validate');
const auth = require('../auth');
const booking = require('../services/booking');
const payments = require('../services/payments');
const whatsapp = require('../services/whatsapp');
const { logAudit, listAudit } = require('../services/audit');

function doctorRow(row) {
  if (!row) return null;
  const specialty = row.specialty_id
    ? getDb().prepare('SELECT * FROM specialties WHERE id = ?').get(row.specialty_id)
    : null;
  const clinics = getDb()
    .prepare(
      `SELECT c.* FROM clinics c JOIN doctor_clinics dc ON dc.clinic_id = c.id WHERE dc.doctor_id = ? ORDER BY c.name`
    )
    .all(row.id);
  const wa = whatsapp.getAccount(row.id);
  return {
    ...row,
    specialty,
    clinics,
    whatsapp: wa
      ? { mode: wa.mode, status: wa.status, display_number: wa.display_number }
      : { mode: 'none', status: 'disconnected', display_number: '' },
  };
}

function listDoctors({ status = null, specialtyId = null, search = '', limit = 100 } = {}) {
  const clauses = [];
  const params = [];
  if (status) { clauses.push('status = ?'); params.push(status); }
  if (specialtyId) { clauses.push('specialty_id = ?'); params.push(requireId(specialtyId, 'specialtyId')); }
  if (search) { clauses.push('(full_name LIKE ? OR public_ref LIKE ?)'); params.push(`%${search}%`, `%${search}%`); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const n = Math.min(500, Math.max(1, Number(limit) || 100));
  return getDb().prepare(`SELECT * FROM doctors ${where} ORDER BY full_name LIMIT ?`).all(...params, n).map(doctorRow);
}

function createDoctor(user, body) {
  auth.requirePermission(user, 'admin:doctors');
  const fullName = requireText(body.full_name, 'full_name', 120);
  const specialtyText = optionalText(body.specialty_text, 120) || '';
  let specialtyId = null;
  if (body.specialty_id) {
    specialtyId = requireId(body.specialty_id, 'specialty_id');
    const exists = getDb().prepare('SELECT id FROM specialties WHERE id = ?').get(specialtyId);
    if (!exists) throw validation('Unknown specialty_id');
  }
  const phone = body.phone ? requirePhoneDZ(body.phone, 'phone') : null;
  const whatsappNumber = body.whatsapp_number ? requirePhoneDZ(body.whatsapp_number, 'whatsapp_number') : null;
  const email = optionalEmail(body.email);
  const fee = body.consultation_fee !== undefined ? requireMoney(body.consultation_fee, 'consultation_fee') : 0;
  const publicRef = `DOC-${String(Date.now()).slice(-6)}${Math.floor(Math.random() * 90 + 10)}`;
  const now = utcNow();
  const result = getDb()
    .prepare(
      `INSERT INTO doctors
         (public_ref, full_name, specialty_id, specialty_text, phone, phone_norm, whatsapp_number, whatsapp_number_norm,
          email, ordre_number, status, consultation_fee, appointment_minutes, max_daily,
          booking_lead_hours, cancel_deadline_hours, auto_confirm, response_deadline_hours, payment_mode,
          baridimob_name, baridimob_rib, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      publicRef, fullName, specialtyId, specialtyText, phone, phone, whatsappNumber, whatsappNumber,
      email, optionalText(body.ordre_number, 60) || '', fee,
      clampInt(body.appointment_minutes, 5, 180, 15),
      clampInt(body.max_daily, 1, 500, 30),
      clampInt(body.booking_lead_hours, 0, 720, 0),
      clampInt(body.cancel_deadline_hours, 0, 720, 0),
      body.auto_confirm ? 1 : 0,
      clampInt(body.response_deadline_hours, 1, 168, 24),
      requireEnum(body.payment_mode || 'baridimob_manual', ['baridimob_manual', 'cash_at_clinic', 'free', 'none'], 'payment_mode'),
      optionalText(body.baridimob_name, 120) || '',
      optionalText(body.baridimob_rib, 60) || '',
      now, now
    );
  const doctor = getDb().prepare('SELECT * FROM doctors WHERE id = ?').get(result.lastInsertRowid);
  logAudit({ userId: user.id, action: 'doctor.create', entity: 'doctor', entityId: String(doctor.id), detail: fullName });
  return doctorRow(doctor);
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function setDoctorStatus(user, doctorId, status) {
  auth.requirePermission(user, 'admin:doctors');
  requireEnum(status, ['active', 'pending', 'suspended', 'inactive'], 'status');
  const doctor = getDb().prepare('SELECT * FROM doctors WHERE id = ?').get(doctorId);
  if (!doctor) throw notFound('Doctor');
  getDb().prepare('UPDATE doctors SET status = ?, updated_at = ? WHERE id = ?').run(status, utcNow(), doctorId);
  logAudit({ userId: user.id, action: `doctor.${status}`, entity: 'doctor', entityId: String(doctorId) });
  return doctorRow(getDb().prepare('SELECT * FROM doctors WHERE id = ?').get(doctorId));
}

function createClinic(user, body) {
  auth.requirePermission(user, 'admin:clinics');
  const name = requireText(body.name, 'name', 160);
  const publicRef = `CLN-${String(Date.now()).slice(-6)}${Math.floor(Math.random() * 90 + 10)}`;
  const now = utcNow();
  const result = getDb()
    .prepare(
      `INSERT INTO clinics (public_ref, name, address, wilaya, city, phone, lat, lng, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      publicRef, name,
      optionalText(body.address, 300) || '',
      optionalText(body.wilaya, 80) || '',
      optionalText(body.city, 80) || '',
      body.phone ? requirePhoneDZ(body.phone, 'phone') : null,
      body.lat !== undefined && body.lat !== '' ? Number(body.lat) : null,
      body.lng !== undefined && body.lng !== '' ? Number(body.lng) : null,
      now, now
    );
  const clinic = getDb().prepare('SELECT * FROM clinics WHERE id = ?').get(result.lastInsertRowid);
  logAudit({ userId: user.id, action: 'clinic.create', entity: 'clinic', entityId: String(clinic.id), detail: name });
  return clinic;
}

function listClinics() {
  return getDb().prepare('SELECT * FROM clinics ORDER BY name').all();
}

function linkDoctorClinic(user, doctorId, clinicId) {
  auth.requirePermission(user, 'admin:clinics');
  const doctor = getDb().prepare('SELECT id FROM doctors WHERE id = ?').get(doctorId);
  const clinic = getDb().prepare('SELECT id FROM clinics WHERE id = ?').get(clinicId);
  if (!doctor) throw notFound('Doctor');
  if (!clinic) throw notFound('Clinic');
  getDb().prepare('INSERT OR IGNORE INTO doctor_clinics (doctor_id, clinic_id) VALUES (?, ?)').run(doctorId, clinicId);
  logAudit({ userId: user.id, action: 'doctor_clinic.link', entity: 'doctor', entityId: String(doctorId), detail: `clinic ${clinicId}` });
  return { doctor_id: doctorId, clinic_id: clinicId };
}

function setSchedule(user, body) {
  auth.requirePermission(user, 'admin:doctors');
  const doctorId = requireId(body.doctor_id, 'doctor_id');
  const clinicId = body.clinic_id ? requireId(body.clinic_id, 'clinic_id') : null;
  const weekday = Number(body.weekday);
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) throw validation('weekday must be 0-6');
  const startTime = requireText(body.start_time, 'start_time', 5);
  const endTime = requireText(body.end_time, 'end_time', 5);
  if (!/^\d{2}:\d{2}$/.test(startTime) || !/^\d{2}:\d{2}$/.test(endTime)) throw validation('start_time/end_time must be HH:MM');
  if (endTime <= startTime) throw validation('end_time must be after start_time');
  const doctor = getDb().prepare('SELECT id FROM doctors WHERE id = ?').get(doctorId);
  if (!doctor) throw notFound('Doctor');
  const result = getDb()
    .prepare(
      `INSERT INTO doctor_schedules (doctor_id, clinic_id, weekday, start_time, end_time)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(doctorId, clinicId, weekday, startTime, endTime);
  logAudit({ userId: user.id, action: 'schedule.create', entity: 'doctor', entityId: String(doctorId), detail: `${weekday} ${startTime}-${endTime}` });
  return { id: result.lastInsertRowid, doctor_id: doctorId, clinic_id: clinicId, weekday, start_time: startTime, end_time: endTime };
}

function blockDate(user, body) {
  auth.requirePermission(user, 'admin:doctors');
  const doctorId = requireId(body.doctor_id, 'doctor_id');
  const clinicId = body.clinic_id ? requireId(body.clinic_id, 'clinic_id') : null;
  const day = requireISODate(body.day, 'day');
  const reason = optionalText(body.reason, 200) || '';
  getDb()
    .prepare('INSERT OR REPLACE INTO blocked_dates (doctor_id, clinic_id, day, reason) VALUES (?, ?, ?, ?)')
    .run(doctorId, clinicId, day, reason);
  logAudit({ userId: user.id, action: 'schedule.block', entity: 'doctor', entityId: String(doctorId), detail: day });
  return { doctor_id: doctorId, clinic_id: clinicId, day, reason };
}

function dashboardStats() {
  const db = getDb();
  const today = booking.todayISO();
  const count = (sql, params = []) => db.prepare(sql).get(...params).n;
  return {
    doctors_total: count('SELECT COUNT(*) AS n FROM doctors'),
    doctors_active: count("SELECT COUNT(*) AS n FROM doctors WHERE status = 'active'"),
    clinics_total: count('SELECT COUNT(*) AS n FROM clinics WHERE is_active = 1'),
    patients_total: count('SELECT COUNT(*) AS n FROM patients'),
    bookings_today: count('SELECT COUNT(*) AS n FROM appointments WHERE day = ?', [today]),
    bookings_pending: count("SELECT COUNT(*) AS n FROM appointments WHERE status IN ('pending_payment','payment_verification','pending_doctor_approval')"),
    bookings_confirmed: count("SELECT COUNT(*) AS n FROM appointments WHERE status = 'confirmed'"),
    bookings_cancelled: count("SELECT COUNT(*) AS n FROM appointments WHERE status = 'cancelled'"),
    payments_pending: count("SELECT COUNT(*) AS n FROM payments WHERE status IN ('awaiting_payment','submitted','under_verification')"),
    payments_paid: count("SELECT COUNT(*) AS n FROM payments WHERE status = 'paid'"),
    collected_dzd: db.prepare("SELECT COALESCE(SUM(amount),0) AS t FROM payments WHERE status = 'paid'").get().t,
    whatsapp: whatsapp.connectionHealth(),
    recent_activity: listAudit({ limit: 15 }),
  };
}

function analytics({ from = null, to = null } = {}) {
  const db = getDb();
  const clauses = [];
  const params = [];
  if (from) { clauses.push('day >= ?'); params.push(requireISODate(from, 'from')); }
  if (to) { clauses.push('day <= ?'); params.push(requireISODate(to, 'to')); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const daily = db
    .prepare(`SELECT day, COUNT(*) AS n FROM appointments ${where} GROUP BY day ORDER BY day`)
    .all(...params);
  const byStatus = db
    .prepare(`SELECT status, COUNT(*) AS n FROM appointments ${where} GROUP BY status`)
    .all(...params);
  const bySpecialty = db
    .prepare(
      `SELECT COALESCE(s.name_fr, d.specialty_text, '—') AS specialty, COUNT(*) AS n
       FROM appointments a LEFT JOIN doctors d ON d.id = a.doctor_id
       LEFT JOIN specialties s ON s.id = d.specialty_id ${where ? where.replace(/day/g, 'a.day') : ''}
       GROUP BY specialty ORDER BY n DESC LIMIT 10`
    )
    .all(...params);
  const byWilaya = db
    .prepare(
      `SELECT COALESCE(c.wilaya, '—') AS wilaya, COUNT(*) AS n
       FROM appointments a LEFT JOIN clinics c ON c.id = a.clinic_id
       ${where ? where.replace(/day/g, 'a.day') : ''} GROUP BY wilaya ORDER BY n DESC LIMIT 15`
    )
    .all(...params);
  const paymentStats = payments.paymentSummary();
  return { daily, byStatus, bySpecialty, byWilaya, paymentStats };
}

function createSpecialty(user, body) {
  auth.requirePermission(user, 'admin:doctors');
  const slug = cleanText(body.slug, 60).toLowerCase().replace(/[^a-z0-9-]/g, '-');
  if (!slug) throw validation('slug is required');
  const nameFr = requireText(body.name_fr, 'name_fr', 120);
  const nameAr = requireText(body.name_ar, 'name_ar', 120);
  getDb().prepare('INSERT OR IGNORE INTO specialties (slug, name_fr, name_ar) VALUES (?, ?, ?)').run(slug, nameFr, nameAr);
  return getDb().prepare('SELECT * FROM specialties WHERE slug = ?').get(slug);
}

function listSpecialties() {
  return getDb().prepare('SELECT * FROM specialties WHERE is_active = 1 ORDER BY name_fr').all();
}

function listPatients({ search = '', limit = 100 } = {}) {
  const n = Math.min(500, Math.max(1, Number(limit) || 100));
  if (search) {
    return getDb()
      .prepare('SELECT * FROM patients WHERE full_name LIKE ? OR phone LIKE ? ORDER BY full_name LIMIT ?')
      .all(`%${search}%`, `%${search}%`, n);
  }
  return getDb().prepare('SELECT * FROM patients ORDER BY full_name LIMIT ?').all(n);
}

module.exports = {
  doctorRow,
  listDoctors,
  createDoctor,
  setDoctorStatus,
  createClinic,
  listClinics,
  linkDoctorClinic,
  setSchedule,
  blockDate,
  dashboardStats,
  analytics,
  createSpecialty,
  listSpecialties,
  listPatients,
};
