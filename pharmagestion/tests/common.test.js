'use strict';
/** Shared helpers in src/main/utils/common.js. */

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  AppError,
  cleanText,
  nowLocal,
  requireId,
  requireEnum,
  toBool,
  safeFileSlug,
} = require('../src/main/utils/common');

test('cleanText trims, collapses whitespace and truncates', () => {
  assert.equal(cleanText('  Pharmacie   El   Nour \n'), 'Pharmacie El Nour');
  assert.equal(cleanText(null), '');
  assert.equal(cleanText(undefined), '');
  assert.equal(cleanText(42), '42');
  assert.equal(cleanText('abcdef', 3), 'abc');
});

test('nowLocal formats a sortable local timestamp', () => {
  const value = nowLocal(new Date(2026, 2, 31, 9, 5, 7));
  assert.equal(value, '2026-03-31 09:05:07');
  assert.match(nowLocal(), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
});

test('requireId accepts positive integers only', () => {
  assert.equal(requireId(7), 7);
  assert.equal(requireId('7'), 7);
  for (const value of [0, -1, 1.5, 'abc', null, undefined, NaN]) {
    assert.throws(() => requireId(value), { code: 'INVALID_ID' });
  }
});

test('requireEnum restricts to a fixed list', () => {
  assert.equal(requireEnum('fr', ['fr', 'ar']), 'fr');
  assert.throws(() => requireEnum('en', ['fr', 'ar']), { code: 'INVALID_VALUE' });
});

test('toBool understands the answers used in forms and imports', () => {
  for (const value of [true, 1, '1', 'true', 'OUI', 'yes', 'نعم']) assert.equal(toBool(value), true);
  for (const value of [false, 0, '0', '', 'non', 'no', null, undefined]) assert.equal(toBool(value), false);
});

test('safeFileSlug cannot escape a folder', () => {
  assert.equal(safeFileSlug('../../etc/passwd'), 'etc-passwd');
  assert.equal(safeFileSlug('Stock 2026/10'), 'Stock-2026-10');
  assert.equal(safeFileSlug(''), 'file');
  assert.equal(safeFileSlug('...'), 'file');
  assert.equal(safeFileSlug(null), 'file');
  assert.doesNotMatch(safeFileSlug('a'.repeat(200)), /\/|\\/);
  assert.ok(safeFileSlug('a'.repeat(200)).length <= 80);
});

test('AppError carries a translatable code', () => {
  const error = new AppError('INVALID_AMOUNT', 'bad amount', { field: 'price' });
  assert.equal(error.code, 'INVALID_AMOUNT');
  assert.equal(error.message, 'bad amount');
  assert.deepEqual(error.details, { field: 'price' });
  assert.ok(error instanceof Error);
});
