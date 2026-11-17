'use strict';
/** In-app notifications (Part 8). WhatsApp/email go through whatsapp.js. */
const { getDb, utcNow } = require('../db');

function notifyPatient({ patientId = null, appointmentId = null, title, body = '' }) {
  getDb()
    .prepare(
      `INSERT INTO notifications (patient_id, appointment_id, channel, title, body, created_at)
       VALUES (?, ?, 'in_app', ?, ?, ?)`
    )
    .run(patientId, appointmentId, String(title).slice(0, 200), String(body).slice(0, 2000), utcNow());
}

function notifyUser({ userId, appointmentId = null, title, body = '' }) {
  getDb()
    .prepare(
      `INSERT INTO notifications (user_id, appointment_id, channel, title, body, created_at)
       VALUES (?, ?, 'in_app', ?, ?, ?)`
    )
    .run(userId, appointmentId, String(title).slice(0, 200), String(body).slice(0, 2000), utcNow());
}

function listForPatient(patientId, limit = 50) {
  return getDb()
    .prepare('SELECT * FROM notifications WHERE patient_id = ? ORDER BY id DESC LIMIT ?')
    .all(patientId, Math.min(200, Math.max(1, Number(limit) || 50)));
}

function markRead(id, patientId) {
  getDb().prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND patient_id = ?').run(id, patientId);
}

module.exports = { notifyPatient, notifyUser, listForPatient, markRead };
