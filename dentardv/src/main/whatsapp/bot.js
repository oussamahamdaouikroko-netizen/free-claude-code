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
const { AppError } = require('../utils/common');

/** Last language used with a phone number (so replies stay consistent). */
const lastLanguage = new Map();
const LANG_TTL_MS = 24 * 60 * 60 * 1000;
const languageSeenAt = new Map();

function rememberLanguage(phone, lang) {
  lastLanguage.set(phone, lang);
  languageSeenAt.set(phone, Date.now());
}

function resolveLanguage(phone, detected, isArabic) {
  const seen = languageSeenAt.get(phone);
  if (seen && Date.now() - seen > LANG_TTL_MS) {
    lastLanguage.delete(phone);
    languageSeenAt.delete(phone);
  }
  if (isArabic) return 'ar';
  return lastLanguage.get(phone) || detected || settings.get('bot_language');
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
  lastLanguage.delete(phone);
  languageSeenAt.delete(phone);
}

/**
 * @param {{phone: string, text: string}} incoming
 * @returns {{reply: string, lang: 'fr'|'ar', action: string, appointment?: object}}
 */
function handle({ phone, text }) {
  const detection = intents.detect(text);
  const lang = resolveLanguage(phone, settings.get('bot_language'), detection.isArabic);
  rememberLanguage(phone, lang);
  const patient = patients.findByPhone(phone);

  try {
    switch (detection.intent) {
      case 'cancel': {
        if (!patient) return { reply: reply(lang, 'nothingToCancel'), lang, action: 'nothing_to_cancel' };
        const upcoming = appointments.upcomingForPatient(patient.id);
        if (!upcoming) return { reply: reply(lang, 'nothingToCancel'), lang, action: 'nothing_to_cancel' };
        appointments.cancel(upcoming.id);
        return {
          reply: reply(lang, 'cancelled', { day: upcoming.day }),
          lang,
          action: 'cancelled',
          appointment: upcoming,
        };
      }

      case 'my_appointment': {
        if (!patient) return { reply: reply(lang, 'noAppointment'), lang, action: 'no_appointment' };
        const upcoming = appointments.upcomingForPatient(patient.id);
        if (!upcoming) return { reply: reply(lang, 'noAppointment'), lang, action: 'no_appointment' };
        return {
          reply: reply(lang, 'myAppointment', {
            day: upcoming.day,
            queue: upcoming.queue_number,
            treatment: upcoming.treatment_name || '',
          }),
          lang,
          action: 'appointment_info',
          appointment: upcoming,
        };
      }

      case 'help':
        return { reply: reply(lang, 'help'), lang, action: 'help' };

      case 'name': {
        // A known number that already holds a slot is not booked twice.
        if (patient) {
          const upcoming = appointments.upcomingForPatient(patient.id);
          if (upcoming) {
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

        return {
          reply: reply(lang, 'booked', {
            name: person.patient.full_name,
            day: appointment.day,
            queue: appointment.queue_number,
          }),
          lang,
          action: 'booked',
          appointment,
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

module.exports = { handle, reminderText, forgetLanguage };
