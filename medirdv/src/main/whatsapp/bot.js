'use strict';
/**
 * WhatsApp booking conversation engine (independent from Baileys).
 *
 * Supports:
 *  - Strict greeting vs. full-name registration gate for unregistered callers
 *    (with persistent SQLite session state across bot restarts).
 *  - Solo specialist cabinet: 1-step booking (send full name -> booked).
 *  - Multi-department polyclinic (2+ active departments): patient sends full
 *    name -> receives numbered list of departments -> replies with department
 *    number (or name) -> booked into that specific department's queue with
 *    doctor, room, fee, and preparation instructions. Also supports choosing
 *    the department number first, then sending full name.
 */

const dbMod = require('../db');
const { CANCEL_COOLDOWN_MINUTES } = require('../config');
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

/** Fallback in-memory pending state (used only if DB is not open). */
const pendingByPhone = new Map();
const PENDING_TTL_MS = 30 * 60 * 1000;
const AWAIT_NAME_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function langKey(phone) {
  return phoneKey(phone) || String(phone || '');
}

function ttlForStep(step) {
  const s = String(step || '');
  if (s === 'await_full_name' || s === 'await_name') return AWAIT_NAME_TTL_MS;
  return PENDING_TTL_MS;
}

function getPending(phone) {
  const key = langKey(phone);
  if (!key) return null;

  if (dbMod.isOpen()) {
    try {
      const row = dbMod
        .getDb()
        .prepare('SELECT state_json, updated_at FROM bot_sessions WHERE phone_key = ?')
        .get(key);
      if (!row) return null;
      const parsed = JSON.parse(row.state_json);
      const updatedAt = Number(row.updated_at) || 0;
      if (Date.now() - updatedAt > ttlForStep(parsed?.step)) {
        dbMod.getDb().prepare('DELETE FROM bot_sessions WHERE phone_key = ?').run(key);
        return null;
      }
      return { ...parsed, createdAt: updatedAt };
    } catch (_err) {
      // Fall back to in-memory map if bot_sessions is unavailable
    }
  }

  const entry = pendingByPhone.get(key);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > ttlForStep(entry.step)) {
    pendingByPhone.delete(key);
    return null;
  }
  return entry;
}

function setPending(phone, data) {
  const key = langKey(phone);
  if (!key) return;
  const now = Date.now();
  const payload = { ...data };
  delete payload.createdAt;
  pendingByPhone.set(key, { ...payload, createdAt: now });

  if (dbMod.isOpen()) {
    try {
      dbMod
        .getDb()
        .prepare(
          `INSERT INTO bot_sessions (phone_key, state_json, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(phone_key) DO UPDATE SET
             state_json = excluded.state_json,
             updated_at = excluded.updated_at`,
        )
        .run(key, JSON.stringify(payload), now);
    } catch (_err) {
      // Ignore if DB is read-only or pre-migration
    }
  }
}

function clearPending(phone) {
  const key = langKey(phone);
  if (!key) return;
  pendingByPhone.delete(key);
  if (dbMod.isOpen()) {
    try {
      dbMod.getDb().prepare('DELETE FROM bot_sessions WHERE phone_key = ?').run(key);
    } catch (_err) {
      // Ignore
    }
  }
}

function scopedLangKey(phone) {
  const base = langKey(phone);
  if (!base) return '';
  return `${dbMod.getPath() || 'mem'}:${base}`;
}

function rememberLanguage(phone, lang) {
  const key = scopedLangKey(phone);
  if (!key) return;
  lastLanguage.set(key, lang);
  languageSeenAt.set(key, Date.now());
}

function rememberedLanguage(phone) {
  const key = scopedLangKey(phone);
  if (!key) return null;
  const seen = languageSeenAt.get(key);
  if (seen && Date.now() - seen > LANG_TTL_MS) {
    lastLanguage.delete(key);
    languageSeenAt.delete(key);
  } else if (lastLanguage.has(key)) {
    return lastLanguage.get(key) || null;
  }
  const pending = getPending(phone);
  if (pending?.lang === 'ar' || pending?.lang === 'fr') return pending.lang;
  return null;
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
  const scoped = scopedLangKey(phone);
  if (scoped) {
    lastLanguage.delete(scoped);
    languageSeenAt.delete(scoped);
  }
  clearPending(phone);
}

