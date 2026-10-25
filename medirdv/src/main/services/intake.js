'use strict';
/**
 * Phase 1 — Patient Pre-Visit Intake Service (Law 18-07 compliant).
 *
 * Crucial safety rule:
 *   Patient-reported data is UNVERIFIED (`status = 'pending'`). It is NEVER
 *   written into the verified medical record (`patients.allergies`,
 *   `patients.chronic_conditions`, `patient_weight_history`, or prescriptions)
 *   until a physician explicitly calls `confirmAndApply()`.
 */

const { getDb } = require('../db');
const patients = require('./patients');
const { AppError, cleanText, nowLocal, requireId } = require('../utils/common');
const { toISODate } = require('../utils/dates');

const SOURCES = new Set(['whatsapp', 'manual']);
const STATUSES = new Set(['pending', 'reviewed', 'applied', 'rejected']);

const SKIP_TOKENS = new Set([
  '0', '-', 'skip', 'passer', 'passe', 'suivant', 'next',
  'تخطي', 'تجاوز', 'عدي', 'فوت', 'التالي',
]);

const NONE_TOKENS = new Set([
  'non', 'no', 'aucun', 'aucune', 'rien', 'nada', 'walou', 'makanch',
  'لا', 'لا يوجد', 'ماكانش', 'مكانش', 'والو', 'لا شيء', 'لاشيء', 'بدون',
]);

const YES_TOKENS = new Set([
  'oui', 'yes', 'ok', 'daccord', 'd accord', 'si', 'ouais', 'confirmer', 'valider', 'wah', 'ih',
  'نعم', 'موافق', 'موافقة', 'اكيد', 'أكيد', 'واه', 'ايه', 'إيه', 'صح', 'تمام', 'نقبل',
]);

const NO_TOKENS = new Set([
  'non', 'no', 'pas maintenant', 'annuler fiche', 'refuser', 'lala',
  'لا', 'لالا', 'لا لا', 'غير موافق', 'ارفض', 'أرفض', 'لاحقا', 'مبعد',
]);

const RESTART_TOKENS = new Set([
  'corriger', 'modifier', 'recommencer', 'refaire',
  'تصحيح', 'تعديل', 'اعادة', 'إعادة', 'عاود',
]);

const CHILD_CUES = /\b(mon enfant|mon fils|ma fille|mon bebe|mon bébé|enfant|pédiatrie|pediatrie)\b|(ابني|إبني|ولدي|بنتي|طفلي|طفلتي|رضيع|للطفل|لولدي|لبنتي)/iu;
const CKD_CUES = /\b(rein|reins|renal|renale|rénal|rénale|irc|insuffisance renale|insuffisance rénale|dialyse|nephro|néphro)\b|(كلى|كلوي|كلوية|قصور كلوي|فشل كلوي|تصفية الدم|دياليز)/iu;

/** Convert Eastern Arabic / Persian numerals and decimal separators to ASCII. */
function normalizeDigits(raw) {
  return String(raw ?? '')
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/٫/g, '.')
    .replace(/,/g, '.')
    .trim();
}

