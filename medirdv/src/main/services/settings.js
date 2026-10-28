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

function normalizeHourMinute(value, fallback = '08:00') {
  const raw = String(value ?? '').trim();
  if (!raw) return fallback;
  if (raw === '24:00') return '00:00';
  const m = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) throw new Error('SETTING_INVALID:work_hours');
  const hh = Number.parseInt(m[1], 10);
  const mm = Number.parseInt(m[2], 10);
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) throw new Error('SETTING_INVALID:work_hours');
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function parseTimeMinutes(hhmm, fallback = 0) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return fallback;
  const hh = Number.parseInt(m[1], 10);
  const mm = Number.parseInt(m[2], 10);
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return fallback;
  return hh * 60 + mm;
}

/**
 * Duration in minutes between `startHHMM` and `endHHMM`.
 * Supports midnight / overnight wrap-around (e.g. `21:00` -> `00:00` = 180 min / 3h).
 */
function spanMinutes(startHHMM, endHHMM) {
  const s = parseTimeMinutes(startHHMM, 0);
  const e = parseTimeMinutes(endHHMM, 0);
  if (s === e) return 0;
  return e > s ? e - s : e + 1440 - s;
}

function addMinutesToHHMM(startHHMM, deltaMinutes) {
  const s = parseTimeMinutes(startHHMM, 0);
  const total = (((s + Math.round(Number(deltaMinutes) || 0)) % 1440) + 1440) % 1440;
  const hh = String(Math.floor(total / 60)).padStart(2, '0');
  const mm = String(total % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

function intervalSegments(startHHMM, endHHMM) {
  const s = parseTimeMinutes(startHHMM, 0);
  const e = parseTimeMinutes(endHHMM, 0);
  if (s === e) return [];
  if (e > s) return [[s, e]];
  return [
    [s, 1440],
    [0, e],
  ];
}

function overlapMinutes(aStart, aEnd, bStart, bEnd) {
  const segA = intervalSegments(aStart, aEnd);
  const segB = intervalSegments(bStart, bEnd);
  let total = 0;
  for (const [s1, e1] of segA) {
    for (const [s2, e2] of segB) {
      const lo = Math.max(s1, s2);
      const hi = Math.min(e1, e2);
      if (hi > lo) total += hi - lo;
    }
  }
  return total;
}

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
  daily_capacity: (v) => String(clampInt(v, 1, 500, 15)),
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
  avg_session_minutes: (v) => String(clampInt(v, 5, 180, 15)),
  queue_notify_enabled: (v) => String(asFlag(v)),
  bot_enabled: (v) => String(asFlag(v)),
  bot_language: (v) => (v === 'ar' ? 'ar' : 'fr'),
  bot_choose_day_enabled: (v) => String(asFlag(v)),
  bot_available_days_count: (v) => String(clampInt(v, 3, 14, 7)),
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

/** Localized labels for the settings screen. */
function dayLabels(lang = 'fr') {
  return (DAY_LABELS[lang] || DAY_LABELS.fr).map((label, index) => ({ index, label }));
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
      twoShifts: false,
      shift1Start,
      shift1End,
      shift1Minutes: 1440,
      shift2Start,
      shift2End,
      shift2Minutes: 0,
      breakEnabled: false,
      breakStart,
      breakEnd,
      breakMinutes: 0,
      grossMinutes: 1440,
      netMinutes: 1440,
      netHours: 24,
    };
  }

  const shift1Minutes = spanMinutes(shift1Start, shift1End);
  const shift2Minutes = twoShifts ? spanMinutes(shift2Start, shift2End) : 0;
  const rawBreakMinutes = breakEnabled ? spanMinutes(breakStart, breakEnd) : 0;
  let deductedBreak = 0;
  if (breakEnabled && rawBreakMinutes > 0) {
    const ov1 = overlapMinutes(shift1Start, shift1End, breakStart, breakEnd);
    const ov2 = twoShifts ? overlapMinutes(shift2Start, shift2End, breakStart, breakEnd) : 0;
    const overlap = ov1 + ov2;
    deductedBreak = overlap > 0 ? Math.min(rawBreakMinutes, overlap) : 0;
  }

  const grossMinutes = Math.min(1440, shift1Minutes + shift2Minutes);
  const netMinutes = Math.max(0, grossMinutes - deductedBreak);
  const netHours = Math.round((netMinutes / 60) * 100) / 100;

  return {
    is24h: false,
    twoShifts,
    shift1Start,
    shift1End,
    shift1Minutes,
    shift2Start,
    shift2End,
    shift2Minutes,
    breakEnabled,
    breakStart,
    breakEnd,
    breakMinutes: rawBreakMinutes,
    deductedBreakMinutes: deductedBreak,
    grossMinutes,
    netMinutes,
    netHours,
  };
}

function formatEndLabel(endHHMM, startHHMM, lang = 'fr') {
  if (endHHMM === '00:00' && startHHMM !== '00:00') {
    return lang === 'ar' ? '00:00 (12 ليلاً)' : '00:00 (minuit)';
  }
  return endHHMM;
}

function formatScheduleSummary(lang = 'fr') {
  const s = getWorkSchedule();
  if (s.is24h) {
    return lang === 'ar' ? '24/24 ساعة بدون توقف' : 'Ouvert 24h/24 sans interruption';
  }
  const s1End = formatEndLabel(s.shift1End, s.shift1Start, lang);
  if (!s.twoShifts) {
    return `${s.shift1Start} – ${s1End}`;
  }
  const s2End = formatEndLabel(s.shift2End, s.shift2Start, lang);
  return lang === 'ar'
    ? `${s.shift1Start} – ${s1End} | الفترة 2: ${s.shift2Start} – ${s2End}`
    : `${s.shift1Start} – ${s1End} · 2e séance : ${s.shift2Start} – ${s2End}`;
}

function formatBreakSummary(lang = 'fr') {
  const s = getWorkSchedule();
  if (s.is24h || !s.breakEnabled || s.breakMinutes <= 0) return '';
  return lang === 'ar'
    ? `راحة الطبيب: ${s.breakStart} – ${s.breakEnd}`
    : `Pause du médecin : ${s.breakStart} – ${s.breakEnd}`;
}

function isMinuteInside(minOfDay, startHHMM, endHHMM) {
  for (const [lo, hi] of intervalSegments(startHHMM, endHHMM)) {
    if (minOfDay >= lo && minOfDay < hi) return true;
  }
  return false;
}

function isTimeInBreak(hhmm) {
  const s = getWorkSchedule();
  if (s.is24h || !s.breakEnabled || s.breakMinutes <= 0) return false;
  const m = parseTimeMinutes(hhmm, -1);
  if (m < 0) return false;
  return isMinuteInside(m, s.breakStart, s.breakEnd);
}

function isTimeWithinWorkSchedule(hhmm) {
  const s = getWorkSchedule();
  if (s.is24h) return true;
  const m = parseTimeMinutes(hhmm, -1);
  if (m < 0) return false;
  if (isTimeInBreak(hhmm)) return false;
  if (isMinuteInside(m, s.shift1Start, s.shift1End)) return true;
  if (s.twoShifts && isMinuteInside(m, s.shift2Start, s.shift2End)) return true;
  return false;
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
  is24hClinic,
  getWorkSchedule,
  formatScheduleSummary,
  formatBreakSummary,
  isTimeInBreak,
  isTimeWithinWorkSchedule,
  spanMinutes,
  addMinutesToHHMM,
};
