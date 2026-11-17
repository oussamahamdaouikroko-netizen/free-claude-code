'use strict';
/**
 * WhatsApp Hub (Part 3) — OFFICIAL Meta WhatsApp Business Platform (Cloud API).
 *
 * Rules enforced here:
 *  - Only the official Cloud API is used. No Baileys / WhatsApp Web / QR
 *    automation is ever used by Medirdv Central (the desktop apps keep their
 *    own local bot; that is separate and untouched).
 *  - Every message is sent through the doctor's OWN Phone Number ID, so
 *    conversations can never be mixed between doctors.
 *  - When the platform is not configured (no verify token / app secret) or a
 *    doctor is not connected, the Hub reports `disabled` / `not_connected`
 *    and callers fall back to Click-to-Chat links. Nothing is simulated.
 *  - Only booking-relevant, explicitly authorized messages are processed.
 */
const { getDb, utcNow } = require('../db');
const { encryptSecret, decryptSecret, hmacSha256Hex, timingSafeEqualHex } = require('../crypto');
const { AppError } = require('../errors');
const { normalizePhoneDZ } = require('../validate');

const CLOUD_API_BASE = process.env.WHATSAPP_CLOUD_API_BASE || 'https://graph.facebook.com/v21.0';

function isPlatformConfigured() {
  return Boolean(process.env.WHATSAPP_VERIFY_TOKEN && process.env.WHATSAPP_APP_SECRET);
}

function getAccount(doctorId) {
  return getDb().prepare('SELECT * FROM whatsapp_accounts WHERE doctor_id = ?').get(doctorId) || null;
}

function ensureAccount(doctorId) {
  const existing = getAccount(doctorId);
  if (existing) return existing;
  getDb()
    .prepare('INSERT INTO whatsapp_accounts (doctor_id, mode, status) VALUES (?, ?, ?)')
    .run(doctorId, 'none', 'disconnected');
  return getAccount(doctorId);
}

/**
 * Connect a doctor's official Cloud API account (after Embedded Signup).
 * The access token is encrypted at rest; passwords/OTPs are never stored.
 */
function connectCloudApi(doctorId, { phoneNumberId, accessToken, wabaId = '', displayNumber = '', tokenExpiresAt = null }) {
  if (!isPlatformConfigured()) {
    throw new AppError('WHATSAPP_DISABLED', 'WhatsApp platform is not configured on this deployment');
  }
  if (!phoneNumberId || !accessToken) {
    throw new AppError('VALIDATION', 'phoneNumberId and accessToken are required');
  }
  ensureAccount(doctorId);
  getDb()
    .prepare(
      `UPDATE whatsapp_accounts
       SET mode = 'cloud_api', phone_number_id = ?, access_token_enc = ?, waba_id = ?,
           display_number = ?, token_expires_at = ?, status = 'connected', last_error = '', updated_at = ?
       WHERE doctor_id = ?`
    )
    .run(
      String(phoneNumberId),
      encryptSecret(String(accessToken)),
      String(wabaId || ''),
      String(displayNumber || ''),
      tokenExpiresAt || null,
      utcNow(),
      doctorId
    );
  return getAccount(doctorId);
}

function setClickToChat(doctorId, whatsappNumber) {
  ensureAccount(doctorId);
  const normalized = normalizePhoneDZ(whatsappNumber) || String(whatsappNumber || '');
  getDb()
    .prepare(
      `UPDATE whatsapp_accounts SET mode = 'click_to_chat', display_number = ?, status = 'pending', updated_at = ?
       WHERE doctor_id = ?`
    )
    .run(normalized, utcNow(), doctorId);
  return getAccount(doctorId);
}

function disconnect(doctorId) {
  ensureAccount(doctorId);
  getDb()
    .prepare(
      `UPDATE whatsapp_accounts SET status = 'disconnected', access_token_enc = NULL, updated_at = ?
       WHERE doctor_id = ?`
    )
    .run(utcNow(), doctorId);
  return getAccount(doctorId);
}

/** Click-to-Chat link with a prefilled booking message (fallback, Part 3.6). */
function clickToChatLink(doctor, message) {
  const number = normalizePhoneDZ(doctor.whatsapp_number || doctor.phone || '');
  if (!number) return null;
  const digits = number.replace('+', '');
  const text = encodeURIComponent(String(message || ''));
  return `https://wa.me/${digits}?text=${text}`;
}

/** Booking notification body (minimal data: name, ref, date/time, clinic). */
function bookingNotificationText({ appointment, doctorName, clinicName, lang = 'fr' }) {
  if (lang === 'ar') {
    return [
      'طلب موعد جديد',
      `المريض: ${appointment.patient_name}`,
      `رقم الحجز: ${appointment.public_ref}`,
      `التاريخ: ${appointment.day}`,
      `الوقت: ${appointment.time}`,
      `العيادة: ${clinicName || '-'}`,
      '',
      'يرجى الرد: قبول / رفض / طلب وقت آخر',
    ].join('\n');
  }
  return [
    'New appointment request',
    `Patient: ${appointment.patient_name}`,
    `Booking ID: ${appointment.public_ref}`,
    `Date: ${appointment.day}`,
    `Time: ${appointment.time}`,
    `Clinic: ${clinicName || '-'}`,
    '',
    'Please reply: Accept / Reject / Request another time',
  ].join('\n');
}

