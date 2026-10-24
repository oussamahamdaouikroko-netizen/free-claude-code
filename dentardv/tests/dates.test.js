'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const dates = require('../src/main/utils/dates');

test('ISO validation rejects impossible dates', () => {
  assert.equal(dates.isValidISODate('2026-10-22'), true);
  assert.equal(dates.isValidISODate('2026-02-30'), false);
  assert.equal(dates.isValidISODate('22/10/2026'), false);
  assert.equal(dates.isValidISODate(''), false);
  assert.equal(dates.isValidISODate(null), false);
});

test('addDays crosses month and year boundaries', () => {
  assert.equal(dates.addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(dates.addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(dates.addDays('2024-02-28', 1), '2024-02-29');
});

test('weekday uses 0 = Sunday', () => {
  assert.equal(dates.weekday('2026-10-22'), 4); // Thursday
  assert.equal(dates.weekday('2026-10-25'), 0); // Sunday
});

test('monthRange returns first and last day', () => {
  assert.deepEqual(dates.monthRange('2026-02'), { start: '2026-02-01', end: '2026-02-28' });
  assert.deepEqual(dates.monthRange('2024-02'), { start: '2024-02-01', end: '2024-02-29' });
});

test('formatting is localized', () => {
  assert.equal(dates.formatFR('2026-10-22'), '22/10/2026');
  assert.match(dates.formatLong('2026-10-22', 'fr'), /jeudi 22 octobre 2026/);
  assert.match(dates.formatLong('2026-10-22', 'ar'), /الخميس 22 أكتوبر 2026/);
});

test('diffDays is signed', () => {
  assert.equal(dates.diffDays('2026-10-22', '2026-10-25'), 3);
  assert.equal(dates.diffDays('2026-10-25', '2026-10-22'), -3);
});
