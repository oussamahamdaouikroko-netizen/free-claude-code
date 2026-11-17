'use strict';
/**
 * WhatsApp booking conversation engine (independent from Baileys).
 *
 * Supports:
 *  - Solo specialist cabinet: 1-step booking (send full name -> booked).
 *  - Multi-department polyclinic (2+ active departments): patient sends full
 *    name -> receives numbered list of departments -> replies with department
 *    number (or name) -> booked into that specific department's queue with
 *    doctor, room, fee, and preparation instructions. Also supports choosing
 *    the department number first, then sending full name.
 */

const intents = require('./intents');
const { message } = require('./messages');
const patients = require('../services/patients');
const appointments = require('../services/appointments');
const departments = require('../services/departments');
const settings = require('../services/settings');
const chat = require('../services/chat');
const { AppError, phoneKey } = require('../utils/common');
const { toISODate } = require('../utils/dates');

/** Last language used with a phone number (so replies stay consistent). */
const lastLanguage = new Map();
const LANG_TTL_MS = 24 * 60 * 60 * 1000;
const languageSeenAt = new Map();

/** Pending multi-department conversation state per phone (TTL 30 min). */
const pendingByPhone = new Map();
const PENDING_TTL_MS = 30 * 60 * 1000;

function langKey(phone) {
  return phoneKey(phone) || String(phone || '');
}

function getPending(phone) {
  const key = langKey(phone);
  if (!key) return null;
  const entry = pendingByPhone.get(key);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > PENDING_TTL_MS) {
    pendingByPhone.delete(key);
    return null;
  }
  return entry;
}

function setPending(phone, data) {
  const key = langKey(phone);
  if (!key) return;
  pendingByPhone.set(key, { ...data, createdAt: Date.now() });
}

function clearPending(phone) {
  const key = langKey(phone);
  if (key) pendingByPhone.delete(key);
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
  return chat.clinicSettings();
}

function reply(lang, key, vars = {}) {
  return message(lang, key, clinicSettings(), vars);
}

function forgetLanguage(phone) {
  const key = langKey(phone);
  lastLanguage.delete(key);
  languageSeenAt.delete(key);
  pendingByPhone.delete(key);
}

/**
 * Match a WhatsApp reply ("1", "٢", "Cardiologie", "طب العيون") against active departments.
 * Returns `{ dept }` on match, `{ outOfRange: true }` on invalid number, or `null`.
 */
function matchDepartmentInput(rawText, activeDepts) {
  if (!activeDepts || activeDepts.length === 0) return null;
  const norm = intents.normalize(rawText);
  if (!norm) return null;

  if (/^\d{1,2}$/.test(norm)) {
    const idx = Number.parseInt(norm, 10);
    if (idx >= 1 && idx <= activeDepts.length) {
      return { dept: activeDepts[idx - 1] };
    }
    return { outOfRange: true };
  }

  for (const dept of activeDepts) {
    const fr = intents.normalize(dept.name_fr);
    const ar = intents.normalize(dept.name_ar);
    const spec = intents.normalize(dept.specialty);
    if (
      (fr && (norm === fr || fr.includes(norm) && norm.length >= 4)) ||
      (ar && (norm === ar || ar.includes(norm) && norm.length >= 4)) ||
      (spec && norm === spec)
    ) {
      return { dept };
    }
  }
  return null;
}

