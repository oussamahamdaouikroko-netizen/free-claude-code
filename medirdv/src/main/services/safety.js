'use strict';
/**
 * Phase 2 — Clinical Safety & Smart Prescription Decision-Support Service.
 *
 * IMPORTANT:
 *   Decision support is an assistive aid for licensed clinicians, never a
 *   replacement for clinical judgment. Starter rules carry `source = 'starter'`
 *   and `verified = 0` until verified by a physician/pharmacist or imported
 *   from an authoritative CSV/JSON source.
 */

const { getDb } = require('../db');
const { AppError, cleanText, nowLocal, requireId } = require('../utils/common');
const { toISODate } = require('../utils/dates');

const ALLOWED_RULE_TABLES = new Set([
  'dose_rules',
  'interaction_pairs',
  'contraindications',
  'allergy_class_rules',
  'controlled_rules',
]);

function fold(str) {
  return String(str ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u0610-\u061A\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .toLowerCase()
    .trim();
}

/** Split combination DCIs like "Amoxicilline + Acide clavulanique" into individual DCIs. */
function splitDciIngredients(rawDci) {
  return fold(rawDci)
    .split(/[+/&,;]+|\bassocie\b/)
    .map((s) => s.replace(/\(.*?\)/g, '').replace(/\d+\s*(mg|g|ml|ui|%)/g, '').trim())
    .filter((s) => s.length >= 3);
}

function parseWeightNumber(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw > 0 ? raw : null;
  const ascii = String(raw)
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/,/g, '.');
  const m = ascii.match(/(\d{1,3}(?:\.\d{1,2})?)/);
  if (!m) return null;
  const v = Number.parseFloat(m[1]);
  return Number.isFinite(v) && v >= 0.3 && v <= 400 ? v : null;
}

function parseAgeMonths({ birth_date = '', age_text = '', age_months = null } = {}) {
  if (age_months !== null && age_months !== undefined && age_months !== '') {
    const m = Number(age_months);
    if (Number.isFinite(m) && m >= 0) return m;
  }
  const iso = String(birth_date || '').trim();
  const ref = toISODate();
  const full = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const refM = ref.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (full && refM) {
    const months = (Number(refM[1]) - Number(full[1])) * 12 + (Number(refM[2]) - Number(full[2]));
    return months >= 0 ? months : null;
  }
  const txt = fold(age_text);
  if (!txt) return null;
  const numM = txt.match(/(\d+(?:[.,]\d+)?)/);
  if (!numM) return null;
  const val = Number.parseFloat(numM[1].replace(',', '.'));
  if (!Number.isFinite(val)) return null;
  if (/\b(mois|month|شهر|اشهر)\b/.test(txt)) return Math.round(val);
  return Math.round(val * 12);
}

/**
 * Parse liquid concentration in mg/ml from strings like:
 *   "250 mg / 5 ml" -> 50
 *   "125mg/5ml"     -> 25
 *   "100 mg/ml"     -> 100
 *   "2,4%" / "2.4%" -> 24 (g per 100 ml = 10 mg/ml per 1%)
 */
function parseConcentrationMgPerMl(text) {
  const s = fold(text).replace(/,/g, '.');
  if (!s) return null;
  const ratio = s.match(/(\d+(?:\.\d+)?)\s*mg\s*\/\s*(\d+(?:\.\d+)?)?\s*ml/);
  if (ratio) {
    const mg = Number.parseFloat(ratio[1]);
    const ml = ratio[2] ? Number.parseFloat(ratio[2]) : 1;
    if (mg > 0 && ml > 0) return Math.round((mg / ml) * 100) / 100;
  }
  const pct = s.match(/(\d+(?:\.\d+)?)\s*%/);
  if (pct && /(sirop|suspension|buvable|goutte|شراب|معلق)/.test(s)) {
    const p = Number.parseFloat(pct[1]);
    if (p > 0 && p <= 50) return Math.round(p * 10 * 100) / 100;
  }
  return null;
}

