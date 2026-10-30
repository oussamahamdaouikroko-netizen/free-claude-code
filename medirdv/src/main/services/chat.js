'use strict';
/**
 * Appointment & queue chat feed service (`chat_events`).
 *
 * Powers the live Mini Chat window in the dashboard:
 *  - booking confirmations (`booked`),
 *  - cancellations (`cancelled`),
 *  - "it's your turn now" calls (`turn_now`),
 *  - waiting-room alerts with remaining count + estimated wait (`queue_ahead`).
 */

const { getDb } = require('../db');
const settings = require('./settings');
const holidays = require('./holidays');
const { message } = require('../whatsapp/messages');
const { cleanText, nowLocal } = require('../utils/common');
const { toISODate } = require('../utils/dates');

const VALID_KINDS = new Set(['booked', 'cancelled', 'turn_now', 'queue_ahead', 'incoming']);
const VALID_DELIVERY = new Set(['local', 'queued', 'sent', 'failed']);

function clinicSettings(departmentId = null) {
  return {
    clinic: settings.get('clinic_name'),
    phone: settings.get('clinic_phone'),
    address: settings.get('clinic_address'),
    doctor: settings.get('doctor_name'),
    specialty: settings.get('doctor_specialty'),
    currency: settings.get('currency'),
    darija: settings.getBool('bot_darija_mode'),
    is24h: settings.is24hClinic(),
    schedule: settings.getWorkSchedule(),
    scheduleTextFr: settings.formatScheduleSummary('fr'),
    scheduleTextAr: settings.formatScheduleSummary('ar'),
    scheduleTextEn: settings.formatScheduleSummary('en'),
    breakTextFr: settings.formatBreakSummary('fr'),
    breakTextAr: settings.formatBreakSummary('ar'),
    breakTextEn: settings.formatBreakSummary('en'),
    holidayCtx: holidays.getWhatsAppHolidayContext(toISODate(), departmentId, 14),
  };
}

function detectLanguage(name, explicitLang) {
  if (explicitLang === 'ar' || explicitLang === 'fr' || explicitLang === 'en') return explicitLang;
  if (/[\u0600-\u06FF]/.test(String(name || ''))) return 'ar';
  const uiLang = settings.get('language');
  const botLang = settings.get('bot_language');
  if (botLang === 'ar' || botLang === 'en') return botLang;
  if (uiLang === 'ar' || uiLang === 'en') return uiLang;
  return 'fr';
}

function getById(id) {
  return getDb().prepare('SELECT * FROM chat_events WHERE id = ?').get(id) || null;
}

/**
 * Record an appointment/queue message in the feed.
 * @param {{
 *   kind: 'booked'|'cancelled'|'turn_now'|'queue_ahead'|'incoming',
 *   direction?: 'in'|'out',
 *   patient_id?: number|null,
 *   appointment_id?: number|null,
 *   patient_name?: string|null,
 *   phone?: string|null,
 *   day?: string|null,
 *   queue_number?: number|null,
 *   ahead_count?: number|null,
 *   eta_minutes?: number|null,
 *   body: string,
 *   delivery?: 'local'|'queued'|'sent'|'failed',
 *   read?: boolean,
 * }} input
 */
function record(input = {}) {
  const kind = VALID_KINDS.has(input.kind) ? input.kind : 'booked';
  const direction = input.direction === 'in' ? 'in' : 'out';
  const delivery = VALID_DELIVERY.has(input.delivery) ? input.delivery : 'local';
  const now = nowLocal();

  const info = getDb()
    .prepare(
      `INSERT INTO chat_events
        (kind, direction, patient_id, appointment_id, patient_name, phone, day,
         queue_number, ahead_count, eta_minutes, body, delivery, read_at, created_at)
       VALUES
        (@kind, @direction, @patient_id, @appointment_id, @patient_name, @phone, @day,
         @queue_number, @ahead_count, @eta_minutes, @body, @delivery, @read_at, @created_at)`,
    )
    .run({
      kind,
      direction,
      patient_id: input.patient_id ?? null,
      appointment_id: input.appointment_id ?? null,
      patient_name: cleanText(input.patient_name, 100) || null,
      phone: cleanText(input.phone, 40) || null,
      day: input.day ? String(input.day).slice(0, 10) : null,
      queue_number:
        input.queue_number === undefined || input.queue_number === null
          ? null
          : Number(input.queue_number),
      ahead_count:
        input.ahead_count === undefined || input.ahead_count === null
          ? null
          : Number(input.ahead_count),
      eta_minutes:
        input.eta_minutes === undefined || input.eta_minutes === null
          ? null
          : Number(input.eta_minutes),
      body: String(input.body ?? '').slice(0, 2000),
      delivery,
      read_at: input.read ? now : null,
      created_at: input.created_at || now,
    });

  return getById(info.lastInsertRowid);
}