function hasRegisteredName(patient) {
  return Boolean(patient && String(patient.full_name || '').trim().length > 0);
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
      (fr && (norm === fr || (fr.includes(norm) && norm.length >= 4))) ||
      (ar && (norm === ar || (ar.includes(norm) && norm.length >= 4))) ||
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

  const effectiveExisting = hasRegisteredName(patientObj) ? patientObj : null;

  if (effectiveExisting) {
    const existingUpcoming = appointments.upcomingForPatient(effectiveExisting.id, toISODate(), deptId);
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

  const person = effectiveExisting
    ? { patient: effectiveExisting, created: false }
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
    lang,
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

function promptForIntakeStep(lang, q, isChild) {
  switch (q) {
    case 'age':
      return reply(lang, 'intakeAskAge', { isChild });
    case 'weight':
      return reply(lang, 'intakeAskWeight', { isChild });
    case 'complaint':
      return reply(lang, 'intakeAskComplaint', { isChild });
    default:
      return reply(lang, 'intakeAskAge', { isChild });
  }
}

function advanceIntakeQuestion({ phone, pending, lang, nextQ }) {
  const draft = intake.get(pending.intakeId);
  if (nextQ === 'done') {
    clearPending(phone);
    return {
      reply: reply(lang, 'intakeCompleted', { draft }),
      lang,
      action: 'intake_completed',
      intake: draft,
    };
  }
  setPending(phone, { ...pending, step: 'intake_q', q: nextQ, retries: 0, lang });
  return {
    reply: promptForIntakeStep(lang, nextQ, pending.isChild),
    lang,
    action: `intake_ask_${nextQ}`,
    intake: draft,
  };
}

function handleIntakeState({ phone, text, lang, pending }) {
  if (pending.step === 'intake_consent') {
    const yn = intake.parseYesNo(text);
    if (yn === 'yes') {
      const draft = intake.create({
        patient_id: pending.patientId,
        appointment_id: pending.appointmentId || null,
        source: 'whatsapp',
        consent: true,
        is_child_intake: pending.isChild ? 1 : 0,
      });
      setPending(phone, {
        step: 'intake_q',
        q: 'age',
        intakeId: draft.id,
        patientId: pending.patientId,
        appointmentId: pending.appointmentId || null,
        isChild: Boolean(pending.isChild),
        retries: 0,
        lang,
      });
      return {
        reply: promptForIntakeStep(lang, 'age', Boolean(pending.isChild)),
        lang,
        action: 'intake_started',
        intake: draft,
      };
    }
    if (yn === 'no' || intake.isSkipInput(text)) {
      clearPending(phone);
      return {
        reply: reply(lang, 'intakeDeclined'),
        lang,
        action: 'intake_declined',
      };
    }
    // Fast-path: patient replied directly with their age (e.g. "32", "32 سنة", "18 شهر").
    const directAge = intake.parseAgeYears(text);
    if (directAge.ok) {
      const childFlag = Boolean(pending.isChild) || directAge.value < 15;
      const draft = intake.create({
        patient_id: pending.patientId,
        appointment_id: pending.appointmentId || null,
        source: 'whatsapp',
        consent: true,
        age_years: directAge.value,
        is_child_intake: childFlag ? 1 : 0,
      });
      setPending(phone, {
        step: 'intake_q',
        q: 'weight',
        intakeId: draft.id,
        patientId: pending.patientId,
        appointmentId: pending.appointmentId || null,
        isChild: childFlag,
        retries: 0,
        lang,
      });
      return {
        reply: promptForIntakeStep(lang, 'weight', childFlag),
        lang,
        action: 'intake_ask_weight',
        intake: draft,
      };
    }
    // Anything else (e.g., MON RDV, ANNULER, name) exits consent prompt cleanly.
    clearPending(phone);
    return null;
  }

  if (pending.step !== 'intake_q') return null;

  if (intake.isRestartInput(text)) {
    const reset = intake.resetAnswers(pending.intakeId);
    setPending(phone, { ...pending, step: 'intake_q', q: 'age', retries: 0, lang });
    return {
      reply: promptForIntakeStep(lang, 'age', pending.isChild),
      lang,
      action: 'intake_restarted',
      intake: reset,
    };
  }

  const skipped = intake.isSkipInput(text);
  const q = pending.q;

  if (q === 'age') {
    if (!skipped) {
      const parsed = intake.parseAgeYears(text);
      if (parsed.ok) {
        const childFlag = Boolean(pending.isChild) || parsed.value < 15;
        intake.update(pending.intakeId, {
          age_years: parsed.value,
          is_child_intake: childFlag ? 1 : 0,
        });
        pending.isChild = childFlag;
      } else if ((pending.retries || 0) < 1) {
        setPending(phone, { ...pending, retries: 1, lang });
        return {
          reply: reply(lang, 'intakeRetryAge'),
          lang,
          action: 'intake_retry_age',
        };
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
        setPending(phone, { ...pending, retries: 1, lang });
        return {
          reply: reply(lang, 'intakeRetryWeight'),
          lang,
          action: 'intake_retry_weight',
        };
      }
    }
    return advanceIntakeQuestion({ phone, pending, lang, nextQ: 'complaint' });
  }

  if (q === 'complaint') {
    if (!skipped && !intake.isNoneInput(text)) {
      const pRow = patients.get(pending.patientId);
      const childDetected = pending.isChild || intake.detectChildContext(pRow, text);
      pending.isChild = childDetected;
      intake.update(pending.intakeId, {
        chief_complaint: text,
        is_child_intake: childDetected ? 1 : 0,
      });
    }
    return advanceIntakeQuestion({ phone, pending, lang, nextQ: 'done' });
  }

  return null;
}

function keepAwaitingName(phone, pending, lang) {
  if (pending?.step === 'await_name' && pending.departmentId) {
    setPending(phone, { step: 'await_name', departmentId: pending.departmentId, lang });
  } else {
    setPending(phone, { step: 'await_full_name', lang });
  }
}

function buildCancelButtons(appointmentId, lang) {
  return lang === 'ar'
    ? [
        { id: `cancel_yes:${appointmentId}`, text: '✅ نعم، ألغِ الموعد' },
        { id: `cancel_no:${appointmentId}`, text: '❌ لا، احتفظ بالموعد' },
      ]
    : [
        { id: `cancel_yes:${appointmentId}`, text: '✅ Oui, annuler le rendez-vous' },
        { id: `cancel_no:${appointmentId}`, text: '❌ Non, garder le rendez-vous' },
      ];
}

function parseCallbackToken(raw) {
  const s = String(raw ?? '').trim();
  const m = s.match(/^(cancel_ask|cancel_yes|cancel_no|sec_paid|pay_confirm):(\d+)$/i);
  if (!m) return null;
  return { kind: m[1].toLowerCase(), id: Number.parseInt(m[2], 10) };
}

function parseCancelDecision(rawText) {
  const norm = intents
    .normalize(String(rawText ?? '').replace(/[✅❌⚠️•1️⃣2️⃣]/g, ' '))
    .trim();
  if (!norm) return null;
  if (
    norm === 'نعم' ||
    norm === 'اه' ||
    norm === 'ايه' ||
    norm === 'اكيد' ||
    norm === 'oui' ||
    norm === 'yes' ||
    norm === '1' ||
    norm.startsWith('نعم ') ||
    norm.startsWith('oui ') ||
    norm.startsWith('yes ') ||
    norm === 'الغ الموعد' ||
    norm === 'الغي الموعد'
  ) {
    return 'yes';
  }
  if (
    norm === 'لا' ||
    norm === 'لالا' ||
    norm === 'احتفظ بالموعد' ||
    norm === 'احتفظ' ||
    norm === 'non' ||
    norm === 'no' ||
    norm === '2' ||
    norm.startsWith('لا ') ||
    norm.startsWith('non ') ||
    norm.startsWith('no ')
  ) {
    return 'no';
  }
  return null;
}

function promptCancelConfirmation({ phone, patient, appointment, lang }) {
  const dept = departments.getOptional(appointment.department_id);
  setPending(phone, {
    step: 'confirm_cancel',
    appointmentId: appointment.id,
    patientId: patient.id,
    lang,
  });
  return {
    reply: reply(lang, 'cancelConfirm', {
      day: appointment.day,
      slotTime: appointment.slot_time || '',
      queue: appointment.queue_number,
      department: dept ? departments.labelFor(dept, lang) : '',
      cooldownMinutes: CANCEL_COOLDOWN_MINUTES,
    }),
    lang,
    action: 'cancel_confirm',
    appointment,
    buttons: buildCancelButtons(appointment.id, lang),
    callbackAnswered: true,
  };
}

function executeConfirmedCancel({ phone, patient, appointmentId, lang, delivery, nowMs }) {
  const currentPending = getPending(phone);
  if (currentPending?.step === 'confirm_cancel') {
    clearPending(phone);
  }
  const outcome = appointments.cancelByPatient({
    appointmentId,
    patientId: patient?.id || null,
    phone,
    nowMs,
    cooldownMinutes: CANCEL_COOLDOWN_MINUTES,
  });

  if (outcome.status === 'forbidden') {
    return {
      reply: reply(lang, 'cancelForbidden'),
      lang,
      action: 'forbidden',
      callbackAnswered: true,
    };
  }

  if (outcome.status === 'stale') {
    return {
      reply: reply(lang, 'cancelStale'),
      lang,
      action: 'stale_appointment',
      callbackAnswered: true,
    };
  }

  const replyText = reply(lang, 'cancelled', {
    day: outcome.appointment.day,
    rebookTime: outcome.rebookTime,
    cooldownMinutes: outcome.cooldownMinutes,
  });
  const chatEvent = chat.recordCancelled(outcome.appointment, {
    body: replyText,
    phone,
    lang,
    delivery,
  });
  return {
    reply: replyText,
    lang,
    action: 'cancelled',
    appointment: outcome.appointment,
    chatEvent,
    blockedUntilUtc: outcome.blockedUntilUtc,
    rebookTime: outcome.rebookTime,
    callbackAnswered: true,
  };
}

/**
 * @param {{phone: string, text: string, callbackData?: string, delivery?: 'local'|'queued'|'sent', isMedia?: boolean, nowMs?: number}} incoming
 * @returns {{reply: string, lang: 'fr'|'ar', action: string, appointment?: object, chatEvent?: object, buttons?: Array, callbackAnswered?: boolean}}
 */
function handle({ phone, text, callbackData = '', delivery = 'sent', isMedia = false, nowMs = Date.now() }) {
  const patient = patients.findByPhone(phone);
  const registered = hasRegisteredName(patient);

  if (isMedia) {
    const lang = resolveLanguage(phone, settings.get('bot_language'), false);
    rememberLanguage(phone, lang);
    if (!registered) {
      keepAwaitingName(phone, getPending(phone), lang);
      return { reply: reply(lang, 'nonTextAskName'), lang, action: 'unsupported' };
    }
    return { reply: reply(lang, 'unsupported'), lang, action: 'unsupported' };
  }

  const rawInput = String(callbackData || text || '');
  const cbToken = parseCallbackToken(rawInput);
  const detection = intents.detect(text);
  const lang = resolveLanguage(
    phone,
    settings.get('bot_language'),
    detection.isArabic || (registered && /[\u0600-\u06FF]/.test(patient.full_name)),
  );
  rememberLanguage(phone, lang);
  const activeDepts = departments.listActive();
  const isMultiDept = activeDepts.length >= 2;

  try {
    // 0. Structured button/callback payloads carrying explicit appointment IDs.
    if (cbToken) {
      if (cbToken.kind === 'sec_paid' || cbToken.kind === 'pay_confirm') {
        // Patients on WhatsApp never hold secretary/admin payment authority.
        return {
          reply: reply(lang, 'cancelForbidden'),
          lang,
          action: 'forbidden',
          callbackAnswered: true,
        };
      }
      if (cbToken.kind === 'cancel_ask') {
        const row = dbMod.getDb().prepare('SELECT * FROM appointments WHERE id = ?').get(cbToken.id);
        if (!row) {
          return {
            reply: reply(lang, 'cancelStale'),
            lang,
            action: 'stale_appointment',
            callbackAnswered: true,
          };
        }
        if (!patient || Number(row.patient_id) !== Number(patient.id)) {
          return {
            reply: reply(lang, 'cancelForbidden'),
            lang,
            action: 'forbidden',
            callbackAnswered: true,
          };
        }
        if (row.status !== 'booked') {
          return {
            reply: reply(lang, 'cancelStale'),
            lang,
            action: 'stale_appointment',
            callbackAnswered: true,
          };
        }
        return promptCancelConfirmation({
          phone,
          patient,
          appointment: appointments.get(row.id),
          lang,
        });
      }
      if (cbToken.kind === 'cancel_yes') {
        return executeConfirmedCancel({
          phone,
          patient,
          appointmentId: cbToken.id,
          lang,
          delivery,
          nowMs,
        });
      }
      if (cbToken.kind === 'cancel_no') {
        const row = dbMod.getDb().prepare('SELECT * FROM appointments WHERE id = ?').get(cbToken.id);
        if (row && (!patient || Number(row.patient_id) !== Number(patient.id))) {
          return {
            reply: reply(lang, 'cancelForbidden'),
            lang,
            action: 'forbidden',
            callbackAnswered: true,
          };
        }
        const cur = getPending(phone);
        if (cur?.step === 'confirm_cancel') clearPending(phone);
        if (!row || row.status !== 'booked') {
          return {
            reply: reply(lang, 'cancelStale'),
            lang,
            action: 'stale_appointment',
            callbackAnswered: true,
          };
        }
        return {
          reply: reply(lang, 'cancelAborted'),
          lang,
          action: 'cancel_aborted',
          callbackAnswered: true,
        };
      }
    }

    // 0b. Active cancellation confirmation state (yes / no decision).
    const pendingBeforeCmd = getPending(phone);
    if (pendingBeforeCmd?.step === 'confirm_cancel') {
      const decision = parseCancelDecision(text);
      if (decision === 'yes') {
        return executeConfirmedCancel({
          phone,
          patient,
          appointmentId: pendingBeforeCmd.appointmentId,
          lang,
          delivery,
          nowMs,
        });
      }
      if (decision === 'no') {
        clearPending(phone);
        const row = dbMod
          .getDb()
          .prepare('SELECT * FROM appointments WHERE id = ?')
          .get(pendingBeforeCmd.appointmentId);
        if (!row || row.status !== 'booked') {
          return {
            reply: reply(lang, 'cancelStale'),
            lang,
            action: 'stale_appointment',
            callbackAnswered: true,
          };
        }
        return {
          reply: reply(lang, 'cancelAborted'),
          lang,
          action: 'cancel_aborted',
          callbackAnswered: true,
        };
      }
    }

    // 1. Explicit commands always take priority and never save command words as names.
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
      return promptCancelConfirmation({ phone, patient, appointment: upcoming, lang });
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
      if (!registered) {
        keepAwaitingName(phone, getPending(phone), lang);
        return { reply: reply(lang, 'welcomeAskName'), lang, action: 'no_appointment' };
      }
      const upcoming = appointments.upcomingForPatient(patient.id);
      const isChild = intake.detectChildContext(patient);
      setPending(phone, {
        step: 'intake_consent',
        patientId: patient.id,
        appointmentId: upcoming ? upcoming.id : null,
        isChild,
        lang,
      });
      return {
        reply: reply(lang, 'intakeInvite'),
        lang,
        action: 'intake_invite',
      };
    }

    // 2. Caller has NO registered name yet: enforce greeting vs. valid full-name gate.
    if (!registered) {
      const pending = getPending(phone);

      if (isMultiDept) {
        const deptMatch = matchDepartmentInput(text, activeDepts);
        if (pending?.step === 'await_department' && pending.name) {
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

        if (pending?.step !== 'await_name' && deptMatch?.dept) {
          setPending(phone, { step: 'await_name', departmentId: deptMatch.dept.id, lang });
          return {
            reply: reply(lang, 'askNameForDepartment', {
              department: departments.labelFor(deptMatch.dept, lang),
            }),
            lang,
            action: 'ask_name_for_department',
            department: deptMatch.dept,
          };
        }
        if (pending?.step !== 'await_name' && deptMatch?.outOfRange) {
          return {
            reply: reply(lang, 'invalidDepartmentChoice', { departments: activeDepts }),
            lang,
            action: 'invalid_department',
          };
        }
      }

      if (detection.isGreeting) {
        keepAwaitingName(phone, pending, lang);
        return {
          reply: reply(lang, 'welcomeAskName'),
          lang,
          action: 'help',
        };
      }

      if (detection.intent === 'help' && !detection.isStopWord) {
        keepAwaitingName(phone, pending, lang);
        return {
          reply: reply(lang, 'help', { departments: activeDepts }),
          lang,
          action: 'help',
        };
      }

      if (detection.intent === 'name') {
        if (isMultiDept) {
          if (pending?.step === 'await_name') {
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
          setPending(phone, { step: 'await_department', name: detection.name, lang });
          return {
            reply: reply(lang, 'chooseDepartment', {
              name: detection.name,
              departments: activeDepts,
            }),
            lang,
            action: 'choose_department',
          };
        }

        clearPending(phone);
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

      // Neither a greeting nor a valid name -> stay in "awaiting name" state & ask politely.
      keepAwaitingName(phone, pending, lang);
      return {
        reply: reply(lang, 'invalidName'),
        lang,
        action: 'unsupported',
      };
    }

    // 3. Caller ALREADY has a valid registered name: unchanged normal bot behavior.
    if (detection.intent === 'help') {
      clearPending(phone);
      return {
        reply: reply(lang, 'help', { departments: activeDepts }),
        lang,
        action: 'help',
      };
    }

    if (isMultiDept) {
      const pending = getPending(phone);
      const deptMatch = matchDepartmentInput(text, activeDepts);

      if (pending?.step === 'await_department') {
        if (deptMatch?.dept) {
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
        if (deptMatch?.outOfRange) {
          return {
            reply: reply(lang, 'invalidDepartmentChoice', { departments: activeDepts }),
            lang,
            action: 'invalid_department',
          };
        }
      }

      if (deptMatch?.dept) {
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
      if (deptMatch?.outOfRange) {
        return {
          reply: reply(lang, 'invalidDepartmentChoice', { departments: activeDepts }),
          lang,
          action: 'invalid_department',
        };
      }

      if (detection.intent === 'name') {
        setPending(phone, { step: 'await_department', name: patient.full_name, lang });
        return {
          reply: reply(lang, 'chooseDepartment', {
            name: patient.full_name,
            departments: activeDepts,
          }),
          lang,
          action: 'choose_department',
        };
      }
    }

    if (detection.intent === 'name') {
      const singleDept = activeDepts.length === 1 ? activeDepts[0] : null;
      return finalizeBooking({
        phone,
        patientObj: patient,
        name: patient.full_name,
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
  if (!key) return;
  const expiredAt = Date.now() - PENDING_TTL_MS - 1000;
  const entry = pendingByPhone.get(key);
  if (entry) entry.createdAt = expiredAt;
  if (dbMod.isOpen()) {
    try {
      dbMod
        .getDb()
        .prepare('UPDATE bot_sessions SET updated_at = ? WHERE phone_key = ?')
        .run(expiredAt, key);
    } catch (_err) {
      // Ignore
    }
  }
}

module.exports = {
  handle,
  getPending,
  setPending,
  clearPending,
  reminderText,
  forgetLanguage,
  preferredLanguage,
  expirePendingForTest,
  PENDING_TTL_MS,
  AWAIT_NAME_TTL_MS,
};
