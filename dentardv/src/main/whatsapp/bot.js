'use strict';
/**
 * The booking conversation, independent from Baileys.
 *
 * `handle()` receives one incoming text message and returns the text to send
 * back. No network code here, which makes the whole patient flow unit-testable
 * (see tests/bot.test.js).
 */

const intents = require('./intents');
const { message } = require('./messages');
const patients = require('../services/patients');
const appointments = require('../services/appointments');
const settings = require('../services/settings');
const chat = require('../services/chat');
const { AppError, phoneKey } = require('../utils/common');
const { toISODate } = require('../utils/dates');

/** Last language used with a phone number (so replies stay consistent). */
const lastLanguage = new Map();
const LANG_TTL_MS = 24 * 60 * 60 * 1000;
const languageSeenAt = new Map();

function langKey(phone) {
  return phoneKey(phone) || String(phone || '');
}

function rememberLanguage(phone, lang) {
  const key = langKey(phone);
  if (!key) return;
  lastLanguage.set(key, lang);
  languageSeenAt.set(key, Date.now());
}

function rememberedLanguage(phone) {
  const key = langKey(phone);
  if (!key) return null;
  const seen = languageSeenAt.get(key);
  if (seen && Date.now() - seen > LANG_TTL_MS) {
    lastLanguage.delete(key);
    languageSeenAt.delete(key);
    return null;
  }
  return lastLanguage.get(key) || null;
}

function resolveLanguage(phone, detected, isArabic) {
  if (isArabic) return 'ar';
  return rememberedLanguage(phone) || detected || settings.get('bot_language');
}

/** Language used for proactive queue updates to a patient. */
function preferredLanguage(phone, fullName) {
  const known = rememberedLanguage(phone);
  if (known) return known;
  return chat.detectLanguage(fullName);
}

function clinicSettings() {
  return {
    clinic: settings.get('clinic_name'),
    phone: settings.get('clinic_phone'),
    currency: settings.get('currency'),
  };
}

function reply(lang, key, vars = {}) {
  return message(lang, key, clinicSettings(), vars);
}

function forgetLanguage(phone) {
  const key = langKey(phone);
  lastLanguage.delete(key);
  languageSeenAt.delete(key);
}

/**
 * @param {{phone: string, text: string, delivery?: 'local'|'queued'|'sent'}} incoming
 * @returns {{reply: string, lang: 'fr'|'ar', action: string, appointment?: object, chatEvent?: object}}
 */
function handle({ phone, text, delivery = 'sent' }) {
  const detection = intents.detect(text);
  const lang = resolveLanguage(phone, settings.get('bot_language'), detection.isArabic);
  rememberLanguage(phone, lang);
  const patient = patients.findByPhone(phone);

  try {
    switch (detection.intent) {
      case 'cancel': {
        const upcoming = patient ? appointments.upcomingForPatient(patient.id) : null;
        if (!upcoming || upcoming.status !== 'booked') {
          const clearedWaiting = appointments.cancelWaitingByPhone(phone);
          if (clearedWaiting > 0) {
            const today = toISODate();
            const replyText = reply(lang, 'cancelled', { day: today });
            const chatEvent = chat.record({
              kind: 'cancelled',
              direction: 'out',
              patient_id: patient?.id ?? null,
              patient_name: patient?.full_name || phone,
              phone,
              day: today,
              body: replyText,
              delivery,
            });
            return { reply: replyText, lang, action: 'cancelled', chatEvent };
          }
          return { reply: reply(lang, 'nothingToCancel'), lang, action: 'nothing_to_cancel' };
        }
        appointments.cancel(upcoming.id);
        const replyText = reply(lang, 'cancelled', { day: upcoming.day });
        const chatEvent = chat.recordCancelled(upcoming, {
          body: replyText,
          phone,
          lang,
          delivery,
        });
        return {
          reply: replyText,
          lang,
          action: 'cancelled',
          appointment: upcoming,
          chatEvent,
        };
      }

      case 'my_appointment': {
        if (!patient) return { reply: reply(lang, 'noAppointment'), lang, action: 'no_appointment' };
        const upcoming = appointments.upcomingForPatient(patient.id);
        if (!upcoming || upcoming.status !== 'booked') {
          return { reply: reply(lang, 'noAppointment'), lang, action: 'no_appointment' };
        }
        const livePos =
          upcoming.day === toISODate()
            ? appointments.queuePosition(upcoming)
            : { ahead: null, etaMinutes: null };
        return {
          reply: reply(lang, 'myAppointment', {
            day: upcoming.day,
            queue: upcoming.queue_number,
            treatment: upcoming.treatment_name || '',
            ahead: livePos.ahead,
            etaMinutes: livePos.etaMinutes,
          }),
          lang,
          action: 'appointment_info',
          appointment: upcoming,
        };
      }

      case 'help':
        return { reply: reply(lang, 'help'), lang, action: 'help' };

      case 'name': {
        // A known number that already holds an active booked slot is not booked twice.
        if (patient) {
          const upcoming = appointments.upcomingForPatient(patient.id);
          if (upcoming && upcoming.status === 'booked') {
            return {
              reply: reply(lang, 'alreadyBooked', {
                day: upcoming.day,
                queue: upcoming.queue_number,
              }),
              lang,
              action: 'already_booked',
              appointment: upcoming,
            };
          }
        }

        const person = patient
          ? { patient, created: false }
          : patients.upsertFromWhatsApp({ name: detection.name, phone });

        let appointment;
        try {
          appointment = appointments.create({
            patient_id: person.patient.id,
            source: 'whatsapp',
            notes: person.created ? 'Réservation WhatsApp' : 'Réservation WhatsApp (patient existant)',
          });
        } catch (error) {
          if (error instanceof AppError && error.code === 'HORIZON_REACHED') {
            appointments.addToWaitingList({
              full_name: detection.name,
              phone,
              note: 'Planning complet (WhatsApp)',
            });
            return { reply: reply(lang, 'full'), lang, action: 'waiting_list' };
          }
          if (error instanceof AppError && error.code === 'ALREADY_BOOKED') {
            const existing = appointments.upcomingForPatient(person.patient.id);
            return {
              reply: reply(lang, 'alreadyBooked', {
                day: existing ? existing.day : error.details?.id,
                queue: existing ? existing.queue_number : '-',
              }),
              lang,
              action: 'already_booked',
              appointment: existing || undefined,
            };
          }
          throw error;
        }

        const replyText = reply(lang, 'booked', {
          name: person.patient.full_name,
          day: appointment.day,
          queue: appointment.queue_number,
        });
        const chatEvent = chat.recordBooked(appointment, {
          body: replyText,
          phone,
          lang,
          delivery,
        });
        return {
          reply: replyText,
          lang,
          action: 'booked',
          appointment,
          chatEvent,
        };
      }

      default:
        return { reply: reply(lang, 'unsupported'), lang, action: 'unsupported' };
    }
  } catch (error) {
    console.error('[bot] handling failed:', error.message);
    return { reply: reply(lang, 'error'), lang, action: 'error', error: error.message };
  }
}

/** Text used for the automatic reminder the day before. */
function reminderText({ name, day, queue, lang = 'fr' }) {
  return message(lang, 'reminder', clinicSettings(), { name, day, queue });
}

module.exports = { handle, reminderText, forgetLanguage, preferredLanguage };
