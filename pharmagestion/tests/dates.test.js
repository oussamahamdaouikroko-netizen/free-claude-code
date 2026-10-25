'use strict';
/**
 * Dates are the backbone of expiry alerts, so they are validated strictly.
 * `new Date('2026-02-30')` would silently become March 2nd; that must never
 * happen to a batch expiry date.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  toISODate,
  todayISO,
  isValidISODate,
  requireISODate,
  addDays,
  daysBetween,
  daysUntil,
  parseFlexibleDate,
} = require('../src/main/utils/dates');

test('today is a valid ISO date built from local time', () => {
  assert.match(todayISO(), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(toISODate(new Date(2026, 0, 5, 23, 30)), '2026-01-05');
});

test('invalid calendar dates are rejected', () => {
  for (const value of ['2026-02-30', '2026-13-01', '2026-00-10', '2026-1-1', '', null, '31/03/2026', 20260101]) {
    assert.equal(isValidISODate(value), false, `should reject ${String(value)}`);
  }
  assert.equal(isValidISODate('2024-02-29'), true, '2024 is a leap year');
  assert.equal(isValidISODate('2026-02-29'), false, '2026 is not');
  assert.throws(() => requireISODate('2026-02-30'), { code: 'INVALID_DATE' });
});

test('day arithmetic is exact and time-zone independent', () => {
  assert.equal(addDays('2026-03-01', 1), '2026-03-02');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(addDays('2024-02-28', 1), '2024-02-29');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-01-01', 365), '2027-01-01');
});

test('days between dates are whole and signed', () => {
  assert.equal(daysBetween('2026-03-01', '2026-03-31'), 30);
  assert.equal(daysBetween('2026-03-31', '2026-03-01'), -30);
  assert.equal(daysBetween('2026-03-01', '2026-03-01'), 0);
  // Crossing a daylight-saving change must not produce 89.96 days.
  assert.equal(daysBetween('2026-03-20', '2026-04-20'), 31);
});

test('days until expiry drives the 90/60/30 thresholds', () => {
  assert.equal(daysUntil('2026-06-29', '2026-03-31'), 90);
  assert.equal(daysUntil('2026-05-30', '2026-03-31'), 60);
  assert.equal(daysUntil('2026-04-30', '2026-03-31'), 30);
  assert.equal(daysUntil('2026-03-31', '2026-03-31'), 0);
  assert.equal(daysUntil('2026-03-30', '2026-03-31'), -1);
});

test('exports and typed input parse in every local format', () => {
  assert.equal(parseFlexibleDate('2026-03-31'), '2026-03-31');
  assert.equal(parseFlexibleDate('31/03/2026'), '2026-03-31');
  assert.equal(parseFlexibleDate('31-03-2026'), '2026-03-31');
  assert.equal(parseFlexibleDate('31.03.2026'), '2026-03-31');
  assert.equal(parseFlexibleDate('31/3/26'), '2026-03-31');
  assert.equal(parseFlexibleDate('2026/03/31'), '2026-03-31');
  assert.equal(parseFlexibleDate('3/2026'), '2026-03-31', 'month/year → last day of month');
  assert.equal(parseFlexibleDate('02/2024'), '2024-02-29', 'leap February');
  assert.equal(parseFlexibleDate('2026-03'), '2026-03-31');
  assert.equal(parseFlexibleDate('  '), null);
});

test('impossible or ambiguous dates parse to null', () => {
  assert.equal(parseFlexibleDate('30/02/2026'), null);
  assert.equal(parseFlexibleDate('32/01/2026'), null);
  assert.equal(parseFlexibleDate('13/2026'), null);
  assert.equal(parseFlexibleDate('not a date'), null);
  assert.equal(parseFlexibleDate('2026-02-31'), null);
  assert.equal(parseFlexibleDate(null), null);
});
