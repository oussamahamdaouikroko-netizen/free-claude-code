'use strict';
/**
 * Small shared helpers used by every service.
 *
 * Design rules for this project:
 *  - errors carry a machine-readable `code` so the interface can show a
 *    message in the language the pharmacist chose (French or Arabic);
 *  - nothing here ever logs or returns customer personal data.
 */

/** Error carrying a code the renderer can translate. */
class AppError extends Error {
  constructor(code, message, details) {
    super(message || code);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
  }
}

/** Trim, collapse whitespace and limit length. Never returns null/undefined. */
function cleanText(value, max = 200) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** Local timestamp "YYYY-MM-DD HH:MM:SS" (used for audit entries). */
function nowLocal(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/** Validate a positive integer identifier. */
function requireId(value, label = 'id') {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new AppError('INVALID_ID', `Invalid ${label}`);
  return id;
}

/** Validate that a value belongs to a fixed list. */
function requireEnum(value, allowed, label = 'value') {
  if (!allowed.includes(value)) {
    throw new AppError('INVALID_VALUE', `${label} must be one of: ${allowed.join(', ')}`);
  }
  return value;
}

/** Convert "true"/"1"/1/true into a strict boolean. */
function toBool(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const text = String(value ?? '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'oui', 'نعم'].includes(text);
}

/**
 * Neutralise anything that could be used to build a path traversal when a
 * value is used as part of a file name (exports, import source labels…).
 */
function safeFileSlug(value, fallback = 'file') {
  const slug = String(value ?? '')
    .normalize('NFKD')
    .replace(/[^\w.\-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 80);
  return slug || fallback;
}

module.exports = {
  AppError,
  cleanText,
  nowLocal,
  requireId,
  requireEnum,
  toBool,
  safeFileSlug,
};
