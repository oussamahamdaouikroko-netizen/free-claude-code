'use strict';
/**
 * DentaRDV v2.0.0 WhatsApp booking conversation engine (independent from Baileys).
 *
 * Features:
 *  - Strict greeting vs. valid full-name registration gate for unregistered callers
 *  - Persistent SQLite `bot_sessions` across restarts
 *  - 2-step interactive cancellation confirmation (`cancel_confirm` -> `OUI`/`نعم`)
 *    with 30-minute re-booking cooldown (`CANCEL_COOLDOWN_MINUTES`)
 *  - Attendance confirmation (`CONFIRMER` / `تأكيد`)
 *  - Post-booking Law 18-07 dental intake (Age + Weight + optional dental symptoms ONLY)
 *  - License validity guard on new bookings
 */

const dbMod = require('../db');
const { CANCEL_COOLDOWN_MINUTES } = require('../config');
const license = require('../services/license');
const intents = require('./intents');
const { message } = require('./messages');
const patients = require('../services/patients');
const appointments = require('../services/appointments');
const holidays = require('../services/holidays');
const intake = require('../services/intake');
const settings = require('../services/settings');
const chat = require('../services/chat');
const { AppError, phoneKey } = require('../utils/common');
const { toISODate } = require('../utils/dates');

const lastLanguage = new Map();
const LANG_TTL_MS = 24 * 60 * 60 * 1000;
const languageSeenAt = new Map();

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
      // Fall back to in-memory map
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
      // Ignore if read-only
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

function checkLicenseReply({ lang, nowMs }) {
  const valid = license.is_license_valid(nowMs !== undefined ? { nowMs } : undefined);
  if (valid) return null;
  return {
    reply: reply(lang, 'serviceSuspended'),
    lang,
    action: 'license_expired',
    callbackAnswered: true,
  };
}

function checkCooldownReply({ patient, phone, lang, nowMs }) {
  const lic = checkLicenseReply({ lang, nowMs });
  if (lic) return lic;
  const effectiveNow = nowMs !== undefined ? nowMs : Date.now();
  const check = appointments.canUserBook({ patientId: patient?.id, phone }, effectiveNow);
  if (check.allowed) return null;
  return {
    reply: reply(lang, 'bookingCooldown', {
      minutes: check.remainingMinutes,
      time: check.unlockTimeLocal,
    }),
    lang,
    action: 'cooldown_blocked',
    remainingMinutes: check.remainingMinutes,
    unlockTimeLocal: check.unlockTimeLocal,
    blockedUntilUtc: check.blockedUntilUtc,
    callbackAnswered: true,
  };
}

function isChooseDayEnabled() {
  return settings.getBool('bot_choose_day_enabled');
}

function checkHolidayPauseReply({ lang }) {
  const hCtx = holidays.getWhatsAppHolidayContext(toISODate());
  if (hCtx && hCtx.activeToday && hCtx.blockAllBookings) {
    return {
      reply: reply(lang, 'doctorOnLeave', {
        holiday: hCtx.holiday,
        resumeDay: hCtx.resumeDay,
      }),
      lang,
      action: 'doctor_on_leave',
      holiday: hCtx.holiday,
      resumeDay: hCtx.resumeDay,
      callbackAnswered: true,
    };
  }
  return null;
}

function buildDayButtons(days = [], hasMore = false, nextOffset = 0, lang = 'fr') {
  const buttons = days.slice(0, 3).map((d, idx) => ({
    id: `day_select:${d.day}`,
    text: `${idx + 1}. ${d.day}`,
  }));
  if (hasMore) {
    buttons.push({
      id: `day_more:${nextOffset}`,
      text: lang === 'ar' ? '🔄 المزيد من الأيام' : '🔄 Plus de dates',
    });
  }
  return buttons;
}