function normalizeToken(raw) {
  return normalizeDigits(raw)
    .normalize('NFKC')
    .replace(/[\u0610-\u061A\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isSkipInput(raw) {
  const tok = normalizeToken(raw);
  return SKIP_TOKENS.has(tok);
}

function isNoneInput(raw) {
  const tok = normalizeToken(raw);
  return NONE_TOKENS.has(tok);
}

function isRestartInput(raw) {
  const tok = normalizeToken(raw);
  return RESTART_TOKENS.has(tok);
}

function parseYesNo(raw) {
  const tok = normalizeToken(raw);
  if (!tok) return null;
  if (YES_TOKENS.has(tok)) return 'yes';
  if (NO_TOKENS.has(tok)) return 'no';
  return null;
}

/**
 * Parse patient-reported weight in kg.
 * Accepts "72", "72kg", "72,5", "٧٢", "٧٢٫٥", "72 كغ", "8.4 kg".
 * Range: 0.3 .. 400 kg.
 */
function parseWeightKg(raw) {
  const ascii = normalizeDigits(raw).toLowerCase();
  if (!ascii) return { ok: false, code: 'INVALID_WEIGHT' };
  const cleaned = ascii
    .replace(/\s*(kilogrammes?|kilogramme|kilos?|kgs?|kg)\s*$/g, '')
    .replace(/\s*(كيلوغرام|كيلو|كلغ|كجم|كغ)\s*$/g, '')
    .trim();
  if (!/^\d{1,3}(?:\.\d{1,2})?$/.test(cleaned)) {
    return { ok: false, code: 'INVALID_WEIGHT' };
  }
  const value = Math.round(Number.parseFloat(cleaned) * 100) / 100;
  if (!Number.isFinite(value) || value < 0.3 || value > 400) {
    return { ok: false, code: 'WEIGHT_OUT_OF_RANGE' };
  }
  return { ok: true, value };
}

/**
 * Parse patient-reported height in cm.
 * Accepts "170", "170 cm", "١٧٠ سم", or meters like "1.70 m" / "1,72m".
 * Range: 30 .. 250 cm.
 */
function parseHeightCm(raw) {
  const ascii = normalizeDigits(raw).toLowerCase();
  if (!ascii) return { ok: false, code: 'INVALID_HEIGHT' };
  const isMeters = /\s*(metres?|mètres?|m)\s*$/.test(ascii) && !/(cm|سم)\s*$/.test(ascii) || /(متر)\s*$/.test(ascii) && !/سنتيمتر/.test(ascii);
  const cleaned = ascii
    .replace(/\s*(centimetres?|centimètres?|cms?|cm|metres?|mètres?|m)\s*$/g, '')
    .replace(/\s*(سنتيمتر|سم|متر)\s*$/g, '')
    .trim();
  if (!/^\d{1,3}(?:\.\d{1,2})?$/.test(cleaned)) {
    return { ok: false, code: 'INVALID_HEIGHT' };
  }
  let num = Number.parseFloat(cleaned);
  if (isMeters || (num >= 0.4 && num <= 2.5)) {
    num *= 100;
  }
  const value = Math.round(num * 10) / 10;
  if (!Number.isFinite(value) || value < 30 || value > 250) {
    return { ok: false, code: 'HEIGHT_OUT_OF_RANGE' };
  }
  return { ok: true, value };
}

/** Parse patient/child reported age in years (accepts years or months like "32", "32 سنة", "18 mois", "18 شهر"). */
function parseAgeYears(raw) {
  const ascii = normalizeDigits(raw).toLowerCase();
  if (!ascii) return { ok: false, code: 'INVALID_AGE' };
  const isMonths = /(?:^|\s|\d)(mois|months?|شهر|أشهر|اشهر|شهور)\s*$/.test(ascii);
  const cleaned = ascii
    .replace(/\s*(ans?|annees?|années?|years?|yrs?|mois|months?)\s*$/g, '')
    .replace(/\s*(سنة|سنه|سنوات|سنين|عام|عاما|أعوام|اعوام|شهر|أشهر|اشهر|شهور)\s*$/g, '')
    .trim();
  if (!/^\d{1,3}(?:\.\d{1,2})?$/.test(cleaned)) {
    return { ok: false, code: 'INVALID_AGE' };
  }
  let years = Number.parseFloat(cleaned);
  if (isMonths) years = Math.round((years / 12) * 100) / 100;
  if (!Number.isFinite(years) || years <= 0 || years > 130) {
    return { ok: false, code: 'INVALID_AGE' };
  }
  return { ok: true, value: years };
}

/** Derive verified age in years from `patients.birth_date` (trusted over reported age). */
function deriveAgeFromBirthDate(birthDate, refIso = toISODate()) {
  const raw = String(birthDate || '').trim();
  if (!raw) return null;
  const full = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const ref = String(refIso).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (full && ref) {
    let age = Number(ref[1]) - Number(full[1]);
    const mDiff = Number(ref[2]) - Number(full[2]);
    if (mDiff < 0 || (mDiff === 0 && Number(ref[3]) < Number(full[3]))) age -= 1;
    return age >= 0 && age <= 130 ? age : null;
  }
  const yearOnly = raw.match(/^(\d{4})$/);
  if (yearOnly && ref) {
    const age = Number(ref[1]) - Number(yearOnly[1]);
    return age >= 0 && age <= 130 ? age : null;
  }
  return null;
}

/** Pregnancy / breastfeeding is asked ONLY when gender === 'f' and age 12..55. */
function shouldAskPregnancy(patient, reportedAgeYears = null) {
  if (!patient || patient.gender !== 'f') return false;
  const derived = deriveAgeFromBirthDate(patient.birth_date);
  const age = derived !== null ? derived : reportedAgeYears;
  if (age === null || age === undefined) return true; // female of unknown age -> safe to ask
  return age >= 12 && age <= 55;
}

function detectChildContext(patient, text = '', reportedAgeYears = null) {
  const derived = deriveAgeFromBirthDate(patient?.birth_date);
  const age = derived !== null ? derived : reportedAgeYears;
  if (age !== null && age !== undefined && age < 15) return true;
  if (CHILD_CUES.test(String(text || ''))) return true;
  return false;
}

function computeBmi(weightKg, heightCm) {
  const w = Number(weightKg);
  const h = Number(heightCm);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h < 30) return null;
  const meters = h / 100;
  return Math.round((w / (meters * meters)) * 10) / 10;
}

/** Merge two clinical text lists (e.g. allergies or chronic conditions) without losing existing items. */
function mergeClinicalList(existingText, incomingText) {
  const splitItems = (str) =>
    String(str || '')
      .split(/[,;·\n/]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  const current = splitItems(existingText);
  const seen = new Set(current.map((s) => normalizeToken(s)));
  for (const item of splitItems(incomingText)) {
    const key = normalizeToken(item);
    if (key && !NONE_TOKENS.has(key) && !seen.has(key)) {
      seen.add(key);
      current.push(item);
    }
  }
  return current.join(', ').slice(0, 500);
}

/** Hydrate an intake row with derived age (birth_date wins!), BMI, unverified flag & red alerts. */
function hydrate(row, patientRow = null) {
  if (!row) return null;
  const patient =
    patientRow ||
    (row.patient_id
      ? getDb().prepare('SELECT * FROM patients WHERE id = ?').get(row.patient_id)
      : null);

  const birthDerivedAge = deriveAgeFromBirthDate(patient?.birth_date);
  const effectiveAgeYears = birthDerivedAge !== null ? birthDerivedAge : row.age_years;
  const bmi = computeBmi(row.weight_kg, row.height_cm);

  const alerts = [];
  if (row.known_allergies && !isNoneInput(row.known_allergies)) {
    alerts.push({ code: 'REPORTED_ALLERGY', detail: row.known_allergies });
  }
  if (row.is_pregnant === 1) {
    alerts.push({ code: 'PREGNANCY', detail: '' });
  }
  if (row.is_breastfeeding === 1) {
    alerts.push({ code: 'BREASTFEEDING', detail: '' });
  }
  if (row.weight_kg !== null && row.weight_kg !== undefined && Number(row.weight_kg) < 15) {
    alerts.push({ code: 'CHILD_UNDER_15KG', detail: `${row.weight_kg} kg` });
  }
  if (row.chronic_conditions && CKD_CUES.test(row.chronic_conditions)) {
    alerts.push({ code: 'CHRONIC_KIDNEY_DISEASE', detail: row.chronic_conditions });
  }

  return {
    ...row,
    bmi,
    derived_age_years: birthDerivedAge,
    effective_age_years: effectiveAgeYears,
    age_from_birth_date: birthDerivedAge !== null,
    unverified: row.status !== 'applied',
    alerts,
  };
}

function validatePatch(patch = {}) {
  const out = {};
  if (patch.weight_kg !== undefined) {
    if (patch.weight_kg === null || patch.weight_kg === '') {
      out.weight_kg = null;
    } else {
      const parsed =
        typeof patch.weight_kg === 'number'
          ? parseWeightKg(String(patch.weight_kg))
          : parseWeightKg(patch.weight_kg);
      if (!parsed.ok) throw new AppError(parsed.code);
      out.weight_kg = parsed.value;
    }
  }
  if (patch.height_cm !== undefined) {
    if (patch.height_cm === null || patch.height_cm === '') {
      out.height_cm = null;
    } else {
      const parsed =
        typeof patch.height_cm === 'number'
          ? parseHeightCm(String(patch.height_cm))
          : parseHeightCm(patch.height_cm);
      if (!parsed.ok) throw new AppError(parsed.code);
      out.height_cm = parsed.value;
    }
  }
  if (patch.age_years !== undefined) {
    if (patch.age_years === null || patch.age_years === '') {
      out.age_years = null;
    } else {
      const n = Number(patch.age_years);
      if (!Number.isFinite(n) || n < 0 || n > 130) throw new AppError('INVALID_AGE');
      out.age_years = Math.round(n * 100) / 100;
    }
  }
  if (patch.is_child_intake !== undefined) {
    out.is_child_intake = patch.is_child_intake ? 1 : 0;
  }
  if (patch.chief_complaint !== undefined) {
    out.chief_complaint = cleanText(patch.chief_complaint, 500);
  }
  if (patch.symptom_duration !== undefined) {
    out.symptom_duration = cleanText(patch.symptom_duration, 160);
  }
  if (patch.current_medications !== undefined) {
    out.current_medications = isNoneInput(patch.current_medications)
      ? ''
      : cleanText(patch.current_medications, 500);
  }
  if (patch.known_allergies !== undefined) {
    out.known_allergies = isNoneInput(patch.known_allergies)
      ? ''
      : cleanText(patch.known_allergies, 400);
  }
  if (patch.chronic_conditions !== undefined) {
    out.chronic_conditions = isNoneInput(patch.chronic_conditions)
      ? ''
      : cleanText(patch.chronic_conditions, 400);
  }
  for (const tri of ['is_pregnant', 'is_breastfeeding', 'smoker']) {
    if (patch[tri] !== undefined) {
      if (patch[tri] === null || patch[tri] === '') out[tri] = null;
      else out[tri] = Number(patch[tri]) ? 1 : 0;
    }
  }
  if (patch.last_blood_pressure !== undefined) {
    out.last_blood_pressure = cleanText(patch.last_blood_pressure, 40);
  }
  if (patch.last_glycemia !== undefined) {
    out.last_glycemia = cleanText(patch.last_glycemia, 40);
  }
  if (patch.status !== undefined) {
    if (!STATUSES.has(patch.status)) throw new AppError('INVALID_STATUS');
    out.status = patch.status;
  }
  return out;
}

/**
 * Create an intake row ONLY after explicit Law 18-07 consent has been given.
 * Throws `INTAKE_CONSENT_REQUIRED` if `consent` / `consent_at` is missing.
 */
function create(input = {}) {
  const patientId = requireId(input.patient_id, 'patient_id');
  const patient = patients.get(patientId);

  const hasConsent = Boolean(input.consent === true || input.consent === 1 || input.consent_at);
  if (!hasConsent) throw new AppError('INTAKE_CONSENT_REQUIRED');

  const source = SOURCES.has(input.source) ? input.source : 'whatsapp';
  const appointmentId = input.appointment_id ? requireId(input.appointment_id, 'appointment_id') : null;
  const consentAt = cleanText(input.consent_at, 30) || nowLocal();
  const fields = validatePatch(input);
  const derivedAge = deriveAgeFromBirthDate(patient.birth_date);
  const ageYears = derivedAge !== null ? derivedAge : (fields.age_years ?? null);
  const isChild =
    fields.is_child_intake !== undefined
      ? fields.is_child_intake
      : detectChildContext(patient, fields.chief_complaint, ageYears) ? 1 : 0;

  const now = nowLocal();
  const info = getDb()
    .prepare(
      `INSERT INTO patient_intake
        (patient_id, appointment_id, created_at, updated_at, source,
         weight_kg, height_cm, age_years, is_child_intake,
         chief_complaint, symptom_duration, current_medications,
         known_allergies, chronic_conditions,
         is_pregnant, is_breastfeeding, smoker,
         last_blood_pressure, last_glycemia,
         consent_at, status)
       VALUES
        (@patient_id, @appointment_id, @now, @now, @source,
         @weight_kg, @height_cm, @age_years, @is_child_intake,
         @chief_complaint, @symptom_duration, @current_medications,
         @known_allergies, @chronic_conditions,
         @is_pregnant, @is_breastfeeding, @smoker,
         @last_blood_pressure, @last_glycemia,
         @consent_at, 'pending')`,
    )
    .run({
      patient_id: patientId,
      appointment_id: appointmentId,
      now,
      source,
      weight_kg: fields.weight_kg ?? null,
      height_cm: fields.height_cm ?? null,
      age_years: ageYears,
      is_child_intake: isChild,
      chief_complaint: fields.chief_complaint ?? '',
      symptom_duration: fields.symptom_duration ?? '',
      current_medications: fields.current_medications ?? '',
      known_allergies: fields.known_allergies ?? '',
      chronic_conditions: fields.chronic_conditions ?? '',
      is_pregnant: fields.is_pregnant ?? null,
      is_breastfeeding: fields.is_breastfeeding ?? null,
      smoker: fields.smoker ?? null,
      last_blood_pressure: fields.last_blood_pressure ?? '',
      last_glycemia: fields.last_glycemia ?? '',
      consent_at: consentAt,
    });

  return get(info.lastInsertRowid);
}

function get(id) {
  const intakeId = requireId(id);
  const row = getDb().prepare('SELECT * FROM patient_intake WHERE id = ?').get(intakeId);
  if (!row) throw new AppError('INTAKE_NOT_FOUND');
  return hydrate(row);
}

/** Update an unverified/pending intake draft (used step-by-step on WhatsApp or doctor Edit). */
function update(id, patch = {}) {
  const current = get(id);
  const fields = validatePatch(patch);
  const keys = Object.keys(fields);
  if (keys.length === 0) return current;

  const sets = keys.map((k) => `${k} = @${k}`);
  sets.push('updated_at = @updated_at');
  getDb()
    .prepare(`UPDATE patient_intake SET ${sets.join(', ')} WHERE id = @id`)
    .run({ ...fields, updated_at: nowLocal(), id: current.id });

  return get(current.id);
}

/** Clear answers to restart a WhatsApp intake while keeping the consent timestamp. */
function resetAnswers(id) {
  const current = get(id);
  getDb()
    .prepare(
      `UPDATE patient_intake SET
         age_years = NULL, weight_kg = NULL, height_cm = NULL,
         chief_complaint = '', symptom_duration = '',
         current_medications = '', known_allergies = '', chronic_conditions = '',
         is_pregnant = NULL, is_breastfeeding = NULL, smoker = NULL,
         last_blood_pressure = '', last_glycemia = '',
         status = 'pending', updated_at = ?
       WHERE id = ?`,
    )
    .run(nowLocal(), current.id);
  return get(current.id);
}

/**
 * Doctor action: "Confirm & apply".
 *  - Merges (never overwrites!) `known_allergies` & `chronic_conditions` into `patients`.
 *  - Saves approximate birth year into `patients.birth_date` when empty and `age_years` was reported.
 *  - Records verified weight in `patient_weight_history`.
 *  - Appends chief complaint draft into linked `appointments.notes` if present.
 *  - Marks intake `status = 'applied'` with `reviewed_by` & `reviewed_at`.
 */
function confirmAndApply(id, options = {}) {
  const intakeId = requireId(id);
  const db = getDb();
  if (options.edits && typeof options.edits === 'object') {
    update(intakeId, options.edits);
  }
  const current = get(intakeId);
  const patient = patients.get(current.patient_id);
  const reviewer = cleanText(options.reviewed_by, 100) || 'doctor';
  const now = nowLocal();

  const mergedAllergies = mergeClinicalList(patient.allergies, current.known_allergies);
  const mergedChronic = mergeClinicalList(patient.chronic_conditions, current.chronic_conditions);

  const tx = db.transaction(() => {
    const patientPatch = {
      id: patient.id,
      allergies: mergedAllergies,
      chronic_conditions: mergedChronic,
    };
    if (!patient.birth_date && current.age_years !== null && current.age_years !== undefined) {
      const refYear = Number(toISODate().slice(0, 4));
      const estYear = refYear - Math.floor(Number(current.age_years));
      if (estYear >= 1900 && estYear <= refYear) {
        patientPatch.birth_date = String(estYear);
      }
    }
    patients.update(patientPatch);

    if (current.weight_kg !== null && current.weight_kg !== undefined) {
      db.prepare(
        `INSERT INTO patient_weight_history
          (patient_id, appointment_id, intake_id, weight_kg, height_cm, recorded_at, source)
         VALUES (?, ?, ?, ?, ?, ?, 'intake_confirmed')`,
      ).run(
        patient.id,
        current.appointment_id || null,
        current.id,
        current.weight_kg,
        current.height_cm ?? null,
        now,
      );
    }

    if (current.appointment_id && current.chief_complaint) {
      const appt = db.prepare('SELECT id, notes FROM appointments WHERE id = ?').get(current.appointment_id);
      if (appt) {
        const draftLine = `[Motif pré-visite] ${current.chief_complaint}${
          current.symptom_duration ? ` (${current.symptom_duration})` : ''
        }`;
        const existingNotes = String(appt.notes || '').trim();
        if (!existingNotes.includes(draftLine)) {
          const combined = existingNotes ? `${existingNotes} · ${draftLine}` : draftLine;
          db.prepare('UPDATE appointments SET notes = ?, updated_at = ? WHERE id = ?').run(
            combined.slice(0, 500),
            now,
            appt.id,
          );
        }
      }
    }

    db.prepare(
      `UPDATE patient_intake
       SET status = 'applied', reviewed_by = ?, reviewed_at = ?, updated_at = ?
       WHERE id = ?`,
    ).run(reviewer, now, now, current.id);
  });
  tx();

  const updatedIntake = get(intakeId);
  const updatedPatient = patients.get(patient.id);
  return {
    intake: updatedIntake,
    patient: updatedPatient,
    prescription_prefill: {
      patient_id: updatedPatient.id,
      patient_name: updatedPatient.full_name,
      patient_age:
        updatedIntake.effective_age_years !== null && updatedIntake.effective_age_years !== undefined
          ? updatedIntake.effective_age_years < 2
            ? `${Math.round(updatedIntake.effective_age_years * 12)} mois`
            : `${Math.round(updatedIntake.effective_age_years)} ans`
          : '',
      patient_weight:
        updatedIntake.weight_kg !== null && updatedIntake.weight_kg !== undefined
          ? `${updatedIntake.weight_kg} kg`
          : '',
      patient_allergies: updatedPatient.allergies || '',
      patient_chronic: updatedPatient.chronic_conditions || '',
      is_pregnant: updatedIntake.is_pregnant === 1,
      is_breastfeeding: updatedIntake.is_breastfeeding === 1,
      current_medications: updatedIntake.current_medications || '',
      chief_complaint: updatedIntake.chief_complaint || '',
      vitals_bp: updatedIntake.last_blood_pressure || '',
      vitals_glycemia: updatedIntake.last_glycemia || '',
    },
  };
}

function reject(id, options = {}) {
  const current = get(id);
  const reviewer = cleanText(options.reviewed_by, 100) || 'doctor';
  const now = nowLocal();
  getDb()
    .prepare(
      `UPDATE patient_intake
       SET status = 'rejected', reviewed_by = ?, reviewed_at = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(reviewer, now, now, current.id);
  return get(current.id);
}

function listForPatient(patientId, { limit = 20 } = {}) {
  const pid = requireId(patientId, 'patient_id');
  const max = Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 20));
  const p = patients.get(pid);
  return getDb()
    .prepare(
      `SELECT * FROM patient_intake
       WHERE patient_id = ?
       ORDER BY id DESC LIMIT ?`,
    )
    .all(pid, max)
    .map((r) => hydrate(r, p));
}

function latestPendingForPatient(patientId) {
  if (!patientId) return null;
  const pid = Number.parseInt(patientId, 10);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const row = getDb()
    .prepare(
      `SELECT * FROM patient_intake
       WHERE patient_id = ? AND status IN ('pending', 'reviewed')
       ORDER BY id DESC LIMIT 1`,
    )
    .get(pid);
  return row ? hydrate(row) : null;
}

function latestForPatient(patientId) {
  if (!patientId) return null;
  const pid = Number.parseInt(patientId, 10);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const row = getDb()
    .prepare(
      `SELECT * FROM patient_intake
       WHERE patient_id = ? AND status <> 'rejected'
       ORDER BY id DESC LIMIT 1`,
    )
    .get(pid);
  return row ? hydrate(row) : null;
}

function forAppointment(appointmentId) {
  if (!appointmentId) return null;
  const aid = Number.parseInt(appointmentId, 10);
  if (!Number.isInteger(aid) || aid <= 0) return null;
  const row = getDb()
    .prepare(
      `SELECT * FROM patient_intake
       WHERE appointment_id = ? AND status <> 'rejected'
       ORDER BY id DESC LIMIT 1`,
    )
    .get(aid);
  return row ? hydrate(row) : null;
}

/** Weight history per patient (verified entries + prescription weights if recorded). */
function weightHistory(patientId, { limit = 12 } = {}) {
  const pid = requireId(patientId, 'patient_id');
  const max = Math.min(50, Math.max(1, Number.parseInt(limit, 10) || 12));
  const rows = getDb()
    .prepare(
      `SELECT id, weight_kg, height_cm, recorded_at, source
       FROM patient_weight_history
       WHERE patient_id = ?
       ORDER BY recorded_at DESC, id DESC
       LIMIT ?`,
    )
    .all(pid, max);
  return rows.map((r) => ({
    ...r,
    bmi: computeBmi(r.weight_kg, r.height_cm),
  }));
}

function recordWeight({ patient_id, appointment_id = null, weight_kg, height_cm = null, source = 'doctor' }) {
  const pid = requireId(patient_id, 'patient_id');
  patients.get(pid);
  const w = parseWeightKg(weight_kg);
  if (!w.ok) throw new AppError(w.code);
  let hVal = null;
  if (height_cm !== null && height_cm !== undefined && height_cm !== '') {
    const hParsed = parseHeightCm(height_cm);
    if (!hParsed.ok) throw new AppError(hParsed.code);
    hVal = hParsed.value;
  }
  const info = getDb()
    .prepare(
      `INSERT INTO patient_weight_history
        (patient_id, appointment_id, weight_kg, height_cm, recorded_at, source)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(pid, appointment_id || null, w.value, hVal, nowLocal(), cleanText(source, 40) || 'doctor');
  return getDb().prepare('SELECT * FROM patient_weight_history WHERE id = ?').get(info.lastInsertRowid);
}

module.exports = {
  normalizeDigits,
  isSkipInput,
  isNoneInput,
  isRestartInput,
  parseYesNo,
  parseWeightKg,
  parseHeightCm,
  parseAgeYears,
  deriveAgeFromBirthDate,
  shouldAskPregnancy,
  detectChildContext,
  computeBmi,
  mergeClinicalList,
  create,
  get,
  update,
  resetAnswers,
  confirmAndApply,
  reject,
  listForPatient,
  latestPendingForPatient,
  latestForPatient,
  forAppointment,
  weightHistory,
  recordWeight,
};