/** Parse prescription duration text ("7 jours", "2 semaines", "1 mois", "10 أيام") into days. */
function parseDurationDays(text) {
  const s = fold(text).replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
  if (!s) return null;
  const m = s.match(/(\d{1,3})/);
  if (!m) return null;
  const n = Number.parseInt(m[1], 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (/(mois|شهر|اشهر)/.test(s)) return n * 30;
  if (/(semaine|اسبوع|اسابيع)/.test(s)) return n * 7;
  return n;
}

/* -------------------------------------------------------------------------- */
/*  1. Pediatric & Weight-based Dose Calculator                               */
/* -------------------------------------------------------------------------- */

function calculatePediatricDose(input = {}) {
  const weightKg = parseWeightNumber(input.weight_kg);
  if (!weightKg) throw new AppError('INVALID_WEIGHT');

  const dciList = splitDciIngredients(input.dci || input.drug_name || '');
  const primaryDci = dciList[0] || fold(input.dci || input.drug_name);
  if (!primaryDci) throw new AppError('MEDICATION_NAME_REQUIRED');

  const ageMonths = parseAgeMonths({
    birth_date: input.birth_date,
    age_text: input.patient_age,
    age_months: input.age_months,
  });

  const candidates = getDb()
    .prepare('SELECT * FROM dose_rules WHERE lower(dci) = ? ORDER BY verified DESC, id ASC')
    .all(primaryDci);

  const rule =
    candidates.find((r) =>
      ageMonths === null ? true : ageMonths >= r.min_age_months && ageMonths <= r.max_age_months,
    ) || candidates[0];

  if (!rule) {
    return { matched: false, dci: primaryDci, weight_kg: weightKg };
  }

  const dosesPerDay =
    Math.max(1, Number.parseInt(input.doses_per_day, 10) || Number(rule.doses_per_day) || 3);

  const rawDailyMg = rule.mg_per_kg_per_day
    ? weightKg * Number(rule.mg_per_kg_per_day)
    : weightKg * Number(rule.mg_per_kg_per_dose || 0) * dosesPerDay;

  const exceedsMaxDaily =
    rule.max_daily_dose_mg !== null &&
    rule.max_daily_dose_mg !== undefined &&
    rawDailyMg > Number(rule.max_daily_dose_mg);

  const cappedDailyMg = exceedsMaxDaily ? Number(rule.max_daily_dose_mg) : rawDailyMg;
  const rawSingleMg = rule.mg_per_kg_per_dose
    ? weightKg * Number(rule.mg_per_kg_per_dose)
    : cappedDailyMg / dosesPerDay;

  const exceedsMaxSingle =
    rule.max_single_dose_mg !== null &&
    rule.max_single_dose_mg !== undefined &&
    rawSingleMg > Number(rule.max_single_dose_mg);

  let singleDoseMg = exceedsMaxSingle ? Number(rule.max_single_dose_mg) : rawSingleMg;
  if (singleDoseMg * dosesPerDay > cappedDailyMg) {
    singleDoseMg = cappedDailyMg / dosesPerDay;
  }

  singleDoseMg = Math.round(singleDoseMg * 10) / 10;
  const dailyDoseMg = Math.round(Math.min(cappedDailyMg, singleDoseMg * dosesPerDay) * 10) / 10;

  const conc =
    (Number(input.concentration_mg_per_ml) > 0 ? Number(input.concentration_mg_per_ml) : null) ||
    parseConcentrationMgPerMl(input.form_strength || '') ||
    (Number(rule.concentration_mg_per_ml) > 0 ? Number(rule.concentration_mg_per_ml) : null);

  const mlPerDose = conc ? Math.round((singleDoseMg / conc) * 10) / 10 : null;

  const rateDescFr = rule.mg_per_kg_per_dose
    ? `${rule.mg_per_kg_per_dose} mg/kg/prise × ${dosesPerDay}/j`
    : `${rule.mg_per_kg_per_day} mg/kg/j ÷ ${dosesPerDay} prises`;
  const rateDescAr = rule.mg_per_kg_per_dose
    ? `${rule.mg_per_kg_per_dose} ملغ/كغ/جرعة × ${dosesPerDay}/يوم`
    : `${rule.mg_per_kg_per_day} ملغ/كغ/يوم ÷ ${dosesPerDay} جرعات`;

  const mlPartFr = mlPerDose ? ` = ${mlPerDose} ml/prise (${conc} mg/ml)` : '';
  const mlPartAr = mlPerDose ? ` = ${mlPerDose} مل/جرعة (${conc} ملغ/مل)` : '';

  const formula_fr =
    `${weightKg} kg × (${rateDescFr}) → ${singleDoseMg} mg/prise${mlPartFr} (total ${dailyDoseMg} mg/j)` +
    (exceedsMaxDaily || exceedsMaxSingle ? ' [Plafonné à la dose max]' : '');
  const formula_ar =
    `${weightKg} كغ × (${rateDescAr}) ← ${singleDoseMg} ملغ/جرعة${mlPartAr} (المجموع ${dailyDoseMg} ملغ/يوم)` +
    (exceedsMaxDaily || exceedsMaxSingle ? ' [محدد بالجرعة القصوى]' : '');

  const suggested_dosage_fr = mlPerDose
    ? `${mlPerDose} ml (${singleDoseMg} mg) × ${dosesPerDay} / jour`
    : `${singleDoseMg} mg × ${dosesPerDay} / jour`;

  return {
    matched: true,
    dci: primaryDci,
    weight_kg: weightKg,
    doses_per_day: dosesPerDay,
    raw_single_dose_mg: Math.round(rawSingleMg * 10) / 10,
    single_dose_mg: singleDoseMg,
    raw_daily_dose_mg: Math.round(rawDailyMg * 10) / 10,
    daily_dose_mg: dailyDoseMg,
    concentration_mg_per_ml: conc,
    ml_per_dose: mlPerDose,
    exceeds_max_single: Boolean(exceedsMaxSingle),
    exceeds_max_daily: Boolean(exceedsMaxDaily),
    max_single_dose_mg: rule.max_single_dose_mg,
    max_daily_dose_mg: rule.max_daily_dose_mg,
    max_duration_days: rule.max_duration_days,
    notes_fr: rule.notes_fr,
    notes_ar: rule.notes_ar,
    formula_fr,
    formula_ar,
    suggested_dosage_fr,
    source: rule.source,
    verified: Boolean(rule.verified),
  };
}

/* -------------------------------------------------------------------------- */
/*  2. Resolve DCIs from items & current medications                          */
/* -------------------------------------------------------------------------- */

function resolveItemDcis(item, db) {
  let dciText = item.dci || '';
  if (!dciText && item.medication_id) {
    const med = db.prepare('SELECT dci, brand FROM medications WHERE id = ?').get(item.medication_id);
    if (med) dciText = med.dci || '';
  }
  if (!dciText && item.drug_name) {
    const med = db
      .prepare('SELECT dci FROM medications WHERE lower(brand) = lower(?) LIMIT 1')
      .get(String(item.drug_name).trim());
    if (med) dciText = med.dci || '';
  }
  const ingredients = splitDciIngredients(dciText || item.drug_name || '');
  return ingredients;
}

function resolveCurrentMedicationDcis(currentMedsText, db) {
  const raw = String(currentMedsText || '').trim();
  if (!raw) return [];
  const parts = raw
    .split(/[,;/+\n·]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 3);
  const out = [];
  for (const part of parts) {
    const cleanName = part.replace(/\d+\s*(mg|g|ml|ui|%)/gi, '').trim();
    const med = db
      .prepare('SELECT dci, brand FROM medications WHERE lower(brand) = lower(?) OR lower(dci) = lower(?) LIMIT 1')
      .get(cleanName, cleanName);
    const dcis = med ? splitDciIngredients(med.dci) : splitDciIngredients(cleanName);
    for (const d of dcis) {
      out.push({ label: part, dci: d, fromCurrentMeds: true });
    }
  }
  return out;
}

function detectPatientConditions({ chronicText = '', is_pregnant = false, is_breastfeeding = false } = {}) {
  const c = fold(chronicText);
  return {
    pregnancy: Boolean(is_pregnant),
    breastfeeding: Boolean(is_breastfeeding),
    renal: /\b(rein|reins|renal|renale|irc|dialyse|nephro)\b|(كلي|كلوي|قصور كلوي|تصفية)/.test(c),
    hepatic: /\b(foie|hepat|cirrhose|ihc)\b|(كبد|كبدي|تشمع)/.test(c),
    asthma: /\b(asthme|asthmatique|bpco)\b|(ربو)/.test(c),
    ulcer: /\b(ulcere|ugd|gastrite erosive|hemorragie digestive)\b|(قرحه|قرحة)/.test(c),
    g6pd: /\b(g6pd|favisme)\b|(تفول)/.test(c),
    foldedChronic: c,
  };
}

/* -------------------------------------------------------------------------- */
/*  3. Comprehensive Prescription Safety Evaluation                           */
/* -------------------------------------------------------------------------- */

function evaluatePrescription(payload = {}) {
  const db = getDb();
  let patient = null;
  if (payload.patient_id) {
    patient = db.prepare('SELECT * FROM patients WHERE id = ?').get(Number(payload.patient_id));
  }

  // Also check applied intake for pregnancy / breastfeeding / current medications if not passed
  let appliedIntake = null;
  if (patient) {
    appliedIntake = db
      .prepare(
        `SELECT * FROM patient_intake
         WHERE patient_id = ? AND status = 'applied'
         ORDER BY id DESC LIMIT 1`,
      )
      .get(patient.id);
  }

  const allergiesText =
    payload.patient_allergies !== undefined
      ? payload.patient_allergies
      : patient?.allergies || '';
  const chronicText =
    payload.patient_chronic !== undefined
      ? payload.patient_chronic
      : patient?.chronic_conditions || '';
  const currentMedsText =
    payload.current_medications !== undefined
      ? payload.current_medications
      : appliedIntake?.current_medications || '';
  const isPregnant =
    payload.is_pregnant !== undefined
      ? Boolean(payload.is_pregnant)
      : appliedIntake?.is_pregnant === 1;
  const isBreastfeeding =
    payload.is_breastfeeding !== undefined
      ? Boolean(payload.is_breastfeeding)
      : appliedIntake?.is_breastfeeding === 1;

  const ageMonths = parseAgeMonths({
    birth_date: patient?.birth_date || payload.birth_date || '',
    age_text: payload.patient_age || '',
    age_months: payload.age_months,
  });
  const weightKg = parseWeightNumber(payload.patient_weight);

  const items = Array.isArray(payload.items) ? payload.items : [];
  const resolvedItems = items
    .filter((it) => cleanText(it?.drug_name, 140))
    .map((it) => ({
      drug_name: cleanText(it.drug_name, 140),
      dci: cleanText(it.dci, 160),
      form_strength: cleanText(it.form_strength, 120),
      duration: cleanText(it.duration, 80),
      dcis: resolveItemDcis(it, db),
    }));

  const alerts = [];
  let hasUnverifiedRules = false;

  // A. Duplicate-therapy detection (2+ items sharing an active DCI)
  const byDci = new Map();
  for (const item of resolvedItems) {
    for (const d of item.dcis) {
      if (!byDci.has(d)) byDci.set(d, []);
      byDci.get(d).push(item.drug_name);
    }
  }
  const duplicate_dci = [];
  for (const [dci, brands] of byDci.entries()) {
    if (brands.length >= 2) {
      const entry = {
        kind: 'duplicate_therapy',
        severity: 'avoid',
        dci,
        drugs: brands,
        message_fr: `Doublon thérapeutique : même principe actif (${dci}) présent dans ${brands.join(' + ')}.`,
        message_ar: `تكرار علاجي: نفس المادة الفعالة (${dci}) موجودة في ${brands.join(' + ')}.`,
        verified: true,
        source: 'engine',
      };
      duplicate_dci.push(entry);
      alerts.push(entry);
    }
  }

  // B. Drug-Class Allergy Cross-Reactivity + direct token match
  const allergy_alerts = [];
  const foldedAllergy = fold(allergiesText);
  if (foldedAllergy) {
    const classRules = db.prepare('SELECT * FROM allergy_class_rules').all();
    const matchedClasses = classRules.filter((rule) =>
      rule.trigger_terms
        .split(',')
        .map((s) => fold(s))
        .filter(Boolean)
        .some((trig) => foldedAllergy.includes(trig)),
    );

    const directTokens = foldedAllergy
      .split(/[,;/+·\s]+/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 4);

    for (const item of resolvedItems) {
      const itemFold = fold(`${item.drug_name} ${item.dci} ${item.dcis.join(' ')}`);
      let triggered = false;

      for (const cls of matchedClasses) {
        const crossTerms = cls.cross_dci_terms
          .split(',')
          .map((s) => fold(s))
          .filter(Boolean);
        if (crossTerms.some((term) => itemFold.includes(term))) {
          if (!cls.verified) hasUnverifiedRules = true;
          const entry = {
            kind: 'allergy',
            severity: cls.severity || 'contraindicated',
            drug_name: item.drug_name,
            matched_class_fr: cls.class_name_fr,
            matched_class_ar: cls.class_name_ar,
            message_fr: `Allergie croisée (${cls.class_name_fr}) détectée pour ${item.drug_name}.`,
            message_ar: `حساسية متقاطعة (${cls.class_name_ar}) مرصودة لدواء ${item.drug_name}.`,
            verified: Boolean(cls.verified),
            source: cls.source,
          };
          allergy_alerts.push(entry);
          alerts.push(entry);
          triggered = true;
        }
      }

      if (!triggered) {
        const directHit = directTokens.find((tok) => itemFold.includes(tok));
        if (directHit) {
          const entry = {
            kind: 'allergy',
            severity: 'contraindicated',
            drug_name: item.drug_name,
            matched_class_fr: directHit,
            matched_class_ar: directHit,
            message_fr: `Allergie directe déclarée (${directHit}) correspondant à ${item.drug_name}.`,
            message_ar: `حساسية مباشرة مسجلة (${directHit}) تطابق دواء ${item.drug_name}.`,
            verified: true,
            source: 'patient_record',
          };
          allergy_alerts.push(entry);
          alerts.push(entry);
        }
      }
    }
  }

  // C. Drug-Drug Interactions (Rx <-> Rx AND Rx <-> Current Medications)
  const interactions = [];
  const currentMedDcis = resolveCurrentMedicationDcis(currentMedsText, db);
  const allDciNodes = [];
  for (const item of resolvedItems) {
    for (const d of item.dcis) {
      allDciNodes.push({ label: item.drug_name, dci: d, fromCurrentMeds: false });
    }
  }
  for (const cm of currentMedDcis) {
    allDciNodes.push(cm);
  }

  const pairStmt = db.prepare(
    `SELECT * FROM interaction_pairs
     WHERE (lower(dci_a) = ? AND lower(dci_b) = ?)
        OR (lower(dci_a) = ? AND lower(dci_b) = ?)`,
  );
  const seenPairs = new Set();
  for (let i = 0; i < allDciNodes.length; i += 1) {
    for (let j = i + 1; j < allDciNodes.length; j += 1) {
      const a = allDciNodes[i];
      const b = allDciNodes[j];
      if (a.fromCurrentMeds && b.fromCurrentMeds) continue;
      if (a.dci === b.dci) continue;
      const pairKey = [a.dci, b.dci].sort().join('::');
      if (seenPairs.has(pairKey)) continue;
      seenPairs.add(pairKey);

      const matches = pairStmt.all(a.dci, b.dci, b.dci, a.dci);
      for (const m of matches) {
        if (!m.verified) hasUnverifiedRules = true;
        const entry = {
          kind: 'interaction',
          severity: m.severity,
          drugs: [a.label, b.label],
          dci_pair: [a.dci, b.dci],
          with_current_med: Boolean(a.fromCurrentMeds || b.fromCurrentMeds),
          message_fr: `${a.label} × ${b.label} : ${m.mechanism_fr}${m.action_fr ? ` — ${m.action_fr}` : ''}`,
          message_ar: `${a.label} × ${b.label}: ${m.mechanism_ar || m.mechanism_fr}${m.action_ar ? ` — ${m.action_ar}` : ''}`,
          verified: Boolean(m.verified),
          source: m.source,
        };
        interactions.push(entry);
        alerts.push(entry);
      }
    }
  }

  // D. Contraindications (pregnancy, breastfeeding, renal, hepatic, asthma, ulcer, g6pd, age, chronic)
  const contraindications = [];
  const condFlags = detectPatientConditions({
    chronicText,
    is_pregnant: isPregnant,
    is_breastfeeding: isBreastfeeding,
  });
  const contraStmt = db.prepare('SELECT * FROM contraindications WHERE lower(dci) = ?');

  for (const item of resolvedItems) {
    for (const d of item.dcis) {
      const rules = contraStmt.all(d);
      for (const r of rules) {
        let hit = false;
        if (r.condition_type === 'pregnancy' && condFlags.pregnancy) hit = true;
        else if (r.condition_type === 'breastfeeding' && condFlags.breastfeeding) hit = true;
        else if (r.condition_type === 'renal' && condFlags.renal) hit = true;
        else if (r.condition_type === 'hepatic' && condFlags.hepatic) hit = true;
        else if (r.condition_type === 'asthma' && condFlags.asthma) hit = true;
        else if (r.condition_type === 'ulcer' && condFlags.ulcer) hit = true;
        else if (r.condition_type === 'g6pd' && condFlags.g6pd) hit = true;
        else if (r.condition_type === 'min_age_months' && ageMonths !== null) {
          const minM = Number.parseInt(r.condition_match, 10);
          if (Number.isFinite(minM) && ageMonths < minM) hit = true;
        } else if (r.condition_type === 'max_age_years' && ageMonths !== null) {
          const maxY = Number.parseInt(r.condition_match, 10);
          if (Number.isFinite(maxY) && ageMonths / 12 > maxY) hit = true;
        } else if (
          r.condition_type === 'chronic' &&
          r.condition_match &&
          condFlags.foldedChronic.includes(fold(r.condition_match))
        ) {
          hit = true;
        }

        if (hit) {
          if (!r.verified) hasUnverifiedRules = true;
          const entry = {
            kind: 'contraindication',
            severity: r.severity,
            drug_name: item.drug_name,
            dci: d,
            condition_type: r.condition_type,
            message_fr: `${item.drug_name} : ${r.message_fr}`,
            message_ar: `${item.drug_name}: ${r.message_ar || r.message_fr}`,
            verified: Boolean(r.verified),
            source: r.source,
          };
          contraindications.push(entry);
          alerts.push(entry);
        }
      }
    }
  }

  // E. Controlled-substance & Max-Duration flags
  const controlled_flags = [];
  const ctrlStmt = db.prepare('SELECT * FROM controlled_rules WHERE lower(dci) = ?');
  const doseDurStmt = db.prepare(
    'SELECT max_duration_days, verified, source FROM dose_rules WHERE lower(dci) = ? AND max_duration_days IS NOT NULL LIMIT 1',
  );

  for (const item of resolvedItems) {
    const durationDays = parseDurationDays(item.duration);
    for (const d of item.dcis) {
      const ctrl = ctrlStmt.get(d);
      if (ctrl) {
        if (!ctrl.verified) hasUnverifiedRules = true;
        const overMax =
          durationDays && ctrl.max_duration_days && durationDays > Number(ctrl.max_duration_days);
        const entry = {
          kind: 'controlled',
          severity: overMax ? 'avoid' : 'caution',
          drug_name: item.drug_name,
          dci: d,
          schedule: ctrl.schedule,
          max_duration_days: ctrl.max_duration_days,
          exceeded_duration: Boolean(overMax),
          requires_secure_rx: Boolean(ctrl.requires_secure_rx),
          message_fr:
            `${item.drug_name} (${ctrl.schedule}) : ${ctrl.notes_fr}` +
            (overMax ? ` — Durée prescrite (${durationDays} j) > max (${ctrl.max_duration_days} j).` : ''),
          message_ar:
            `${item.drug_name} (${ctrl.schedule}): ${ctrl.notes_ar || ctrl.notes_fr}` +
            (overMax ? ` — المدة الموصوفة (${durationDays} يوم) تتجاوز الحد (${ctrl.max_duration_days} يوم).` : ''),
          verified: Boolean(ctrl.verified),
          source: ctrl.source,
        };
        controlled_flags.push(entry);
        alerts.push(entry);
      } else if (durationDays) {
        const dr = doseDurStmt.get(d);
        if (dr && durationDays > Number(dr.max_duration_days)) {
          if (!dr.verified) hasUnverifiedRules = true;
          const entry = {
            kind: 'max_duration',
            severity: 'caution',
            drug_name: item.drug_name,
            dci: d,
            max_duration_days: dr.max_duration_days,
            exceeded_duration: true,
            message_fr: `${item.drug_name} : durée prescrite (${durationDays} j) supérieure à la durée usuelle (${dr.max_duration_days} j).`,
            message_ar: `${item.drug_name}: مدة العلاج (${durationDays} يوم) تتجاوز المدة المعتادة (${dr.max_duration_days} يوم).`,
            verified: Boolean(dr.verified),
            source: dr.source,
          };
          controlled_flags.push(entry);
          alerts.push(entry);
        }
      }
    }
  }

  const blocking = alerts.some((a) => a.severity === 'contraindicated');
  const requiresOverride = alerts.some(
    (a) => a.severity === 'contraindicated' || a.severity === 'avoid',
  );

  return {
    alerts,
    blocking,
    requires_override: requiresOverride,
    has_unverified_rules: hasUnverifiedRules,
    patient_weight_kg: weightKg,
    duplicate_dci,
    allergy_alerts,
    interactions,
    contraindications,
    controlled_flags,
  };
}

/* -------------------------------------------------------------------------- */
/*  4. Safety Audit Trail per Saved Prescription                              */
/* -------------------------------------------------------------------------- */

function recordAudit({
  prescription_id,
  patient_weight_kg = null,
  evaluation,
  override_reason = '',
  prescriber_name = '',
}) {
  const rxId = requireId(prescription_id, 'prescription_id');
  const alerts = evaluation?.alerts || [];
  const overrides = override_reason
    ? alerts.filter((a) => a.severity === 'contraindicated' || a.severity === 'avoid')
    : [];
  const info = getDb()
    .prepare(
      `INSERT INTO prescription_safety_audits
        (prescription_id, created_at, patient_weight_kg,
         warnings_shown_json, overrides_json, override_reason,
         prescriber_name, has_unverified_rules)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      rxId,
      nowLocal(),
      patient_weight_kg ?? evaluation?.patient_weight_kg ?? null,
      JSON.stringify(alerts),
      JSON.stringify(overrides),
      cleanText(override_reason, 400),
      cleanText(prescriber_name, 100),
      evaluation?.has_unverified_rules ? 1 : 0,
    );
  return getDb()
    .prepare('SELECT * FROM prescription_safety_audits WHERE id = ?')
    .get(info.lastInsertRowid);
}

function getAuditForPrescription(prescriptionId) {
  const rxId = requireId(prescriptionId, 'prescription_id');
  const row = getDb()
    .prepare('SELECT * FROM prescription_safety_audits WHERE prescription_id = ? ORDER BY id DESC LIMIT 1')
    .get(rxId);
  if (!row) return null;
  let warnings_shown = [];
  let overrides = [];
  try { warnings_shown = JSON.parse(row.warnings_shown_json || '[]'); } catch (_e) {}
  try { overrides = JSON.parse(row.overrides_json || '[]'); } catch (_e) {}
  return { ...row, warnings_shown, overrides };
}

/* -------------------------------------------------------------------------- */
/*  5. CSV / JSON Clinical Rules Importer & Verification Management           */
/* -------------------------------------------------------------------------- */

function parseCsvObjects(csvText) {
  const lines = String(csvText || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const sep = lines[0].includes(';') && !lines[0].includes(',') ? ';' : ',';
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
  const headers = splitLine(lines[0]).map((h) => h.trim().toLowerCase());
  return lines.slice(1).map((line) => {
    const vals = splitLine(line);
    const obj = {};
    headers.forEach((h, idx) => {
      obj[h] = vals[idx] ?? '';
    });
    return obj;
  });
}

function importRules({ table, format = 'json', content, mark_verified = false } = {}) {
  if (!ALLOWED_RULE_TABLES.has(table)) throw new AppError('INVALID_RULE_TABLE');
  let records = [];
  if (Array.isArray(content)) {
    records = content;
  } else if (String(format).toLowerCase() === 'csv') {
    records = parseCsvObjects(content);
  } else {
    try {
      const parsed = JSON.parse(String(content || '[]'));
      records = Array.isArray(parsed) ? parsed : [];
    } catch (_err) {
      throw new AppError('INVALID_IMPORT_FORMAT');
    }
  }
  if (records.length === 0) return { imported: 0, table };

  const db = getDb();
  const verifiedBit = mark_verified ? 1 : 0;
  const now = nowLocal();
  let count = 0;

  const tx = db.transaction(() => {
    if (table === 'dose_rules') {
      const ins = db.prepare(`
        INSERT INTO dose_rules
          (dci, form, concentration_mg_per_ml, min_age_months, max_age_months,
           mg_per_kg_per_day, mg_per_kg_per_dose, doses_per_day,
           max_single_dose_mg, max_daily_dose_mg, max_duration_days,
           notes_fr, notes_ar, source, verified, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'import', ?, ?)
      `);
      for (const r of records) {
        const dci = fold(r.dci);
        if (!dci) continue;
        ins.run(
          dci,
          cleanText(r.form, 60),
          r.concentration_mg_per_ml ? Number(r.concentration_mg_per_ml) : null,
          Number.parseInt(r.min_age_months, 10) || 0,
          Number.parseInt(r.max_age_months, 10) || 1560,
          r.mg_per_kg_per_day ? Number(r.mg_per_kg_per_day) : null,
          r.mg_per_kg_per_dose ? Number(r.mg_per_kg_per_dose) : null,
          Number.parseInt(r.doses_per_day, 10) || 3,
          r.max_single_dose_mg ? Number(r.max_single_dose_mg) : null,
          r.max_daily_dose_mg ? Number(r.max_daily_dose_mg) : null,
          r.max_duration_days ? Number.parseInt(r.max_duration_days, 10) : null,
          cleanText(r.notes_fr, 300),
          cleanText(r.notes_ar, 300),
          verifiedBit,
          now,
        );
        count += 1;
      }
    } else if (table === 'interaction_pairs') {
      const ins = db.prepare(`
        INSERT INTO interaction_pairs
          (dci_a, dci_b, severity, mechanism_fr, mechanism_ar, action_fr, action_ar, source, verified, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'import', ?, ?)
      `);
      for (const r of records) {
        const a = fold(r.dci_a);
        const b = fold(r.dci_b);
        const sev = ['contraindicated', 'avoid', 'caution', 'monitor'].includes(r.severity)
          ? r.severity
          : 'caution';
        if (!a || !b) continue;
        ins.run(
          a,
          b,
          sev,
          cleanText(r.mechanism_fr, 300),
          cleanText(r.mechanism_ar, 300),
          cleanText(r.action_fr, 300),
          cleanText(r.action_ar, 300),
          verifiedBit,
          now,
        );
        count += 1;
      }
    } else if (table === 'contraindications') {
      const ins = db.prepare(`
        INSERT INTO contraindications
          (dci, condition_type, condition_match, severity, message_fr, message_ar, source, verified, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'import', ?, ?)
      `);
      for (const r of records) {
        const dci = fold(r.dci);
        if (!dci || !r.condition_type) continue;
        const sev = ['contraindicated', 'avoid', 'caution'].includes(r.severity)
          ? r.severity
          : 'caution';
        ins.run(
          dci,
          cleanText(r.condition_type, 30),
          cleanText(r.condition_match, 120),
          sev,
          cleanText(r.message_fr, 300),
          cleanText(r.message_ar, 300),
          verifiedBit,
          now,
        );
        count += 1;
      }
    } else if (table === 'allergy_class_rules') {
      const ins = db.prepare(`
        INSERT OR REPLACE INTO allergy_class_rules
          (class_code, class_name_fr, class_name_ar, trigger_terms, cross_dci_terms, severity, source, verified, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'import', ?, ?)
      `);
      for (const r of records) {
        const code = fold(r.class_code);
        if (!code || !r.trigger_terms || !r.cross_dci_terms) continue;
        ins.run(
          code,
          cleanText(r.class_name_fr || code, 120),
          cleanText(r.class_name_ar || r.class_name_fr || code, 120),
          cleanText(r.trigger_terms, 500),
          cleanText(r.cross_dci_terms, 800),
          ['contraindicated', 'avoid', 'caution'].includes(r.severity) ? r.severity : 'contraindicated',
          verifiedBit,
          now,
        );
        count += 1;
      }
    } else if (table === 'controlled_rules') {
      const ins = db.prepare(`
        INSERT OR REPLACE INTO controlled_rules
          (dci, schedule, max_duration_days, requires_secure_rx, notes_fr, notes_ar, source, verified, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'import', ?, ?)
      `);
      for (const r of records) {
        const dci = fold(r.dci);
        if (!dci) continue;
        ins.run(
          dci,
          cleanText(r.schedule || 'psychotrope', 40),
          r.max_duration_days ? Number.parseInt(r.max_duration_days, 10) : null,
          r.requires_secure_rx ? 1 : 0,
          cleanText(r.notes_fr, 300),
          cleanText(r.notes_ar, 300),
          verifiedBit,
          now,
        );
        count += 1;
      }
    }
  });
  tx();

  return { imported: count, table };
}

function listRules({ table = 'dose_rules', limit = 200 } = {}) {
  if (!ALLOWED_RULE_TABLES.has(table)) throw new AppError('INVALID_RULE_TABLE');
  const max = Math.min(500, Math.max(1, Number.parseInt(limit, 10) || 200));
  return getDb().prepare(`SELECT * FROM ${table} ORDER BY verified DESC, id ASC LIMIT ?`).all(max);
}

function verifyRule({ table, id, verified = true } = {}) {
  if (!ALLOWED_RULE_TABLES.has(table)) throw new AppError('INVALID_RULE_TABLE');
  const rowId = requireId(id);
  getDb()
    .prepare(`UPDATE ${table} SET verified = ?, updated_at = ? WHERE id = ?`)
    .run(verified ? 1 : 0, nowLocal(), rowId);
  return getDb().prepare(`SELECT * FROM ${table} WHERE id = ?`).get(rowId);
}

function stats() {
  const db = getDb();
  const out = {};
  for (const tbl of ALLOWED_RULE_TABLES) {
    const total = db.prepare(`SELECT COUNT(*) AS n FROM ${tbl}`).get().n;
    const verified = db.prepare(`SELECT COUNT(*) AS n FROM ${tbl} WHERE verified = 1`).get().n;
    out[tbl] = { total, verified, unverified: total - verified };
  }
  return out;
}

module.exports = {
  fold,
  splitDciIngredients,
  parseWeightNumber,
  parseAgeMonths,
  parseConcentrationMgPerMl,
  parseDurationDays,
  calculatePediatricDose,
  evaluatePrescription,
  recordAudit,
  getAuditForPrescription,
  importRules,
  listRules,
  verifyRule,
  stats,
};