function promptDaySelection({
  phone,
  patientObj,
  name,
  lang,
  offset = 0,
  unavailableNotice = null,
  invalidChoice = false,
  nowMs,
}) {
  const cooldownGuard = checkCooldownReply({ patient: patientObj, phone, lang, nowMs });
  if (cooldownGuard) return cooldownGuard;

  const effectiveExisting = hasRegisteredName(patientObj) ? patientObj : null;
  if (effectiveExisting) {
    const existingUpcoming = appointments.upcomingForPatient(effectiveExisting.id, toISODate());
    if (existingUpcoming && existingUpcoming.status === 'booked') {
      clearPending(phone);
      return {
        reply: reply(lang, 'alreadyBooked', {
          day: existingUpcoming.day,
          queue: existingUpcoming.queue_number,
        }),
        lang,
        action: 'already_booked',
        appointment: existingUpcoming,
      };
    }
  }

  let avail = appointments.listAvailableDays({ offset });
  if (offset > 0 && avail.days.length === 0 && avail.totalAvailable > 0) {
    avail = appointments.listAvailableDays({ offset: 0 });
  }

  const effectiveName = (effectiveExisting ? effectiveExisting.full_name : '') || name || '';

  if (avail.totalAvailable === 0) {
    clearPending(phone);
    const hCtx = holidays.getWhatsAppHolidayContext(toISODate(), 45);
    if (hCtx && hCtx.holiday) {
      return {
        reply: reply(lang, 'doctorOnLeave', {
          holiday: hCtx.holiday,
          resumeDay: hCtx.resumeDay,
        }),
        lang,
        action: 'doctor_on_leave',
        holiday: hCtx.holiday,
        resumeDay: hCtx.resumeDay,
      };
    }
    const person = effectiveExisting
      ? { patient: effectiveExisting }
      : patients.upsertFromWhatsApp({ name: effectiveName, phone });
    appointments.addToWaitingList({
      full_name: person.patient.full_name || effectiveName,
      phone,
      enforceCooldown: true,
      nowMs,
      note: 'Planning complet (WhatsApp)',
    });
    return {
      reply: reply(lang, 'full'),
      lang,
      action: 'waiting_list',
    };
  }

  setPending(phone, {
    step: 'await_day',
    name: effectiveName,
    offset: avail.offset,
    dayChoices: avail.days.map((d) => d.day),
    hasMore: avail.hasMore,
    lang,
  });

  const nextOffset = avail.hasMore ? avail.offset + avail.days.length : 0;
  const buttons = buildDayButtons(avail.days, avail.hasMore, nextOffset, lang);

  if (unavailableNotice) {
    return {
      reply: reply(lang, 'dayUnavailable', {
        ...unavailableNotice,
        days: avail.days,
        hasMore: avail.hasMore,
      }),
      lang,
      action: 'day_unavailable',
      availableDays: avail.days,
      hasMoreDays: avail.hasMore,
      buttons,
      callbackAnswered: true,
    };
  }

  if (invalidChoice) {
    return {
      reply: reply(lang, 'invalidDayChoice', {
        days: avail.days,
        hasMore: avail.hasMore,
      }),
      lang,
      action: 'invalid_day',
      availableDays: avail.days,
      hasMoreDays: avail.hasMore,
      buttons,
      callbackAnswered: true,
    };
  }

  return {
    reply: reply(lang, 'chooseDay', {
      name: effectiveName,
      days: avail.days,
      hasMore: avail.hasMore,
    }),
    lang,
    action: 'choose_day',
    availableDays: avail.days,
    hasMoreDays: avail.hasMore,
    buttons,
    callbackAnswered: true,
  };
}

function startOrFinalizeBooking({ phone, patientObj, name, lang, delivery, nowMs }) {
  if (isChooseDayEnabled()) {
    return promptDaySelection({
      phone,
      patientObj,
      name,
      lang,
      offset: 0,
      nowMs,
    });
  }
  return finalizeBooking({ phone, patientObj, name, lang, delivery, nowMs });
}

