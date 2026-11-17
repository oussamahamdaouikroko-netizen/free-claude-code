'use strict';
/**
 * Small shared helpers: validation errors, money rounding, phone keys.
 */

/** Error carrying a machine-readable code the renderer can translate. */
class AppError extends Error {
  constructor(code, message, details) {
    super(message || code);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
  }
}

/** Round money to 2 decimals without float artefacts. */
function money(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Keep the last 9 digits of a phone number, so "0555 12 34 56",
 * "+213 555 12 34 56" and "213555123456@s.whatsapp.net" all compare equal.
 */
function phoneKey(input) {
  let digits = String(input ?? '').replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('213')) digits = `0${digits.slice(3)}`;
  return digits ? digits.slice(-9) : '';
}

/** Trim + collapse whitespace + limit length. */
function cleanText(value, max = 200) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** Local timestamp "YYYY-MM-DD HH:MM:SS" (used for payments/expenses). */
function nowLocal(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

function requireId(value, label = 'id') {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new AppError('INVALID_ID', `Invalid ${label}`);
  return id;
}

module.exports = { AppError, money, phoneKey, cleanText, nowLocal, requireId };
