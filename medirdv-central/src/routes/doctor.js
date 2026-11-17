'use strict';
/**
 * Doctor self-service API (Part 2/8): a doctor sees ONLY their own data.
 * Ownership is enforced by doctor_id on the user account.
 */
const { getDb, utcNow } = require('../db');
const { notFound, forbidden, validation } = require('../errors');
const { requireId, requireISODate, cleanText, optionalText } = require('../validate');
const booking = require('../services/booking');
const whatsapp = require('../services/whatsapp');
const { logAudit } = require('../services/audit');

function ownDoctorId(user) {
  if (!user || user.role !== 'doctor' || !user.doctor_id) {
    throw forbidden('Doctor account required');
  }
  return user.doctor_id;
}

function getOwnProfile(user) {
  const doctorId = ownDoctorId(user);
  const doctor = getDb().prepare('SELECT * FROM doctors WHERE id = ?').get(doctorId);
  if (!doctor) throw notFound('Doctor');
  const clinics = getDb()
    .prepare('SELECT c.* FROM clinics c JOIN doctor_clinics dc ON dc.clinic_id = c.id WHERE dc.doctor_id = ? ORDER BY c.name')
    .all(doctorId);
  const schedules = getDb().prepare('SELECT * FROM doctor_schedules WHERE doctor_id = ? ORDER BY weekday, start_time').all(doctorId);
  const wa = whatsapp.getAccount(doctorId);
  return { doctor, clinics, schedules, whatsapp: wa };
}

function listOwnAppointments(user, { day = null, status = null } = {}) {
  const doctorId = ownDoctorId(user);
  const clauses = ['doctor_id = ?'];
  const params = [doctorId];
  if (day) { clauses.push('day = ?'); params.push(requireISODate(day, 'day')); }
  if (status) { clauses.push('status = ?'); params.push(status); }
  return getDb()
    .prepare(`SELECT * FROM appointments WHERE ${clauses.join(' AND ')} ORDER BY day, time LIMIT 200`)
    .all(...params);
}

function respondToBooking(user, appointmentId, decision, body = {}) {
  const doctorId = ownDoctorId(user);
  const appointment = booking.getAppointmentById(requireId(appointmentId, 'appointmentId'));
  if (appointment.doctor_id !== doctorId) throw forbidden('This booking belongs to another doctor');
  const now = utcNow();
  if (decision === 'accepted') {
    const updated = booking.transition(appointment.id, 'confirmed', { actor: `doctor:${doctorId}`, note: 'Accepted via dashboard' });
    getDb().prepare('UPDATE appointments SET doctor_response = ?, doctor_responded_at = ? WHERE id = ?').run('accepted', now, appointment.id);
    logAudit({ userId: user.id, action: 'booking.accept', entity: 'appointment', entityId: String(appointment.id) });
    return updated;
  }
  if (decision === 'rejected') {
    const updated = booking.transition(appointment.id, 'rejected', { actor: `doctor:${doctorId}`, note: cleanText(body.note, 500) });
    getDb().prepare('UPDATE appointments SET doctor_response = ?, doctor_responded_at = ? WHERE id = ?').run('rejected', now, appointment.id);
    logAudit({ userId: user.id, action: 'booking.reject', entity: 'appointment', entityId: String(appointment.id) });
    return updated;
  }
  if (decision === 'reschedule') {
    const proposedDay = body.proposed_day ? requireISODate(body.proposed_day, 'proposed_day') : null;
    const proposedTime = body.proposed_time ? cleanText(body.proposed_time, 5) : null;
    const updated = booking.transition(appointment.id, 'rescheduling_requested', { actor: `doctor:${doctorId}`, note: cleanText(body.note, 500) });
    getDb()
      .prepare('UPDATE appointments SET doctor_response = ?, doctor_responded_at = ?, proposed_day = ?, proposed_time = ? WHERE id = ?')
      .run('reschedule', now, proposedDay, proposedTime, appointment.id);
    logAudit({ userId: user.id, action: 'booking.reschedule', entity: 'appointment', entityId: String(appointment.id) });
    return updated;
  }
  throw validation('decision must be accepted, rejected or reschedule');
}

function updateOwnSchedule(user, body) {
  const doctorId = ownDoctorId(user);
  const weekday = Number(body.weekday);
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) throw validation('weekday must be 0-6');
  const startTime = cleanText(body.start_time, 5);
  const endTime = cleanText(body.end_time, 5);
  if (!/^\d{2}:\d{2}$/.test(startTime) || !/^\d{2}:\d{2}$/.test(endTime)) throw validation('start_time/end_time must be HH:MM');
  if (endTime <= startTime) throw validation('end_time must be after start_time');
  const clinicId = body.clinic_id ? requireId(body.clinic_id, 'clinic_id') : null;
  const result = getDb()
    .prepare('INSERT INTO doctor_schedules (doctor_id, clinic_id, weekday, start_time, end_time) VALUES (?, ?, ?, ?, ?)')
    .run(doctorId, clinicId, weekday, startTime, endTime);
  logAudit({ userId: user.id, action: 'schedule.create', entity: 'doctor', entityId: String(doctorId) });
  return { id: result.lastInsertRowid };
}

module.exports = { ownDoctorId, getOwnProfile, listOwnAppointments, respondToBooking, updateOwnSchedule };
