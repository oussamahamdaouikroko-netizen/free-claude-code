const fs = require('node:fs');
const { AppError, cleanText, requireId } = require('../utils/common');
const { foldSearch, parseCsvText } = require('./nomenclature');

function buildIcdFolded(row) {
  return foldSearch(`${row.code || ''} ${row.label_fr || ''} ${row.label_ar || ''} ${row.chapter || ''}`);
}

function searchIcd10(db, { query = '', limit = 30, aldOnly = false, notifiableOnly = false } = {}) {
  const safeLimit = Math.min(200, Math.max(1, Number(limit) || 30));
  const raw = cleanText(query, 100);
  const filters = [];
  const params = [];

  if (aldOnly) filters.push('i.is_chronic_ald = 1');
  if (notifiableOnly) filters.push('i.is_notifiable = 1');

  if (!raw) {
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    return db
      .prepare(`SELECT i.* FROM icd10 i ${where} ORDER BY i.is_chronic_ald DESC, i.code ASC LIMIT ?`)
      .all(...params, safeLimit);
  }

  const folded = foldSearch(raw);
  const tokens = folded
    .split(/\s+/)
    .map((tok) => tok.replace(/[^a-z0-9.\u0600-\u06ff]/gi, ''))
    .filter(Boolean);

  if (tokens.length > 0) {
    try {
      const ftsQuery = tokens.map((tok) => `"${tok.replace(/"/g, '')}"*`).join(' AND ');
      const whereExtra = filters.length ? `AND ${filters.join(' AND ')}` : '';
      const rows = db
        .prepare(
          `SELECT i.*
           FROM icd10_fts f
           JOIN icd10 i ON i.id = f.rowid
           WHERE icd10_fts MATCH ? ${whereExtra}
           ORDER BY CASE WHEN UPPER(i.code) = UPPER(?) THEN 0 ELSE 1 END, rank, i.code ASC
           LIMIT ?`,
        )
        .all(ftsQuery, raw, safeLimit);
      if (rows.length > 0) return rows;
    } catch (_) {
      // Fallback to indexed LIKE search below
    }
  }

  const q = `%${raw.toLowerCase()}%`;
  const qFolded = `%${folded}%`;
  const whereExtra = filters.length ? `AND ${filters.join(' AND ')}` : '';
  return db
    .prepare(
      `SELECT i.* FROM icd10 i
       WHERE (LOWER(i.code) LIKE ? OR LOWER(i.label_fr) LIKE ? OR i.label_ar LIKE ? OR i.folded_search LIKE ?)
       ${whereExtra}
       ORDER BY CASE WHEN UPPER(i.code) = UPPER(?) THEN 0 ELSE 1 END, i.code ASC
       LIMIT ?`,
    )
    .all(q, q, `%${raw}%`, qFolded, raw, safeLimit);
}

