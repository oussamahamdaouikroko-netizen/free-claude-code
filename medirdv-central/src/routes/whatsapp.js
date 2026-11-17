'use strict';
/**
 * WhatsApp Hub API (Part 3): connection management + official webhooks.
 *
 * Webhook flow:
 *  1. GET  /webhooks/whatsapp — Meta verification handshake (hub.verify_token).
 *  2. POST /webhooks/whatsapp — signed event delivery. Signature is verified
 *     against WHATSAPP_APP_SECRET; duplicate wa_message_ids are ignored.
 *  3. Incoming doctor replies are matched to the doctor by phone_number_id
 *     (never by guessing) and to the booking by reference in the text.
 */
const { getDb, utcNow } = require('../db');
const { AppError, validation, notFound } = require('../errors');
const { requireId, cleanText } = require('../validate');
const { sha256Hex } = require('../crypto');
const auth = require('../auth');
const whatsapp = require('../services/whatsapp');
const booking = require('../services/booking');
const notify = require('../services/notify');
const { logAudit } = require('../services/audit');

function verifyWebhook(query) {
  const mode = query['hub.mode'];
  const token = query['hub.verify_token'];
  const challenge = query['hub.challenge'];
  const expected = process.env.WHATSAPP_VERIFY_TOKEN || '';
  if (mode === 'subscribe' && token && token === expected) {
    return { status: 200, body: String(challenge || '') };
  }
  return { status: 403, body: 'Forbidden' };
}

const ACCEPT_WORDS = new Set(['accept', 'accepte', 'accepter', 'ok', 'yes', 'oui', 'قبول', 'نعم', 'مقبول']);
const REJECT_WORDS = new Set(['reject', 'refuse', 'refuser', 'no', 'non', 'رفض', 'لا', 'مرفوض']);
const RESCHEDULE_WORDS = new Set(['reschedule', 'another', 'autre', 'وقت آخر', 'تغيير']);

function parseDoctorReply(text) {
  const normalized = String(text || '').trim().toLowerCase();
  const refMatch = normalized.match(/mr-\d{4}-\d{6}/i);
  const ref = refMatch ? refMatch[0].toUpperCase() : null;
  let decision = null;
  if ([...ACCEPT_WORDS].some((w) => normalized === w || normalized.startsWith(`${w} `) || normalized.includes(` ${w}`))) decision = 'accepted';
  if ([...REJECT_WORDS].some((w) => normalized === w || normalized.startsWith(`${w} `) || normalized.includes(` ${w}`))) decision = 'rejected';
  if ([...RESCHEDULE_WORDS].some((w) => normalized.includes(w))) decision = 'reschedule';
  return { ref, decision };
}

function doctorIdForPhoneNumberId(phoneNumberId) {
  const row = getDb()
    .prepare('SELECT doctor_id FROM whatsapp_accounts WHERE phone_number_id = ? AND mode = ?')
    .get(String(phoneNumberId || ''), 'cloud_api');
  return row ? row.doctor_id : null;
}

/**
 * Process one verified webhook payload. Returns { processed, duplicates }.
 * Safe to retry: already-seen wa_message_ids are skipped.
 */
function handleWebhook(payload) {
  let processed = 0;
  let duplicates = 0;
  const entries = payload?.entry || [];
  for (const entry of entries) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      const phoneNumberId = value.metadata?.phone_number_id || '';
      const doctorId = doctorIdForPhoneNumberId(phoneNumberId);
      for (const message of value.messages || []) {
        const waMessageId = message.id || '';
        if (!waMessageId) continue;
        const payloadHash = sha256Hex(JSON.stringify(message));
        if (whatsapp.markWebhookProcessed(phoneNumberId, waMessageId, payloadHash)) {
          duplicates += 1;
          continue;
        }
        const from = message.from || '';
        const text = message.text?.body || message.button?.text || message.interactive?.button_reply?.title || '';
        whatsapp.recordMessage({
          doctorId, direction: 'in', fromPhone: from, body: text, waMessageId, status: 'received',
        });
        if (doctorId) applyDoctorReply(doctorId, text);
        processed += 1;
      }
      for (const statusUpdate of value.statuses || []) {
        if (statusUpdate.id) {
          const mapped = { sent: 'sent', delivered: 'delivered', read: 'read', failed: 'failed' }[statusUpdate.status] || 'sent';
          whatsapp.updateMessageStatus(statusUpdate.id, mapped, statusUpdate.errors?.[0]?.title || '');
        }
      }
    }
  }
  return { processed, duplicates };
}

