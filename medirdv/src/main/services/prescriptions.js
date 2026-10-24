'use strict';
/**
 * Prescriptions, Algerian Nomenclature medications, reusable protocol
 * templates, allergy cross-check, and medical certificates service.
 */

const { getDb } = require('../db');
const settings = require('./settings');
const departments = require('./departments');
const { toISODate } = require('../utils/dates');
const { AppError, cleanText, requireId } = require('../utils/common');

/** Strip Latin diacritics + normalize Arabic alef/ta-marbuta for fast offline search. */
function foldSearch(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .trim();
}

function computeAgeFromBirthDate(birthDate) {
  const raw = String(birthDate || '').trim();
  if (!raw) return '';
  const yearMatch = raw.match(/^(\d{4})/);
  if (!yearMatch) return raw.slice(0, 30);
  const birthYear = Number.parseInt(yearMatch[1], 10);
  const currentYear = Number.parseInt(toISODate().slice(0, 4), 10);
  if (!Number.isFinite(birthYear) || birthYear < 1900 || birthYear > currentYear) return '';
  const age = currentYear - birthYear;
  return age > 0 ? `${age} ans` : '< 1 an';
}

/* -------------------------------------------------------------------------- */
/*  Algerian Nomenclature Medications                                         */
/* -------------------------------------------------------------------------- */

function searchMedications(queryOrOpts = '', opts = {}) {
  const isObj = queryOrOpts && typeof queryOrOpts === 'object';
  const query = isObj ? queryOrOpts.query || queryOrOpts.search || '' : queryOrOpts;
  const specialty = isObj ? queryOrOpts.specialty || '' : opts.specialty || '';
  const limit = isObj ? queryOrOpts.limit : opts.limit;
  const max = Math.min(200, Math.max(1, Number.parseInt(limit, 10) || 40));
  const spec = cleanText(specialty, 40).toLowerCase();
  const rows = spec
    ? getDb()
        .prepare('SELECT * FROM medications WHERE active = 1 AND lower(specialty) = ? ORDER BY brand COLLATE NOCASE ASC')
        .all(spec)
    : getDb()
        .prepare('SELECT * FROM medications WHERE active = 1 ORDER BY brand COLLATE NOCASE ASC')
        .all();

  const foldedQuery = foldSearch(query);
  if (!foldedQuery) return rows.slice(0, max);

  const tokens = foldedQuery.split(/\s+/).filter(Boolean);
  const scored = [];
  for (const row of rows) {
    const haystack = foldSearch(
      `${row.brand} ${row.dci} ${row.strength} ${row.form} ${row.specialty} ${row.keywords_ar}`,
    );
    if (!tokens.every((tok) => haystack.includes(tok))) continue;
    const brandFold = foldSearch(row.brand);
    const dciFold = foldSearch(row.dci);
    let score = 0;
    if (brandFold.startsWith(tokens[0])) score += 30;
    else if (dciFold.startsWith(tokens[0])) score += 20;
    else if (brandFold.includes(tokens[0])) score += 10;
    if (row.custom) score += 2;
    scored.push({ row, score });
  }
  scored.sort((a, b) => b.score - a.score || a.row.brand.localeCompare(b.row.brand));
  return scored.slice(0, max).map((s) => s.row);
}

function medicationStats() {
  const total = getDb().prepare('SELECT COUNT(*) AS n FROM medications WHERE active = 1').get().n;
  const custom = getDb()
    .prepare('SELECT COUNT(*) AS n FROM medications WHERE active = 1 AND custom = 1')
    .get().n;
  const specialties = getDb()
    .prepare(
      `SELECT specialty, COUNT(*) AS count
       FROM medications WHERE active = 1 AND specialty != ''
       GROUP BY specialty ORDER BY count DESC`,
    )
    .all();
  return { total, custom, specialties };
}