function finalizeBooking({ phone, patientObj, name, department, lang, delivery }) {
  const deptId = department ? department.id : null;
  const deptLabel = department ? departments.labelFor(department, lang) : '';

  if (patientObj) {
    const existingUpcoming = appointments.upcomingForPatient(patientObj.id, toISODate(), deptId);
    if (existingUpcoming && existingUpcoming.status === 'booked') {
      return {
        reply: reply(lang, 'alreadyBooked', {
          day: existingUpcoming.day,
          queue: existingUpcoming.queue_number,
          department: deptLabel,
        }),
        lang,
        action: 'already_booked',
        appointment: existingUpcoming,
      };
    }
  }

  const person = patientObj
    ? { patient: patientObj, created: false }
    : patients.upsertFromWhatsApp({ name, phone });

  let appointment;
  try {
    appointment = appointments.create({
      patient_id: person.patient.id,
      department_id: deptId,
      source: 'whatsapp',
      notes: department
        ? `Réservation WhatsApp — ${department.name_fr}`
        : person.created
          ? 'Réservation WhatsApp'
          : 'Réservation WhatsApp (patient existant)',
    });
  } catch (error) {
    if (error instanceof AppError && error.code === 'HORIZON_REACHED') {
      appointments.addToWaitingList({
        full_name: person.patient.full_name || name,
        phone,
        note: department
          ? `Planning complet (WhatsApp — ${department.name_fr})`
          : 'Planning complet (WhatsApp)',
      });
      return {
        reply: reply(lang, 'full', { department: deptLabel }),
        lang,
        action: 'waiting_list',
      };
    }
    if (error instanceof AppError && error.code === 'ALREADY_BOOKED') {
      const existing = appointments.upcomingForPatient(person.patient.id, toISODate(), deptId);
      return {
        reply: reply(lang, 'alreadyBooked', {
          day: existing ? existing.day : error.details?.id,
          queue: existing ? existing.queue_number : '-',
          department: deptLabel,
        }),
        lang,
        action: 'already_booked',
        appointment: existing || undefined,
      };
    }
    throw error;
  }

  const doctorName = department?.doctor_name || settings.get('doctor_name') || '';
  const replyText = reply(lang, 'booked', {
    name: person.patient.full_name,
    day: appointment.day,
    queue: appointment.queue_number,
    department: deptLabel,
    doctor: doctorName,
    room: department?.room || '',
    instructions: department?.instructions || '',
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
    department: department || undefined,
    chatEvent,
  };
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
  const activeDepts = departments.listActive();
  const isMultiDept = activeDepts.length >= 2;

  try {
    // 1. Explicit commands always take priority and clear any pending multi-step state.
    if (detection.intent === 'cancel') {
      clearPending(phone);
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

    if (detection.intent === 'my_appointment') {
      clearPending(phone);
      if (!patient) return { reply: reply(lang, 'noAppointment'), lang, action: 'no_appointment' };
      const upcoming = appointments.upcomingForPatient(patient.id);
      if (!upcoming || upcoming.status !== 'booked') {
        return { reply: reply(lang, 'noAppointment'), lang, action: 'no_appointment' };
      }
      const livePos =
        upcoming.day === toISODate()
          ? appointments.queuePosition(upcoming)
          : { ahead: null, etaMinutes: null };
      const dept = departments.getOptional(upcoming.department_id);
      return {
        reply: reply(lang, 'myAppointment', {
          day: upcoming.day,
          queue: upcoming.queue_number,
          department: dept ? departments.labelFor(dept, lang) : '',
          room: dept?.room || '',
          treatment: upcoming.treatment_name || '',
          ahead: livePos.ahead,
          etaMinutes: livePos.etaMinutes,
        }),
        lang,
        action: 'appointment_info',
        appointment: upcoming,
      };
    }

    if (detection.intent === 'help') {
      clearPending(phone);
      return {
        reply: reply(lang, 'help', { departments: activeDepts }),
        lang,
        action: 'help',
      };
    }

    // 2. Multi-department state machine (2+ active departments).
    if (isMultiDept) {
      const pending = getPending(phone);
      const deptMatch = matchDepartmentInput(text, activeDepts);

      if (pending?.step === 'await_department') {
        if (deptMatch?.dept) {
          clearPending(phone);
          return finalizeBooking({
            phone,
            patientObj: patient,
            name: pending.name,
            department: deptMatch.dept,
            lang,
            delivery,
          });
        }
        if (deptMatch?.outOfRange) {
          return {
            reply: reply(lang, 'invalidDepartmentChoice', { departments: activeDepts }),
            lang,
            action: 'invalid_department',
          };
        }
      }

      if (pending?.step === 'await_name' && detection.intent === 'name') {
        const chosenDept =
          activeDepts.find((d) => d.id === pending.departmentId) || activeDepts[0];
        clearPending(phone);
        return finalizeBooking({
          phone,
          patientObj: patient,
          name: detection.name,
          department: chosenDept,
          lang,
          delivery,
        });
      }

      // Patient sent a department number/name first without pending state.
      if (deptMatch?.dept) {
        if (patient) {
          clearPending(phone);
          return finalizeBooking({
            phone,
            patientObj: patient,
            name: patient.full_name,
            department: deptMatch.dept,
            lang,
            delivery,
          });
        }
        setPending(phone, { step: 'await_name', departmentId: deptMatch.dept.id });
        return {
          reply: reply(lang, 'askNameForDepartment', {
            department: departments.labelFor(deptMatch.dept, lang),
          }),
          lang,
          action: 'ask_name_for_department',
          department: deptMatch.dept,
        };
      }
      if (deptMatch?.outOfRange) {
        return {
          reply: reply(lang, 'invalidDepartmentChoice', { departments: activeDepts }),
          lang,
          action: 'invalid_department',
        };
      }

      // Patient sent their full name -> ask them which department they want.
      if (detection.intent === 'name') {
        const candidateName = patient ? patient.full_name : detection.name;
        setPending(phone, { step: 'await_department', name: candidateName });
        return {
          reply: reply(lang, 'chooseDepartment', {
            name: candidateName,
            departments: activeDepts,
          }),
          lang,
          action: 'choose_department',
        };
      }
    }

    // 3. Solo cabinet (0 departments) or single-department cabinet (1 department).
    if (detection.intent === 'name') {
      const singleDept = activeDepts.length === 1 ? activeDepts[0] : null;
      return finalizeBooking({
        phone,
        patientObj: patient,
        name: detection.name,
        department: singleDept,
        lang,
        delivery,
      });
    }

    return { reply: reply(lang, 'unsupported'), lang, action: 'unsupported' };
  } catch (error) {
    console.error('[bot] handling failed:', error.message);
    return { reply: reply(lang, 'error'), lang, action: 'error', error: error.message };
  }
}

/** Text used for the automatic reminder the day before. */
function reminderText({ name, day, queue, department = '', lang = 'fr' }) {
  return message(lang, 'reminder', clinicSettings(), { name, day, queue, department });
}

module.exports = { handle, reminderText, forgetLanguage, preferredLanguage, clearPending };
