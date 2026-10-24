'use strict';
/**
 * Phase 5 — Structured Electronic Medical Record (Dossier Médical Électronique):
 *  - Structured SOAP / clinical consultations (`consultations`)
 *  - Secure offline attachments (`patient_documents` with allowlist & size limit)
 *  - Laboratory orders, abnormal result flags & longitudinal analyte trends
 *  - Medical imaging orders & findings
 *  - Algerian National Vaccination Schedule (PEV) + patient log + due alerts
 *  - Pregnancy follow-up (`DDR` -> `DPA`, gestational weeks, visit log)
 *  - WHO Child Growth Z-score & percentile calculator (0–10 years)
 *  - Longitudinal BP & Glycemia dashboards + Unified Patient Timeline
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { getDb, getPath } = require('../db');
const { AppError, cleanText, requireId } = require('../utils/common');
const { toISODate, addDays } = require('../utils/dates');

const ALLOWED_DOC_EXTENSIONS = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.webp']);
const MAX_DOC_BYTES = 15 * 1024 * 1024; // 15 MB

const EXT_MIMES = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

function numOrNull(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function intOrNull(v) {
  const n = numOrNull(v);
  return n === null ? null : Math.round(n);
}

function ensurePatient(db, patientId) {
  const id = requireId(patientId, 'patient_id');
  const p = db.prepare('SELECT * FROM patients WHERE id = ?').get(id);
  if (!p) throw new AppError('PATIENT_NOT_FOUND');
  return p;
}

/* -------------------------------------------------------------------------- */
/*  1. Structured Clinical Consultations                                      */
/* -------------------------------------------------------------------------- */