function createMedication(input = {}) {
  const brand = cleanText(input.brand, 120);
  if (!brand) throw new AppError('MEDICATION_NAME_REQUIRED');
  const dci = cleanText(input.dci, 160);
  const strength = cleanText(input.strength, 80);
  const form = cleanText(input.form, 80) || 'Comprimé';
  const specialty = cleanText(input.specialty, 40) || 'general';
  const keywordsAr = cleanText(input.keywords_ar, 200);
  const defaultDosage = cleanText(input.default_dosage, 160);
  const defaultDuration = cleanText(input.default_duration, 80);

  const info = getDb()
    .prepare(
      `INSERT INTO medications
        (brand, dci, strength, form, specialty, keywords_ar, default_dosage, default_duration, custom, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1)`,
    )
    .run(brand, dci, strength, form, specialty, keywordsAr, defaultDosage, defaultDuration);
  return getDb().prepare('SELECT * FROM medications WHERE id = ?').get(info.lastInsertRowid);
}

/**
 * Check if any prescribed medication matches a patient's recorded drug allergy
 * (including penicillin <-> amoxicilline/augmentin/clamoxyl class cross-check).
 */
function checkAllergyWarnings(allergiesText, items = []) {
  const foldedAllergy = foldSearch(allergiesText);
  if (!foldedAllergy) return [];

  const tokens = foldedAllergy
    .split(/[,;/+·\s]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3);
  if (tokens.length === 0) return [];

  const hasPenicillinAllergy =
    foldedAllergy.includes('penicill') ||
    foldedAllergy.includes('بنسلين') ||
    foldedAllergy.includes('بنسيلين') ||
    foldedAllergy.includes('amoxicill');

  const hasNsaidAllergy =
    foldedAllergy.includes('ains') ||
    foldedAllergy.includes('aspirin') ||
    foldedAllergy.includes('اسبرين') ||
    foldedAllergy.includes('ibuprofen') ||
    foldedAllergy.includes('diclofenac') ||
    foldedAllergy.includes('ketoprofen');

  const warnings = [];
  for (const item of items) {
    const drugFold = foldSearch(`${item.drug_name || ''} ${item.dci || ''}`);
    if (!drugFold) continue;
    let matched = tokens.find((tok) => drugFold.includes(tok));
    if (
      !matched &&
      hasPenicillinAllergy &&
      (drugFold.includes('amoxicill') || drugFold.includes('augmentin') || drugFold.includes('clamoxyl'))
    ) {
      matched = 'Pénicilline / Bêta-lactamine';
    }
    if (
      !matched &&
      hasNsaidAllergy &&
      (drugFold.includes('ibuprofen') ||
        drugFold.includes('ketoprofen') ||
        drugFold.includes('diclofenac') ||
        drugFold.includes('celecoxib') ||
        drugFold.includes('naproxen') ||
        drugFold.includes('acetylsalicyl'))
    ) {
      matched = 'AINS / Aspirine';
    }
    if (matched) {
      warnings.push({
        drug_name: item.drug_name || item.dci,
        matched_allergy: matched,
      });
    }
  }
  return warnings;
}

/* -------------------------------------------------------------------------- */
/*  Prescriptions (Ordonnances médicales)                                     */
/* -------------------------------------------------------------------------- */

function normalizeItems(rawItems) {
  if (!Array.isArray(rawItems)) return [];
  const out = [];
  rawItems.forEach((item, index) => {
    const drugName = cleanText(item?.drug_name, 140);
    if (!drugName) return;
    out.push({
      medication_id: item?.medication_id ? Number.parseInt(item.medication_id, 10) || null : null,
      drug_name: drugName,
      dci: cleanText(item?.dci, 160),
      form_strength: cleanText(item?.form_strength, 120),
      dosage: cleanText(item?.dosage, 180),
      timing: cleanText(item?.timing, 120),
      duration: cleanText(item?.duration, 80),
      quantity: cleanText(item?.quantity, 60),
      note: cleanText(item?.note, 200),
      sort_order: index + 1,
    });
  });
  return out;
}

