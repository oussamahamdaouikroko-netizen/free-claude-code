'use strict';
/**
 * Settings service.
 *
 * Settings are stored as strings in a key/value table (easy to extend without
 * migrations) but every write goes through a validator so a bad value can
 * never break the booking or prescription engine.
 */

const { getDb } = require('../db');
const { DEFAULT_SETTINGS } = require('../db/seed');

const DAY_LABELS = {
  fr: ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'],
  ar: ['أحد', 'اثنين', 'ثلاثاء', 'أربعاء', 'خميس', 'جمعة', 'سبت'],
};

const clampInt = (value, min, max, fallback) => {
  const n = Number.parseInt(String(value), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

const asFlag = (value) => (String(value) === '1' || String(value) === 'true' ? 1 : 0);

/**
 * Validators. Each returns the normalized string to store.
 * Throwing here means the renderer gets a readable error through IPC.
 */
const VALIDATORS = {
  clinic_name: (v) => {
    const name = String(v ?? '').trim().slice(0, 100);
    if (!name) throw new Error('SETTING_INVALID:clinic_name');
    return name;
  },
  clinic_phone: (v) => String(v ?? '').trim().slice(0, 40),
  clinic_address: (v) => String(v ?? '').trim().slice(0, 200),
  clinic_wilaya: (v) => String(v ?? '').trim().slice(0, 60),
  doctor_name: (v) => String(v ?? '').trim().slice(0, 100),
  doctor_specialty: (v) => String(v ?? '').trim().slice(0, 120),
  doctor_ordre: (v) => String(v ?? '').trim().slice(0, 60),
  clinic_rc: (v) => String(v ?? '').trim().slice(0, 60),
  clinic_nif: (v) => String(v ?? '').trim().slice(0, 60),
  clinic_nis: (v) => String(v ?? '').trim().slice(0, 60),
  clinic_ai: (v) => String(v ?? '').trim().slice(0, 60),
  print_paper_size: (v) => (String(v).toUpperCase() === 'A4' ? 'A4' : 'A5'),
  print_letterhead: (v) => String(asFlag(v)),
  doctor_signature_data: (v) => {
    const raw = String(v ?? '').trim();
    if (!raw) return '';
    if (!/^data:image\/(png|jpeg|jpg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/i.test(raw)) {
      throw new Error('SETTING_INVALID:doctor_signature_data');
    }
    return raw.slice(0, 350000);
  },
  bot_darija_mode: (v) => String(asFlag(v)),
  currency: (v) => String(v ?? 'DZD').trim().toUpperCase().slice(0, 8) || 'DZD',
  default_consultation_fee: (v) => String(clampInt(v, 0, 1000000, 0)),
  autostart_enabled: (v) => String(asFlag(v)),
  autostart_initialized: (v) => String(asFlag(v)),
  language: (v) => (v === 'ar' ? 'ar' : 'fr'),
  daily_capacity: (v) => String(clampInt(v, 1, 200, 15)),
  working_days: (v) => {
    const days = String(v ?? '')
      .split(',')
      .map((d) => Number.parseInt(d, 10))
      .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
    const unique = [...new Set(days)].sort();
    if (unique.length === 0) throw new Error('SETTING_INVALID:working_days');
    return unique.join(',');
  },
  allow_same_day_booking: (v) => String(asFlag(v)),
  booking_horizon_days: (v) => String(clampInt(v, 1, 365, 45)),
  avg_session_minutes: (v) => String(clampInt(v, 5, 180, 15)),
  queue_notify_enabled: (v) => String(asFlag(v)),
  bot_enabled: (v) => String(asFlag(v)),
  bot_language: (v) => (v === 'ar' ? 'ar' : 'fr'),
  reminder_enabled: (v) => String(asFlag(v)),
  reminder_hour: (v) => String(clampInt(v, 0, 23, 17)),
  send_min_delay_ms: (v) => String(clampInt(v, 1500, 60000, 4000)),
  send_max_delay_ms: (v) => String(clampInt(v, 2000, 120000, 9000)),
  max_replies_per_hour: (v) => String(clampInt(v, 1, 60, 8)),
  max_replies_per_day: (v) => String(clampInt(v, 1, 500, 120)),
  backup_enabled: (v) => String(asFlag(v)),
  backup_keep: (v) => String(clampInt(v, 1, 365, 30)),
  last_backup_at: (v) => String(v ?? '').slice(0, 40),
};

/** Keys the renderer is allowed to write. */
function writableKeys() {
  return Object.keys(VALIDATORS);
}

function getRaw(key) {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : undefined;
}

/** @returns {string} */
function get(key) {
  const raw = getRaw(key);
  return raw === undefined ? String(DEFAULT_SETTINGS[key] ?? '') : raw;
}

function getInt(key) {
  return Number.parseInt(get(key), 10) || 0;
}

function getBool(key) {
  return get(key) === '1';
}

/** Full settings object for the UI (never exposes the password hash). */
function all() {
  const rows = getDb().prepare('SELECT key, value FROM settings').all();
  const out = { ...DEFAULT_SETTINGS };
  for (const row of rows) out[row.key] = row.value;
  delete out.password_hash;
  delete out.password_salt;
  out.has_password = Boolean(getRaw('password_hash'));
  out.working_days = getWorkingDays();
  return out;
}

function set(key, value) {
  const validator = VALIDATORS[key];
  if (!validator) throw new Error(`SETTING_UNKNOWN:${key}`);
  const normalized = validator(value);
  getDb()
    .prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    )
    .run(key, normalized);
  return normalized;
}

/** Validate + persist several keys atomically. */
function setMany(patch) {
  if (!patch || typeof patch !== 'object') throw new Error('SETTINGS_INVALID');
  const db = getDb();
  const tx = db.transaction(() => {
    for (const [key, value] of Object.entries(patch)) {
      if (!VALIDATORS[key]) continue; // ignore unknown/read-only keys silently
      const normalized = VALIDATORS[key](value);
      db.prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      ).run(key, normalized);
    }
  });
  tx();
  return all();
}

/** @returns {number[]} working weekday indexes (0 = Sunday) */
function getWorkingDays() {
  return get('working_days')
    .split(',')
    .map((d) => Number.parseInt(d, 10))
    .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
}

function isWorkingDay(isoDate) {
  const { weekday } = require('../utils/dates');
  return getWorkingDays().includes(weekday(isoDate));
}

/** Localized labels for the settings screen. */
function dayLabels(lang = 'fr') {
  return (DAY_LABELS[lang] || DAY_LABELS.fr).map((label, index) => ({ index, label }));
}

module.exports = {
  get,
  getInt,
  getBool,
  getRaw,
  all,
  set,
  setMany,
  writableKeys,
  getWorkingDays,
  isWorkingDay,
  dayLabels,
};
