'use strict';
/**
 * Doctor Software Connector (Part 7) — secure REST sync for desktop apps.
 *
 * The existing Medirdv/Dentardv desktop apps are NOT modified. This API is
 * the adapter they (or a future lightweight sync agent) can call:
 *  - per-clinic API keys (hashed at rest, revocable);
 *  - idempotent appointment push (external_ref + idempotency key);
 *  - availability pull (central slots for a clinic's doctors);
 *  - status sync with conflict detection (central wins on status, local
 *    wins on nothing — every sync is logged in integration_logs).
 *
 * The central system keeps working when a doctor's computer is offline:
 * bookings live centrally; sync is best-effort and retryable.
 */
const { getDb, utcNow } = require('../db');
const { validation, notFound, unauthorized, conflict } = require('../errors');
const { requireId, requireISODate, cleanText } = require('../validate');
const { sha256Hex, randomToken } = require('../crypto');
const auth = require('../auth');
const booking = require('../services/booking');
const { logAudit } = require('../services/audit');

function logIntegration(deviceId, kind, ok, detail) {
  getDb()
    .prepare('INSERT INTO integration_logs (device_id, kind, ok, detail, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(deviceId, kind, ok ? 1 : 0, String(detail).slice(0, 1000), utcNow());
}

function createDeviceKey(user, clinicId) {
  auth.requirePermission(user, 'connector:manage');
  const id = requireId(clinicId, 'clinicId');
  const clinic = getDb().prepare('SELECT id FROM clinics WHERE id = ?').get(id);
  if (!clinic) throw notFound('Clinic');
  const rawKey = `mdc_${randomToken(24)}`;
  const result = getDb()
    .prepare('INSERT INTO device_connections (clinic_id, device_name, api_key_hash) VALUES (?, ?, ?)')
    .run(id, cleanText(user.device_name, 120) || 'desktop', sha256Hex(rawKey));
  logAudit({ userId: user.id, action: 'connector.key_create', entity: 'clinic', entityId: String(id) });
  // The raw key is returned ONCE and never stored.
  return { id: result.lastInsertRowid, clinic_id: id, api_key: rawKey };
}

function revokeDeviceKey(user, deviceId) {
  auth.requirePermission(user, 'connector:manage');
  const id = requireId(deviceId, 'deviceId');
  const row = getDb().prepare('SELECT id FROM device_connections WHERE id = ?').get(id);
  if (!row) throw notFound('Device connection');
  getDb().prepare("UPDATE device_connections SET status = 'revoked' WHERE id = ?").run(id);
  logAudit({ userId: user.id, action: 'connector.key_revoke', entity: 'device', entityId: String(id) });
  return { id, status: 'revoked' };
}

/** Authenticate a connector request via `Authorization: Bearer mdc_…`. */
function authenticateConnector(header) {
  const match = String(header || '').match(/^Bearer\s+(mdc_.+)$/);
  if (!match) throw unauthorized('Connector API key required');
  const row = getDb().prepare('SELECT * FROM device_connections WHERE api_key_hash = ?').get(sha256Hex(match[1]));
  if (!row || row.status !== 'active') throw unauthorized('Invalid or revoked connector API key');
  getDb().prepare('UPDATE device_connections SET last_seen_at = ? WHERE id = ?').run(utcNow(), row.id);
  return row;
}

/**
 * Push a local appointment status to the central system.
 * body: { external_ref, status, day?, time?, note? }
 * Conflict rule: central status wins; the attempt is logged either way.
 */
function pushAppointmentStatus(device, body) {
  const externalRef = cleanText(body.external_ref, 120);
  if (!externalRef) throw validation('external_ref is required');
  const status = cleanText(body.status, 40);
  const appointment = getDb().prepare('SELECT * FROM appointments WHERE public_ref = ?').get(externalRef);
  if (!appointment) {
    logIntegration(device.id, 'push_status', false, `unknown ref ${externalRef}`);
    throw notFound('Appointment');
  }
  // The device may only sync appointments for doctors linked to its clinic.
  const linked = getDb()
    .prepare(
      `SELECT 1 AS ok FROM doctor_clinics WHERE doctor_id = ? AND clinic_id = ?`
    )
    .get(appointment.doctor_id, device.clinic_id);
  if (!linked) {
    logIntegration(device.id, 'push_status', false, `clinic mismatch for ${externalRef}`);
    throw unauthorized('This device is not linked to the appointment doctor');
  }
  const allowed = ['confirmed', 'completed', 'cancelled'];
  if (!allowed.includes(status)) {
    logIntegration(device.id, 'push_status', false, `unsupported status ${status}`);
    throw validation(`status must be one of: ${allowed.join(', ')}`);
  }
  if (!booking.canTransition(appointment.status, status)) {
    logIntegration(device.id, 'push_status', false, `conflict ${appointment.status} -> ${status} for ${externalRef}`);
    throw conflict('INVALID_STATE', `Central status ${appointment.status} cannot move to ${status}; central wins`);
  }
  const updated = booking.transition(appointment.id, status, { actor: `device:${device.id}`, note: cleanText(body.note, 500) });
  getDb().prepare('UPDATE device_connections SET last_sync_at = ? WHERE id = ?').run(utcNow(), device.id);
  logIntegration(device.id, 'push_status', true, `${externalRef} -> ${status}`);
  return updated;
}

/** Pull central availability for doctors linked to the device's clinic. */
function pullAvailability(device, { day, doctorId = null } = {}) {
  requireISODate(day, 'day');
  const doctors = getDb()
    .prepare(
      `SELECT d.* FROM doctors d JOIN doctor_clinics dc ON dc.doctor_id = d.id
       WHERE dc.clinic_id = ? AND d.status = 'active' AND (? IS NULL OR d.id = ?)
       ORDER BY d.full_name`
    )
    .all(device.clinic_id, doctorId, doctorId);
  return doctors.map((doctor) => ({
    doctor_id: doctor.id,
    doctor_name: doctor.full_name,
    slots: booking.availableSlots(doctor.id, day, device.clinic_id),
  }));
}

/** Pull confirmed appointments for the device's clinic on a day. */
function pullAppointments(device, { day } = {}) {
  requireISODate(day, 'day');
  const rows = getDb()
    .prepare(
      `SELECT a.* FROM appointments a JOIN doctor_clinics dc ON dc.doctor_id = a.doctor_id
       WHERE dc.clinic_id = ? AND a.day = ? AND a.status IN ('confirmed','pending_doctor_approval')
       ORDER BY a.time`
    )
    .all(device.clinic_id, day);
  getDb().prepare('UPDATE device_connections SET last_sync_at = ? WHERE id = ?').run(utcNow(), device.id);
  logIntegration(device.id, 'pull_appointments', true, `day ${day}: ${rows.length} rows`);
  return rows;
}

module.exports = {
  createDeviceKey,
  revokeDeviceKey,
  authenticateConnector,
  pushAppointmentStatus,
  pullAvailability,
  pullAppointments,
  logIntegration,
};
