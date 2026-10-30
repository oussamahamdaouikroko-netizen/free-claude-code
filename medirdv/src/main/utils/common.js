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

/**
 * Shared case/accent/diacritic/hyphen-insensitive search normalizer:
 *  - Unicode compatibility + canonical decomposition (NFKC -> NFD)
 *  - Strips Latin combining accents & Arabic tashkeel / tatweel ("ـ")
 *  - Unifies Arabic letter variants (إأآٱ -> ا, ى -> ي, ة -> ه, ؤئ -> ء) and digits
 *  - Casefolds (toLowerCase + ligatures œ/æ/ß)
 *  - Treats hyphens/dashes as spaces ("doli-prane" === "doli prane")
 *  - Collapses repeated whitespace and trims.
 */
function normalizeSearch(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .replace(/œ/gi, 'oe')
    .replace(/æ/gi, 'ae')
    .replace(/ß/g, 'ss')
    .replace(/ø/gi, 'o')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[ؤئ]/g, 'ء')
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .toLowerCase()
    .replace(/[-‐‑‒–—―]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Escape SQLite LIKE wildcards (%, _, \) for `LIKE ? ESCAPE '\'`. */
function escapeLike(text) {
  return String(text ?? '').replace(/[\\%_]/g, '\\$&');
}

module.exports = {
  AppError,
  money,
  phoneKey,
  cleanText,
  nowLocal,
  requireId,
  normalizeSearch,
  normalize_search: normalizeSearch,
  escapeLike,
};
