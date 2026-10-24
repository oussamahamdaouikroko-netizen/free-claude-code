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
const intake = require('../services/intake');
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
  const isChild =
    intake.detectChildContext(person.patient, department?.specialty || '') ||
    /pédiatr|pediatr|أطفال|اطفال/i.test(`${department?.name_fr || ''} ${department?.name_ar || ''} ${department?.specialty || ''}`);
  setPending(phone, {
    step: 'intake_consent',
    patientId: person.patient.id,
    appointmentId: appointment.id,
    isChild,
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

function promptForIntakeStep(lang, q, isChild, draft) {
  switch (q) {
    case 'child_age':
      return reply(lang, 'intakeAskChildAge');
    case 'weight':
      return reply(lang, 'intakeAskWeight', { isChild });
    case 'height':
      return reply(lang, 'intakeAskHeight', { isChild });
    case 'complaint':
      return reply(lang, 'intakeAskComplaint', { isChild });
    case 'duration':
      return reply(lang, 'intakeAskDuration', { isChild });
    case 'medications':
      return reply(lang, 'intakeAskMedications', { isChild });
    case 'allergies':
      return reply(lang, 'intakeAskAllergies', { isChild });
    case 'chronic':
      return reply(lang, 'intakeAskChronic', { isChild });
    case 'pregnant':
      return reply(lang, 'intakeAskPregnant');
    case 'breastfeeding':
      return reply(lang, 'intakeAskBreastfeeding');
    case 'summary':
      return reply(lang, 'intakeSummary', { draft });
    default:
      return reply(lang, 'intakeAskWeight', { isChild });
  }
}

function advanceIntakeQuestion({ phone, pending, lang, nextQ }) {
  const draft = intake.get(pending.intakeId);
  if (nextQ === 'summary') {
    setPending(phone, { ...pending, step: 'intake_confirm', q: 'summary', retries: 0 });
    return {
      reply: promptForIntakeStep(lang, 'summary', pending.isChild, draft),
      lang,
      action: 'intake_summary',
      intake: draft,
    };
  }
  setPending(phone, { ...pending, step: 'intake_q', q: nextQ, retries: 0 });
  return {
    reply: promptForIntakeStep(lang, nextQ, pending.isChild, draft),
    lang,
    action: `intake_ask_${nextQ}`,
    intake: draft,
  };
}

function handleIntakeState({ phone, text, lang, pending }) {
  if (pending.step === 'intake_consent') {
    const yn = intake.parseYesNo(text);
    if (yn === 'yes') {
      const pRow = patients.get(pending.patientId);
      const draft = intake.create({
        patient_id: pending.patientId,
        appointment_id: pending.appointmentId || null,
        source: 'whatsapp',
        consent: true,
        is_child_intake: pending.isChild ? 1 : 0,
      });
      const firstQ = pending.isChild && !pRow.birth_date ? 'child_age' : 'weight';
      setPending(phone, {
        step: 'intake_q',
        q: firstQ,
        intakeId: draft.id,
        patientId: pending.patientId,
        appointmentId: pending.appointmentId || null,
        isChild: Boolean(pending.isChild),
        retries: 0,
      });
      return {
        reply: promptForIntakeStep(lang, firstQ, Boolean(pending.isChild), draft),
        lang,
        action: 'intake_started',
        intake: draft,
      };
    }
    if (yn === 'no') {
      clearPending(phone);
      return {
        reply: reply(lang, 'intakeDeclined'),
        lang,
        action: 'intake_declined',
      };
    }
    // Anything else (e.g., MON RDV, ANNULER, name) exits consent prompt cleanly.
    clearPending(phone);
    return null;
  }

  if (pending.step === 'intake_confirm') {
    if (intake.isRestartInput(text) || intake.parseYesNo(text) === 'no') {
      const reset = intake.resetAnswers(pending.intakeId);
      setPending(phone, { ...pending, step: 'intake_q', q: 'weight', retries: 0 });
      return {
        reply: promptForIntakeStep(lang, 'weight', pending.isChild, reset),
        lang,
        action: 'intake_restarted',
        intake: reset,
      };
    }
    if (intake.parseYesNo(text) === 'yes') {
      clearPending(phone);
      const completed = intake.get(pending.intakeId);
      return {
        reply: reply(lang, 'intakeCompleted'),
        lang,
        action: 'intake_completed',
        intake: completed,
      };
    }
    const currentDraft = intake.get(pending.intakeId);
    setPending(phone, pending);
    return {
      reply: promptForIntakeStep(lang, 'summary', pending.isChild, currentDraft),
      lang,
      action: 'intake_summary',
      intake: currentDraft,
    };
  }

  if (pending.step !== 'intake_q') return null;

  const skipped = intake.isSkipInput(text);
  const q = pending.q;

  if (q === 'child_age') {
    if (!skipped) {
      const parsed = intake.parseAgeYears(text);
      if (parsed.ok) {
        const childFlag = parsed.value < 15;
        intake.update(pending.intakeId, {
          age_years: parsed.value,
          is_child_intake: childFlag ? 1 : 0,
        });
        pending.isChild = childFlag;
      }
    }
    return advanceIntakeQuestion({ phone, pending, lang, nextQ: 'weight' });
  }

  if (q === 'weight') {
    if (!skipped) {
      const parsed = intake.parseWeightKg(text);
      if (parsed.ok) {
        intake.update(pending.intakeId, { weight_kg: parsed.value });
      } else if ((pending.retries || 0) < 1) {
        setPending(phone, { ...pending, retries: 1 });
        return {
          reply: reply(lang, 'intakeRetryWeight'),
          lang,
          action: 'intake_retry_weight',
        };
      }
    }
    return advanceIntakeQuestion({ phone, pending, lang, nextQ: 'height' });
  }

  if (q === 'height') {
    if (!skipped) {
      const parsed = intake.parseHeightCm(text);
      if (parsed.ok) {
        intake.update(pending.intakeId, { height_cm: parsed.value });
      } else if ((pending.retries || 0) < 1) {
        setPending(phone, { ...pending, retries: 1 });
        return {
          reply: reply(lang, 'intakeRetryHeight'),
          lang,
          action: 'intake_retry_height',
        };
      }
    }
    return advanceIntakeQuestion({ phone, pending, lang, nextQ: 'complaint' });
  }

  if (q === 'complaint') {
    if (!skipped) {
      const pRow = patients.get(pending.patientId);
      const childDetected = pending.isChild || intake.detectChildContext(pRow, text);
      pending.isChild = childDetected;
      intake.update(pending.intakeId, {
        chief_complaint: text,
        is_child_intake: childDetected ? 1 : 0,
      });
    }
    return advanceIntakeQuestion({ phone, pending, lang, nextQ: 'duration' });
  }

  if (q === 'duration') {
    if (!skipped) {
      intake.update(pending.intakeId, { symptom_duration: text });
    }
    return advanceIntakeQuestion({ phone, pending, lang, nextQ: 'medications' });
  }

  if (q === 'medications') {
    if (!skipped) {
      intake.update(pending.intakeId, { current_medications: text });
    }
    return advanceIntakeQuestion({ phone, pending, lang, nextQ: 'allergies' });
  }

  if (q === 'allergies') {
    if (!skipped) {
      intake.update(pending.intakeId, { known_allergies: text });
    }
    return advanceIntakeQuestion({ phone, pending, lang, nextQ: 'chronic' });
  }

  if (q === 'chronic') {
    if (!skipped) {
      intake.update(pending.intakeId, { chronic_conditions: text });
    }
    const pRow = patients.get(pending.patientId);
    const draft = intake.get(pending.intakeId);
    const askPreg = intake.shouldAskPregnancy(pRow, draft.age_years);
    return advanceIntakeQuestion({
      phone,
      pending,
      lang,
      nextQ: askPreg ? 'pregnant' : 'summary',
    });
  }

  if (q === 'pregnant') {
    if (!skipped) {
      const yn = intake.parseYesNo(text);
      if (yn === 'yes') intake.update(pending.intakeId, { is_pregnant: 1 });
      else if (yn === 'no') intake.update(pending.intakeId, { is_pregnant: 0 });
    }
    return advanceIntakeQuestion({ phone, pending, lang, nextQ: 'breastfeeding' });
  }

  if (q === 'breastfeeding') {
    if (!skipped) {
      const yn = intake.parseYesNo(text);
      if (yn === 'yes') intake.update(pending.intakeId, { is_breastfeeding: 1 });
      else if (yn === 'no') intake.update(pending.intakeId, { is_breastfeeding: 0 });
    }
    return advanceIntakeQuestion({ phone, pending, lang, nextQ: 'summary' });
  }

  return null;
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

    if (detection.intent === 'confirm') {
      clearPending(phone);
      if (!patient) return { reply: reply(lang, 'noAppointment'), lang, action: 'no_appointment' };
      const upcoming = appointments.upcomingForPatient(patient.id);
      if (!upcoming || upcoming.status !== 'booked') {
        return { reply: reply(lang, 'noAppointment'), lang, action: 'no_appointment' };
      }
      const confirmed = appointments.confirmAppointment(upcoming.id);
      const replyText =
        lang === 'ar'
          ? `✅ تم تأكيد حضوركم لموعد يوم ${confirmed.day} (الدور رقم ${confirmed.queue_number}). شكرا لكم!`
          : `✅ Votre présence au rendez-vous du ${confirmed.day} (tour n° ${confirmed.queue_number}) est bien confirmée. Merci !`;
      return {
        reply: replyText,
        lang,
        action: 'confirmed',
        appointment: confirmed,
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

    // 1b. Active pre-visit intake conversation (consent / step-by-step / summary).
    const activePending = getPending(phone);
    if (activePending && String(activePending.step || '').startsWith('intake_')) {
      const intakeReply = handleIntakeState({ phone, text, lang, pending: activePending });
      if (intakeReply) return intakeReply;
    }

    // 1c. Keyword trigger ("fiche", "معلومات", "وزن") to start pre-visit intake anytime.
    if (detection.intent === 'intake') {
      if (!patient) {
        return { reply: reply(lang, 'noAppointment'), lang, action: 'no_appointment' };
      }
      const upcoming = appointments.upcomingForPatient(patient.id);
      const isChild = intake.detectChildContext(patient);
      setPending(phone, {
        step: 'intake_consent',
        patientId: patient.id,
        appointmentId: upcoming ? upcoming.id : null,
        isChild,
      });
      return {
        reply: reply(lang, 'intakeInvite'),
        lang,
        action: 'intake_invite',
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

function expirePendingForTest(phone) {
  const key = langKey(phone);
  const entry = pendingByPhone.get(key);
  if (entry) entry.createdAt = Date.now() - PENDING_TTL_MS - 1000;
}

module.exports = {
  handle,
  reminderText,
  forgetLanguage,
  preferredLanguage,
  clearPending,
  expirePendingForTest,
  PENDING_TTL_MS,
};
