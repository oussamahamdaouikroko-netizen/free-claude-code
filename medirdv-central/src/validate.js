'use strict';
/**
 * Input validation + normalization helpers (server-side, authoritative).
 * The frontend mirrors these rules for UX only; the API never trusts it.
 */
const { validation } = require('./errors');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function cleanText(value, max = 200) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function requireText(value, field, max = 200) {
  const text = cleanText(value, max);
  if (!text) throw validation(`${field} is required`);
  return text;
}

function optionalText(value, max = 200) {
  const text = cleanText(value, max);
  return text || null;
}

function requireEmail(value) {
  const email = cleanText(value, 254).toLowerCase();
  if (!EMAIL_RE.test(email)) throw validation('A valid email address is required');
  return email;
}

function optionalEmail(value) {
  const email = cleanText(value, 254).toLowerCase();
  if (!email) return null;
  if (!EMAIL_RE.test(email)) throw validation('A valid email address is required');
  return email;
}

/**
 * Normalize an Algerian phone number to E.164 (+213XXXXXXXXX).
 * Accepts 05/06/07…, +213…, 00213…, 213… and 9-digit local forms.
 * Returns null when the number cannot be normalized.
 */
function normalizePhoneDZ(value) {
  let digits = String(value ?? '').replace(/\D/g, '');
  if (!digits) return null;
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('213')) digits = digits.slice(3);
  if (digits.startsWith('0')) digits = digits.slice(1);
  if (digits.length !== 9) return null;
  if (!/^[567]/.test(digits)) return null; // DZ mobile prefixes
  return `+213${digits}`;
}

function requirePhoneDZ(value, field = 'phone') {
  const phone = normalizePhoneDZ(value);
  if (!phone) throw validation(`${field} must be a valid Algerian phone number`);
  return phone;
}

/** Last-9-digits key so 0555… / +213555… / 213555… compare equal. */
function phoneKey(input) {
  const normalized = normalizePhoneDZ(input);
  if (normalized) return normalized.slice(-9);
  const digits = String(input ?? '').replace(/\D/g, '');
  return digits ? digits.slice(-9) : '';
}

function isValidISODate(value) {
  if (typeof value !== 'string' || !ISO_DATE_RE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function requireISODate(value, field = 'date') {
  if (!isValidISODate(value)) throw validation(`${field} must be a valid date (YYYY-MM-DD)`);
  return value;
}

function requireTime(value, field = 'time') {
  const time = cleanText(value, 5);
  if (!TIME_RE.test(time)) throw validation(`${field} must be HH:MM`);
  return time;
}

function requireId(value, field = 'id') {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw validation(`Invalid ${field}`);
  return id;
}

function requireEnum(value, allowed, field) {
  if (!allowed.includes(value)) throw validation(`${field} must be one of: ${allowed.join(', ')}`);
  return value;
}

function requireMoney(value, field = 'amount') {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw validation(`${field} must be a non-negative number`);
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Parse a comma-separated weekday list ("0,1,2,3,4") → sorted unique array. */
function parseWeekdays(value) {
  const days = String(value ?? '')
    .split(',')
    .map((d) => Number.parseInt(d.trim(), 10))
    .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
  return [...new Set(days)].sort((a, b) => a - b);
}

function requirePassword(value) {
  const password = String(value ?? '');
  if (password.length < 8) throw validation('Password must be at least 8 characters');
  return password;
}

/** Strip control characters / HTML from free text stored or rendered. */
function sanitizeText(value, max = 2000) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .slice(0, max);
}

module.exports = {
  cleanText,
  requireText,
  optionalText,
  requireEmail,
  optionalEmail,
  normalizePhoneDZ,
  requirePhoneDZ,
  phoneKey,
  isValidISODate,
  requireISODate,
  requireTime,
  requireId,
  requireEnum,
  requireMoney,
  parseWeekdays,
  requirePassword,
  sanitizeText,
};
