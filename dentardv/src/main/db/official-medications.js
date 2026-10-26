'use strict';
/**
 * Bundled Official Algerian Dental Medications Catalog (`dental-medications.csv.gz`).
 *
 * Strictly filtered from the Algerian National Nomenclature (MIPH) to retain ONLY
 * dental / odonto-stomatological outpatient medications and dental local anesthetics
 * (575 registered Algerian specialties — zero non-dental specialties or hospital IVs).
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { normalizeSearch } = require('../utils/common');

const GZ_PATH = path.join(__dirname, 'dental-medications.csv.gz');

let cachedCatalog = null;

function foldText(str) {
  return normalizeSearch(str);
}

function makeGroup(dci, strength) {
  const d = foldText(dci);
  const s = foldText(strength).replace(/\s+/g, '');
  if (!d) return '';
  return `${d}|${s}`;
}

function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let cur = '';
  let inQuotes = false;
  const s = String(text || '').replace(/^\uFEFF/, '');
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(cur);
      cur = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i += 1;
      row.push(cur);
      cur = '';
      if (row.some((cell) => cell.trim() !== '')) rows.push(row);
      row = [];
    } else {
      cur += ch;
    }
  }
  if (cur.length > 0 || row.length > 0) {
    row.push(cur);
    if (row.some((cell) => cell.trim() !== '')) rows.push(row);
  }
  return rows;
}

function normalizeSchedule(rawList) {
  const f = foldText(rawList);
  if (!f) return '';
  if (f.includes('stupefiant')) return 'stupefiant';
  if (f.includes('psychotrope')) return 'psychotrope';
  if (/liste\s*ii\b|liste\s*2/.test(f)) return 'liste_ii';
  if (/liste\s*i\b|liste\s*1/.test(f)) return 'liste_i';
  return '';
}

function loadOfficialDentalMedications() {
  if (cachedCatalog) return cachedCatalog;
  if (!fs.existsSync(GZ_PATH)) {
    cachedCatalog = [];
    return cachedCatalog;
  }

  const csvText = zlib.gunzipSync(fs.readFileSync(GZ_PATH)).toString('utf8');
  const matrix = parseCsvRows(csvText);
  if (matrix.length < 2) {
    cachedCatalog = [];
    return cachedCatalog;
  }

  const headers = matrix[0].map((h) => String(h || '').trim());
  const idx = (name) => headers.indexOf(name);

  const iReg = idx('registrationNumber');
  const iCode = idx('code');
  const iDci = idx('dci');
  const iBrand = idx('brandName');
  const iForm = idx('form');
  const iDosage = idx('dosage');
  const iPack = idx('packaging');
  const iList = idx('list');
  const iLab = idx('laboratory');
  const iCountry = idx('country');
  const iExp = idx('registrationDateFinal');
  const iType = idx('type');
  const iSpec = idx('dentalSpecialty');

  const records = [];
  for (let r = 1; r < matrix.length; r += 1) {
    const row = matrix[r];
    const dci = String(row[iDci] || '').trim().slice(0, 180);
    const brand = String(row[iBrand] || dci || '').trim().slice(0, 140);
    if (!brand && !dci) continue;

    const strength = String(row[iDosage] || '').trim().slice(0, 80);
    const baseForm = String(row[iForm] || '').trim();
    const pack = String(row[iPack] || '').trim();
    const fullForm = (pack ? `${baseForm} (${pack})` : baseForm || 'Comprimé').slice(0, 120);
    const regNum = String(row[iReg] || row[iCode] || '').trim().slice(0, 60);
    const laboratory = String(row[iLab] || '').trim().slice(0, 140);
    const country = String(row[iCountry] || '').trim().slice(0, 80);
    const expiry = String(row[iExp] || '').trim().slice(0, 30);
    const rawType = String(row[iType] || '').trim().toUpperCase();
    const isGeneric = rawType === 'GE' ? 1 : 0;
    const schedule = normalizeSchedule(row[iList]);
    const specialty = String(row[iSpec] || 'stomato').trim();
    const dciGroup = makeGroup(dci, strength);
    const nameNorm = normalizeSearch(brand);
    const folded = normalizeSearch(`${brand} ${dci} ${strength} ${fullForm} ${laboratory} ${regNum} ${specialty}`);

    records.push([
      brand,
      dci,
      strength,
      fullForm,
      specialty,
      regNum,
      laboratory,
      country,
      isGeneric,
      dciGroup,
      schedule,
      expiry,
      nameNorm,
      folded,
    ]);
  }

  cachedCatalog = records;
  return cachedCatalog;
}

function seedOfficialDentalMedications(db) {
  const existing = db
    .prepare("SELECT COUNT(*) AS n FROM medications WHERE source = 'official_dz'")
    .get().n;
  if (existing > 0) return 0;

  const catalog = loadOfficialDentalMedications();
  if (catalog.length === 0) return 0;

  const insertStmt = db.prepare(`
    INSERT INTO medications
      (brand, dci, strength, form, specialty, keywords_ar, default_dosage, default_duration,
       registration_number, laboratory, country, is_generic, reference_dci_group,
       schedule, marketed, expiry_of_registration,
       source, verified, last_updated, name_normalized, folded_search, custom, active)
    VALUES
      (?, ?, ?, ?, ?, '', '', '',
       ?, ?, ?, ?, ?,
       ?, 1, ?,
       'official_dz', 1, '2026-10-26', ?, ?, 0, 1)
  `);

  const bulkTx = db.transaction((rows) => {
    db.exec('DROP TRIGGER IF EXISTS trg_medications_ai;');
    for (let i = 0; i < rows.length; i += 1) {
      insertStmt.run(...rows[i]);
    }
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_medications_ai AFTER INSERT ON medications BEGIN
        INSERT INTO medications_fts(rowid, brand, dci, strength, form, laboratory, keywords_ar, folded_search)
        VALUES (new.id, new.brand, new.dci, new.strength, new.form, new.laboratory, new.keywords_ar, new.folded_search);
      END;
      INSERT INTO medications_fts(medications_fts) VALUES('rebuild');
    `);
  });

  bulkTx(catalog);
  return catalog.length;
}

module.exports = {
  loadOfficialDentalMedications,
  seedOfficialDentalMedications,
};
