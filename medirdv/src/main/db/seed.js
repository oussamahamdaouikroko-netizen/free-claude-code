'use strict';
/**
 * First-run seed data for MediRDV: default clinic/doctor settings, medical acts
 * catalog with Algerian clinic prices (DZD, editable), standard expense
 * categories, offline Algerian Nomenclature medications, and starter
 * prescription templates.
 */

const { ALGERIA_MEDICATIONS, STARTER_TEMPLATES } = require('./algeria-drugs');
const { seedOfficialAlgerianMedications } = require('./official-medications');
const { normalizeSearch } = require('../utils/common');
const {
  STARTER_DOSE_RULES,
  STARTER_INTERACTION_PAIRS,
  STARTER_CONTRAINDICATIONS,
  STARTER_ALLERGY_CLASSES,
  STARTER_CONTROLLED_RULES,
} = require('./clinical-starter');
const { ICD10_STARTER } = require('./icd10-starter');

const DEFAULT_SETTINGS = {
  clinic_name: 'Cabinet Médical',
  clinic_phone: '',
  clinic_address: '',
  clinic_wilaya: 'Alger',
  doctor_name: '',
  doctor_specialty: 'Médecine Générale',
  doctor_ordre: '',
  clinic_rc: '',
  clinic_nif: '',
  clinic_nis: '',
  clinic_ai: '',
  print_paper_size: 'A5',
  print_letterhead: '1',
  doctor_signature_data: '',
  bot_darija_mode: '0',
  currency: 'DZD',
  language: 'fr',
  daily_capacity: '15',
  // 0 = Sunday … 6 = Saturday. Algeria works Sunday → Thursday.
  working_days: '0,1,2,3,4',
  // Patients can take today's slot when room is left.
  allow_same_day_booking: '1',
  booking_horizon_days: '45',
  // Average consultation duration (minutes), used to estimate waiting time in queue.
  avg_session_minutes: '15',
  queue_notify_enabled: '1',
  password_hash: '',
  password_salt: '',
  // WhatsApp
  bot_enabled: '0',
  bot_language: 'fr', // language used when the patient's intent is unclear
  reminder_enabled: '1',
  reminder_hour: '17', // sent the day before at 17:00 local time
  // Anti-ban guard rails (incoming replies only, never bulk).
  send_min_delay_ms: '4000',
  send_max_delay_ms: '9000',
  max_replies_per_hour: '8',
  max_replies_per_day: '120',
  // Backups
  backup_enabled: '1',
  backup_keep: '30',
  last_backup_at: '',
  // Internal
  schema_version: '1',
};

const TREATMENTS = [
  ['Consultation générale', 'فحص طبي عام', 1500],
  ['Consultation spécialisée', 'فحص طبي متخصص', 2500],
  ['Contrôle médical', 'مراقبة طبية (فحص متابعة)', 1000],
  ['Électrocardiogramme (ECG)', 'تخطيط القلب الكهربائي (ECG)', 2000],
  ['Échographie cardiaque (Écho-Doppler)', 'إيكوغرافيا القلب والدوبلر', 4500],
  ['Échographie abdominale / pelvienne', 'إيكوغرافيا البطن والحوض', 3000],
  ['Fond d’œil + Tonus oculaire', 'فحص قاع العين وضغط العين', 3000],
  ['Réfraction & Acuité visuelle', 'قياس البصر وتصحيح النظر', 2000],
  ['Infiltration articulaire', 'حقن مفصلي موضعي', 3500],
  ['Immobilisation / Plâtre / Attelle', 'تجبير أو وضع جبيرة طبية', 3000],
  ['Nébulisation / Aérosolthérapie', 'حصة تبخير تنفسي (أيروسول)', 1000],
  ['Pansement & Petite chirurgie', 'تضميد وجراحة صغرى', 1500],
  ['Holter tensionnel / ECG (24h)', 'هولتر ضغط الدم أو القلب 24 سا', 5000],
  ['Certificat d’aptitude médicale', 'شهادة اللياقة الطبية', 1000],
];

