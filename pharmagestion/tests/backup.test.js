'use strict';
/**
 * Backup / restore is the safety net of the whole application.
 * These tests cover the promises made to the pharmacist:
 *  - a snapshot is a complete, restorable database;
 *  - restoring never destroys the current data (safety copy first);
 *  - a corrupted or too-new file is refused *before* anything is touched;
 *  - uninstalling or updating cannot delete the data folder.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../src/main/db');
const settings = require('../src/main/services/settings');
const backup = require('../src/main/services/backup');
const audit = require('../src/main/services/audit');
const { useTempDataDir } = require('./helpers');

function withDataFolder(run) {
  const folder = useTempDataDir();
  db.closeAndReset();
  db.open(path.join(folder.dir, 'pharmagestion.sqlite'), { backupDir: folder.backupsDir });
  backup.init(folder.dir);
  try {
    return run(folder);
  } finally {
    backup.stopScheduler();
    try {
      db.close();
    } catch (error) {
      /* closed */
    }
    folder.cleanup();
  }
}

test('a manual backup produces a complete, readable database', () =>
  withDataFolder((folder) => {
    settings.set('pharmacy_name', 'Pharmacie Test');
    const result = backup.create({ kind: 'manual' });

    assert.ok(fs.existsSync(result.file));
    assert.match(result.name, /^pharmagestion-manual-\d{8}-\d{6}-\d{3}(-\d+)?\.sqlite$/);
    assert.equal(result.kind, 'manual');
    assert.ok(result.size > 0);

    const integrity = db.checkIntegrity(result.file);
    assert.equal(integrity.ok, true);
    assert.equal(integrity.schemaVersion, db.SCHEMA_VERSION);

    // The snapshot contains the real data.
    const Database = require('better-sqlite3');
    const probe = new Database(result.file, { readonly: true });
    try {
      const row = probe.prepare("SELECT value FROM settings WHERE key = 'pharmacy_name'").get();
      assert.equal(row.value, 'Pharmacie Test');
    } finally {
      probe.close();
    }

    assert.ok(fs.existsSync(folder.backupsDir));
  }));

test('backups never overwrite each other, even in the same millisecond', () =>
  withDataFolder(() => {
    // A tight loop is exactly the case that used to collide on fast machines:
    // the timestamp has millisecond precision, the loop takes microseconds.
    const created = [];
    for (let index = 0; index < 8; index += 1) created.push(backup.create({ kind: 'manual' }));
    const files = created.map((entry) => entry.file);
    assert.equal(new Set(files).size, files.length, 'every snapshot has its own file');
    for (const file of files) assert.equal(fs.existsSync(file), true, `${file} exists`);
    assert.equal(backup.list().filter((entry) => entry.kind === 'manual').length, 8);
  }));

test('pruning keeps the configured number of snapshots', () =>
  withDataFolder(() => {
    settings.set('backup_keep', 2);
    const created = [];
    for (let index = 0; index < 4; index += 1) created.push(backup.create({ kind: 'manual' }));
    const remaining = backup.list().filter((entry) => entry.kind === 'manual');
    assert.equal(remaining.length, 2, 'older snapshots were removed');
    assert.equal(fs.existsSync(created[created.length - 1].file), true, 'newest kept');
    assert.equal(fs.existsSync(created[0].file), false, 'oldest removed');
  }));

test('the daily backup runs once per day', () =>
  withDataFolder(() => {
    settings.set('backup_enabled', true);
    settings.set('last_backup_at', '2020-01-01 08:00:00');
    assert.equal(backup.isDue(), true);
    const created = backup.maybeAutoBackup();
    assert.ok(created, 'a snapshot was created');
    assert.equal(backup.isDue(), false, 'not due again the same day');
    assert.equal(backup.maybeAutoBackup(), null);

    settings.set('backup_enabled', false);
    settings.set('last_backup_at', '2020-01-01 08:00:00');
    assert.equal(backup.isDue(), false, 'disabled by the pharmacist');
  }));

