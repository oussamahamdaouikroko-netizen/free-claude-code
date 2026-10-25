'use strict';
/**
 * First-run defaults.
 *
 * `INSERT OR IGNORE` means existing values are never overwritten: upgrading the
 * application must not reset the pharmacy's language, name or backup policy.
 */

const DEFAULTS = {
  // Interface
  language: 'fr', // 'fr' | 'ar'
  setup_completed: '0',

  // Pharmacy identity (printed on exports and reports)
  pharmacy_name: '',
  pharmacist_name: '',
  pharmacy_phone: '',
  pharmacy_address: '',

  // Money: amounts are integer centimes; the currency label is fixed for DZ.
  currency: 'DZD',

  // Expiry alerts (days before expiry), highest first.
  expiry_threshold_1: '90',
  expiry_threshold_2: '60',
  expiry_threshold_3: '30',

  // Stock policy
  low_stock_threshold: '10',
  allow_negative_stock: '0', // An explicit, audited override; off by default.

  // Backups
  backup_enabled: '1',
  backup_keep: '30',
  last_backup_at: '',

  // Housekeeping
  audit_keep_days: '730',
};

/**
 * @param {import('better-sqlite3').Database} db
 * @returns {number} how many rows were inserted
 */
function seedDefaults(db) {
  const insert = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  let inserted = 0;
  const run = db.transaction(() => {
    for (const [key, value] of Object.entries(DEFAULTS)) {
      const result = insert.run(key, value);
      inserted += result.changes;
    }
  });
  run();
  return inserted;
}

module.exports = { DEFAULTS, seedDefaults };