function finalizeBooking({ phone, patientObj, name, chosenDay = null, lang, delivery, nowMs }) {
  const cooldownGuard = checkCooldownReply({ patient: patientObj, phone, lang, nowMs });
  if (cooldownGuard) return cooldownGuard;

  const effectiveExisting = hasRegisteredName(patientObj) ? patientObj : null;

  if (effectiveExisting) {
    const existingUpcoming = appointments.upcomingForPatient(effectiveExisting.id, toISODate());
    if (existingUpcoming && existingUpcoming.status === 'booked') {
      return {
        reply: reply(lang, 'alreadyBooked', {
          day: existingUpcoming.day,
          queue: existingUpcoming.queue_number,
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
      day: chosenDay || undefined,
      source: 'whatsapp',
      nowMs,
      notes: person.created ? 'Réservation WhatsApp' : 'Réservation WhatsApp (patient existant)',
    });
  } catch (error) {
    if (
      chosenDay &&
      error instanceof AppError &&
      ['DAY_FULL', 'NOT_WORKING_DAY', 'DOCTOR_ON_LEAVE', 'DATE_IN_PAST'].includes(error.code)
    ) {
      const reasonMap = {
        DAY_FULL: 'full',
        NOT_WORKING_DAY: 'closed',
        DOCTOR_ON_LEAVE: 'holiday',
        DATE_IN_PAST: 'past',
      };
      return promptDaySelection({
        phone,
        patientObj: person.patient,
        name: person.patient.full_name || name,
        lang,
        offset: 0,
        unavailableNotice: { day: chosenDay, reason: reasonMap[error.code] || 'full' },
        nowMs,
      });
    }
    if (error instanceof AppError && error.code === 'BOOKING_COOLDOWN') {
      return {
        reply: reply(lang, 'bookingCooldown', {
          minutes: error.details?.remainingMinutes || 1,
          time: error.details?.unlockTimeLocal || '',
        }),
        lang,
        action: 'cooldown_blocked',
      };
    }
    if (error instanceof AppError && error.code === 'HORIZON_REACHED') {
      const hCtx = holidays.getWhatsAppHolidayContext(toISODate(), 45);
      if (hCtx && hCtx.holiday) {
        return {
          reply: reply(lang, 'doctorOnLeave', {
            holiday: hCtx.holiday,
            resumeDay: hCtx.resumeDay,
          }),
          lang,
          action: 'doctor_on_leave',
          holiday: hCtx.holiday,
          resumeDay: hCtx.resumeDay,
        };
      }
      appointments.addToWaitingList({
        full_name: person.patient.full_name || name,
        phone,
        enforceCooldown: true,
        nowMs,
        note: 'Planning complet (WhatsApp)',
      });
      return {
        reply: reply(lang, 'full'),
        lang,
        action: 'waiting_list',
      };
    }
    if (error instanceof AppError && error.code === 'ALREADY_BOOKED') {
      const existing = appointments.upcomingForPatient(person.patient.id, toISODate());
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

  const doctorName = settings.get('doctor_name') || '';
  const replyText = reply(lang, 'booked', {
    name: person.patient.full_name,
    day: appointment.day,
    queue: appointment.queue_number,
    doctor: doctorName,
  });
  const chatEvent = chat.recordBooked(appointment, {
    body: replyText,
    phone,
    lang,
    delivery,
  });
  if (settings.get('intake_enabled') !== '0') {
    const isChild = intake.detectChildContext(person.patient);
    setPending(phone, {
      step: 'intake_consent',
      patientId: person.patient.id,
      appointmentId: appointment.id,
      isChild,
      lang,
    });
  }
  return {
    reply: replyText,
    lang,
    action: 'booked',
    appointment,
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
    // Fast-path: patient replied directly with their age (e.g. "32", "32 سنة", "24 شهر").
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
  if (/^book_start$/i.test(s)) return { kind: 'book_start', id: 0 };
  const daySel = s.match(/^day_select:(\d{4}-\d{2}-\d{2})$/i);
  if (daySel) return { kind: 'day_select', day: daySel[1] };
  const dayMore = s.match(/^day_more:(\d+)$/i);
  if (dayMore) return { kind: 'day_more', offset: Number.parseInt(dayMore[1], 10) };
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

function handle({ phone, text, callbackData = '', delivery = 'sent', isMedia = false, nowMs }) {
  const patient = patients.findByPhone(phone);
  const registered = hasRegisteredName(patient);

  if (isMedia) {
    const lang = resolveLanguage(phone, settings.get('bot_language'), false);
    rememberLanguage(phone, lang);
    const licMedia = checkLicenseReply({ lang, nowMs });
    if (licMedia) return licMedia;
    if (!registered) {
      setPending(phone, { step: 'await_full_name', lang });
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

  try {
    // 0. Structured button/callback payloads
    if (cbToken) {
      if (cbToken.kind === 'sec_paid' || cbToken.kind === 'pay_confirm') {
        return {
          reply: reply(lang, 'cancelForbidden'),
          lang,
          action: 'forbidden',
          callbackAnswered: true,
        };
      }
      if (cbToken.kind === 'day_more' || cbToken.kind === 'day_select') {
        const holidayPause = checkHolidayPauseReply({ lang });
        if (holidayPause) {
          clearPending(phone);
          return holidayPause;
        }
        const pendingDay = getPending(phone);
        const effName = (registered ? patient.full_name : '') || pendingDay?.name || '';
        if (!effName) {
          setPending(phone, { step: 'await_full_name', lang });
          return {
            reply: reply(lang, 'welcomeAskName'),
            lang,
            action: 'help',
            callbackAnswered: true,
          };
        }
        if (cbToken.kind === 'day_more') {
          return promptDaySelection({
            phone,
            patientObj: patient,
            name: effName,
            lang,
            offset: cbToken.offset,
            nowMs,
          });
        }
        const check = appointments.checkDayAvailability(cbToken.day);
        if (!check.bookable) {
          return promptDaySelection({
            phone,
            patientObj: patient,
            name: effName,
            lang,
            offset: 0,
            unavailableNotice: { day: cbToken.day, reason: check.reason },
            nowMs,
          });
        }
        clearPending(phone);
        return finalizeBooking({
          phone,
          patientObj: patient,
          name: effName,
          chosenDay: cbToken.day,
          lang,
          delivery,
          nowMs,
        });
      }
      if (cbToken.kind === 'book_start') {
        const holidayPause = checkHolidayPauseReply({ lang });
        if (holidayPause) {
          clearPending(phone);
          return holidayPause;
        }
        const cd = checkCooldownReply({ patient, phone, lang, nowMs });
        if (cd) return cd;
        if (!registered) {
          setPending(phone, { step: 'await_full_name', lang });
          return {
            reply: reply(lang, 'welcomeAskName'),
            lang,
            action: 'help',
            callbackAnswered: true,
          };
        }
        return startOrFinalizeBooking({
          phone,
          patientObj: patient,
          name: patient.full_name,
          lang,
          delivery,
          nowMs,
        });
      }
      if (cbToken.kind === 'cancel_ask') {
        const row = dbMod.getDb().prepare('SELECT * FROM appointments WHERE id = ?').get(cbToken.id);
        if (!row || row.status !== 'booked') {
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

    // 1. Explicit commands
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

    // 1b. Active pre-visit intake conversation
    const activePending = getPending(phone);
    if (activePending && String(activePending.step || '').startsWith('intake_')) {
      const intakeReply = handleIntakeState({ phone, text, lang, pending: activePending });
      if (intakeReply) return intakeReply;
    }

    // 1c. Keyword trigger ("fiche", "معلومات", "وزن")
    if (detection.intent === 'intake') {
      if (!registered) {
        setPending(phone, { step: 'await_full_name', lang });
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

    // License guard before new bookings
    const licGuard = checkLicenseReply({ lang, nowMs });
    if (licGuard) return licGuard;

    // Doctor holiday pause guard (when block_all_wa is enabled on an active holiday)
    // Note: explicit `help` still returns clinic info unless it's a booking attempt;
    // greetings, names, `book`, and `dates` immediately inform the patient of the holiday.
    const holidayPause = checkHolidayPauseReply({ lang });
    if (holidayPause && !(detection.intent === 'help' && !detection.isGreeting && !detection.isStopWord)) {
      clearPending(phone);
      return holidayPause;
    }

    // 1d. Active day-selection step (`await_day`): works identically for new & registered patients.
    const pendingDaySession = getPending(phone);
    if (pendingDaySession?.step === 'await_day') {
      const cd = checkCooldownReply({ patient, phone, lang, nowMs });
      if (cd) {
        clearPending(phone);
        return cd;
      }
      const effName = (registered ? patient.full_name : '') || pendingDaySession.name || '';

      if (detection.intent === 'help' && !detection.isStopWord && !detection.isGreeting) {
        clearPending(phone);
        return { reply: reply(lang, 'help'), lang, action: 'help' };
      }

      if (detection.intent === 'dates' || detection.isGreeting) {
        return promptDaySelection({
          phone,
          patientObj: patient,
          name: effName,
          lang,
          offset: 0,
          nowMs,
        });
      }

      const choices = Array.isArray(pendingDaySession.dayChoices) ? pendingDaySession.dayChoices : [];
      const parsedDay = intents.parseDaySelection(text, choices.length, {
        allowSameDay: settings.getBool('allow_same_day_booking'),
      });

      if (parsedDay.type === 'more') {
        const nextOffset = pendingDaySession.hasMore
          ? (Number(pendingDaySession.offset) || 0) + (choices.length || 5)
          : 0;
        return promptDaySelection({
          phone,
          patientObj: patient,
          name: effName,
          lang,
          offset: nextOffset,
          nowMs,
        });
      }

      if (parsedDay.type === 'index' || parsedDay.type === 'date') {
        const requestedDay =
          parsedDay.type === 'index' ? choices[parsedDay.index] : parsedDay.day;
        const check = appointments.checkDayAvailability(requestedDay);
        if (!check.bookable) {
          return promptDaySelection({
            phone,
            patientObj: patient,
            name: effName,
            lang,
            offset: parsedDay.type === 'index' ? 0 : Number(pendingDaySession.offset) || 0,
            unavailableNotice: { day: requestedDay, reason: check.reason },
            nowMs,
          });
        }
        clearPending(phone);
        return finalizeBooking({
          phone,
          patientObj: patient,
          name: effName,
          chosenDay: requestedDay,
          lang,
          delivery,
          nowMs,
        });
      }

      if (parsedDay.type === 'invalid_date') {
        return promptDaySelection({
          phone,
          patientObj: patient,
          name: effName,
          lang,
          offset: Number(pendingDaySession.offset) || 0,
          unavailableNotice: { day: '', reason: 'invalid_date' },
          nowMs,
        });
      }

      if (!registered && detection.intent === 'name' && detection.name) {
        return promptDaySelection({
          phone,
          patientObj: patient,
          name: detection.name,
          lang,
          offset: Number(pendingDaySession.offset) || 0,
          nowMs,
        });
      }

      return promptDaySelection({
        phone,
        patientObj: patient,
        name: effName,
        lang,
        offset: Number(pendingDaySession.offset) || 0,
        invalidChoice: true,
        nowMs,
      });
    }

    // 1e. Direct inquiry for available dates ("الأيام المتاحة" / "JOURS DISPONIBLES").
    if (detection.intent === 'dates') {
      const cd = checkCooldownReply({ patient, phone, lang, nowMs });
      if (cd) return cd;

      if (registered) {
        return promptDaySelection({
          phone,
          patientObj: patient,
          name: patient.full_name,
          lang,
          offset: 0,
          nowMs,
        });
      }

      const avail = appointments.listAvailableDays({ offset: 0 });
      if (avail.totalAvailable === 0) {
        return {
          reply: reply(lang, 'full'),
          lang,
          action: 'full_preview',
        };
      }
      setPending(phone, { step: 'await_full_name', lang });
      return {
        reply: reply(lang, 'availableDaysPreview', { days: avail.days }),
        lang,
        action: 'available_days',
        availableDays: avail.days,
        hasMoreDays: avail.hasMore,
      };
    }

    // 2. Unregistered caller: enforce greeting vs. valid full-name gate
    if (!registered) {
      if (detection.intent === 'book' || detection.isGreeting) {
        const cd = checkCooldownReply({ patient, phone, lang, nowMs });
        if (cd) return cd;
        setPending(phone, { step: 'await_full_name', lang });
        return { reply: reply(lang, 'welcomeAskName'), lang, action: 'help' };
      }

      if (detection.intent === 'help' && !detection.isStopWord) {
        setPending(phone, { step: 'await_full_name', lang });
        return { reply: reply(lang, 'help'), lang, action: 'help' };
      }

      if (detection.intent === 'name') {
        const cd = checkCooldownReply({ patient, phone, lang, nowMs });
        if (cd) return cd;
        clearPending(phone);
        return startOrFinalizeBooking({
          phone,
          patientObj: patient,
          name: detection.name,
          lang,
          delivery,
          nowMs,
        });
      }

      setPending(phone, { step: 'await_full_name', lang });
      return {
        reply: reply(lang, 'invalidName'),
        lang,
        action: 'unsupported',
      };
    }

    // 3. Registered caller
    if (detection.intent === 'help') {
      clearPending(phone);
      return { reply: reply(lang, 'help'), lang, action: 'help' };
    }

    if (detection.intent === 'name' || detection.intent === 'book') {
      const cd = checkCooldownReply({ patient, phone, lang, nowMs });
      if (cd) return cd;
      return startOrFinalizeBooking({
        phone,
        patientObj: patient,
        name: patient.full_name,
        lang,
        delivery,
        nowMs,
      });
    }

    return { reply: reply(lang, 'unsupported'), lang, action: 'unsupported' };
  } catch (error) {
    console.error('[bot] handling failed:', error.message);
    return { reply: reply(lang, 'error'), lang, action: 'error', error: error.message };
  }
}

function reminderText({ name, day, queue, lang = 'fr' }) {
  return message(lang, 'reminder', clinicSettings(), { name, day, queue });
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

function resetMemory() {
  lastLanguage.clear();
  languageSeenAt.clear();
  pendingByPhone.clear();
}

module.exports = {
  handle,
  getPending,
  setPending,
  clearPending,
  resetMemory,
  reminderText,
  forgetLanguage,
  preferredLanguage,
  expirePendingForTest,
  PENDING_TTL_MS,
  AWAIT_NAME_TTL_MS,
};