test('restore brings the data back and keeps a safety copy', () =>
  withDataFolder(() => {
    settings.set('pharmacy_name', 'Avant la restauration');
    const snapshot = backup.create({ kind: 'manual' });

    settings.set('pharmacy_name', 'Après la restauration');
    const result = backup.restore(snapshot.file);

    assert.equal(result.ok, true);
    assert.equal(settings.get('pharmacy_name'), 'Avant la restauration');
    assert.ok(fs.existsSync(result.safetyFile), 'the pre-restore database was saved');
    assert.match(path.basename(result.safetyFile), /^before-restore-/);

    const entries = audit.list({ limit: 5 });
    assert.equal(entries[0].action, 'backup.restore');
    assert.equal(entries[0].severity, 'critical');

    // The application is usable after the swap (new writes work).
    settings.set('pharmacist_name', 'Dr Test');
    assert.equal(settings.get('pharmacist_name'), 'Dr Test');
  }));

test('a missing file is refused', () =>
  withDataFolder(() => {
    assert.throws(() => backup.restore('/no/such/backup.sqlite'), { code: 'BACKUP_NOT_FOUND' });
    assert.throws(() => backup.restore(''), { code: 'BACKUP_NOT_FOUND' });
  }));

test('a corrupted file is refused before any change', () =>
  withDataFolder((folder) => {
    const broken = path.join(folder.dir, 'broken.sqlite');
    fs.writeFileSync(broken, 'this is definitely not a sqlite database');
    settings.set('pharmacy_name', 'Intact');
    assert.throws(() => backup.restore(broken), { code: 'BACKUP_CORRUPT' });
    assert.equal(settings.get('pharmacy_name'), 'Intact', 'current data untouched');
    assert.ok(db.isOpen(), 'the database is still open');
  }));

test('a backup from a newer application version is refused', () =>
  withDataFolder((folder) => {
    const newer = path.join(folder.dir, 'newer.sqlite');
    const Database = require('better-sqlite3');
    const probe = new Database(newer);
    probe.pragma(`user_version = ${db.SCHEMA_VERSION + 10}`);
    probe.exec('CREATE TABLE future (id INTEGER PRIMARY KEY)');
    probe.close();

    assert.throws(() => backup.restore(newer), { code: 'BACKUP_TOO_NEW' });
    assert.ok(db.isOpen());
  }));

test('exporting a copy writes a restorable file', () =>
  withDataFolder((folder) => {
    const destination = path.join(folder.dir, 'exports', 'copy.sqlite');
    const result = backup.exportCopy(destination);
    assert.ok(fs.existsSync(result.file));
    assert.equal(db.checkIntegrity(destination).ok, true);
    assert.throws(() => backup.exportCopy(''), { code: 'BACKUP_DESTINATION_REQUIRED' });
  }));

test('snapshot kinds are recognised from their file names', () => {
  assert.equal(backup.kindOf('pharmagestion-auto-20260101-120000-000.sqlite'), 'auto');
  assert.equal(backup.kindOf('pharmagestion-manual-20260101-120000-000.sqlite'), 'manual');
  assert.equal(backup.kindOf('pre-update-v1-20260101-120000-000.sqlite'), 'pre-update');
  assert.equal(backup.kindOf('before-restore-20260101-120000-000.sqlite'), 'before-restore');
  assert.equal(backup.kindOf('something-else.sqlite'), 'external');
});

test('the database lives in the data folder, not next to the executable', () =>
  withDataFolder((folder) => {
    const databaseFile = db.getPath();
    assert.ok(databaseFile.startsWith(folder.dir), 'database inside the data folder');
    assert.ok(backup.backupsDir().startsWith(folder.dir), 'backups inside the data folder');
    assert.equal(path.basename(databaseFile), 'pharmagestion.sqlite');
  }));
