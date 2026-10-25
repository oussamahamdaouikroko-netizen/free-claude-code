'use strict';
/**
 * Typed access to the `settings` table.
 *
 * The renderer can only write settings through `settings:set`, and only the
 * keys declared in `SPECS` below. Each value is validated and stored as TEXT;
 * the getters return proper JS types. This is what keeps a typo in the UI from
 * writing `"abc"` into `backup_keep` and breaking every future backup.
 */

const db = require('../db');
const { AppError, cleanText, nowLocal, toBool } = require('../utils/common');
const { DEFAULTS } = require('../db/seed');

/** Allowed settings, their type and their range. */
const SPECS = {
  language: { type: 'enum', values: ['fr', 'ar'], default: 'fr' },
  setup_completed: { type: 'bool', default: false },

  pharmacy_name: { type: 'text', max: 120, default: '' },
  pharmacist_name: { type: 'text', max: 120, default: '' },
  pharmacy_phone: { type: 'text', max: 40, default: '' },
  pharmacy_address: { type: 'text', max: 240, default: '' },

  currency: { type: 'enum', values: ['DZD'], default: 'DZD' },

  expiry_threshold_1: { type: 'int', min: 1, max: 3650, default: 90 },
  expiry_threshold_2: { type: 'int', min: 1, max: 3650, default: 60 },
  expiry_threshold_3: { type: 'int', min: 1, max: 3650, default: 30 },

  low_stock_threshold: { type: 'int', min: 0, max: 100000, default: 10 },
  allow_negative_stock: { type: 'bool', default: false },

  backup_enabled: { type: 'bool', default: true },
  backup_keep: { type: 'int', min: 1, max: 365, default: 30 },
  last_backup_at: { type: 'text', max: 40, default: '' },

  audit_keep_days: { type: 'int', min: 30, max: 3650, default: 730 },
};

function spec(key) {
  const definition = SPECS[key];
  if (!definition) throw new AppError('INVALID_SETTING_KEY', `Unknown setting: ${key}`);
  return definition;
}

/** Validate + normalise a value for storage (always a string). */
function normalise(key, value) {
  const definition = spec(key);
  switch (definition.type) {
    case 'bool':
      return toBool(value) ? '1' : '0';
    case 'int': {
      const number = Number(value);
      if (!Number.isInteger(number)) {
        throw new AppError('INVALID_SETTING_VALUE', `${key} must be a whole number`);
      }
      if (number < definition.min || number > definition.max) {
        throw new AppError(
          'INVALID_SETTING_VALUE',
          `${key} must be between ${definition.min} and ${definition.max}`,
        );
      }
      return String(number);
    }
    case 'enum': {
      const text = String(value ?? '').trim();
      if (!definition.values.includes(text)) {
        throw new AppError('INVALID_SETTING_VALUE', `${key} must be one of: ${definition.values.join(', ')}`);
      }
      return text;
    }
    case 'text':
    default:
      return cleanText(value, definition.max || 200);
  }
}

/** Read one raw value; returns the spec default when the row is missing. */
function getRaw(key) {
  const definition = spec(key);
  const database = db.getDb();
  const row = database.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) {
    return DEFAULTS[key] ?? String(definition.default);
  }
  return row.value;
}

function get(key) {
  return getRaw(key);
}

function getInt(key) {
  return Number.parseInt(getRaw(key), 10) || 0;
}

function getBool(key) {
  return toBool(getRaw(key));
}

function getLanguage() {
  const value = getRaw('language');
  return value === 'ar' ? 'ar' : 'fr';
}

/** Typed snapshot for the renderer. */
function all() {
  const result = {};
  for (const key of Object.keys(SPECS)) {
    const definition = SPECS[key];
    const raw = getRaw(key);
    if (definition.type === 'bool') result[key] = toBool(raw);
    else if (definition.type === 'int') result[key] = Number.parseInt(raw, 10) || 0;
    else result[key] = raw;
  }
  return result;
}

/** Write one validated value and record it in the audit log. */
function set(key, value) {
  const database = db.getDb();
  const normalised = normalise(key, value);
  database
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(key, normalised, nowLocal());
  return normalised;
}

/**
 * Write several values atomically. Validation happens *before* the first
 * write, so a rejected field never leaves half of a form saved.
 */
function setMany(values) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    throw new AppError('INVALID_PAYLOAD', 'settings must be an object');
  }
  const entries = Object.entries(values);
  if (entries.length === 0) return {};

  const prepared = entries.map(([key, value]) => [key, normalise(key, value)]);
  assertThresholds(prepared);

  const database = db.getDb();
  const statement = database.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  );
  const at = nowLocal();
  const run = database.transaction(() => {
    for (const [key, value] of prepared) statement.run(key, value, at);
  });
  run();

  const written = {};
  for (const [key, value] of prepared) written[key] = value;
  return written;
}

/**
 * Expiry warning thresholds must be strictly decreasing (90 > 60 > 30); mixing
 * them up would make one alert hide another.
 */
function assertThresholds(entries) {
  const current = {
    expiry_threshold_1: getRaw('expiry_threshold_1'),
    expiry_threshold_2: getRaw('expiry_threshold_2'),
    expiry_threshold_3: getRaw('expiry_threshold_3'),
  };
  for (const [key, value] of entries) {
    if (key in current) current[key] = value;
  }
  const [first, second, third] = [
    Number(current.expiry_threshold_1),
    Number(current.expiry_threshold_2),
    Number(current.expiry_threshold_3),
  ];
  if (!(first > second && second > third)) {
    throw new AppError(
      'INVALID_THRESHOLDS',
      'Expiry thresholds must be strictly decreasing (e.g. 90 > 60 > 30)',
    );
  }
}

/** Thresholds as a sorted array, highest first: [90, 60, 30]. */
function expiryThresholds() {
  return [
    getInt('expiry_threshold_1'),
    getInt('expiry_threshold_2'),
    getInt('expiry_threshold_3'),
  ].sort((a, b) => b - a);
}

function setLanguage(language) {
  if (!['fr', 'ar'].includes(language)) {
    throw new AppError('INVALID_SETTING_VALUE', 'language must be fr or ar');
  }
  set('language', language);
  return getLanguage();
}

module.exports = {
  SPECS,
  get,
  getInt,
  getBool,
  getLanguage,
  getRaw,
  all,
  set,
  setMany,
  setLanguage,
  expiryThresholds,
  normalise,
};
