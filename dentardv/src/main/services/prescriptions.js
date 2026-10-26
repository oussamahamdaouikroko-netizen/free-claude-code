'use strict';
/**
 * Dental Prescriptions (Ordonnances dentaires), Dental Medications Catalog,
 * Reusable Dental Protocol Templates, Allergy Cross-Check & Medical Certificates.
 */

const { getDb } = require('../db');
const settings = require('./settings');
const safety = require('./safety');
const nomenclature = require('./nomenclature');
const { toISODate } = require('../utils/dates');
const { AppError, cleanText, requireId, normalizeSearch } = require('../utils/common');

function foldSearch(text) {
  return normalizeSearch(text);
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
/*  Dental Medications Catalog                                                */
/* -------------------------------------------------------------------------- */

function searchMedications(queryOrOpts = '', opts = {}) {
  const isObj = queryOrOpts && typeof queryOrOpts === 'object';
  const query = isObj ? queryOrOpts.query || queryOrOpts.search || '' : queryOrOpts;
  const specialty = isObj ? queryOrOpts.specialty || '' : opts.specialty || '';
  const limit = isObj ? queryOrOpts.limit : opts.limit;
  const onlyGeneric = Boolean(isObj ? queryOrOpts.only_generic : opts.only_generic);
  return nomenclature.searchFast({
    query,
    specialty,
    onlyGeneric,
    limit,
  });
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
  return { total, custom, dental_only: true, specialties };
}

function createMedication(input = {}) {
  const brand = cleanText(input.brand, 120);
  if (!brand) throw new AppError('MEDICATION_NAME_REQUIRED');
  const dci = cleanText(input.dci, 160);
  const strength = cleanText(input.strength, 80);
  const form = cleanText(input.form, 80) || 'Comprimé';
  const specialty = nomenclature.normalizeDentalSpecialty(input.specialty || 'stomato');
  const keywordsAr = cleanText(input.keywords_ar, 200);
  const defaultDosage = cleanText(input.default_dosage, 160);
  const defaultDuration = cleanText(input.default_duration, 80);
  const laboratory = cleanText(input.laboratory, 140);
  const registrationNumber = cleanText(input.registration_number, 60);
  const isGeneric = input.is_generic ? 1 : 0;
  const schedule = cleanText(input.schedule, 30);
  const dciGroup = nomenclature.makeDciGroup(dci, strength);
  const nameNorm = normalizeSearch(brand);
  const folded = normalizeSearch(`${brand} ${dci} ${strength} ${form} ${laboratory} ${specialty} ${keywordsAr}`);

  const info = getDb()
    .prepare(
      `INSERT INTO medications
        (brand, dci, strength, form, specialty, keywords_ar, default_dosage, default_duration,
         registration_number, laboratory, is_generic, reference_dci_group, schedule,
         source, verified, last_updated, name_normalized, folded_search, custom, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'custom', 1, ?, ?, ?, 1, 1)`,
    )
    .run(
      brand, dci, strength, form, specialty, keywordsAr, defaultDosage, defaultDuration,
      registrationNumber, laboratory, isGeneric, dciGroup, schedule,
      toISODate(), nameNorm, folded,
    );
  return getDb().prepare('SELECT * FROM medications WHERE id = ?').get(info.lastInsertRowid);
}

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
    foldedAllergy.includes('sapofen') ||
    foldedAllergy.includes('diclofenac') ||
    foldedAllergy.includes('rapidus');

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
        drugFold.includes('sapofen') ||
        drugFold.includes('ketoprofen') ||
        drugFold.includes('diclofenac') ||
        drugFold.includes('rapidus') ||
        drugFold.includes('tiaprofen') ||
        drugFold.includes('surgam') ||
        drugFold.includes('celecoxib') ||
        drugFold.includes('naproxen'))
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
/*  Dental Prescriptions (Ordonnances)                                        */
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
      substitutable: item?.substitutable === false || item?.substitutable === 0 ? 0 : 1,
      schedule: cleanText(item?.schedule, 30),
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
              p.blood_group AS patient_blood_group
       FROM prescriptions rx
       LEFT JOIN patients p ON p.id = rx.patient_id
       WHERE rx.id = ?`,
    )
    .get(rxId);
  if (!rx) throw new AppError('PRESCRIPTION_NOT_FOUND');

  const items = getDb()
    .prepare('SELECT * FROM prescription_items WHERE prescription_id = ? ORDER BY sort_order ASC, id ASC')
    .all(rxId);
  const allergy_warnings = checkAllergyWarnings(rx.patient_allergies, items);
  const safety_audit = safety.getAuditForPrescription(rxId);
  return { ...rx, items, allergy_warnings, safety_audit };
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

  const doctorName = cleanText(input.doctor_name, 100) || settings.get('doctor_name') || '';
  const doctorSpecialty =
    cleanText(input.doctor_specialty, 120) ||
    settings.get('doctor_specialty') ||
    'Chirurgien-Dentiste';
  const doctorOrdre = cleanText(input.doctor_ordre, 60) || settings.get('doctor_ordre') || '';

  const items = normalizeItems(input.items);
  const examsRequested = cleanText(input.exams_requested, 1000);
  if (items.length === 0 && !examsRequested) {
    throw new AppError('PRESCRIPTION_ITEMS_REQUIRED');
  }

  const overrideReason = cleanText(input.safety_override_reason, 400);
  const safetyEval = safety.evaluatePrescription({
    patient_id: patient ? patient.id : null,
    patient_weight: patientWeight,
    patient_age: patientAge,
    patient_allergies: input.patient_allergies,
    patient_chronic: input.patient_chronic,
    is_pregnant: input.is_pregnant,
    is_breastfeeding: input.is_breastfeeding,
    current_medications: input.current_medications,
    items,
  });

  if (safetyEval.blocking && !overrideReason) {
    throw new AppError('SAFETY_OVERRIDE_REQUIRED', 'Safety override required', {
      blocking: true,
      alerts: safetyEval.alerts,
    });
  }

  const day = cleanText(input.day, 10) || toISODate();
  const printMode = ['brand', 'dci', 'both'].includes(input.print_mode) ? input.print_mode : 'both';
  const hasControlled =
    Boolean(safetyEval.controlled_flags?.some((f) => f.requires_secure_rx)) ||
    items.some((it) => it.schedule === 'psychotrope' || it.schedule === 'stupefiant');
  const diagnosis = cleanText(input.diagnosis, 300);
  const toothRef = cleanText(input.tooth_ref, 60);
  const advice = cleanText(input.advice, 1000);
  const appointmentId = input.appointment_id ? Number.parseInt(input.appointment_id, 10) || null : null;

  const tx = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO prescriptions
          (patient_id, appointment_id, day,
           patient_name, patient_age, patient_weight,
           doctor_name, doctor_specialty, doctor_ordre,
           diagnosis, tooth_ref, exams_requested, advice, print_mode, controlled_rx)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        patient ? patient.id : null,
        appointmentId,
        day,
        patientName,
        patientAge,
        patientWeight,
        doctorName,
        doctorSpecialty,
        doctorOrdre,
        diagnosis,
        toothRef,
        examsRequested,
        advice,
        printMode,
        hasControlled ? 1 : 0,
      );
    const rxId = info.lastInsertRowid;
    const insertItem = db.prepare(
      `INSERT INTO prescription_items
        (prescription_id, medication_id, drug_name, dci, form_strength,
         dosage, timing, duration, quantity, note, substitutable, schedule, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const item of items) {
      let itemSchedule = item.schedule;
      if (!itemSchedule && item.medication_id) {
        const medRow = db.prepare('SELECT schedule FROM medications WHERE id = ?').get(item.medication_id);
        if (medRow?.schedule) itemSchedule = medRow.schedule;
      }
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
        item.substitutable,
        itemSchedule,
        item.sort_order,
      );
    }
    safety.recordAudit({
      prescription_id: rxId,
      patient_weight_kg: safetyEval.patient_weight_kg,
      evaluation: safetyEval,
      override_reason: overrideReason,
      prescriber_name: doctorName,
    });
    return rxId;
  });

  const createdId = tx();
  return get(createdId);
}

