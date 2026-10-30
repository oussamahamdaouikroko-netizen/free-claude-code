'use strict';
/**
 * Settings service.
 *
 * Settings are stored as strings in a key/value table (easy to extend without
 * migrations) but every write goes through a validator so a bad value can
 * never break the booking engine.
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

const normalizeHourMinute = (value, fallback) => {
  const s = String(value ?? '').trim();
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return fallback;
  let hh = Number.parseInt(m[1], 10);
  const mm = Number.parseInt(m[2], 10);
  if (hh === 24 && mm === 0) hh = 0;
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return fallback;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
};

const parseHHMM = (hhmm, fallback = 0) => {
  const m = String(hhmm || '').match(/^(\d{2}):(\d{2})$/);
  if (!m) return fallback;
  return Number.parseInt(m[1], 10) * 60 + Number.parseInt(m[2], 10);
};

/**
 * Duration in minutes from `startHHMM` to `endHHMM`.
 * Handles midnight (`00:00`) and overnight spans (e.g. `21:00` -> `00:00` = 180 min).
 */
const spanMinutes = (startHHMM, endHHMM) => {
  const s = parseHHMM(startHHMM, 480);
  const eRaw = parseHHMM(endHHMM, 1020);
  const e = eRaw <= s ? eRaw + 1440 : eRaw;
  return Math.max(0, e - s);
};

const addMinutesToHHMM = (startHHMM, deltaMinutes) => {
  const total = (((parseHHMM(startHHMM, 480) + Math.round(Number(deltaMinutes) || 0)) % 1440) + 1440) % 1440;
  const hh = Math.floor(total / 60);
  const mm = total % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
};

const overlapMinutes = (aStart, aEnd, bStart, bEnd) => {
  const as = parseHHMM(aStart, 0);
  const aeRaw = parseHHMM(aEnd, 0);
  const ae = aeRaw <= as ? aeRaw + 1440 : aeRaw;
  const bs0 = parseHHMM(bStart, 0);
  const be0Raw = parseHHMM(bEnd, 0);
  const be0 = be0Raw <= bs0 ? be0Raw + 1440 : be0Raw;
  let total = 0;
  for (const offset of [0, 1440]) {
    const bs = bs0 + offset;
    const be = be0 + offset;
    const lo = Math.max(as, bs);
    const hi = Math.min(ae, be);
    if (hi > lo) total += hi - lo;
  }
  return total;
};

const isMinuteInsideSpan = (minuteOfDay, startHHMM, endHHMM) => {
  const s = parseHHMM(startHHMM, 0);
  const eRaw = parseHHMM(endHHMM, 0);
  if (s === eRaw) return true;
  if (eRaw > s) return minuteOfDay >= s && minuteOfDay < eRaw;
  return minuteOfDay >= s || minuteOfDay < eRaw;
};

/**
 * Validators. Each returns the normalized string to store.
 * Throwing here means the renderer gets a readable error through IPC.
 */