function applyDoctorReply(doctorId, text) {
  const { ref, decision } = parseDoctorReply(text);
  if (!ref || !decision) return;
  let appointment;
  try {
    appointment = booking.getAppointmentByRef(ref);
  } catch {
    return;
  }
  // Never let one doctor act on another doctor's booking.
  if (appointment.doctor_id !== doctorId) return;

  const now = utcNow();
  if (decision === 'accepted') {
    if (appointment.status === 'pending_doctor_approval') {
      booking.transition(appointment.id, 'confirmed', { actor: `doctor:${doctorId}`, note: 'Accepted via WhatsApp' });
      getDb().prepare('UPDATE appointments SET doctor_response = ?, doctor_responded_at = ? WHERE id = ?').run('accepted', now, appointment.id);
      notify.notifyPatient({ patientId: appointment.patient_id, appointmentId: appointment.id, title: 'Appointment confirmed', body: `${appointment.public_ref} — ${appointment.day} ${appointment.time}` });
    }
  } else if (decision === 'rejected') {
    if (appointment.status === 'pending_doctor_approval') {
      booking.transition(appointment.id, 'rejected', { actor: `doctor:${doctorId}`, note: 'Rejected via WhatsApp' });
      getDb().prepare('UPDATE appointments SET doctor_response = ?, doctor_responded_at = ? WHERE id = ?').run('rejected', now, appointment.id);
      notify.notifyPatient({ patientId: appointment.patient_id, appointmentId: appointment.id, title: 'Appointment rejected', body: `${appointment.public_ref} — please choose another time or doctor.` });
    }
  } else if (decision === 'reschedule') {
    if (appointment.status === 'pending_doctor_approval' || appointment.status === 'confirmed') {
      booking.transition(appointment.id, 'rescheduling_requested', { actor: `doctor:${doctorId}`, note: 'Reschedule requested via WhatsApp' });
      getDb().prepare('UPDATE appointments SET doctor_response = ?, doctor_responded_at = ? WHERE id = ?').run('reschedule', now, appointment.id);
      notify.notifyPatient({ patientId: appointment.patient_id, appointmentId: appointment.id, title: 'Reschedule requested', body: `${appointment.public_ref} — the doctor proposed another time.` });
    }
  }
}

/** Send the booking notification to the doctor (official API or error). */
async function notifyDoctorOfBooking(appointmentId) {
  const appointment = booking.getAppointmentById(appointmentId);
  const doctor = getDb().prepare('SELECT * FROM doctors WHERE id = ?').get(appointment.doctor_id);
  const clinic = appointment.clinic_id
    ? getDb().prepare('SELECT name FROM clinics WHERE id = ?').get(appointment.clinic_id)
    : null;
  const wa = whatsapp.getAccount(appointment.doctor_id);
  if (!wa || wa.mode !== 'cloud_api' || wa.status !== 'connected') {
    throw new AppError('WHATSAPP_NOT_CONNECTED', 'Doctor WhatsApp is not connected via the official API');
  }
  const text = whatsapp.bookingNotificationText({
    appointment, doctorName: doctor.full_name, clinicName: clinic ? clinic.name : '',
  });
  const result = await whatsapp.sendTextMessage(appointment.doctor_id, appointment.patient_phone_norm, text, { appointmentId: appointment.id });
  return { ...result, text };
}

function connectDoctor(user, doctorId, body) {
  auth.requirePermission(user, 'whatsapp:manage');
  const id = requireId(doctorId, 'doctorId');
  const doctor = getDb().prepare('SELECT id FROM doctors WHERE id = ?').get(id);
  if (!doctor) throw notFound('Doctor');
  if (body.mode === 'click_to_chat') {
    const account = whatsapp.setClickToChat(id, body.whatsapp_number || '');
    logAudit({ userId: user.id, action: 'whatsapp.click_to_chat', entity: 'doctor', entityId: String(id) });
    return account;
  }
  const account = whatsapp.connectCloudApi(id, {
    phoneNumberId: body.phone_number_id,
    accessToken: body.access_token,
    wabaId: body.waba_id || '',
    displayNumber: body.display_number || '',
    tokenExpiresAt: body.token_expires_at || null,
  });
  logAudit({ userId: user.id, action: 'whatsapp.connect', entity: 'doctor', entityId: String(id) });
  return account;
}

function disconnectDoctor(user, doctorId) {
  auth.requirePermission(user, 'whatsapp:manage');
  const id = requireId(doctorId, 'doctorId');
  const account = whatsapp.disconnect(id);
  logAudit({ userId: user.id, action: 'whatsapp.disconnect', entity: 'doctor', entityId: String(id) });
  return account;
}

async function retryFailedMessages(user, { limit = 20 } = {}) {
  auth.requirePermission(user, 'whatsapp:manage');
  const failed = getDb()
    .prepare("SELECT * FROM whatsapp_messages WHERE direction = 'out' AND status = 'failed' ORDER BY id DESC LIMIT ?")
    .all(Math.min(100, Math.max(1, Number(limit) || 20)));
  const results = [];
  for (const message of failed) {
    try {
      await whatsapp.sendTextMessage(message.doctor_id, message.to_phone, message.body, { appointmentId: message.appointment_id });
      results.push({ id: message.id, ok: true });
    } catch (error) {
      results.push({ id: message.id, ok: false, error: error.message });
    }
  }
  return results;
}

module.exports = {
  verifyWebhook,
  handleWebhook,
  parseDoctorReply,
  doctorIdForPhoneNumberId,
  notifyDoctorOfBooking,
  connectDoctor,
  disconnectDoctor,
  retryFailedMessages,
};