/** Record a booking confirmation card (WhatsApp or desk). */
function recordBooked(appointment, options = {}) {
  if (!appointment) return null;
  const lang = detectLanguage(appointment.full_name, options.lang);
  const deptLabel =
    lang === 'ar'
      ? (appointment.dept_name_ar || appointment.dept_name_fr || appointment.department_name || '')
      : (appointment.dept_name_fr || appointment.department_name || appointment.dept_name_ar || '');
  const body =
    options.body ||
    message(lang, 'booked', clinicSettings(), {
      name: appointment.full_name || '',
      day: appointment.day,
      queue: appointment.queue_number,
      department: deptLabel,
      doctor: appointment.dept_doctor_name || settings.get('doctor_name') || '',
      room: appointment.dept_room || '',
      instructions: appointment.dept_instructions || '',
    });
  return record({
    kind: 'booked',
    direction: 'out',
    patient_id: appointment.patient_id ?? null,
    appointment_id: appointment.id ?? null,
    patient_name: appointment.full_name || null,
    phone: options.phone || appointment.phone || null,
    day: appointment.day,
    queue_number: appointment.queue_number,
    body,
    delivery: options.delivery || 'local',
    read: Boolean(options.read),
  });
}

/** Record a cancellation card (WhatsApp or desk). */
function recordCancelled(appointment, options = {}) {
  if (!appointment) return null;
  const lang = detectLanguage(appointment.full_name, options.lang);
  const body =
    options.body ||
    message(lang, 'cancelled', clinicSettings(), {
      day: appointment.day,
    });
  return record({
    kind: 'cancelled',
    direction: 'out',
    patient_id: appointment.patient_id ?? null,
    appointment_id: appointment.id ?? null,
    patient_name: appointment.full_name || null,
    phone: options.phone || appointment.phone || null,
    day: appointment.day,
    queue_number: appointment.queue_number,
    body,
    delivery: options.delivery || 'local',
    read: Boolean(options.read),
  });
}

/** Update delivery status after WhatsApp transmission finishes. */
function setDelivery(id, delivery) {
  if (!id || !VALID_DELIVERY.has(delivery)) return;
  getDb().prepare('UPDATE chat_events SET delivery = ? WHERE id = ?').run(delivery, id);
}

/**
 * Return the feed for the Mini Chat window (chronological order, newest last).
 * @param {{ kind?: 'all'|'booked'|'cancelled'|'queue', limit?: number }} [filter]
 */
function feed(filter = {}) {
  const db = getDb();
  const limit = Math.min(Math.max(Number(filter.limit) || 60, 1), 200);
  const kind = filter.kind || 'all';

  let where = '';
  const params = [];
  if (kind === 'booked' || kind === 'cancelled') {
    where = 'WHERE kind = ?';
    params.push(kind);
  } else if (kind === 'queue') {
    where = "WHERE kind IN ('turn_now', 'queue_ahead')";
  }

  const latestRows = db
    .prepare(`SELECT * FROM chat_events ${where} ORDER BY id DESC LIMIT ?`)
    .all(...params, limit);
  const items = latestRows.reverse();

  const unread = db
    .prepare('SELECT COUNT(*) AS n FROM chat_events WHERE read_at IS NULL')
    .get().n;
  const latest = db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM chat_events').get().id;
  const today = toISODate();
  const counts = db
    .prepare(
      `SELECT
        SUM(CASE WHEN kind = 'booked' THEN 1 ELSE 0 END) AS booked,
        SUM(CASE WHEN kind = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
        SUM(CASE WHEN kind IN ('turn_now', 'queue_ahead') THEN 1 ELSE 0 END) AS queue
       FROM chat_events WHERE substr(created_at, 1, 10) = ?`,
    )
    .get(today);

  return {
    items,
    unread: unread || 0,
    latest_id: latest || 0,
    today_counts: {
      booked: counts?.booked || 0,
      cancelled: counts?.cancelled || 0,
      queue: counts?.queue || 0,
    },
  };
}

function markAllRead() {
  getDb()
    .prepare('UPDATE chat_events SET read_at = ? WHERE read_at IS NULL')
    .run(nowLocal());
  return { ok: true, unread: 0 };
}

module.exports = {
  record,
  recordBooked,
  recordCancelled,
  setDelivery,
  feed,
  markAllRead,
  detectLanguage,
  clinicSettings,
};