function list({ search = '', patientId = null, limit = 100 } = {}) {
  const max = Math.min(500, Math.max(1, Number.parseInt(limit, 10) || 100));
  const clauses = ['1 = 1'];
  const params = [];

  if (patientId) {
    clauses.push('rx.patient_id = ?');
    params.push(requireId(patientId));
  }
  const q = cleanText(search, 80);
  if (q) {
    clauses.push('(rx.patient_name LIKE ? OR rx.diagnosis LIKE ? OR rx.tooth_ref LIKE ? OR rx.doctor_name LIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }
  params.push(max);

  return getDb()
    .prepare(
      `SELECT rx.*,
              p.phone AS patient_phone,
              (SELECT COUNT(*) FROM prescription_items pi WHERE pi.prescription_id = rx.id) AS items_count,
              (SELECT GROUP_CONCAT(drug_name, ' · ') FROM prescription_items pi WHERE pi.prescription_id = rx.id) AS items_summary
       FROM prescriptions rx
       LEFT JOIN patients p ON p.id = rx.patient_id
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
  return rows.map((row) => ({ ...row, items: getItems.all(row.id) }));
}

function remove(id) {
  const rxId = requireId(id);
  get(rxId);
  getDb().prepare('DELETE FROM prescriptions WHERE id = ?').run(rxId);
  return { ok: true };
}

/* -------------------------------------------------------------------------- */
/*  Dental Prescription Templates                                             */
/* -------------------------------------------------------------------------- */

function listTemplates() {
  const rows = getDb()
    .prepare('SELECT * FROM prescription_templates ORDER BY id ASC')
    .all();
  return rows.map((row) => {
    let items = [];
    try { items = JSON.parse(row.items_json || '[]'); } catch { items = []; }
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
        (title_fr, title_ar, specialty, items_json, exams_requested, advice, source, verified)
       VALUES (?, ?, ?, ?, ?, ?, 'custom', 1)`,
    )
    .run(
      titleFr || titleAr,
      titleAr || titleFr,
      cleanText(input.specialty, 80) || settings.get('doctor_specialty') || 'Chirurgie Dentaire',
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
/*  Dental Medical Certificates (Certificats & Arrêts de travail)             */
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
  const doctorName = cleanText(input.doctor_name, 100) || settings.get('doctor_name') || '';
  const doctorSpecialty =
    cleanText(input.doctor_specialty, 120) ||
    settings.get('doctor_specialty') ||
    'Chirurgien-Dentiste';
  const doctorOrdre = cleanText(input.doctor_ordre, 60) || settings.get('doctor_ordre') || '';

  const kind = CERT_KINDS.has(input.kind) ? input.kind : 'arret_travail';
  const restDays = Math.max(0, Math.min(365, Number.parseInt(input.rest_days, 10) || 0));
  const day = cleanText(input.day, 10) || toISODate();
  const startDay = cleanText(input.start_day, 10) || day;
  const content = cleanText(input.content, 1500);

  const info = db
    .prepare(
      `INSERT INTO medical_certificates
        (patient_id, day, patient_name, patient_age,
         doctor_name, doctor_specialty, doctor_ordre,
         kind, rest_days, start_day, content)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      patient ? patient.id : null,
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
