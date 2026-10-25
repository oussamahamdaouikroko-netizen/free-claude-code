'use strict';
/**
 * Settings: validation, defaults, atomic writes and the audit trail.
 * A typo in the interface must never store an unusable value such as
 * `backup_keep = "abc"`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const settings = require('../src/main/services/settings');
const audit = require('../src/main/services/audit');
const { useTempDb } = require('./helpers');

function withDb(run) {
  const handle = useTempDb();
  try {
    return run(handle);
  } finally {
    handle.cleanup();
  }
}

test('first run seeds the defaults documented in the README', () =>
  withDb(() => {
    assert.equal(settings.getLanguage(), 'fr');
    assert.deepEqual(settings.expiryThresholds(), [90, 60, 30]);
    assert.equal(settings.getInt('backup_keep'), 30);
    assert.equal(settings.getBool('backup_enabled'), true);
    assert.equal(settings.getBool('allow_negative_stock'), false, 'negative stock is opt-in');
    assert.equal(settings.getRaw('currency'), 'DZD');
  }));

test('seeding never overwrites an existing value', () =>
  withDb(() => {
    settings.set('pharmacy_name', 'Pharmacie El Nour');
    const { seedDefaults } = require('../src/main/db/seed');
    seedDefaults(require('../src/main/db').getDb());
    assert.equal(settings.get('pharmacy_name'), 'Pharmacie El Nour');
  }));

test('values are validated by type and range', () =>
  withDb(() => {
    assert.throws(() => settings.set('backup_keep', 'abc'), { code: 'INVALID_SETTING_VALUE' });
    assert.throws(() => settings.set('backup_keep', 0), { code: 'INVALID_SETTING_VALUE' });
    assert.throws(() => settings.set('backup_keep', 99999), { code: 'INVALID_SETTING_VALUE' });
    assert.throws(() => settings.set('language', 'en'), { code: 'INVALID_SETTING_VALUE' });
    assert.throws(() => settings.set('not_a_setting', 1), { code: 'INVALID_SETTING_KEY' });
    assert.throws(() => settings.set('audit_keep_days', 5), { code: 'INVALID_SETTING_VALUE' });
  }));

test('booleans round-trip as real booleans', () =>
  withDb(() => {
    settings.set('allow_negative_stock', true);
    assert.equal(settings.getBool('allow_negative_stock'), true);
    assert.equal(settings.getRaw('allow_negative_stock'), '1');
    settings.set('allow_negative_stock', false);
    assert.equal(settings.getBool('allow_negative_stock'), false);
  }));

test('text settings are trimmed and length-limited', () =>
  withDb(() => {
    settings.set('pharmacy_name', '   Pharmacie    Es-Salem  ');
    assert.equal(settings.get('pharmacy_name'), 'Pharmacie Es-Salem');
    settings.set('pharmacy_name', 'x'.repeat(400));
    assert.equal(settings.get('pharmacy_name').length, 120);
  }));

test('expiry thresholds must be strictly decreasing', () =>
  withDb(() => {
    assert.throws(
      () => settings.setMany({ expiry_threshold_1: 30, expiry_threshold_2: 60, expiry_threshold_3: 90 }),
      { code: 'INVALID_THRESHOLDS' },
    );
    assert.throws(
      () => settings.setMany({ expiry_threshold_2: 90, expiry_threshold_3: 90 }),
      { code: 'INVALID_THRESHOLDS' },
    );
    // A valid change is accepted and sorted highest first.
    settings.setMany({ expiry_threshold_1: 120, expiry_threshold_2: 60, expiry_threshold_3: 15 });
    assert.deepEqual(settings.expiryThresholds(), [120, 60, 15]);
  }));

test('setMany is atomic: one invalid field saves nothing', () =>
  withDb(() => {
    settings.set('pharmacy_name', 'Before');
    assert.throws(
      () =>
        settings.setMany({
          pharmacy_name: 'After',
          backup_keep: 'not-a-number',
        }),
      { code: 'INVALID_SETTING_VALUE' },
    );
    assert.equal(settings.get('pharmacy_name'), 'Before', 'no partial write');
  }));

test('language switching is restricted to the two supported languages', () =>
  withDb(() => {
    assert.equal(settings.setLanguage('ar'), 'ar');
    assert.equal(settings.getLanguage(), 'ar');
    assert.throws(() => settings.setLanguage('fr-CA'), { code: 'INVALID_SETTING_VALUE' });
    assert.equal(settings.getLanguage(), 'ar');
  }));

test('the typed snapshot exposes only declared keys', () =>
  withDb(() => {
    const all = settings.all();
    assert.ok(Object.keys(all).includes('pharmacy_name'));
    assert.equal(typeof all.backup_enabled, 'boolean');
    assert.equal(typeof all.expiry_threshold_3, 'number');
    for (const key of Object.keys(all)) {
      assert.ok(settings.SPECS[key], `${key} must be declared in SPECS`);
    }
  }));

test('the audit log is append-only and carries no personal data fields', () =>
  withDb(() => {
    audit.log('backup.create', { entity: 'backup', details: 'pharmagestion-manual-x.sqlite' });
    audit.log('backup.restore', { entity: 'backup', severity: 'critical' });
    const entries = audit.list({ limit: 10 });
    assert.equal(entries.length, 2);
    assert.equal(entries[0].action, 'backup.restore');
    assert.equal(entries[0].severity, 'critical');
    assert.deepEqual(Object.keys(entries[0]).sort(), [
      'action',
      'at',
      'details',
      'entity',
      'entityId',
      'id',
      'severity',
    ]);
    assert.throws(() => audit.log(''), { code: 'INVALID_AUDIT_ACTION' });
    // Unknown severities fall back to 'info' rather than failing a write.
    audit.log('x', { severity: 'whatever' });
    assert.equal(audit.list({ limit: 1 })[0].severity, 'info');
  }));

test('audit pruning keeps recent entries', () =>
  withDb(() => {
    const db = require('../src/main/db').getDb();
    audit.log('old.event');
    db.prepare("UPDATE audit_log SET at = datetime('now', '-3 years')").run();
    audit.log('new.event');
    const removed = audit.prune(30);
    assert.equal(removed, 1);
    assert.equal(audit.list().length, 1);
    assert.equal(audit.list()[0].action, 'new.event');
  }));
