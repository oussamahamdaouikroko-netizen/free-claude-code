'use strict';
/**
 * Phase 3 — Algerian National Drug Nomenclature Service.
 *
 * Capabilities:
 *  - Offline CSV / TSV / JSON / XLSX Nomenclature importer (zero external deps,
 *    built-in ZIP + XML worksheet parser using `node:zlib`).
 *  - High-speed FTS5 + folded index search for 5,000+ drug rows.
 *  - Generic substitution & CNAS reference-price / reimbursement lookup.
 */

const fs = require('node:fs');
const zlib = require('node:zlib');
const { getDb } = require('../db');
const { AppError, cleanText, requireId } = require('../utils/common');
const { toISODate } = require('../utils/dates');

function foldSearch(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[\u0610-\u061A\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .trim();
}

function makeDciGroup(dci, strength) {
  const d = foldSearch(dci).replace(/\s+/g, ' ');
  const s = foldSearch(strength).replace(/\s+/g, '');
  if (!d) return '';
  return `${d}|${s}`;
}

/* -------------------------------------------------------------------------- */
/*  Zero-dependency XLSX reader (ZIP Central Directory + XML sheet1)          */
/* -------------------------------------------------------------------------- */

function decodeXmlEntities(str) {
  return String(str || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&amp;/g, '&');
}

function readZipEntries(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const entries = new Map();

  // Locate End of Central Directory (0x06054b50)
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) throw new AppError('INVALID_XLSX_FILE');

  const totalEntries = buf.readUInt16LE(eocdOffset + 10);
  let cdOffset = buf.readUInt32LE(eocdOffset + 16);

  for (let n = 0; n < totalEntries && cdOffset + 46 <= buf.length; n += 1) {
    if (buf.readUInt32LE(cdOffset) !== 0x02014b50) break;
    const method = buf.readUInt16LE(cdOffset + 10);
    const compSize = buf.readUInt32LE(cdOffset + 20);
    const nameLen = buf.readUInt16LE(cdOffset + 28);
    const extraLen = buf.readUInt16LE(cdOffset + 30);
    const commentLen = buf.readUInt16LE(cdOffset + 32);
    const localHeaderOffset = buf.readUInt32LE(cdOffset + 42);
    const name = buf.slice(cdOffset + 46, cdOffset + 46 + nameLen).toString('utf8');

    if (localHeaderOffset + 30 <= buf.length && buf.readUInt32LE(localHeaderOffset) === 0x04034b50) {
      const lNameLen = buf.readUInt16LE(localHeaderOffset + 26);
      const lExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
      const dataStart = localHeaderOffset + 30 + lNameLen + lExtraLen;
      const rawSlice = buf.slice(dataStart, dataStart + compSize);
      if (method === 0) {
        entries.set(name, rawSlice);
      } else if (method === 8) {
        entries.set(name, zlib.inflateRawSync(rawSlice));
      }
    }
    cdOffset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function colLettersToIndex(letters) {
  let idx = 0;
  for (let i = 0; i < letters.length; i += 1) {
    idx = idx * 26 + (letters.charCodeAt(i) - 64);
  }
  return idx - 1;
}

function parseXlsxBuffer(buffer) {
  const entries = readZipEntries(buffer);
  const sharedStrings = [];
  if (entries.has('xl/sharedStrings.xml')) {
    const sstXml = entries.get('xl/sharedStrings.xml').toString('utf8');
    const siMatches = sstXml.match(/<si[\s>][\s\S]*?<\/si>/g) || [];
    for (const si of siMatches) {
      const tParts = [];
      const tRe = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
      let m;
      while ((m = tRe.exec(si)) !== null) {
        tParts.push(decodeXmlEntities(m[1]));
      }
      sharedStrings.push(tParts.join(''));
    }
  }

  const sheetKey =
    Array.from(entries.keys()).find((k) => /^xl\/worksheets\/sheet1\.xml$/i.test(k)) ||
    Array.from(entries.keys()).find((k) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(k));
  if (!sheetKey) throw new AppError('INVALID_XLSX_FILE');

  const sheetXml = entries.get(sheetKey).toString('utf8');
  const rowMatches = sheetXml.match(/<row[\s>][\s\S]*?<\/row>/g) || [];
  const matrix = [];

  for (const rowXml of rowMatches) {
    const cells = [];
    const cellRe = /<c\b([^>]*)>([\s\S]*?)<\/c>/g;
    let cm;
    while ((cm = cellRe.exec(rowXml)) !== null) {
      const attrs = cm[1];
      const inner = cm[2];
      const refMatch = attrs.match(/\br="([A-Z]+)\d+"/);
      const colIdx = refMatch ? colLettersToIndex(refMatch[1]) : cells.length;
      const typeMatch = attrs.match(/\bt="([^"]+)"/);
      const cellType = typeMatch ? typeMatch[1] : '';

      let val = '';
      if (cellType === 'inlineStr') {
        const tm = inner.match(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/);
        val = tm ? decodeXmlEntities(tm[1]) : '';
      } else {
        const vm = inner.match(/<v>([\s\S]*?)<\/v>/);
        const rawV = vm ? decodeXmlEntities(vm[1]) : '';
        if (cellType === 's') {
          val = sharedStrings[Number.parseInt(rawV, 10)] ?? '';
        } else {
          val = rawV;
        }
      }
      cells[colIdx] = val;
    }
    if (cells.some((c) => String(c || '').trim() !== '')) {
      matrix.push(cells);
    }
  }

  if (matrix.length < 2) return [];
  const headers = matrix[0].map((h) => normalizeHeaderKey(h));
  return matrix.slice(1).map((row) => {
    const obj = {};
    headers.forEach((h, i) => {
      if (h) obj[h] = row[i] ?? '';
    });
    return obj;
  });
}

/* -------------------------------------------------------------------------- */
/*  CSV / JSON / Header normalization & Algerian Nomenclature mapping         */
/* -------------------------------------------------------------------------- */

function normalizeHeaderKey(raw) {
  return foldSearch(raw)
    .replace(/[^a-z0-9\u0600-\u06ff]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function parseCsvText(csvText) {
  const clean = String(csvText || '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const lines = clean.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];

  const first = lines[0];
  const sep = first.includes('\t')
    ? '\t'
    : first.split(';').length > first.split(',').length
      ? ';'
      : ',';

  const splitLine = (line) => {
    const out = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === sep && !inQuotes) {
        out.push(cur.trim());
        cur = '';
      } else {
        cur += ch;
      }
    }
    out.push(cur.trim());
    return out;
  };

  const headers = splitLine(first).map(normalizeHeaderKey);
  return lines.slice(1).map((line) => {
    const vals = splitLine(line);
    const obj = {};
    headers.forEach((h, idx) => {
      if (h) obj[h] = vals[idx] ?? '';
    });
    return obj;
  });
}

function pickField(row, keys) {
  for (const k of keys) {
    if (row[k] !== undefined && row[k] !== null && String(row[k]).trim() !== '') {
      return String(row[k]).trim();
    }
  }
  return '';
}

function parseOptionalPrice(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const cleaned = String(raw).replace(/\s/g, '').replace(',', '.').replace(/[^0-9.]/g, '');
  if (!cleaned) return null;
  const num = Number.parseFloat(cleaned);
  return Number.isFinite(num) && num >= 0 ? Math.round(num * 100) / 100 : null;
}

function parseBoolFlag(raw, defaultVal = 0) {
  const s = foldSearch(raw);
  if (!s) return defaultVal;
  if (['1', 'oui', 'yes', 'true', 'g', 'ge', 'generique', 'remboursable', 'نعم', 'جنيس'].includes(s)) return 1;
  if (['0', 'non', 'no', 'false', 'princeps', 'r', 're', 'bio', 'لا'].includes(s)) return 0;
  return defaultVal;
}

function normalizeSchedule(raw) {
  const s = foldSearch(raw);
  if (!s) return '';
  if (/(stupefiant|tableau b|مخدر)/.test(s)) return 'stupefiant';
  if (/(psychotrope|مؤثر عقلي)/.test(s)) return 'psychotrope';
  if (/(liste ii|liste 2|tableau c)/.test(s)) return 'liste_ii';
  if (/(liste i\b|liste 1|tableau a)/.test(s)) return 'liste_i';
  return cleanText(raw, 30);
}

function mapNomenclatureRecord(rawRow = {}) {
  const row = {};
  for (const [k, v] of Object.entries(rawRow)) {
    row[normalizeHeaderKey(k)] = v;
  }

  const brand = cleanText(
    pickField(row, [
      'brand', 'brandname', 'brand_name', 'nom_de_marque', 'nom_marque', 'marque', 'specialite', 'nom_commercial', 'الاسم_التجاري',
    ]),
    140,
  );
  const dci = cleanText(
    pickField(row, [
      'dci', 'denomination_commune_internationale', 'denomination_commune', 'principe_actif', 'الماده_الفعاله',
    ]),
    180,
  );
  if (!brand && !dci) return null;

  const strength = cleanText(pickField(row, ['strength', 'dosage', 'concentration', 'التركيز']), 80);
  const baseForm = cleanText(pickField(row, ['form', 'forme', 'forme_pharmaceutique', 'الشكل']), 80) || 'Comprimé';
  const packaging = cleanText(pickField(row, ['packaging', 'conditionnement']), 50);
  const form = cleanText(packaging ? `${baseForm} (${packaging})` : baseForm, 120);
  const regNum = cleanText(
    pickField(row, [
      'registration_number', 'registrationnumber', 'num_enregistrement', 'n_enregistrement', 'numero_enregistrement', 'code_enregistrement', 'رقم_التسجيل',
    ]),
    60,
  );
  const laboratory = cleanText(
    pickField(row, ['laboratory', 'laboratoire', 'labo', 'detenteur_decision', 'المخبر']),
    140,
  );
  const country = cleanText(pickField(row, ['country', 'pays', 'pays_origine', 'البلد']), 80);
  const isGeneric = parseBoolFlag(pickField(row, ['is_generic', 'generique', 'type', 'statut_generique']), 0);
  const ppa = parseOptionalPrice(pickField(row, ['ppa', 'prix_public', 'prix_ppa']));
  const referencePrice = parseOptionalPrice(
    pickField(row, ['reference_price', 'tarif_reference', 'tarif_de_reference', 'prix_reference']),
  );
  const reimbRateRaw = pickField(row, ['reimbursement_rate', 'taux_remboursement', 'taux']);
  const reimbRate = reimbRateRaw ? Math.min(100, Math.max(0, Number.parseInt(reimbRateRaw, 10) || 0)) : 0;
  const reimbursable = parseBoolFlag(
    pickField(row, ['reimbursable', 'remboursable', 'cnas']),
    reimbRate > 0 ? 1 : 0,
  );
  const schedule = normalizeSchedule(pickField(row, ['schedule', 'list', 'liste', 'tableau', 'classement']));
  const marketed = parseBoolFlag(pickField(row, ['marketed', 'commercialise', 'commercialisation']), 1);
  const expiry = cleanText(
    pickField(row, ['expiry_of_registration', 'registrationdatefinal', 'registration_date_final', 'date_expiration', 'peremption_enregistrement']),
    30,
  );
  const specialty = cleanText(pickField(row, ['specialty', 'specialite_medicale', 'classe_therapeutique']), 40) || 'general';
  const keywordsAr = cleanText(pickField(row, ['keywords_ar', 'mots_cles_ar', 'كلمات_عربيه']), 200);

  const effectiveBrand = brand || dci;
  const dciGroup =
    cleanText(pickField(row, ['reference_dci_group']), 180) || makeDciGroup(dci, strength);
  const folded = foldSearch(`${effectiveBrand} ${dci} ${strength} ${form} ${laboratory} ${specialty} ${keywordsAr}`);

  return {
    brand: effectiveBrand,
    dci,
    strength,
    form,
    specialty,
    keywords_ar: keywordsAr,
    registration_number: regNum,
    laboratory,
    country,
    is_generic: isGeneric,
    reference_dci_group: dciGroup,
    ppa,
    reference_price: referencePrice,
    reimbursable: reimbursable ? 1 : 0,
    reimbursement_rate: reimbRate || (reimbursable ? 80 : 0),
    schedule,
    marketed,
    expiry_of_registration: expiry,
    folded_search: folded,
  };
}

/**
 * Import Algerian Nomenclature rows from CSV, JSON, or base64/Buffer XLSX.
 */
function importNomenclature({
  format = 'csv',
  content = '',
  xlsxBase64 = '',
  filePath = '',
  mark_verified = false,
  source = 'nomenclature',
} = {}) {
  let rawRecords = [];
  const fmt = String(format || '').toLowerCase();

  if (filePath) {
    if (!fs.existsSync(filePath)) throw new AppError('FILE_NOT_FOUND');
    const ext = filePath.toLowerCase();
    if (ext.endsWith('.xlsx')) {
      rawRecords = parseXlsxBuffer(fs.readFileSync(filePath));
    } else if (ext.endsWith('.json')) {
      rawRecords = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } else {
      rawRecords = parseCsvText(fs.readFileSync(filePath, 'utf8'));
    }
  } else if (fmt === 'xlsx' || xlsxBase64) {
    const buf = Buffer.from(String(xlsxBase64 || content), 'base64');
    rawRecords = parseXlsxBuffer(buf);
  } else if (fmt === 'json') {
    try {
      const parsed = typeof content === 'string' ? JSON.parse(content) : content;
      rawRecords = Array.isArray(parsed) ? parsed : [];
    } catch (_e) {
      throw new AppError('INVALID_IMPORT_FORMAT');
    }
  } else if (Array.isArray(content)) {
    rawRecords = content;
  } else {
    rawRecords = parseCsvText(content);
  }

  if (!Array.isArray(rawRecords) || rawRecords.length === 0) {
    return { imported: 0, updated: 0, skipped: 0 };
  }

  const db = getDb();
  const today = toISODate();
  const verifiedBit = mark_verified ? 1 : 0;
  const srcLabel = cleanText(source, 40) || 'nomenclature';

  const findByReg = db.prepare(
    `SELECT id FROM medications WHERE registration_number != '' AND registration_number = ? LIMIT 1`,
  );
  const findByTuple = db.prepare(
    `SELECT id FROM medications
     WHERE lower(brand) = lower(?) AND lower(strength) = lower(?) AND lower(form) = lower(?)
     LIMIT 1`,
  );

  const insertStmt = db.prepare(`
    INSERT INTO medications
      (brand, dci, strength, form, specialty, keywords_ar,
       registration_number, laboratory, country, is_generic, reference_dci_group,
       ppa, reference_price, reimbursable, reimbursement_rate,
       schedule, marketed, expiry_of_registration,
       source, verified, last_updated, folded_search, custom, active)
    VALUES
      (@brand, @dci, @strength, @form, @specialty, @keywords_ar,
       @registration_number, @laboratory, @country, @is_generic, @reference_dci_group,
       @ppa, @reference_price, @reimbursable, @reimbursement_rate,
       @schedule, @marketed, @expiry_of_registration,
       @source, @verified, @last_updated, @folded_search, 0, @active)
  `);

  const updateStmt = db.prepare(`
    UPDATE medications SET
      brand = @brand,
      dci = @dci,
      strength = @strength,
      form = @form,
      registration_number = CASE WHEN @registration_number != '' THEN @registration_number ELSE registration_number END,
      laboratory = @laboratory,
      country = @country,
      is_generic = @is_generic,
      reference_dci_group = @reference_dci_group,
      ppa = @ppa,
      reference_price = @reference_price,
      reimbursable = @reimbursable,
      reimbursement_rate = @reimbursement_rate,
      schedule = @schedule,
      marketed = @marketed,
      expiry_of_registration = @expiry_of_registration,
      source = @source,
      verified = @verified,
      last_updated = @last_updated,
      folded_search = @folded_search,
      active = @active
    WHERE id = @id
  `);

  let imported = 0;
  let updated = 0;
  let skipped = 0;

  const tx = db.transaction(() => {
    for (const raw of rawRecords) {
      const mapped = mapNomenclatureRecord(raw);
      if (!mapped) {
        skipped += 1;
        continue;
      }
      const existing =
        (mapped.registration_number ? findByReg.get(mapped.registration_number) : null) ||
        findByTuple.get(mapped.brand, mapped.strength, mapped.form);

      const params = {
        ...mapped,
        source: srcLabel,
        verified: verifiedBit,
        last_updated: today,
        active: mapped.marketed ? 1 : 0,
      };

      if (existing) {
        updateStmt.run({ ...params, id: existing.id });
        updated += 1;
      } else {
        insertStmt.run(params);
        imported += 1;
      }
    }
  });
  tx();

  return { imported, updated, skipped, last_updated: today };
}

/* -------------------------------------------------------------------------- */
/*  High-speed FTS5 + Folded Search & Generic Substitution                    */
/* -------------------------------------------------------------------------- */

function searchFast({ query = '', specialty = '', onlyReimbursable = false, onlyGeneric = false, includeUnmarketed = false, limit = 60 } = {}) {
  const db = getDb();
  const max = Math.min(200, Math.max(1, Number.parseInt(limit, 10) || 60));
  const spec = cleanText(specialty, 40).toLowerCase();
  const foldedQuery = foldSearch(query);

  const filterClauses = [];
  const filterParams = [];
  if (!includeUnmarketed) {
    filterClauses.push('m.active = 1 AND m.marketed = 1');
  }
  if (spec) {
    filterClauses.push('lower(m.specialty) = ?');
    filterParams.push(spec);
  }
  if (onlyReimbursable) {
    filterClauses.push('m.reimbursable = 1');
  }
  if (onlyGeneric) {
    filterClauses.push('m.is_generic = 1');
  }
  const whereExtra = filterClauses.length ? `AND ${filterClauses.join(' AND ')}` : '';
  const priorityOrder = `m.custom DESC, CASE WHEN m.source = 'nomenclature' THEN 0 WHEN m.source = 'starter' THEN 1 ELSE 2 END ASC`;

  if (!foldedQuery) {
    return db
      .prepare(
        `SELECT m.* FROM medications m
         WHERE 1=1 ${whereExtra}
         ORDER BY ${priorityOrder}, m.brand COLLATE NOCASE ASC
         LIMIT ?`,
      )
      .all(...filterParams, max);
  }

  // Try FTS5 prefix search first for < 5ms latency on 5,000+ drugs
  const ftsTokens = foldedQuery
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2);

  if (ftsTokens.length > 0) {
    const ftsMatch = ftsTokens.map((tok) => `"${tok}"*`).join(' AND ');
    try {
      const ftsRows = db
        .prepare(
          `SELECT m.*
           FROM medications_fts f
           JOIN medications m ON m.id = f.rowid
           WHERE medications_fts MATCH ? ${whereExtra}
           ORDER BY ${priorityOrder}, bm25(medications_fts), m.brand COLLATE NOCASE ASC
           LIMIT ?`,
        )
        .all(ftsMatch, ...filterParams, max);
      if (ftsRows.length > 0) return ftsRows;
    } catch (_ftsErr) {
      // Fall back to folded LIKE below
    }
  }

  // Substring fallback on indexed/precomputed folded_search + Arabic keywords
  const tokens = foldedQuery.split(/\s+/).filter(Boolean);
  const likeClauses = tokens.map(() => '(m.folded_search LIKE ? OR m.keywords_ar LIKE ?)');
  const likeParams = [];
  for (const tok of tokens) {
    likeParams.push(`%${tok}%`, `%${tok}%`);
  }

  return db
    .prepare(
      `SELECT m.* FROM medications m
       WHERE ${likeClauses.join(' AND ')} ${whereExtra}
       ORDER BY ${priorityOrder}, m.brand COLLATE NOCASE ASC
       LIMIT ?`,
    )
    .all(...likeParams, ...filterParams, max);
}

/**
 * Find generic & therapeutic equivalents sharing the same DCI + strength.
 */
function findSubstitutes({ medication_id = null, dci = '', strength = '' } = {}) {
  const db = getDb();
  let target = null;
  if (medication_id) {
    target = db.prepare('SELECT * FROM medications WHERE id = ?').get(requireId(medication_id));
  }
  const effDci = cleanText(dci || target?.dci, 160);
  const effStrength = cleanText(strength || target?.strength, 80);
  if (!effDci) return { target, substitutes: [] };

  const group = target?.reference_dci_group || makeDciGroup(effDci, effStrength);
  const rows = db
    .prepare(
      `SELECT * FROM medications
       WHERE active = 1 AND marketed = 1
         AND (
           (reference_dci_group != '' AND reference_dci_group = @group)
           OR lower(trim(dci)) = lower(trim(@dci))
         )
       ORDER BY
         CASE WHEN reference_dci_group = @group THEN 0 ELSE 1 END ASC,
         reimbursable DESC,
         is_generic DESC,
         CASE WHEN ppa IS NULL THEN 1 ELSE 0 END ASC,
         ppa ASC,
         brand COLLATE NOCASE ASC
       LIMIT 30`,
    )
    .all({ group, dci: effDci });

  const substitutes = target ? rows.filter((r) => r.id !== target.id) : rows;
  return { target, substitutes };
}

function nomenclatureSummary() {
  const db = getDb();
  const total = db.prepare('SELECT COUNT(*) AS n FROM medications WHERE active = 1').get().n;
  const imported = db
    .prepare("SELECT COUNT(*) AS n FROM medications WHERE source != 'starter' AND custom = 0")
    .get().n;
  const verified = db.prepare('SELECT COUNT(*) AS n FROM medications WHERE verified = 1').get().n;
  const generics = db
    .prepare('SELECT COUNT(*) AS n FROM medications WHERE active = 1 AND is_generic = 1')
    .get().n;
  const reimbursable = db
    .prepare('SELECT COUNT(*) AS n FROM medications WHERE active = 1 AND reimbursable = 1')
    .get().n;
  const lastRow = db
    .prepare("SELECT MAX(last_updated) AS last_updated FROM medications WHERE last_updated != ''")
    .get();
  return {
    total,
    imported,
    verified,
    generics,
    reimbursable,
    last_updated: lastRow?.last_updated || '',
  };
}

module.exports = {
  foldSearch,
  makeDciGroup,
  parseXlsxBuffer,
  parseCsvText,
  mapNomenclatureRecord,
  importNomenclature,
  searchFast,
  findSubstitutes,
  nomenclatureSummary,
};