function upsertIcd10(db, payload = {}) {
  const code = cleanText(payload.code, 20).toUpperCase();
  const labelFr = cleanText(payload.label_fr, 240);
  if (!code || !labelFr) {
    throw new AppError('INVALID_INPUT', 'ICD-10 code and French label are required.');
  }
  const labelAr = cleanText(payload.label_ar, 240);
  const chapter = cleanText(payload.chapter, 120);
  const isChronicAld = payload.is_chronic_ald ? 1 : 0;
  const isNotifiable = payload.is_notifiable ? 1 : 0;
  const source = cleanText(payload.source, 30) || 'custom';
  const verified = payload.verified ? 1 : 0;
  const folded = buildIcdFolded({ code, label_fr: labelFr, label_ar: labelAr, chapter });

  const existing = db.prepare('SELECT id FROM icd10 WHERE UPPER(code) = ?').get(code);
  if (existing) {
    db.prepare(
      `UPDATE icd10 SET
         code = ?, label_fr = ?, label_ar = ?, chapter = ?,
         is_chronic_ald = ?, is_notifiable = ?, folded_search = ?,
         source = ?, verified = ?, updated_at = datetime('now')
       WHERE id = ?`,
    ).run(code, labelFr, labelAr, chapter, isChronicAld, isNotifiable, folded, source, verified, existing.id);
    return db.prepare('SELECT * FROM icd10 WHERE id = ?').get(existing.id);
  }
  const info = db
    .prepare(
      `INSERT INTO icd10
        (code, label_fr, label_ar, chapter, is_chronic_ald, is_notifiable, folded_search, source, verified)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(code, labelFr, labelAr, chapter, isChronicAld, isNotifiable, folded, source, verified);
  return db.prepare('SELECT * FROM icd10 WHERE id = ?').get(info.lastInsertRowid);
}

function importIcd10(db, { format = 'csv', content, filePath, markVerified = false } = {}) {
  let rawContent = content;
  let fmt = String(format || '').toLowerCase();
  if (filePath) {
    if (!fs.existsSync(filePath)) throw new AppError('FILE_NOT_FOUND', 'ICD-10 file not found.');
    rawContent = fs.readFileSync(filePath, 'utf8');
    if (filePath.toLowerCase().endsWith('.json')) fmt = 'json';
    else fmt = 'csv';
  }
  if (!rawContent || !String(rawContent).trim()) {
    throw new AppError('INVALID_INPUT', 'Empty ICD-10 import payload.');
  }

  let rows = [];
  if (fmt === 'json') {
    try {
      const parsed = JSON.parse(rawContent);
      rows = Array.isArray(parsed) ? parsed : parsed.rows || parsed.codes || [];
    } catch (_) {
      throw new AppError('INVALID_IMPORT_FORMAT', 'Invalid JSON format.');
    }
  } else {
    rows = parseCsvText(rawContent);
  }
  if (!rows.length) throw new AppError('INVALID_INPUT', 'No ICD-10 rows found.');

  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  const parseBool = (val) => {
    if (val === true || val === 1) return 1;
    const s = foldSearch(val);
    return ['1', 'oui', 'yes', 'true', 'ald', 'mdo'].includes(s) ? 1 : 0;
  };

  const tx = db.transaction(() => {
    for (const r of rows) {
      const code = cleanText(r.code || r.cim10 || r.icd10 || r['code cim10'], 20).toUpperCase();
      const labelFr = cleanText(r.label_fr || r.libelle || r.libelle_fr || r.label || r.intitule, 240);
      if (!code || !labelFr) {
        skipped += 1;
        continue;
      }
      const labelAr = cleanText(r.label_ar || r.libelle_ar || '', 240);
      const chapter = cleanText(r.chapter || r.chapitre || '', 120);
      const isAld = parseBool(r.is_chronic_ald ?? r.ald ?? r.chronique);
      const isMdo = parseBool(r.is_notifiable ?? r.mdo ?? r.notifiable ?? r.declaration_obligatoire);
      const verified = markVerified ? 1 : parseBool(r.verified);
      const folded = buildIcdFolded({ code, label_fr: labelFr, label_ar: labelAr, chapter });

      const existing = db.prepare('SELECT id FROM icd10 WHERE UPPER(code) = ?').get(code);
      if (existing) {
        db.prepare(
          `UPDATE icd10 SET
             label_fr = ?, label_ar = CASE WHEN ? != '' THEN ? ELSE label_ar END,
             chapter = CASE WHEN ? != '' THEN ? ELSE chapter END,
             is_chronic_ald = ?, is_notifiable = ?, folded_search = ?,
             source = 'import', verified = ?, updated_at = datetime('now')
           WHERE id = ?`,
        ).run(labelFr, labelAr, labelAr, chapter, chapter, isAld, isMdo, folded, verified, existing.id);
        updated += 1;
      } else {
        db.prepare(
          `INSERT INTO icd10
            (code, label_fr, label_ar, chapter, is_chronic_ald, is_notifiable, folded_search, source, verified)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'import', ?)`,
        ).run(code, labelFr, labelAr, chapter, isAld, isMdo, folded, verified);
        inserted += 1;
      }
    }
  });
  tx();

  return {
    inserted,
    updated,
    skipped,
    total: db.prepare('SELECT COUNT(*) AS n FROM icd10').get().n,
  };
}

function verifyIcd10(db, { id, verified = 1 } = {}) {
  const rowId = requireId(id, 'icd10');
  db.prepare("UPDATE icd10 SET verified = ?, updated_at = datetime('now') WHERE id = ?").run(verified ? 1 : 0, rowId);
  return db.prepare('SELECT * FROM icd10 WHERE id = ?').get(rowId);
}

function icd10Summary(db) {
  return db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         COALESCE(SUM(CASE WHEN is_chronic_ald = 1 THEN 1 ELSE 0 END), 0) AS ald_count,
         COALESCE(SUM(CASE WHEN is_notifiable = 1 THEN 1 ELSE 0 END), 0) AS notifiable_count,
         COALESCE(SUM(CASE WHEN verified = 1 THEN 1 ELSE 0 END), 0) AS verified_count
       FROM icd10`,
    )
    .get();
}