function get(id) {
  const rxId = requireId(id);
  const rx = getDb()
    .prepare(
      `SELECT rx.*,
              p.phone AS patient_phone,
              p.allergies AS patient_allergies,
              p.chronic_conditions AS patient_chronic_conditions,
              p.blood_group AS patient_blood_group,
              d.name_fr AS dept_name_fr,
              d.name_ar AS dept_name_ar,
              d.room AS dept_room
       FROM prescriptions rx
       LEFT JOIN patients p ON p.id = rx.patient_id
       LEFT JOIN departments d ON d.id = rx.department_id
       WHERE rx.id = ?`,
    )
    .get(rxId);
  if (!rx) throw new AppError('PRESCRIPTION_NOT_FOUND');

  const items = getDb()
    .prepare('SELECT * FROM prescription_items WHERE prescription_id = ? ORDER BY sort_order ASC, id ASC')
    .all(rxId);
  const allergy_warnings = checkAllergyWarnings(rx.patient_allergies, items);
  return { ...rx, items, allergy_warnings };
}

function create(input = {}) {
  const db = getDb();
  let patient = null;
  if (input.patient_id) {
    patient = db.prepare('SELECT * FROM patients WHERE id = ?').get(requireId(input.patient_id));
    if (!patient) throw new AppError('PATIENT_NOT_FOUND');
  }

  const patientName = cleanText(input.patient_name || patient?.full_name, 120);
  if (!patientName) throw new AppError('PATIENT_NAME_REQUIRED');

  const patientAge =
    cleanText(input.patient_age, 40) ||
    (patient ? computeAgeFromBirthDate(patient.birth_date) : '');
  const patientWeight = cleanText(input.patient_weight, 30);

  const dept = departments.getOptional(input.department_id);
  const doctorName =
    cleanText(input.doctor_name, 100) ||
    dept?.doctor_name ||
    settings.get('doctor_name') ||
    '';
  const doctorSpecialty =
    cleanText(input.doctor_specialty, 120) ||
    dept?.specialty ||
    dept?.name_fr ||
    settings.get('doctor_specialty') ||
    '';
  const doctorOrdre = cleanText(input.doctor_ordre, 60) || settings.get('doctor_ordre') || '';

  const items = normalizeItems(input.items);
  const examsRequested = cleanText(input.exams_requested, 1000);
  if (items.length === 0 && !examsRequested) {
    throw new AppError('PRESCRIPTION_ITEMS_REQUIRED');
  }

  const day = cleanText(input.day, 10) || toISODate();
  const diagnosis = cleanText(input.diagnosis, 300);
  const vitalsBp = cleanText(input.vitals_bp, 30);
  const vitalsHr = cleanText(input.vitals_hr, 30);
  const vitalsTemp = cleanText(input.vitals_temp, 30);
  const vitalsSpo2 = cleanText(input.vitals_spo2, 30);
  const vitalsGlycemia = cleanText(input.vitals_glycemia, 30);
  const advice = cleanText(input.advice, 1000);
  const appointmentId = input.appointment_id ? Number.parseInt(input.appointment_id, 10) || null : null;

  const tx = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO prescriptions
          (patient_id, appointment_id, department_id, day,
           patient_name, patient_age, patient_weight,
           doctor_name, doctor_specialty, doctor_ordre,
           diagnosis, vitals_bp, vitals_hr, vitals_temp, vitals_spo2, vitals_glycemia,
           exams_requested, advice)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        patient ? patient.id : null,
        appointmentId,
        dept ? dept.id : null,
        day,
        patientName,
        patientAge,
        patientWeight,
        doctorName,
        doctorSpecialty,
        doctorOrdre,
        diagnosis,
        vitalsBp,
        vitalsHr,
        vitalsTemp,
        vitalsSpo2,
        vitalsGlycemia,
        examsRequested,
        advice,
      );
    const rxId = info.lastInsertRowid;
    const insertItem = db.prepare(
      `INSERT INTO prescription_items
        (prescription_id, medication_id, drug_name, dci, form_strength,
         dosage, timing, duration, quantity, note, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const item of items) {
      insertItem.run(
        rxId,
        item.medication_id,
        item.drug_name,
        item.dci,
        item.form_strength,
        item.dosage,
        item.timing,
        item.duration,
        item.quantity,
        item.note,
        item.sort_order,
      );
    }
    return rxId;
  });

  const createdId = tx();
  return get(createdId);
}

function list({ search = '', patientId = null, departmentId = null, limit = 100 } = {}) {
  const max = Math.min(500, Math.max(1, Number.parseInt(limit, 10) || 100));
  const clauses = ['1 = 1'];
  const params = [];

  if (patientId) {
    clauses.push('rx.patient_id = ?');
    params.push(requireId(patientId));
  }
  if (departmentId) {
    clauses.push('rx.department_id = ?');
    params.push(requireId(departmentId));
  }
  const q = cleanText(search, 80);
  if (q) {
    clauses.push('(rx.patient_name LIKE ? OR rx.diagnosis LIKE ? OR rx.doctor_name LIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  params.push(max);

  return getDb()
    .prepare(
      `SELECT rx.*,
              p.phone AS patient_phone,
              d.name_fr AS dept_name_fr,
              d.name_ar AS dept_name_ar,
              (SELECT COUNT(*) FROM prescription_items pi WHERE pi.prescription_id = rx.id) AS items_count,
              (SELECT GROUP_CONCAT(drug_name, ' · ') FROM prescription_items pi WHERE pi.prescription_id = rx.id) AS items_summary
       FROM prescriptions rx
       LEFT JOIN patients p ON p.id = rx.patient_id
       LEFT JOIN departments d ON d.id = rx.department_id
       WHERE ${clauses.join(' AND ')}
       ORDER BY rx.day DESC, rx.id DESC
       LIMIT ?`,
    )
    .all(...params);
}

function forPatient(patientId) {
  const rows = list({ patientId, limit: 100 });
  const getItems = getDb().prepare(
    'SELECT * FROM prescription_items WHERE prescription_id = ? ORDER BY sort_order ASC, id ASC',
  );
  return rows.map((row) => ({
    ...row,
    items: getItems.all(row.id),
  }));
}

function remove(id) {
  const rxId = requireId(id);
  get(rxId);
  getDb().prepare('DELETE FROM prescriptions WHERE id = ?').run(rxId);
  return { ok: true };
}

/* -------------------------------------------------------------------------- */
/*  Prescription Templates (Ordonnances types)                                */
/* -------------------------------------------------------------------------- */

function listTemplates() {
  const rows = getDb()
    .prepare('SELECT * FROM prescription_templates ORDER BY id ASC')
    .all();
  return rows.map((row) => {
    let items = [];
    try {
      items = JSON.parse(row.items_json || '[]');
    } catch {
      items = [];
    }
    return { ...row, items };
  });
}

function createTemplate(input = {}) {
  const titleFr = cleanText(input.title_fr, 120);
  const titleAr = cleanText(input.title_ar, 120);
  if (!titleFr && !titleAr) throw new AppError('TEMPLATE_TITLE_REQUIRED');
  const items = normalizeItems(input.items);
  const examsRequested = cleanText(input.exams_requested, 1000);
  if (items.length === 0 && !examsRequested) throw new AppError('PRESCRIPTION_ITEMS_REQUIRED');

  const info = getDb()
    .prepare(
      `INSERT INTO prescription_templates
        (title_fr, title_ar, specialty, items_json, exams_requested, advice)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      titleFr || titleAr,
      titleAr || titleFr,
      cleanText(input.specialty, 80) || settings.get('doctor_specialty'),
      JSON.stringify(items),
      examsRequested,
      cleanText(input.advice, 1000),
    );
  const row = getDb().prepare('SELECT * FROM prescription_templates WHERE id = ?').get(info.lastInsertRowid);
  return { ...row, items };
}

