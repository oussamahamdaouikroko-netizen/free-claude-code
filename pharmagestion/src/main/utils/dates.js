'use strict';
/**
 * Date helpers.
 *
 * Everything stored in the database uses the ISO calendar date `YYYY-MM-DD`
 * (no time zone, no time of day): a medicine batch expires on a *day*, and
 * comparing two `YYYY-MM-DD` strings is exact and cheap.
 *
 * `new Date('2026-02-30')` silently rolls over to March in JavaScript, which
 * would corrupt an expiry date, so dates are validated piece by piece here.
 */

const { AppError } = require('./common');

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Format a JS Date as a local ISO calendar date. */
function toISODate(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function todayISO() {
  return toISODate(new Date());
}

/** True when the string is a real calendar date (`2026-02-30` is rejected). */
function isValidISODate(value) {
  const match = ISO_DATE.exec(String(value ?? ''));
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1900 || year > 2200) return false;
  if (month < 1 || month > 12) return false;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day >= 1 && day <= daysInMonth;
}

/** Throw a translatable error when a date is not a valid ISO calendar date. */
function requireISODate(value, label = 'date') {
  if (!isValidISODate(value)) throw new AppError('INVALID_DATE', `${label}: ${value}`);
  return value;
}

/**
 * Format using UTC getters. Calendar dates are time-zone free, so a machine
 * set to UTC-5 must not shift `2026-03-31` to `2026-03-30`.
 */
function formatUTCDate(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/** Add (or subtract) days to an ISO date and return an ISO date. */
function addDays(isoDate, days) {
  requireISODate(isoDate);
  const [year, month, day] = isoDate.split('-').map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day));
  utc.setUTCDate(utc.getUTCDate() + Number(days || 0));
  return formatUTCDate(utc);
}

/** Whole days from `from` to `to` (negative when `to` is in the past). */
function daysBetween(from, to) {
  requireISODate(from);
  requireISODate(to);
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  return Math.round((end - start) / 86400000);
}

/** Days remaining before an expiry date (0 = expires today, <0 = expired). */
function daysUntil(isoDate, reference = todayISO()) {
  return daysBetween(reference, isoDate);
}

/**
 * Parse the date formats found in Algerian pharmacy exports and typed input:
 * `2026-03-31`, `31/03/2026`, `31-03-2026`, `31.03.2026`, `3/2026` (month/year,
 * stored as the last day of that month). Returns null when it cannot be read.
 */
function parseFlexibleDate(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;

  let year;
  let month;
  let day;

  let match = ISO_DATE.exec(text);
  if (match) {
    [, year, month, day] = match;
    const iso = `${year}-${month}-${day}`;
    return isValidISODate(iso) ? iso : null;
  }

  // 31/03/2026, 31-3-2026, 31.03.26
  match = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2}|\d{4})$/.exec(text);
  if (match) {
    day = Number(match[1]);
    month = Number(match[2]);
    year = Number(match[3]);
    if (year < 100) year += year >= 70 ? 1900 : 2000;
    return buildIso(year, month, day);
  }

  // 2026/03/31
  match = /^(\d{4})[/.\-](\d{1,2})[/.\-](\d{1,2})$/.exec(text);
  if (match) return buildIso(Number(match[1]), Number(match[2]), Number(match[3]));

  // 03/2026 — a month/year only (common on medicine boxes): last day of month.
  match = /^(\d{1,2})[/.\-](\d{4})$/.exec(text);
  if (match) {
    year = Number(match[2]);
    month = Number(match[1]);
    if (month < 1 || month > 12) return null;
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return buildIso(year, month, lastDay);
  }

  // 2026-03 (year-month from an ISO-ish export)
  match = /^(\d{4})[/.\-](\d{1,2})$/.exec(text);
  if (match) {
    year = Number(match[1]);
    month = Number(match[2]);
    if (month < 1 || month > 12) return null;
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return buildIso(year, month, lastDay);
  }

  return null;
}

function buildIso(year, month, day) {
  const pad = (n) => String(n).padStart(2, '0');
  const iso = `${pad(year)}-${pad(month)}-${pad(day)}`;
  return isValidISODate(iso) ? iso : null;
}

module.exports = {
  toISODate,
  todayISO,
  isValidISODate,
  requireISODate,
  addDays,
  daysBetween,
  daysUntil,
  parseFlexibleDate,
};
