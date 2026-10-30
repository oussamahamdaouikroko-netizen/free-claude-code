'use strict';
/**
 * Date helpers.
 *
 * Everything is stored as a plain `YYYY-MM-DD` string in **local** time so a
 * clinic in Algiers sees the same day on the screen and in the database.
 * Nothing here depends on the host timezone offset, and weekdays are computed
 * with UTC math to avoid daylight-saving surprises.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** @returns {string} local date as YYYY-MM-DD */
function toISODate(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function isValidISODate(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d
  );
}

/** @returns {string} date shifted by `days` (can be negative) */
function addDays(isoDate, days) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return date.toISOString().slice(0, 10);
}

/** Day of week: 0 = Sunday … 6 = Saturday (same convention as SQLite/JS). */
function weekday(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Difference in whole days: `to - from`. */
function diffDays(fromIso, toIso) {
  const a = Date.parse(`${fromIso}T00:00:00Z`);
  const b = Date.parse(`${toIso}T00:00:00Z`);
  return Math.round((b - a) / 86400000);
}

const MONTHS_FR = [
  'janvier', 'février', 'mars', 'avril', 'mai', 'juin',
  'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre',
];
const MONTHS_AR = [
  'جانفي', 'فيفري', 'مارس', 'أفريل', 'ماي', 'جوان',
  'جويلية', 'أوت', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر',
];
const MONTHS_EN = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const DAYS_FR = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const DAYS_AR = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
const DAYS_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** 22/10/2026 */
function formatFR(isoDate) {
  if (!isValidISODate(isoDate)) return '';
  const [y, m, d] = isoDate.split('-');
  return `${d}/${m}/${y}`;
}

/** jeudi 22 octobre 2026 / Thursday, 22 October 2026 */
function formatLong(isoDate, lang = 'fr') {
  if (!isValidISODate(isoDate)) return '';
  const [, m, d] = isoDate.split('-').map(Number);
  const wd = weekday(isoDate);
  if (lang === 'en') {
    return `${DAYS_EN[wd]}, ${d} ${MONTHS_EN[m - 1]} ${isoDate.slice(0, 4)}`;
  }
  const dayName = lang === 'ar' ? DAYS_AR[wd] : DAYS_FR[wd];
  const monthName = lang === 'ar' ? MONTHS_AR[m - 1] : MONTHS_FR[m - 1];
  return `${dayName} ${d} ${monthName} ${isoDate.slice(0, 4)}`;
}

/** Nom du jour seul. */
function weekdayName(isoDate, lang = 'fr') {
  const wd = weekday(isoDate);
  if (lang === 'en') return DAYS_EN[wd];
  return lang === 'ar' ? DAYS_AR[wd] : DAYS_FR[wd];
}

/** YYYY-MM */
function monthKey(isoDate) {
  return isoDate.slice(0, 7);
}

/** First / last day of a YYYY-MM month. */
function monthRange(month) {
  const [y, m] = month.split('-').map(Number);
  const first = `${month}-01`;
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start: first, end: `${month}-${String(lastDay).padStart(2, '0')}` };
}

module.exports = {
  toISODate,
  isValidISODate,
  addDays,
  weekday,
  diffDays,
  formatFR,
  formatLong,
  weekdayName,
  monthKey,
  monthRange,
  MONTHS_FR,
  MONTHS_AR,
  MONTHS_EN,
  DAYS_FR,
  DAYS_AR,
  DAYS_EN,
};