function removeTemplate(id) {
  const tplId = requireId(id);
  getDb().prepare('DELETE FROM prescription_templates WHERE id = ?').run(tplId);
  return { ok: true };
}

/* -------------------------------------------------------------------------- */
/*  Medical Certificates (Certificats médicaux & Arrêts de travail)           */
/* -------------------------------------------------------------------------- */

const CERT_KINDS = new Set(['arret_travail', 'aptitude', 'scolaire', 'general']);

function getCertificate(id) {
  const certId = requireId(id);
  const row = getDb()
    .prepare(
      `SELECT mc.*, p.phone AS patient_phone
       FROM medical_certificates mc
       LEFT JOIN patients p ON p.id = mc.patient_id
       WHERE mc.id = ?`,
    )
    .get(certId);
  if (!row) throw new AppError('CERTIFICATE_NOT_FOUND');
  return row;
}

function createCertificate(input = {}) {
  const db = getDb();
  let patient = null;
  if (input.patient_id) {
    patient = db.prepare('SELECT * FROM patients WHERE id = ?').get(requireId(input.patient_id));
    if (!patient) throw new AppError('PATIENT_NOT_FOUND');
  }
  const patientName = cleanText(input.patient_name || patient?.full_name, 120);
  if (!patientName) throw new AppError('PATIENT_NAME_REQUIRED');

  const patientAge =
    cleanText(input.patient_age, 40) ||
    (patient ? computeAgeFromBirthDate(patient.birth_date) : '');
  const dept = departments.getOptional(input.department_id);
  const doctorName =
    cleanText(input.doctor_name, 100) ||
    dept?.doctor_name ||
    settings.get('doctor_name') ||
    '';
  const doctorSpecialty =
    cleanText(input.doctor_specialty, 120) ||
    dept?.specialty ||
    settings.get('doctor_specialty') ||
    '';
  const doctorOrdre = cleanText(input.doctor_ordre, 60) || settings.get('doctor_ordre') || '';

  const kind = CERT_KINDS.has(input.kind) ? input.kind : 'arret_travail';
  const restDays = Math.max(0, Math.min(365, Number.parseInt(input.rest_days, 10) || 0));
  const day = cleanText(input.day, 10) || toISODate();
  const startDay = cleanText(input.start_day, 10) || day;
  const content = cleanText(input.content, 1500);

  const info = db
    .prepare(
      `INSERT INTO medical_certificates
        (patient_id, department_id, day, patient_name, patient_age,
         doctor_name, doctor_specialty, doctor_ordre,
         kind, rest_days, start_day, content)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      patient ? patient.id : null,
      dept ? dept.id : null,
      day,
      patientName,
      patientAge,
      doctorName,
      doctorSpecialty,
      doctorOrdre,
      kind,
      restDays,
      startDay,
      content,
    );
  return getCertificate(info.lastInsertRowid);
}

function listCertificates({ patientId = null, limit = 50 } = {}) {
  const max = Math.min(200, Math.max(1, Number.parseInt(limit, 10) || 50));
  if (patientId) {
    return getDb()
      .prepare('SELECT * FROM medical_certificates WHERE patient_id = ? ORDER BY day DESC, id DESC LIMIT ?')
      .all(requireId(patientId), max);
  }
  return getDb()
    .prepare('SELECT * FROM medical_certificates ORDER BY day DESC, id DESC LIMIT ?')
    .all(max);
}

function removeCertificate(id) {
  const certId = requireId(id);
  getCertificate(certId);
  getDb().prepare('DELETE FROM medical_certificates WHERE id = ?').run(certId);
  return { ok: true };
}

module.exports = {
  searchMedications,
  medicationStats,
  createMedication,
  checkAllergyWarnings,
  computeAgeFromBirthDate,
  get,
  create,
  list,
  forPatient,
  remove,
  listTemplates,
  createTemplate,
  removeTemplate,
  getCertificate,
  createCertificate,
  listCertificates,
  removeCertificate,
};