function recordMessage({ doctorId, appointmentId = null, direction, toPhone = '', fromPhone = '', templateName = '', body = '', waMessageId = '', status = 'queued', error = '' }) {
  const result = getDb()
    .prepare(
      `INSERT INTO whatsapp_messages
         (doctor_id, appointment_id, direction, to_phone, from_phone, template_name, body, wa_message_id, status, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(doctorId, appointmentId, direction, toPhone, fromPhone, templateName, String(body).slice(0, 4000), waMessageId, status, String(error).slice(0, 500), utcNow());
  return result.lastInsertRowid;
}

function updateMessageStatus(waMessageId, status, error = '') {
  getDb()
    .prepare('UPDATE whatsapp_messages SET status = ?, error = ? WHERE wa_message_id = ?')
    .run(status, String(error).slice(0, 500), waMessageId);
}

/**
 * Send a text message via the doctor's Cloud API number.
 * Returns { ok, waMessageId } or throws AppError(WHATSAPP_NOT_CONNECTED).
 * Never falls back to unofficial transports.
 */
async function sendTextMessage(doctorId, toPhone, text, { appointmentId = null, fetchImpl = globalThis.fetch } = {}) {
  const account = getAccount(doctorId);
  if (!account || account.mode !== 'cloud_api' || account.status !== 'connected') {
    throw new AppError('WHATSAPP_NOT_CONNECTED', 'Doctor WhatsApp account is not connected via the official API');
  }
  const token = decryptSecret(account.access_token_enc);
  if (!token) {
    throw new AppError('WHATSAPP_NOT_CONNECTED', 'Doctor WhatsApp credentials are unavailable');
  }
  const to = String(toPhone || '').replace(/\D/g, '');
  if (!to) throw new AppError('VALIDATION', 'Recipient phone number is required');

  const messageId = recordMessage({
    doctorId, appointmentId, direction: 'out', toPhone: to, body: text, status: 'queued',
  });

  const response = await fetchImpl(`${CLOUD_API_BASE}/${account.phone_number_id}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: String(text).slice(0, 4096) },
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const errorText = payload?.error?.message || `Cloud API HTTP ${response.status}`;
    getDb().prepare('UPDATE whatsapp_messages SET status = ?, error = ? WHERE id = ?').run('failed', String(errorText).slice(0, 500), messageId);
    throw new AppError('WHATSAPP_NOT_CONNECTED', `WhatsApp send failed: ${errorText}`);
  }
  const waMessageId = payload?.messages?.[0]?.id || '';
  getDb().prepare('UPDATE whatsapp_messages SET status = ?, wa_message_id = ? WHERE id = ?').run('sent', waMessageId, messageId);
  return { ok: true, waMessageId, messageId };
}

/** Verify Meta webhook signature (X-Hub-Signature-256 over the raw body). */
function verifyWebhookSignature(rawBody, signatureHeader) {
  const secret = process.env.WHATSAPP_APP_SECRET || '';
  if (!secret || !signatureHeader) return false;
  const expected = hmacSha256Hex(secret, rawBody);
  const provided = String(signatureHeader).replace(/^sha256=/, '');
  return timingSafeEqualHex(expected, provided);
}

/**
 * Idempotency guard for webhook deliveries: returns true when this
 * wa_message_id was already processed (duplicate delivery).
 */
function markWebhookProcessed(phoneNumberId, waMessageId, payloadHash) {
  const existing = getDb().prepare('SELECT id FROM whatsapp_webhook_events WHERE wa_message_id = ?').get(waMessageId);
  if (existing) return true;
  getDb()
    .prepare(
      `INSERT INTO whatsapp_webhook_events (phone_number_id, wa_message_id, payload_hash, processed, created_at)
       VALUES (?, ?, ?, 1, ?)`
    )
    .run(phoneNumberId || '', waMessageId, payloadHash, utcNow());
  return false;
}

function listMessages({ doctorId = null, appointmentId = null, limit = 100 } = {}) {
  const clauses = [];
  const params = [];
  if (doctorId) { clauses.push('doctor_id = ?'); params.push(Number(doctorId)); }
  if (appointmentId) { clauses.push('appointment_id = ?'); params.push(Number(appointmentId)); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const n = Math.min(500, Math.max(1, Number(limit) || 100));
  return getDb().prepare(`SELECT * FROM whatsapp_messages ${where} ORDER BY id DESC LIMIT ?`).all(...params, n);
}

function connectionHealth() {
  return getDb()
    .prepare(
      `SELECT a.doctor_id, d.full_name, a.mode, a.status, a.display_number, a.last_error, a.last_checked_at
       FROM whatsapp_accounts a JOIN doctors d ON d.id = a.doctor_id
       ORDER BY d.full_name`
    )
    .all();
}

module.exports = {
  isPlatformConfigured,
  getAccount,
  ensureAccount,
  connectCloudApi,
  setClickToChat,
  disconnect,
  clickToChatLink,
  bookingNotificationText,
  recordMessage,
  updateMessageStatus,
  sendTextMessage,
  verifyWebhookSignature,
  markWebhookProcessed,
  listMessages,
  connectionHealth,
};
