'use strict';
/**
 * First-run seed data for MediRDV: default clinic/doctor settings, medical acts
 * catalog with Algerian clinic prices (DZD, editable), standard expense
 * categories, offline Algerian Nomenclature medications, and starter
 * prescription templates.
 */

const { ALGERIA_MEDICATIONS, STARTER_TEMPLATES } = require('./algeria-drugs');

const DEFAULT_SETTINGS = {
  clinic_name: 'Cabinet Médical',
  clinic_phone: '',
  clinic_address: '',
  clinic_wilaya: 'Alger',
  doctor_name: '',
  doctor_specialty: 'Médecine Générale',
  doctor_ordre: '',
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
          (brand, dci, strength, form, specialty, keywords_ar, default_dosage, default_duration, custom)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
      `);
      for (const row of ALGERIA_MEDICATIONS) insertMed.run(...row);
    }

    const tplCount = db.prepare('SELECT COUNT(*) AS n FROM prescription_templates').get().n;
    if (tplCount === 0) {
      const insertTpl = db.prepare(`
        INSERT INTO prescription_templates
          (title_fr, title_ar, specialty, items_json, exams_requested, advice)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const tpl of STARTER_TEMPLATES) {
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
  });
  tx();
}

module.exports = { seedDefaults, DEFAULT_SETTINGS, TREATMENTS, EXPENSE_CATEGORIES };
