'use strict';
/**
 * First-run & additive upgrade seed data for DentaRDV:
 *  - Default clinic, doctor, WhatsApp, Darija, and autostart settings
 *  - Dental treatment catalog with Algerian market prices (DZD)
 *  - Expense categories
 *  - Strictly dental-only Algerian medications (curated dental practice catalog
 *    + 575 official Algerian Nomenclature dental specialties)
 *  - Dental prescription protocol templates
 *  - Dental clinical safety reference rules (pédodontie mg/kg, interactions, allergies)
 */

const { normalizeSearch } = require('../utils/common');
const { DENTAL_MEDICATIONS, DENTAL_PRESCRIPTION_TEMPLATES } = require('./dental-drugs');
const { seedOfficialDentalMedications } = require('./official-medications');
const {
  STARTER_DOSE_RULES,
  STARTER_INTERACTION_PAIRS,
  STARTER_CONTRAINDICATIONS,
  STARTER_ALLERGY_CLASSES,
  STARTER_CONTROLLED_RULES,
} = require('./dental-clinical-starter');

const DEFAULT_SETTINGS = {
  clinic_name: 'Cabinet Dentaire',
  clinic_phone: '',
  clinic_address: '',
  doctor_name: '',
  doctor_specialty: 'Chirurgien-Dentiste',
  doctor_ordre: '',
  currency: 'DZD',
  language: 'fr',
  daily_capacity: '10',
  // 0 = Sunday … 6 = Saturday. Algeria works Sunday → Thursday.
  working_days: '0,1,2,3,4',
  // Patients can take today's slot when room is left.
  allow_same_day_booking: '1',
  booking_horizon_days: '45',
  // Average session duration (minutes), used to estimate waiting time in queue.
  avg_session_minutes: '20',
  queue_notify_enabled: '1',
  password_hash: '',
  password_salt: '',
  // WhatsApp
  bot_enabled: '0',
  bot_language: 'fr',
  bot_darija_mode: '0',
  intake_enabled: '1',
  reminder_enabled: '1',
  reminder_hour: '17',
  // Anti-ban guard rails (incoming replies only, never bulk).
  send_min_delay_ms: '4000',
  send_max_delay_ms: '9000',
  max_replies_per_hour: '8',
  max_replies_per_day: '120',
  // Autostart
  autostart_enabled: '1',
  autostart_initialized: '0',
  // Backups
  backup_enabled: '1',
  backup_keep: '30',
  last_backup_at: '',
  // Internal
  schema_version: '3',
};

const TREATMENTS = [
  ['Consultation', 'فحص', 1500],
  ['Détartrage', 'تنظيف الجير', 3000],
  ['Carie composite', 'حشو بلاستيكي', 4000],
  ['Carie amalgame', 'حشو ملغمي', 3000],
  ['Traitement canal (1 racine)', 'علاج قناة (جذر واحد)', 8000],
  ['Extraction simple', 'قلع بسيط', 3000],
  ['Extraction dent de sagesse', 'قلع ضرس العقل', 8000],
  ['Couronne céramique', 'تاج خزفي', 25000],
  ['Prothèse partielle', 'طقم جزئي', 30000],
  ['Prothèse complète', 'طقم كامل', 45000],
  ['Blanchiment', 'تبييض الأسنان', 20000],
  ['Implant dentaire', 'زرع سني', 90000],
  ['Radiographie', 'صورة أشعة', 1000],
  ['Détartrage enfant', 'تنظيف أسنان الأطفال', 2000],
];

const EXPENSE_CATEGORIES = [
  ['materials', 'Matériel', 'مواد وأدوات'],
  ['rent', 'Loyer', 'الإيجار'],
  ['salaries', 'Salaires', 'الأجور'],
  ['lab', 'Laboratoire', 'المخبر'],
  ['electricity', 'Électricité / Eau', 'كهرباء وماء'],
  ['transport', 'Transport', 'النقل'],
  ['marketing', 'Publicité', 'الإشهار'],
  ['other', 'Autres', 'أخرى'],
];

function makeDciGroup(dci, strength) {
  const d = normalizeSearch(dci);
  const s = normalizeSearch(strength).replace(/\s+/g, '');
  return d ? `${d}|${s}` : '';
}