function createConsultation(input = {}) {
  const db = getDb();
  const patient = ensurePatient(db, input.patient_id);
  const day = cleanText(input.day, 10) || toISODate();
  const weightKg = numOrNull(input.weight_kg);
  const heightCm = numOrNull(input.height_cm);
  let bmi = null;
  if (weightKg && heightCm && heightCm >= 30) {
    const hm = heightCm / 100;
    bmi = Math.round((weightKg / (hm * hm)) * 10) / 10;
  }

  let bpSys = intOrNull(input.vitals_bp_sys);
  let bpDia = intOrNull(input.vitals_bp_dia);
  if ((!bpSys || !bpDia) && input.vitals_bp) {
    const m = String(input.vitals_bp).match(/(\d{2,3})\s*[/\-]\s*(\d{2,3})/);
    if (m) {
      bpSys = Number(m[1]);
      bpDia = Number(m[2]);
    }
  }

  const info = db
    .prepare(
      `INSERT INTO consultations
        (patient_id, appointment_id, department_id, day, doctor_name,
         chief_complaint, history_of_illness, physical_exam, assessment, plan,
         vitals_bp_sys, vitals_bp_dia, vitals_hr, vitals_temp, vitals_spo2, vitals_glycemia,
         weight_kg, height_cm, head_circumference_cm, bmi)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      patient.id,
      input.appointment_id ? Number(input.appointment_id) || null : null,
      input.department_id ? Number(input.department_id) || null : null,
      day,
      cleanText(input.doctor_name, 100),
      cleanText(input.chief_complaint, 400),
      cleanText(input.history_of_illness, 2000),
      cleanText(input.physical_exam, 2000),
      cleanText(input.assessment, 1000),
      cleanText(input.plan, 2000),
      bpSys,
      bpDia,
      intOrNull(input.vitals_hr),
      numOrNull(input.vitals_temp),
      intOrNull(input.vitals_spo2),
      numOrNull(input.vitals_glycemia),
      weightKg,
      heightCm,
      numOrNull(input.head_circumference_cm),
      bmi,
    );

  if (weightKg && weightKg >= 0.3 && weightKg <= 400) {
    db.prepare(
      `INSERT INTO patient_weight_history (patient_id, weight_kg, height_cm, source, recorded_at)
       VALUES (?, ?, ?, 'consultation', ?)`,
    ).run(patient.id, weightKg, heightCm, day);
  }

  return db.prepare('SELECT * FROM consultations WHERE id = ?').get(info.lastInsertRowid);
}

function listConsultations(patientId) {
  const id = requireId(patientId, 'patient_id');
  return getDb()
    .prepare(
      `SELECT c.*, d.name_fr AS dept_name_fr, d.name_ar AS dept_name_ar
       FROM consultations c
       LEFT JOIN departments d ON d.id = c.department_id
       WHERE c.patient_id = ?
       ORDER BY c.day DESC, c.id DESC`,
    )
    .all(id);
}

function removeConsultation(id) {
  const rowId = requireId(id);
  getDb().prepare('DELETE FROM consultations WHERE id = ?').run(rowId);
  return { ok: true };
}

/* -------------------------------------------------------------------------- */
/*  2. Secure Local Patient Documents                                         */
/* -------------------------------------------------------------------------- */

function docsDir() {
  const dbFile = getPath();
  const base = dbFile && dbFile !== ':memory:' ? path.dirname(dbFile) : path.join(require('node:os').tmpdir(), 'medirdv-docs');
  const dir = path.join(base, 'documents');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function attachDocument(input = {}) {
  const db = getDb();
  const patient = ensurePatient(db, input.patient_id);
  const origName = path.basename(cleanText(input.filename, 180) || 'document.pdf');
  const ext = path.extname(origName).toLowerCase();
  if (!ALLOWED_DOC_EXTENSIONS.has(ext)) {
    throw new AppError('UNSUPPORTED_FILE_TYPE', `Unsupported extension: ${ext}`);
  }

  let buffer;
  if (input.file_path) {
    if (!fs.existsSync(input.file_path)) throw new AppError('FILE_NOT_FOUND');
    buffer = fs.readFileSync(input.file_path);
  } else if (input.data_base64) {
    const raw = String(input.data_base64).replace(/^data:[^;]+;base64,/, '');
    buffer = Buffer.from(raw, 'base64');
  } else {
    throw new AppError('INVALID_INPUT', 'Document content required.');
  }

  if (buffer.length === 0 || buffer.length > MAX_DOC_BYTES) {
    throw new AppError('FILE_TOO_LARGE', 'Document exceeds 15 MB limit or is empty.');
  }

  const storedName = `${patient.id}-${crypto.randomUUID()}${ext}`;
  const fullPath = path.join(docsDir(), storedName);
  fs.writeFileSync(fullPath, buffer);

  const validCats = new Set(['lab', 'imaging', 'letter', 'consent', 'other']);
  const category = validCats.has(input.category) ? input.category : 'other';
  const title = cleanText(input.title, 160) || origName;
  const day = cleanText(input.day, 10) || toISODate();

  const info = db
    .prepare(
      `INSERT INTO patient_documents
        (patient_id, consultation_id, category, title, filename, stored_name, mime_type, size_bytes, day, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      patient.id,
      input.consultation_id ? Number(input.consultation_id) || null : null,
      category,
      title,
      origName,
      storedName,
      EXT_MIMES[ext] || 'application/octet-stream',
      buffer.length,
      day,
      cleanText(input.notes, 500),
    );
  return db.prepare('SELECT * FROM patient_documents WHERE id = ?').get(info.lastInsertRowid);
}

function listDocuments(patientId) {
  const id = requireId(patientId, 'patient_id');
  return getDb()
    .prepare('SELECT * FROM patient_documents WHERE patient_id = ? ORDER BY day DESC, id DESC')
    .all(id);
}

function readDocument(id) {
  const docId = requireId(id);
  const row = getDb().prepare('SELECT * FROM patient_documents WHERE id = ?').get(docId);
  if (!row) throw new AppError('NOT_FOUND');
  const safeName = path.basename(row.stored_name);
  const fullPath = path.join(docsDir(), safeName);
  if (!fs.existsSync(fullPath)) throw new AppError('FILE_NOT_FOUND');
  const buf = fs.readFileSync(fullPath);
  return {
    ...row,
    data_url: `data:${row.mime_type};base64,${buf.toString('base64')}`,
  };
}

function removeDocument(id) {
  const docId = requireId(id);
  const row = getDb().prepare('SELECT * FROM patient_documents WHERE id = ?').get(docId);
  if (!row) throw new AppError('NOT_FOUND');
  const safeName = path.basename(row.stored_name);
  const fullPath = path.join(docsDir(), safeName);
  if (fs.existsSync(fullPath)) {
    try { fs.unlinkSync(fullPath); } catch (_) { /* ignore */ }
  }
  getDb().prepare('DELETE FROM patient_documents WHERE id = ?').run(docId);
  return { ok: true };
}

/* -------------------------------------------------------------------------- */
/*  3. Laboratory & Imaging Orders + Abnormal Flags + Trends                  */
/* -------------------------------------------------------------------------- */

function computeAbnormalFlag(valNum, refMin, refMax) {
  if (valNum === null || valNum === undefined) return '';
  if (refMin !== null && valNum < refMin) {
    return valNum < refMin * 0.5 ? 'critical' : 'low';
  }
  if (refMax !== null && valNum > refMax) {
    return valNum > refMax * 2.0 ? 'critical' : 'high';
  }
  return '';
}

function createLabOrder(input = {}) {
  const db = getDb();
  const patient = ensurePatient(db, input.patient_id);
  const day = cleanText(input.day, 10) || toISODate();
  const status = input.status === 'completed' ? 'completed' : 'ordered';
  const info = db
    .prepare(
      `INSERT INTO lab_orders (patient_id, consultation_id, day, status, fasting_required, requested_tests, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      patient.id,
      input.consultation_id ? Number(input.consultation_id) || null : null,
      day,
      status,
      input.fasting_required ? 1 : 0,
      cleanText(input.requested_tests, 600),
      cleanText(input.notes, 500),
    );
  const orderId = info.lastInsertRowid;

  if (Array.isArray(input.results)) {
    for (const r of input.results) {
      addLabResult({ ...r, lab_order_id: orderId, patient_id: patient.id, day: r.day || day });
    }
  }
  return getLabOrder(orderId);
}

function addLabResult(input = {}) {
  const db = getDb();
  const patient = ensurePatient(db, input.patient_id);
  const label = cleanText(input.analyte_label, 120);
  if (!label) throw new AppError('INVALID_INPUT', 'Analyte label required.');
  const code =
    cleanText(input.analyte_code, 40).toUpperCase() ||
    label.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9]/g, '_').toUpperCase().slice(0, 30);
  const valNum = numOrNull(input.value_num);
  const refMin = numOrNull(input.ref_min);
  const refMax = numOrNull(input.ref_max);
  const flag =
    ['low', 'high', 'critical'].includes(input.abnormal_flag)
      ? input.abnormal_flag
      : computeAbnormalFlag(valNum, refMin, refMax);
  const day = cleanText(input.day, 10) || toISODate();

  const info = db
    .prepare(
      `INSERT INTO lab_results
        (lab_order_id, patient_id, day, analyte_code, analyte_label, value_num, value_text, unit, ref_min, ref_max, abnormal_flag)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.lab_order_id ? Number(input.lab_order_id) || null : null,
      patient.id,
      day,
      code,
      label,
      valNum,
      cleanText(input.value_text, 120),
      cleanText(input.unit, 30),
      refMin,
      refMax,
      flag,
    );
  if (input.lab_order_id) {
    db.prepare("UPDATE lab_orders SET status = 'completed' WHERE id = ?").run(Number(input.lab_order_id));
  }
  return db.prepare('SELECT * FROM lab_results WHERE id = ?').get(info.lastInsertRowid);
}

function getLabOrder(id) {
  const row = getDb().prepare('SELECT * FROM lab_orders WHERE id = ?').get(requireId(id));
  if (!row) throw new AppError('NOT_FOUND');
  const results = getDb()
    .prepare('SELECT * FROM lab_results WHERE lab_order_id = ? ORDER BY id ASC')
    .all(row.id);
  return { ...row, results };
}

function listLabs(patientId) {
  const id = requireId(patientId, 'patient_id');
  const orders = getDb()
    .prepare('SELECT * FROM lab_orders WHERE patient_id = ? ORDER BY day DESC, id DESC')
    .all(id);
  const results = getDb()
    .prepare('SELECT * FROM lab_results WHERE patient_id = ? ORDER BY day DESC, id DESC')
    .all(id);
  const byOrder = new Map();
  for (const r of results) {
    if (r.lab_order_id) {
      if (!byOrder.has(r.lab_order_id)) byOrder.set(r.lab_order_id, []);
      byOrder.get(r.lab_order_id).push(r);
    }
  }
  const trends = {};
  for (const r of [...results].reverse()) {
    if (r.value_num === null) continue;
    if (!trends[r.analyte_code]) {
      trends[r.analyte_code] = {
        analyte_code: r.analyte_code,
        analyte_label: r.analyte_label,
        unit: r.unit,
        points: [],
      };
    }
    trends[r.analyte_code].points.push({
      day: r.day,
      value_num: r.value_num,
      abnormal_flag: r.abnormal_flag,
    });
  }
  return {
    orders: orders.map((o) => ({ ...o, results: byOrder.get(o.id) || [] })),
    results,
    trends: Object.values(trends),
  };
}

function createImagingOrder(input = {}) {
  const db = getDb();
  const patient = ensurePatient(db, input.patient_id);
  const modalities = new Set(['rx', 'echo', 'ct', 'mri', 'ecg', 'other']);
  const modality = modalities.has(input.modality) ? input.modality : 'rx';
  const day = cleanText(input.day, 10) || toISODate();
  const findings = cleanText(input.findings, 2000);
  const status = input.status === 'completed' || findings ? 'completed' : 'ordered';
  const info = db
    .prepare(
      `INSERT INTO imaging_orders
        (patient_id, consultation_id, day, modality, body_region, indication, status, findings, abnormal_flag)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      patient.id,
      input.consultation_id ? Number(input.consultation_id) || null : null,
      day,
      modality,
      cleanText(input.body_region, 140),
      cleanText(input.indication, 400),
      status,
      findings,
      input.abnormal_flag ? 1 : 0,
    );
  return db.prepare('SELECT * FROM imaging_orders WHERE id = ?').get(info.lastInsertRowid);
}

function updateImagingOrder(input = {}) {
  const id = requireId(input.id);
  const existing = getDb().prepare('SELECT * FROM imaging_orders WHERE id = ?').get(id);
  if (!existing) throw new AppError('NOT_FOUND');
  const findings = input.findings !== undefined ? cleanText(input.findings, 2000) : existing.findings;
  const status = input.status || (findings ? 'completed' : existing.status);
  const abnormal = input.abnormal_flag !== undefined ? (input.abnormal_flag ? 1 : 0) : existing.abnormal_flag;
  getDb()
    .prepare('UPDATE imaging_orders SET findings = ?, status = ?, abnormal_flag = ? WHERE id = ?')
    .run(findings, status, abnormal, id);
  return getDb().prepare('SELECT * FROM imaging_orders WHERE id = ?').get(id);
}

function listImaging(patientId) {
  const id = requireId(patientId, 'patient_id');
  return getDb()
    .prepare('SELECT * FROM imaging_orders WHERE patient_id = ? ORDER BY day DESC, id DESC')
    .all(id);
}

/* -------------------------------------------------------------------------- */
/*  4. Algerian National Vaccination Schedule & Patient Log                   */
/* -------------------------------------------------------------------------- */

function ageInMonthsFromBirth(birthDate, refDay = toISODate()) {
  if (!birthDate) return null;
  const parts = String(birthDate).split('-').map(Number);
  if (!parts[0]) return null;
  const [ry, rm] = String(refDay).split('-').map(Number);
  const by = parts[0];
  const bm = parts[1] || 1;
  return Math.max(0, (ry - by) * 12 + (rm - bm));
}

function listVaccinations(patientId) {
  const db = getDb();
  const patient = ensurePatient(db, patientId);
  const schedule = db.prepare('SELECT * FROM vaccine_schedule ORDER BY recommended_age_months ASC, id ASC').all();
  const administered = db
    .prepare('SELECT * FROM patient_vaccinations WHERE patient_id = ? ORDER BY administered_day DESC, id DESC')
    .all(patient.id);
  const doneCodes = new Set(administered.map((v) => v.vaccine_code));
  const ageMonths = ageInMonthsFromBirth(patient.birth_date);

  const due = [];
  if (ageMonths !== null) {
    for (const item of schedule) {
      if (doneCodes.has(item.vaccine_code)) continue;
      if (ageMonths >= item.recommended_age_months) {
        due.push({
          ...item,
          status: ageMonths > item.recommended_age_months + 2 ? 'overdue' : 'due',
        });
      }
    }
  }
  return { schedule, administered, due, age_months: ageMonths };
}

function recordVaccination(input = {}) {
  const db = getDb();
  const patient = ensurePatient(db, input.patient_id);
  const vaccineName = cleanText(input.vaccine_name, 160);
  const vaccineCode = cleanText(input.vaccine_code, 40) || vaccineName.toUpperCase().slice(0, 30);
  if (!vaccineName) throw new AppError('INVALID_INPUT', 'Vaccine name required.');
  const adminDay = cleanText(input.administered_day, 10) || toISODate();
  let nextDue = cleanText(input.next_due_day, 10);
  if (!nextDue && vaccineCode) {
    const sched = db.prepare('SELECT booster_interval_months FROM vaccine_schedule WHERE vaccine_code = ?').get(vaccineCode);
    if (sched?.booster_interval_months) {
      nextDue = addDays(adminDay, sched.booster_interval_months * 30);
    }
  }
  const info = db
    .prepare(
      `INSERT INTO patient_vaccinations
        (patient_id, vaccine_code, vaccine_name, dose_label, administered_day, lot_number, next_due_day, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      patient.id,
      vaccineCode,
      vaccineName,
      cleanText(input.dose_label, 80),
      adminDay,
      cleanText(input.lot_number, 60),
      nextDue,
      cleanText(input.notes, 300),
    );
  return db.prepare('SELECT * FROM patient_vaccinations WHERE id = ?').get(info.lastInsertRowid);
}

/* -------------------------------------------------------------------------- */
/*  5. Pregnancy Follow-up & WHO Child Growth Percentiles                     */
/* -------------------------------------------------------------------------- */

function diffDaysISO(startIso, endIso) {
  const a = new Date(`${String(startIso).slice(0, 10)}T00:00:00Z`).getTime();
  const b = new Date(`${String(endIso).slice(0, 10)}T00:00:00Z`).getTime();
  return Math.round((b - a) / 86400000);
}

function createPregnancyEpisode(input = {}) {
  const db = getDb();
  const patient = ensurePatient(db, input.patient_id);
  const ddr = cleanText(input.ddr, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ddr)) throw new AppError('INVALID_DATE');
  const dpa = cleanText(input.dpa, 10) || addDays(ddr, 280); // Naegele's 40 SA rule
  const info = db
    .prepare(
      `INSERT INTO pregnancy_episodes
        (patient_id, ddr, dpa, gravida, para, risk_level, risk_notes, status, outcome)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      patient.id,
      ddr,
      dpa,
      Math.max(1, intOrNull(input.gravida) || 1),
      Math.max(0, intOrNull(input.para) || 0),
      input.risk_level === 'high' ? 'high' : 'normal',
      cleanText(input.risk_notes, 500),
      ['active', 'delivered', 'closed'].includes(input.status) ? input.status : 'active',
      cleanText(input.outcome, 300),
    );
  return db.prepare('SELECT * FROM pregnancy_episodes WHERE id = ?').get(info.lastInsertRowid);
}

function addPregnancyVisit(input = {}) {
  const db = getDb();
  const episodeId = requireId(input.episode_id);
  const ep = db.prepare('SELECT * FROM pregnancy_episodes WHERE id = ?').get(episodeId);
  if (!ep) throw new AppError('NOT_FOUND');
  const day = cleanText(input.day, 10) || toISODate();
  const gaWeeks =
    numOrNull(input.gestational_weeks) ??
    Math.max(0, Math.round((diffDaysISO(ep.ddr, day) / 7) * 10) / 10);

  const info = db
    .prepare(
      `INSERT INTO pregnancy_visits
        (episode_id, patient_id, day, gestational_weeks, weight_kg, bp,
         uterine_height_cm, fetal_hr, albuminuria, glycosuria, ultrasound_notes, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      ep.id,
      ep.patient_id,
      day,
      gaWeeks,
      numOrNull(input.weight_kg),
      cleanText(input.bp, 30),
      numOrNull(input.uterine_height_cm),
      intOrNull(input.fetal_hr),
      cleanText(input.albuminuria, 40),
      cleanText(input.glycosuria, 40),
      cleanText(input.ultrasound_notes, 1000),
      cleanText(input.notes, 500),
    );
  return db.prepare('SELECT * FROM pregnancy_visits WHERE id = ?').get(info.lastInsertRowid);
}

function listPregnancy(patientId) {
  const id = requireId(patientId, 'patient_id');
  const episodes = getDb()
    .prepare('SELECT * FROM pregnancy_episodes WHERE patient_id = ? ORDER BY id DESC')
    .all(id);
  const visits = getDb()
    .prepare('SELECT * FROM pregnancy_visits WHERE patient_id = ? ORDER BY day DESC, id DESC')
    .all(id);
  return episodes.map((ep) => ({
    ...ep,
    current_gestational_weeks:
      ep.status === 'active'
        ? Math.max(0, Math.round((diffDaysISO(ep.ddr, toISODate()) / 7) * 10) / 10)
        : null,
    visits: visits.filter((v) => v.episode_id === ep.id),
  }));
}

// Simplified WHO Child Growth Standards reference anchor points (0..120 months) [ageMonths, medianWeightKg, sdWeight, medianHeightCm, sdHeight]
const WHO_GROWTH_BOYS = [
  [0, 3.3, 0.45, 49.9, 1.9],
  [3, 6.4, 0.75, 61.4, 2.1],
  [6, 7.9, 0.88, 67.6, 2.2],
  [12, 9.6, 1.05, 75.7, 2.4],
  [24, 12.2, 1.35, 87.8, 3.1],
  [36, 14.3, 1.65, 96.1, 3.7],
  [60, 18.3, 2.35, 110.0, 4.6],
  [84, 22.9, 3.2, 121.7, 5.2],
  [120, 31.2, 5.1, 137.8, 6.0],
];

const WHO_GROWTH_GIRLS = [
  [0, 3.2, 0.44, 49.1, 1.9],
  [3, 5.8, 0.72, 59.8, 2.1],
  [6, 7.3, 0.86, 65.7, 2.2],
  [12, 8.9, 1.05, 74.0, 2.5],
  [24, 11.5, 1.35, 86.4, 3.2],
  [36, 13.9, 1.7, 95.1, 3.8],
  [60, 18.2, 2.45, 109.4, 4.7],
  [84, 22.4, 3.4, 120.8, 5.3],
  [120, 31.9, 5.6, 138.6, 6.2],
];

function erf(x) {
  const sign = x >= 0 ? 1 : -1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
  return sign * y;
}

function zToPercentile(z) {
  return Math.round(0.5 * (1 + erf(z / Math.SQRT2)) * 1000) / 10;
}

function interpolateWho(table, ageMonths) {
  const m = Math.max(0, Math.min(120, Number(ageMonths) || 0));
  for (let i = 0; i < table.length - 1; i++) {
    const a = table[i];
    const b = table[i + 1];
    if (m >= a[0] && m <= b[0]) {
      const ratio = (m - a[0]) / (b[0] - a[0] || 1);
      return {
        wMed: a[1] + (b[1] - a[1]) * ratio,
        wSd: a[2] + (b[2] - a[2]) * ratio,
        hMed: a[3] + (b[3] - a[3]) * ratio,
        hSd: a[4] + (b[4] - a[4]) * ratio,
      };
    }
  }
  const last = table[table.length - 1];
  return { wMed: last[1], wSd: last[2], hMed: last[3], hSd: last[4] };
}

function computeWhoGrowth({ gender = 'm', age_months, weight_kg, height_cm } = {}) {
  const ageM = numOrNull(age_months);
  if (ageM === null || ageM < 0 || ageM > 120) {
    throw new AppError('INVALID_INPUT', 'WHO child growth applies to 0–120 months.');
  }
  const table = gender === 'f' ? WHO_GROWTH_GIRLS : WHO_GROWTH_BOYS;
  const ref = interpolateWho(table, ageM);
  const w = numOrNull(weight_kg);
  const h = numOrNull(height_cm);
  const out = { age_months: ageM, gender: gender === 'f' ? 'f' : 'm', disclaimer: 'reference_only' };
  if (w !== null) {
    const zW = Math.round(((w - ref.wMed) / ref.wSd) * 100) / 100;
    out.weight_z = zW;
    out.weight_percentile = zToPercentile(zW);
    out.weight_alert = zW < -2 ? 'underweight' : zW > 2 ? 'overweight' : 'normal';
  }
  if (h !== null) {
    const zH = Math.round(((h - ref.hMed) / ref.hSd) * 100) / 100;
    out.height_z = zH;
    out.height_percentile = zToPercentile(zH);
    out.height_alert = zH < -2 ? 'stunting' : 'normal';
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  6. Longitudinal Vitals Dashboards & Unified Patient Timeline              */
/* -------------------------------------------------------------------------- */

function vitalsTrends(patientId) {
  const db = getDb();
  const id = requireId(patientId, 'patient_id');
  const bp = [];
  const glycemia = [];

  const consults = db
    .prepare('SELECT day, vitals_bp_sys, vitals_bp_dia, vitals_glycemia FROM consultations WHERE patient_id = ? ORDER BY day ASC, id ASC')
    .all(id);
  for (const c of consults) {
    if (c.vitals_bp_sys && c.vitals_bp_dia) {
      bp.push({ day: c.day, sys: c.vitals_bp_sys, dia: c.vitals_bp_dia, source: 'consultation' });
    }
    if (c.vitals_glycemia !== null && c.vitals_glycemia !== undefined) {
      glycemia.push({ day: c.day, value: c.vitals_glycemia, source: 'consultation' });
    }
  }

  const rxs = db
    .prepare('SELECT day, vitals_bp, vitals_glycemia FROM prescriptions WHERE patient_id = ? ORDER BY day ASC, id ASC')
    .all(id);
  for (const r of rxs) {
    if (r.vitals_bp) {
      const m = String(r.vitals_bp).match(/(\d{2,3})\s*[/\-]\s*(\d{2,3})/);
      if (m) bp.push({ day: r.day, sys: Number(m[1]), dia: Number(m[2]), source: 'prescription' });
    }
    if (r.vitals_glycemia) {
      const g = numOrNull(r.vitals_glycemia);
      if (g !== null) glycemia.push({ day: r.day, value: g, source: 'prescription' });
    }
  }

  bp.sort((a, b) => a.day.localeCompare(b.day));
  glycemia.sort((a, b) => a.day.localeCompare(b.day));
  return { bp, glycemia };
}

function patientTimeline(patientId) {
  const db = getDb();
  const id = requireId(patientId, 'patient_id');
  const events = [];

  for (const c of listConsultations(id)) {
    events.push({
      kind: 'consultation',
      day: c.day,
      id: c.id,
      title: c.chief_complaint || c.assessment || 'Consultation clinique',
      detail: [c.assessment, c.plan].filter(Boolean).join(' · '),
    });
  }

  const rxs = db
    .prepare('SELECT id, day, diagnosis, doctor_name FROM prescriptions WHERE patient_id = ?')
    .all(id);
  for (const rx of rxs) {
    events.push({
      kind: 'prescription',
      day: rx.day,
      id: rx.id,
      title: rx.diagnosis || `Ordonnance #${rx.id}`,
      detail: rx.doctor_name || '',
    });
  }

  const appts = db
    .prepare('SELECT id, day, status, treatment_name, queue_number FROM appointments WHERE patient_id = ?')
    .all(id);
  for (const a of appts) {
    events.push({
      kind: 'appointment',
      day: a.day,
      id: a.id,
      title: a.treatment_name || `RDV #${a.queue_number}`,
      detail: a.status,
    });
  }

  const labs = db.prepare('SELECT id, day, status, requested_tests FROM lab_orders WHERE patient_id = ?').all(id);
  for (const l of labs) {
    events.push({
      kind: 'lab',
      day: l.day,
      id: l.id,
      title: l.requested_tests || 'Bilan biologique',
      detail: l.status,
    });
  }

  for (const im of listImaging(id)) {
    events.push({
      kind: 'imaging',
      day: im.day,
      id: im.id,
      title: `${im.modality.toUpperCase()} — ${im.body_region || im.indication}`,
      detail: im.findings || im.status,
    });
  }

  const vacs = db.prepare('SELECT id, administered_day, vaccine_name, dose_label FROM patient_vaccinations WHERE patient_id = ?').all(id);
  for (const v of vacs) {
    events.push({
      kind: 'vaccination',
      day: v.administered_day,
      id: v.id,
      title: v.vaccine_name,
      detail: v.dose_label,
    });
  }

  for (const doc of listDocuments(id)) {
    events.push({
      kind: 'document',
      day: doc.day,
      id: doc.id,
      title: doc.title,
      detail: doc.category,
    });
  }

  events.sort((a, b) => b.day.localeCompare(a.day) || b.id - a.id);
  return events;
}

module.exports = {
  createConsultation,
  listConsultations,
  removeConsultation,
  attachDocument,
  listDocuments,
  readDocument,
  removeDocument,
  createLabOrder,
  addLabResult,
  getLabOrder,
  listLabs,
  createImagingOrder,
  updateImagingOrder,
  listImaging,
  listVaccinations,
  recordVaccination,
  createPregnancyEpisode,
  addPregnancyVisit,
  listPregnancy,
  computeWhoGrowth,
  vitalsTrends,
  patientTimeline,
};
