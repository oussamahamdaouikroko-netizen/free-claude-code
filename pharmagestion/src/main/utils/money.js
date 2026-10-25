'use strict';
/**
 * Money helpers — **never** use binary floating point for money.
 *
 * Amounts are stored in the database as integer *centimes* (1 DZD = 100
 * centimes, "santim" in Algerian Arabic). 0.1 + 0.2 !== 0.3 in JavaScript;
 * 10 + 20 === 30 with integers, always, which is what a ledger needs.
 *
 * Every value that enters the database goes through `parseCents()`.
 */

const { AppError } = require('./common');

const MAX_CENTS = 100_000_000_00; // 1 billion DZD — far above any pharmacy total

/**
 * Parse a user/import value into integer centimes.
 *
 * Accepted: `1500`, `1500.50`, `"1 500,50"`, `"1.500,50"` (French grouping),
 * `"1500.5"`, `"1500"`, `"1,5"`. A single separator followed by 1–2 digits is
 * treated as a decimal separator; three digits after a separator is treated as
 * a thousands separator. Unreadable or over-precise values throw instead of
 * being silently rounded — a wrong price must be visible.
 *
 * @param {number|string} value
 * @param {{ allowNegative?: boolean }} [options]
 * @returns {number} integer centimes
 */
function parseCents(value, options = {}) {
  const { allowNegative = false } = options;
  if (value === null || value === undefined || value === '') {
    throw new AppError('INVALID_AMOUNT', 'Amount is required');
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new AppError('INVALID_AMOUNT', 'Amount is not a number');
    // Numbers coming from JSON/Excel are decimals: convert with a rounding
    // step that is exact enough for money (no accumulated drift).
    return checkRange(Math.round(value * 100), allowNegative);
  }

  let text = String(value).trim();
  if (!text) throw new AppError('INVALID_AMOUNT', 'Amount is required');

  let negative = false;
  if (/^[-−]/.test(text)) {
    negative = true;
    text = text.slice(1);
  }
  text = text.replace(/\s|\u00a0|\u202f|'|DZD|DA|دج/gi, '');

  if (!/^[0-9.,]+$/.test(text)) throw new AppError('INVALID_AMOUNT', `Unreadable amount: ${value}`);

  const { integer, fraction } = splitAmount(text, value);
  const cents = Number(integer) * 100 + Number(fraction || '0');
  if (!Number.isSafeInteger(cents)) throw new AppError('INVALID_AMOUNT', `Amount too large: ${value}`);
  return checkRange(negative ? -cents : cents, allowNegative);
}

/**
 * Separate the integer part from the (optional) fraction of a written amount.
 *
 * Rules, chosen to match Algerian/French habits and to fail loudly on typos:
 *  - one separator with 1–2 digits after it is a decimal separator: `12,50`;
 *  - one separator with exactly 3 digits after it is a thousands separator:
 *    `1.500` → 1500, `12.345` → 12345 (documented and tested);
 *  - several separators, or both `,` and `.`, are only valid as thousands
 *    grouping (every group after the first has exactly 3 digits) plus an
 *    optional 1–2 digit fraction at the end: `1.234.567,89`;
 *  - anything else (`12,34,56`, `1..2`, `1.2.3,456`) is rejected.
 */
function splitAmount(text, original) {
  const separatorCount = (text.match(/[.,]/g) || []).length;
  if (separatorCount === 0) {
    if (!/^\d+$/.test(text)) throw new AppError('INVALID_AMOUNT', `Unreadable amount: ${original}`);
    return { integer: text, fraction: '' };
  }

  const parts = text.split(/[.,]/);
  const last = parts[parts.length - 1];
  const hasBoth = text.includes(',') && text.includes('.');

  // Is the tail a decimal fraction?
  const tailIsFraction = last.length >= 1 && last.length <= 2;
  const singleThreeDigitTail = !hasBoth && separatorCount === 1 && last.length === 3;

  if (tailIsFraction) {
    const integerParts = parts.slice(0, -1);
    // One decimal digit means tenths: "0,5" is 50 centimes, not 5.
    const fraction = last.length === 1 ? `${last}0` : last;
    return { integer: joinGrouped(integerParts, original), fraction };
  }

  if (singleThreeDigitTail) {
    return { integer: parts.join(''), fraction: '' };
  }

  // No fraction: the whole text must be a properly grouped thousands number.
  return { integer: joinGrouped(parts, original), fraction: '' };
}

/** Join grouped digits, rejecting malformed grouping such as `12,34,56`. */
function joinGrouped(parts, original) {
  if (parts.length === 0) throw new AppError('INVALID_AMOUNT', `Unreadable amount: ${original}`);
  if (parts.length === 1) {
    // A single plain group: any number of digits is fine ("1500.50").
    if (!/^\d+$/.test(parts[0])) throw new AppError('INVALID_AMOUNT', `Unreadable amount: ${original}`);
    return parts[0];
  }
  const [head, ...rest] = parts;
  if (!/^\d{1,3}$/.test(head)) {
    throw new AppError('INVALID_AMOUNT', `Ambiguous amount: ${original}`);
  }
  for (const group of rest) {
    if (!/^\d{3}$/.test(group)) throw new AppError('INVALID_AMOUNT', `Ambiguous amount: ${original}`);
  }
  return parts.join('');
}

function checkRange(cents, allowNegative) {
  if (!Number.isSafeInteger(cents)) throw new AppError('INVALID_AMOUNT', 'Amount is not an integer');
  if (!allowNegative && cents < 0) throw new AppError('INVALID_AMOUNT', 'Amount cannot be negative');
  if (Math.abs(cents) > MAX_CENTS) throw new AppError('INVALID_AMOUNT', 'Amount is too large');
  return cents;
}

/** Sum integer centimes, refusing anything that is not an integer. */
function sumCents(values) {
  let total = 0;
  for (const value of values) {
    if (!Number.isSafeInteger(value)) throw new AppError('INVALID_AMOUNT', 'Not integer centimes');
    total += value;
  }
  return total;
}

/**
 * Multiply a unit price (centimes) by a quantity without float drift.
 * Quantities are integers in this app (boxes/units), percentages are integers.
 */
function multiplyCents(cents, quantity) {
  if (!Number.isSafeInteger(cents)) throw new AppError('INVALID_AMOUNT', 'Not integer centimes');
  const qty = Number(quantity);
  if (!Number.isInteger(qty)) throw new AppError('INVALID_QUANTITY', 'Quantity must be a whole number');
  return Math.round(cents * qty);
}

/** Apply an integer percentage (e.g. 19 for 19 %) to a centime amount. */
function percentOfCents(cents, percent) {
  if (!Number.isSafeInteger(cents)) throw new AppError('INVALID_AMOUNT', 'Not integer centimes');
  const rate = Number(percent);
  if (!Number.isFinite(rate)) throw new AppError('INVALID_PERCENT', 'Invalid percentage');
  return Math.round((cents * rate) / 100);
}

/**
 * Display integer centimes as a plain decimal string: 123456 → "1234.56".
 * The renderer localises it; this is for CSV exports and logs.
 */
function centsToDecimalString(cents) {
  checkRange(cents, true);
  const negative = cents < 0;
  const absolute = Math.abs(cents);
  const units = Math.floor(absolute / 100);
  const rest = String(absolute % 100).padStart(2, '0');
  return `${negative ? '-' : ''}${units}.${rest}`;
}

module.exports = {
  MAX_CENTS,
  parseCents,
  sumCents,
  multiplyCents,
  percentOfCents,
  centsToDecimalString,
};