const EXPENSE_CATEGORIES = [
  ['materials', 'Consommables médicaux', 'مستهلكات ومعدات طبية'],
  ['rent', 'Loyer', 'الإيجار'],
  ['salaries', 'Salaires', 'الأجور'],
  ['lab', 'Analyses / Maintenance', 'تحاليل وصيانة الأجهزة'],
  ['electricity', 'Électricité / Eau / Internet', 'كهرباء وماء وإنترنت'],
  ['transport', 'Transport', 'النقل'],
  ['marketing', 'Publicité / Imprimerie', 'إشهار ومطبوعات (وصفات)'],
  ['other', 'Autres', 'أخرى'],
];

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

    const medCount = db.prepare('SELECT COUNT(*) AS n FROM medications WHERE custom = 0').get().n;
    if (medCount === 0) {
      const insertMed = db.prepare(`
        INSERT INTO medications
          (brand, dci, strength, form, specialty, keywords_ar, default_dosage, default_duration,
           reference_dci_group, name_normalized, folded_search, source, verified, custom)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'starter', 0, 0)
      `);
      for (const row of ALGERIA_MEDICATIONS) {
        const [brand, dci, strength, form, spec, kwAr, defDos, defDur] = row;
        const dciGroup = `${normalizeSearch(dci)}|${normalizeSearch(strength).replace(/\s+/g, '')}`;
        const nameNorm = normalizeSearch(brand);
        const folded = normalizeSearch(`${brand} ${dci} ${strength} ${form} ${spec} ${kwAr}`);
        insertMed.run(brand, dci, strength, form, spec, kwAr, defDos, defDur, dciGroup, nameNorm, folded);
      }
    }

    seedOfficialAlgerianMedications(db);

    const tplCount = db.prepare('SELECT COUNT(*) AS n FROM prescription_templates').get().n;
    if (tplCount === 0) {
      const insertTpl = db.prepare(`
        INSERT INTO prescription_templates
          (title_fr, title_ar, specialty, items_json, exams_requested, advice, icd10_code, source, verified)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'starter', 0)
      `);
      const inferIcd = (titleFr = '') => {
        const t = titleFr.toLowerCase();
        if (t.includes('angine')) return 'J02.9';
        if (t.includes('hypertension') || t.includes('hta')) return 'I10';
        if (t.includes('diab')) return 'E11.9';
        if (t.includes('gastro')) return 'A09';
        if (t.includes('reflux') || t.includes('rgo') || t.includes('gastrite')) return 'K21.9';
        if (t.includes('rhino') || t.includes('grippe')) return 'J00';
        if (t.includes('asthme')) return 'J45.9';
        if (t.includes('conjonctivite')) return 'H10.9';
        if (t.includes('lombalgie') || t.includes('sciatique')) return 'M54.5';
        return '';
      };
      for (const tpl of STARTER_TEMPLATES) {
        insertTpl.run(
          tpl.title_fr,
          tpl.title_ar,
          tpl.specialty,
          JSON.stringify(tpl.items),
          tpl.exams_requested || '',
          tpl.advice || '',
          tpl.icd10_code || inferIcd(tpl.title_fr),
        );
      }
    }

    if (db.prepare('SELECT COUNT(*) AS n FROM icd10').get().n === 0) {
      const insIcd = db.prepare(`
        INSERT INTO icd10
          (code, label_fr, label_ar, chapter, is_chronic_ald, is_notifiable, folded_search, source, verified)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'starter', 0)
      `);
      for (const item of ICD10_STARTER) {
        const folded = `${item.code} ${item.label_fr} ${item.label_ar} ${item.chapter}`
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .toLowerCase();
        insIcd.run(
          item.code,
          item.label_fr,
          item.label_ar,
          item.chapter,
          item.is_chronic_ald ? 1 : 0,
          item.is_notifiable ? 1 : 0,
          folded,
        );
      }
    }

    if (db.prepare('SELECT COUNT(*) AS n FROM dose_rules').get().n === 0) {
      const ins = db.prepare(`
        INSERT INTO dose_rules
          (dci, form, concentration_mg_per_ml, min_age_months, max_age_months,
           mg_per_kg_per_day, mg_per_kg_per_dose, doses_per_day,
           max_single_dose_mg, max_daily_dose_mg, max_duration_days,
           notes_fr, notes_ar, source, verified)
        VALUES
          (@dci, @form, @concentration_mg_per_ml, @min_age_months, @max_age_months,
           @mg_per_kg_per_day, @mg_per_kg_per_dose, @doses_per_day,
           @max_single_dose_mg, @max_daily_dose_mg, @max_duration_days,
           @notes_fr, @notes_ar, 'starter', 0)
      `);
      for (const r of STARTER_DOSE_RULES) ins.run(r);
    }

    if (db.prepare('SELECT COUNT(*) AS n FROM interaction_pairs').get().n === 0) {
      const ins = db.prepare(`
        INSERT INTO interaction_pairs
          (dci_a, dci_b, severity, mechanism_fr, mechanism_ar, action_fr, action_ar, source, verified)
        VALUES
          (@dci_a, @dci_b, @severity, @mechanism_fr, @mechanism_ar, @action_fr, @action_ar, 'starter', 0)
      `);
      for (const r of STARTER_INTERACTION_PAIRS) ins.run(r);
    }

    if (db.prepare('SELECT COUNT(*) AS n FROM contraindications').get().n === 0) {
      const ins = db.prepare(`
        INSERT INTO contraindications
          (dci, condition_type, condition_match, severity, message_fr, message_ar, source, verified)
        VALUES
          (@dci, @condition_type, @condition_match, @severity, @message_fr, @message_ar, 'starter', 0)
      `);
      for (const r of STARTER_CONTRAINDICATIONS) ins.run(r);
    }

    if (db.prepare('SELECT COUNT(*) AS n FROM allergy_class_rules').get().n === 0) {
      const ins = db.prepare(`
        INSERT INTO allergy_class_rules
          (class_code, class_name_fr, class_name_ar, trigger_terms, cross_dci_terms, severity, source, verified)
        VALUES
          (@class_code, @class_name_fr, @class_name_ar, @trigger_terms, @cross_dci_terms, @severity, 'starter', 0)
      `);
      for (const r of STARTER_ALLERGY_CLASSES) ins.run(r);
    }

    if (db.prepare('SELECT COUNT(*) AS n FROM controlled_rules').get().n === 0) {
      const ins = db.prepare(`
        INSERT INTO controlled_rules
          (dci, schedule, max_duration_days, requires_secure_rx, notes_fr, notes_ar, source, verified)
        VALUES
          (@dci, @schedule, @max_duration_days, @requires_secure_rx, @notes_fr, @notes_ar, 'starter', 0)
      `);
      for (const r of STARTER_CONTROLLED_RULES) ins.run(r);
    }

    if (db.prepare('SELECT COUNT(*) AS n FROM vaccine_schedule').get().n === 0) {
      const PEV_ALGERIA = [
        ['BCG_HB0', 'BCG + Hépatite B (naissance)', 'السل + التهاب الكبد ب (عند الولادة)', 0, 'Naissance', null, 'Calendrier vaccinal national indicatif'],
        ['PENTA_VPC_2M', 'DTCa-VPI-Hib-HB + VPC (2 mois)', 'اللقاح السداسي + المكورات الرئوية (شهران)', 2, '1ère dose (2 mois)', 2, 'Calendrier vaccinal national indicatif'],
        ['PENTA_VPC_4M', 'DTCa-VPI-Hib-HB + VPC (4 mois)', 'اللقاح السداسي + المكورات الرئوية (4 أشهر)', 4, '2ème dose (4 mois)', 8, 'Calendrier vaccinal national indicatif'],
        ['PENTA_VPC_12M', 'DTCa-VPI-Hib-HB + VPC (12 mois)', 'اللقاح السداسي + المكورات الرئوية (12 شهرا)', 12, 'Rappel (12 mois)', null, 'Calendrier vaccinal national indicatif'],
        ['ROR_11M', 'ROR — Rougeole-Oreillons-Rubéole (11 mois)', 'الحصبة والنكاف والحصبة الألمانية (11 شهرا)', 11, '1ère dose (11 mois)', 7, 'Calendrier vaccinal national indicatif'],
        ['ROR_18M', 'ROR — 2ème dose (18 mois)', 'الحصبة والنكاف والحصبة الألمانية (18 شهرا)', 18, '2ème dose (18 mois)', null, 'Calendrier vaccinal national indicatif'],
        ['DTCA_VPI_6Y', 'DTCa-VPI (Rappel scolaire 6 ans)', 'تذكير الدخول المدرسي (6 سنوات)', 72, 'Rappel 6 ans', 60, 'Calendrier vaccinal national indicatif'],
        ['DTC_VPI_11Y', 'dTca-VPI (Rappel 11–13 ans)', 'تذكير المراهقين (11–13 سنة)', 144, 'Rappel 11–13 ans', 60, 'Calendrier vaccinal national indicatif'],
        ['DT_ADULT', 'dT Adulte (Rappel décennal)', 'تذكير الدفتيريا والكزاز للبالغين', 216, 'Rappel 10 ans', 120, 'Calendrier vaccinal national indicatif'],
      ];
      const insVac = db.prepare(`
        INSERT INTO vaccine_schedule
          (vaccine_code, name_fr, name_ar, recommended_age_months, dose_label, booster_interval_months, notes_fr, source, verified)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'starter', 0)
      `);
      for (const v of PEV_ALGERIA) insVac.run(...v);
    }
  });
  tx();
}

module.exports = { seedDefaults, DEFAULT_SETTINGS, TREATMENTS, EXPENSE_CATEGORIES };
