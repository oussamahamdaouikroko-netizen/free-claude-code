'use strict';
/**
 * Money must never touch binary floating point: amounts are integer centimes.
 * These tests pin down the parsing rules used by manual entry, imports and
 * reports (including the French/Algerian decimal comma).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseCents,
  sumCents,
  multiplyCents,
  percentOfCents,
  centsToDecimalString,
} = require('../src/main/utils/money');

test('integers and decimals become integer centimes', () => {
  assert.equal(parseCents(1500), 150000);
  assert.equal(parseCents('1500'), 150000);
  assert.equal(parseCents('1500.50'), 150050);
  assert.equal(parseCents('1500,50'), 150050);
  assert.equal(parseCents('1500.5'), 150050);
  assert.equal(parseCents(0), 0);
  assert.equal(parseCents('0.01'), 1);
});

test('spaces, non-breaking spaces and currency labels are ignored', () => {
  assert.equal(parseCents('1 500,50'), 150050);
  assert.equal(parseCents('1\u00a0500.50'), 150050);
  assert.equal(parseCents('1500 DA'), 150000);
  assert.equal(parseCents('1500 دج'), 150000);
});

test('a three-digit group after a separator is a thousands separator', () => {
  assert.equal(parseCents('1.500'), 150000);
  assert.equal(parseCents('1,500'), 150000);
  assert.equal(parseCents('1.234.567'), 123456700);
  assert.equal(parseCents('1.234.567,89'), 123456789);
  // "12.345" is read as 12 345 DZD (grouping), never as 12,345 DZD.
  assert.equal(parseCents('12.345'), 1234500);
});

test('unreadable input is refused, never silently rounded', () => {
  for (const value of ['abc', '', null, undefined, {}, '1.2.3,456', '12,34,56', '1..2']) {
    assert.throws(() => parseCents(value), { code: 'INVALID_AMOUNT' }, `should reject ${String(value)}`);
  }
  assert.throws(() => parseCents(-5), { code: 'INVALID_AMOUNT' });
  assert.equal(parseCents(-5, { allowNegative: true }), -500);
});

test('negatives in text are refused unless explicitly allowed', () => {
  assert.throws(() => parseCents('-12,50'), { code: 'INVALID_AMOUNT' });
  assert.equal(parseCents('-12,50', { allowNegative: true }), -1250);
});

test('0.1 + 0.2 is exactly 0.3 in centimes', () => {
  const total = sumCents([parseCents('0.10'), parseCents('0.20')]);
  assert.equal(total, 30);
  assert.equal(centsToDecimalString(total), '0.30');
  // The same sum with floats is famously wrong:
  assert.notEqual(0.1 + 0.2, 0.3);
});

test('multiplying a unit price by a quantity stays exact', () => {
  assert.equal(multiplyCents(parseCents('19.99'), 3), 5997);
  assert.equal(multiplyCents(1250, 0), 0);
  assert.throws(() => multiplyCents(1250, 1.5), { code: 'INVALID_QUANTITY' });
});

test('percentages round to the nearest centime', () => {
  assert.equal(percentOfCents(1000, 19), 190);
  assert.equal(percentOfCents(999, 33), 330);
  assert.equal(percentOfCents(100000, 0), 0);
});

test('decimal strings are stable for CSV exports', () => {
  assert.equal(centsToDecimalString(0), '0.00');
  assert.equal(centsToDecimalString(5), '0.05');
  assert.equal(centsToDecimalString(123456), '1234.56');
  assert.equal(centsToDecimalString(-1250), '-12.50');
});

test('sumCents refuses values that are not integers', () => {
  assert.throws(() => sumCents([1.5]), { code: 'INVALID_AMOUNT' });
});