function seedDefaults(db) {
  const insertSetting = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING',
  );
  const tx = db.transaction(() => {
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) insertSetting.run(key, value);

    const treatmentCount = db.prepare('SELECT COUNT(*) AS n FROM treatments').get().n;
    if (treatmentCount === 0) {
      const insert = db.prepare(
        'INSERT INTO treatments (name_fr, name_ar, default_price) VALUES (?, ?, ?)',
      );
      for (const [fr, ar, price] of TREATMENTS) insert.run(fr, ar, price);
    }

    const categoryCount = db.prepare('SELECT COUNT(*) AS n FROM expense_categories').get().n;
    if (categoryCount === 0) {
      const insert = db.prepare(
        'INSERT INTO expense_categories (key, name_fr, name_ar) VALUES (?, ?, ?)',
      );
      for (const [key, fr, ar] of EXPENSE_CATEGORIES) insert.run(key, fr, ar);
    }

    // Seed curated Algerian dental medications
    const starterMedCount = db
      .prepare("SELECT COUNT(*) AS n FROM medications WHERE source = 'starter'")
      .get().n;
    if (starterMedCount === 0) {
      const insertMed = db.prepare(`
        INSERT INTO medications
          (brand, dci, strength, form, specialty, keywords_ar, default_dosage, default_duration,
           reference_dci_group, source, verified, last_updated, name_normalized, folded_search, custom, active)
        VALUES
          (?, ?, ?, ?, ?, ?, ?, ?, ?, 'starter', 1, '2026-10-26', ?, ?, 0, 1)
      `);
      for (const [brand, dci, strength, form, specialty, keywordsAr, dosage, duration] of DENTAL_MEDICATIONS) {
        const nameNorm = normalizeSearch(brand);
        const folded = normalizeSearch(`${brand} ${dci} ${strength} ${form} ${specialty} ${keywordsAr}`);
        insertMed.run(
          brand,
          dci,
          strength,
          form,
          specialty,
          keywordsAr,
          dosage,
          duration,
          makeDciGroup(dci, strength),
          nameNorm,
          folded,
        );
      }
    }

    // Seed dental prescription protocol templates
    const tplCount = db.prepare('SELECT COUNT(*) AS n FROM prescription_templates').get().n;
    if (tplCount === 0) {
      const insertTpl = db.prepare(`
        INSERT INTO prescription_templates
          (title_fr, title_ar, specialty, items_json, exams_requested, advice, source, verified)
        VALUES (?, ?, ?, ?, ?, ?, 'starter', 1)
      `);
      for (const tpl of DENTAL_PRESCRIPTION_TEMPLATES) {
        insertTpl.run(
          tpl.title_fr,
          tpl.title_ar,
          tpl.specialty,
          JSON.stringify(tpl.items),
          tpl.exams_requested || '',
          tpl.advice || '',
        );
      }
    }

    // Seed dental clinical decision-support starter rules
    if (db.prepare('SELECT COUNT(*) AS n FROM dose_rules').get().n === 0) {
      const ins = db.prepare(`
        INSERT INTO dose_rules
          (dci, form, concentration_mg_per_ml, min_age_months, max_age_months,
           mg_per_kg_per_day, mg_per_kg_per_dose, doses_per_day,
           max_single_dose_mg, max_daily_dose_mg, max_duration_days,
           notes_fr, notes_ar, source, verified)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'starter', 0)
      `);
      for (const r of STARTER_DOSE_RULES) {
        ins.run(
          r.dci, r.form, r.concentration_mg_per_ml, r.min_age_months, r.max_age_months,
          r.mg_per_kg_per_day, r.mg_per_kg_per_dose, r.doses_per_day,
          r.max_single_dose_mg, r.max_daily_dose_mg, r.max_duration_days,
          r.notes_fr, r.notes_ar,
        );
      }
    }

    if (db.prepare('SELECT COUNT(*) AS n FROM interaction_pairs').get().n === 0) {
      const ins = db.prepare(`
        INSERT INTO interaction_pairs
          (dci_a, dci_b, severity, mechanism_fr, mechanism_ar, action_fr, action_ar, source, verified)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'starter', 0)
      `);
      for (const r of STARTER_INTERACTION_PAIRS) {
        ins.run(r.dci_a, r.dci_b, r.severity, r.mechanism_fr, r.mechanism_ar, r.action_fr, r.action_ar);
      }
    }

    if (db.prepare('SELECT COUNT(*) AS n FROM contraindications').get().n === 0) {
      const ins = db.prepare(`
        INSERT INTO contraindications
          (dci, condition_type, condition_match, severity, message_fr, message_ar, source, verified)
        VALUES (?, ?, ?, ?, ?, ?, 'starter', 0)
      `);
      for (const r of STARTER_CONTRAINDICATIONS) {
        ins.run(r.dci, r.condition_type, r.condition_match, r.severity, r.message_fr, r.message_ar);
      }
    }

    if (db.prepare('SELECT COUNT(*) AS n FROM allergy_class_rules').get().n === 0) {
      const ins = db.prepare(`
        INSERT INTO allergy_class_rules
          (class_code, class_name_fr, class_name_ar, trigger_terms, cross_dci_terms, severity, source, verified)
        VALUES (?, ?, ?, ?, ?, ?, 'starter', 0)
      `);
      for (const r of STARTER_ALLERGY_CLASSES) {
        ins.run(r.class_code, r.class_name_fr, r.class_name_ar, r.trigger_terms, r.cross_dci_terms, r.severity);
      }
    }

    if (db.prepare('SELECT COUNT(*) AS n FROM controlled_rules').get().n === 0) {
      const ins = db.prepare(`
        INSERT INTO controlled_rules
          (dci, schedule, max_duration_days, requires_secure_rx, notes_fr, notes_ar, source, verified)
        VALUES (?, ?, ?, ?, ?, ?, 'starter', 0)
      `);
      for (const r of STARTER_CONTROLLED_RULES) {
        ins.run(r.dci, r.schedule, r.max_duration_days, r.requires_secure_rx, r.notes_fr, r.notes_ar);
      }
    }
  });
  tx();

  // Seed official Algerian dental nomenclature catalog (575 registered dental specialties)
  seedOfficialDentalMedications(db);
}

module.exports = { seedDefaults, DEFAULT_SETTINGS, TREATMENTS, EXPENSE_CATEGORIES };
