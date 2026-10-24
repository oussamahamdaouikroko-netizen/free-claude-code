'use strict';
/**
 * First-run seed data: default settings, a small dental treatment catalog with
 * Algerian market prices (DZD, editable), and standard expense categories.
 */

const DEFAULT_SETTINGS = {
  clinic_name: 'Cabinet Dentaire',
  clinic_phone: '',
  clinic_address: '',
  currency: 'DZD',
  language: 'fr',
  daily_capacity: '10',
  // 0 = Sunday … 6 = Saturday. Algeria works Sunday → Thursday.
  working_days: '0,1,2,3,4',
  // Patients can take today's slot when room is left.
  allow_same_day_booking: '1',
  booking_horizon_days: '45',
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
  });
  tx();
}

module.exports = { seedDefaults, DEFAULT_SETTINGS, TREATMENTS, EXPENSE_CATEGORIES };