const VALIDATORS = {
  clinic_name: (v) => {
    const name = String(v ?? '').trim().slice(0, 80);
    if (!name) throw new Error('SETTING_INVALID:clinic_name');
    return name;
  },
  clinic_phone: (v) => String(v ?? '').trim().slice(0, 40),
  clinic_address: (v) => String(v ?? '').trim().slice(0, 160),
  doctor_name: (v) => String(v ?? '').trim().slice(0, 100),
  doctor_specialty: (v) => String(v ?? '').trim().slice(0, 120) || 'Chirurgien-Dentiste',
  doctor_ordre: (v) => String(v ?? '').trim().slice(0, 60),
  currency: (v) => String(v ?? 'DZD').trim().toUpperCase().slice(0, 8) || 'DZD',
  language: (v) => (v === 'ar' ? 'ar' : 'fr'),
  daily_capacity: (v) => String(clampInt(v, 1, 500, 10)),
  working_days: (v) => {
    const raw = Array.isArray(v) ? v.join(',') : String(v ?? '');
    const days = raw
      .split(',')
      .map((d) => Number.parseInt(d, 10))
      .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
    const unique = [...new Set(days)].sort();
    if (unique.length === 0) throw new Error('SETTING_INVALID:working_days');
    return unique.join(',');
  },
  clinic_24h_enabled: (v) => String(asFlag(v)),
  work_start_hour: (v) => normalizeHourMinute(v, '08:00'),
  work_end_hour: (v) => normalizeHourMinute(v, '17:00'),
  two_shifts_enabled: (v) => String(asFlag(v)),
  shift2_start_hour: (v) => normalizeHourMinute(v, '21:00'),
  shift2_end_hour: (v) => normalizeHourMinute(v, '00:00'),
  break_enabled: (v) => String(asFlag(v)),
  break_start_hour: (v) => normalizeHourMinute(v, '12:30'),
  break_end_hour: (v) => normalizeHourMinute(v, '13:30'),
  allow_same_day_booking: (v) => String(asFlag(v)),
  booking_horizon_days: (v) => String(clampInt(v, 1, 365, 45)),
  avg_session_minutes: (v) => String(clampInt(v, 5, 180, 20)),
  queue_notify_enabled: (v) => String(asFlag(v)),
  bot_enabled: (v) => String(asFlag(v)),
  bot_language: (v) => (v === 'ar' ? 'ar' : 'fr'),
  bot_darija_mode: (v) => String(asFlag(v)),
  bot_choose_day_enabled: (v) => String(asFlag(v)),
  bot_max_day_choices: (v) => String(clampInt(v, 3, 14, 5)),
  intake_enabled: (v) => String(asFlag(v)),
  reminder_enabled: (v) => String(asFlag(v)),
  reminder_hour: (v) => String(clampInt(v, 0, 23, 17)),
  send_min_delay_ms: (v) => String(clampInt(v, 1500, 60000, 4000)),
  send_max_delay_ms: (v) => String(clampInt(v, 2000, 120000, 9000)),
  max_replies_per_hour: (v) => String(clampInt(v, 1, 60, 8)),
  max_replies_per_day: (v) => String(clampInt(v, 1, 500, 120)),
  autostart_enabled: (v) => String(asFlag(v)),
  autostart_initialized: (v) => String(asFlag(v)),
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
  out.work_schedule = getWorkSchedule();
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

function is24hClinic() {
  return getBool('clinic_24h_enabled');
}

function getWorkSchedule() {
  const is24h = is24hClinic();
  const shift1Start = get('work_start_hour') || '08:00';
  const shift1End = get('work_end_hour') || '17:00';
  const twoShifts = !is24h && getBool('two_shifts_enabled');
  const shift2Start = get('shift2_start_hour') || '21:00';
  const shift2End = get('shift2_end_hour') || '00:00';
  const breakEnabled = !is24h && getBool('break_enabled');
  const breakStart = get('break_start_hour') || '12:30';
  const breakEnd = get('break_end_hour') || '13:30';

  if (is24h) {
    return {
      is24h: true,
      shift1Start: '00:00',
      shift1End: '00:00',
      shift1Minutes: 1440,
      twoShifts: false,
      shift2Start,
      shift2End,
      shift2Minutes: 0,
      grossMinutes: 1440,
      breakEnabled: false,
      breakStart,
      breakEnd,
      breakMinutes: 0,
      deductedBreakMinutes: 0,
      netMinutes: 1440,
      netHours: 24,
    };
  }

  const shift1Minutes = spanMinutes(shift1Start, shift1End);
  const shift2Minutes = twoShifts ? spanMinutes(shift2Start, shift2End) : 0;
  const grossMinutes = shift1Minutes + shift2Minutes;
  const breakMinutes = breakEnabled ? spanMinutes(breakStart, breakEnd) : 0;
  const deductedBreakMinutes = breakEnabled
    ? overlapMinutes(shift1Start, shift1End, breakStart, breakEnd) +
      (twoShifts ? overlapMinutes(shift2Start, shift2End, breakStart, breakEnd) : 0)
    : 0;
  const netMinutes = Math.max(0, grossMinutes - deductedBreakMinutes);

  return {
    is24h: false,
    shift1Start,
    shift1End,
    shift1Minutes,
    twoShifts,
    shift2Start,
    shift2End,
    shift2Minutes,
    grossMinutes,
    breakEnabled,
    breakStart,
    breakEnd,
    breakMinutes,
    deductedBreakMinutes,
    netMinutes,
    netHours: Math.round((netMinutes / 60) * 100) / 100,
  };
}

function formatScheduleSummary(lang = 'fr') {
  const s = getWorkSchedule();
  if (s.is24h) {
    return lang === 'ar' ? '24/24 ساعة بدون توقف' : '24h/24 sans interruption';
  }
  const endLabel = (hhmm) =>
    hhmm === '00:00' ? (lang === 'ar' ? '00:00 (12 ليلاً)' : '00:00 (minuit)') : hhmm;
  const part1 = `${s.shift1Start} – ${endLabel(s.shift1End)}`;
  if (!s.twoShifts) return part1;
  const part2 = `${s.shift2Start} – ${endLabel(s.shift2End)}`;
  return lang === 'ar' ? `${part1} | الفترة 2: ${part2}` : `${part1} | 2e période : ${part2}`;
}

function formatBreakSummary(lang = 'fr') {
  const s = getWorkSchedule();
  if (!s.breakEnabled) return '';
  return lang === 'ar'
    ? `راحة الطبيب: ${s.breakStart} – ${s.breakEnd}`
    : `Pause praticien : ${s.breakStart} – ${s.breakEnd}`;
}

function isTimeInBreak(hhmm) {
  const s = getWorkSchedule();
  if (!s.breakEnabled) return false;
  return isMinuteInsideSpan(parseHHMM(hhmm, -1), s.breakStart, s.breakEnd);
}

function isTimeWithinWorkSchedule(hhmm) {
  const s = getWorkSchedule();
  if (s.is24h) return true;
  const m = parseHHMM(hhmm, -1);
  if (m < 0) return false;
  if (s.breakEnabled && isMinuteInsideSpan(m, s.breakStart, s.breakEnd)) return false;
  if (isMinuteInsideSpan(m, s.shift1Start, s.shift1End)) return true;
  if (s.twoShifts && isMinuteInsideSpan(m, s.shift2Start, s.shift2End)) return true;
  return false;
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
  is24hClinic,
  getWorkSchedule,
  formatScheduleSummary,
  formatBreakSummary,
  isTimeInBreak,
  isTimeWithinWorkSchedule,
  spanMinutes,
  addMinutesToHHMM,
  dayLabels,
};
