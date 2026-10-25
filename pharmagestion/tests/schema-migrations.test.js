'use strict';
/**
 * Schema and migration safety.
 *
 * A pharmacy database holds years of stock and debt history: a migration must
 * either apply completely or not at all, must never run twice, and must refuse
 * a database created by a newer version of the application.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { migrate, currentVersion, SCHEMA_VERSION, MIGRATIONS, MIGRATION_1 } = require('../src/main/db/schema');
const { useTempDb, safeRemove } = require('./helpers');

test('a new database is migrated to the latest version', () => {
  const handle = useTempDb();
  try {
    const database = require('../src/main/db').getDb();
    assert.equal(currentVersion(database), SCHEMA_VERSION);
    const tables = database
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((row) => row.name);
    assert.ok(tables.includes('settings'));
    assert.ok(tables.includes('audit_log'));
  } finally {
    handle.cleanup();
  }
});

test('migrations are idempotent and never run twice', () => {
  const handle = useTempDb();
  try {
    const db = require('../src/main/db');
    const first = migrate(db.getDb());
    assert.deepEqual(first.applied, [], 'already up to date');
    assert.equal(first.from, SCHEMA_VERSION);
    assert.equal(first.to, SCHEMA_VERSION);
  } finally {
    handle.cleanup();
  }
});

test('a new migration is applied in one transaction and recorded', () => {
  const handle = useTempDb();
  try {
    const database = require('../src/main/db').getDb();
    const migrations = [
      ...MIGRATIONS,
      {
        version: SCHEMA_VERSION + 1,
        name: 'add_test_table',
        up: 'CREATE TABLE test_only (id INTEGER PRIMARY KEY, label TEXT);',
      },
    ];
    const result = migrate(database, { migrations });
    assert.deepEqual(result.applied, ['add_test_table']);
    assert.equal(result.to, SCHEMA_VERSION + 1);
    assert.ok(
      database.prepare("SELECT name FROM sqlite_master WHERE name='test_only'").get(),
      'table was created',
    );
    // Running again is a no-op.
    assert.deepEqual(migrate(database, { migrations }).applied, []);
  } finally {
    handle.cleanup();
  }
});

test('a failing migration is rolled back completely', () => {
  const handle = useTempDb();
  try {
    const database = require('../src/main/db').getDb();
    const before = currentVersion(database);
    const broken = [
      ...MIGRATIONS,
      {
        version: SCHEMA_VERSION + 1,
        name: 'broken',
        up: 'CREATE TABLE half_written (id INTEGER); INSERT INTO missing_table VALUES (1);',
      },
    ];
    assert.throws(() => migrate(database, { migrations: broken }), { code: 'MIGRATION_FAILED' });
    assert.equal(currentVersion(database), before, 'version did not move');
    assert.equal(
      database.prepare("SELECT name FROM sqlite_master WHERE name='half_written'").get(),
      undefined,
      'the partial table was rolled back',
    );
  } finally {
    handle.cleanup();
  }
});

test('a database from a newer version is refused, not modified', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pharmagestion-newer-'));
  const file = path.join(dir, 'newer.sqlite');
  const database = new Database(file);
  try {
    database.pragma(`user_version = ${SCHEMA_VERSION + 5}`);
    assert.throws(() => migrate(database), { code: 'SCHEMA_TOO_NEW' });
    assert.equal(currentVersion(database), SCHEMA_VERSION + 5);
  } finally {
    database.close();
    safeRemove(dir);
  }
});

test('the first migration declares foreign keys, checks and indexes', () => {
  assert.match(MIGRATION_1, /CREATE TABLE IF NOT EXISTS settings/);
  assert.match(MIGRATION_1, /CREATE TABLE IF NOT EXISTS audit_log/);
  assert.match(MIGRATION_1, /CHECK \(severity IN/);
  assert.match(MIGRATION_1, /CREATE INDEX IF NOT EXISTS idx_audit_at/);
  // Financial tables arrive later, but the schema must already be versioned.
  assert.ok(Array.isArray(MIGRATIONS));
  assert.equal(MIGRATIONS[0].version, 1);
});

test('foreign keys are enforced on the live connection', () => {
  const handle = useTempDb();
  try {
    const database = require('../src/main/db').getDb();
    assert.equal(database.pragma('foreign_keys', { simple: true }), 1);
    assert.equal(String(database.pragma('journal_mode', { simple: true })).toLowerCase(), 'wal');
    assert.equal(database.pragma('synchronous', { simple: true }), 2, 'FULL');
  } finally {
    handle.cleanup();
  }
});