function diagnosisStats(db, { start, end, department_id } = {}) {
  const filters = ['1 = 1'];
  const params = [];
  if (start) {
    filters.push('pd.day >= ?');
    params.push(cleanText(start, 10));
  }
  if (end) {
    filters.push('pd.day <= ?');
    params.push(cleanText(end, 10));
  }
  if (department_id) {
    filters.push('pd.department_id = ?');
    params.push(Number(department_id));
  }
  const where = `WHERE ${filters.join(' AND ')}`;

  const totals = db
    .prepare(
      `SELECT
         COUNT(*) AS total_diagnoses,
         COUNT(DISTINCT pd.prescription_id) AS prescriptions_with_diag,
         COALESCE(SUM(CASE WHEN pd.is_chronic_ald = 1 THEN 1 ELSE 0 END), 0) AS chronic_ald_cases,
         COALESCE(SUM(CASE WHEN pd.is_notifiable = 1 THEN 1 ELSE 0 END), 0) AS notifiable_cases
       FROM prescription_diagnoses pd
       ${where}`,
    )
    .get(...params);

  const byCode = db
    .prepare(
      `SELECT
         CASE WHEN pd.icd10_code != '' THEN pd.icd10_code ELSE 'LIBRE' END AS code,
         COALESCE(NULLIF(pd.label_fr, ''), pd.free_text) AS label_fr,
         pd.label_ar,
         MAX(pd.is_chronic_ald) AS is_chronic_ald,
         MAX(pd.is_notifiable) AS is_notifiable,
         COUNT(*) AS count
       FROM prescription_diagnoses pd
       ${where}
       GROUP BY code, label_fr
       ORDER BY count DESC, code ASC
       LIMIT 20`,
    )
    .all(...params);

  const byDepartment = db
    .prepare(
      `SELECT
         COALESCE(d.name_fr, 'Non spécifié') AS name_fr,
         COALESCE(d.name_ar, 'غير محدد') AS name_ar,
         COUNT(*) AS count
       FROM prescription_diagnoses pd
       LEFT JOIN departments d ON d.id = pd.department_id
       ${where}
       GROUP BY pd.department_id
       ORDER BY count DESC`,
    )
    .all(...params);

  const currentYear = new Date().getFullYear();
  const byAgeGroup = db
    .prepare(
      `SELECT
         CASE
           WHEN p.birth_date IS NULL OR TRIM(p.birth_date) = '' THEN 'unknown'
           WHEN (? - CAST(substr(p.birth_date, 1, 4) AS INTEGER)) < 15 THEN '0_14'
           WHEN (? - CAST(substr(p.birth_date, 1, 4) AS INTEGER)) < 45 THEN '15_44'
           WHEN (? - CAST(substr(p.birth_date, 1, 4) AS INTEGER)) < 65 THEN '45_64'
           ELSE '65_plus'
         END AS age_group,
         COUNT(*) AS count
       FROM prescription_diagnoses pd
       LEFT JOIN patients p ON p.id = pd.patient_id
       ${where}
       GROUP BY age_group
       ORDER BY count DESC`,
    )
    .all(currentYear, currentYear, currentYear, ...params);

  const notifiableAlerts = db
    .prepare(
      `SELECT pd.*, p.full_name AS patient_name, d.name_fr AS department_name_fr, d.name_ar AS department_name_ar
       FROM prescription_diagnoses pd
       LEFT JOIN patients p ON p.id = pd.patient_id
       LEFT JOIN departments d ON d.id = pd.department_id
       ${where} AND pd.is_notifiable = 1
       ORDER BY pd.day DESC, pd.id DESC
       LIMIT 30`,
    )
    .all(...params);

  return {
    totals,
    by_code: byCode,
    by_department: byDepartment,
    by_age_group: byAgeGroup,
    notifiable_alerts: notifiableAlerts,
  };
}

module.exports = {
  buildIcdFolded,
  searchIcd10,
  upsertIcd10,
  importIcd10,
  verifyIcd10,
  icd10Summary,
  diagnosisStats,
};
