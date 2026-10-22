'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { useTempDb } = require('./helpers');
const auth = require('../src/main/services/auth');
const backup = require('../src/main/services/backup');
const patients = require('../src/main/services/patients');
const settings = require('../src/main/services/settings');
const db = require('../src/main/db');

function expectCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.equal(error.code, code, `expected ${code}, got ${error.code}`);
    return true;
  });
}

test('password setup, login and lock', (t) => {
  const ctx = useTempDb();
  t.after(() => ctx.cleanup());

  expectCode(() => auth.setup({ password: '12', confirm: '12' }), 'PASSWORD_TOO_SHORT');
  expectCode(() => auth.setup({ password: '1234', confirm: '9999' }), 'PASSWORD_MISMATCH');

  auth.setup({ password: '1234', confirm: '1234' });
  assert.equal(auth.status().unlocked, true);
  expectCode(() => auth.setup({ password: '1234', confirm: '1234' }), 'PASSWORD_ALREADY_SET');

  auth.lock();
  assert.equal(auth.status().unlocked, false);
  expectCode(() => auth.login('0000'), 'BAD_PASSWORD');
  auth.login('1234');
  assert.equal(auth.status().unlocked, true);
  assert.equal(auth.requireUnlocked(), true);
  auth.lock();
  expectCode(() => auth.requireUnlocked(), 'LOCKED');
});

test('changing the password requires the current one', (t) => {
  const ctx = useTempDb();
  t.after(() => ctx.cleanup());

  auth.setup({ password: '1234', confirm: '1234' });
  expectCode(
    () => auth.changePassword({ current: 'nope', next: '5678', confirm: '5678' }),
    'BAD_PASSWORD',
  );
  auth.changePassword({ current: '1234', next: '5678', confirm: '5678' });
  auth.lock();
  auth.login('5678');
  assert.equal(auth.status().unlocked, true);
});

test('a backup can be created, listed and restored', async (t) => {
  const ctx = useTempDb();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dentardv-backup-'));
  t.after(() => {
    backup.stopScheduler();
    ctx.cleanup();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  settings.setMany({ backup_enabled: '1', backup_keep: '5' });
  backup.init(dataDir);
  patients.create({ full_name: 'Before Backup', phone: '0555222001' });

  const snapshot = backup.create({ reason: 'manual' });
  assert.ok(fs.existsSync(snapshot.file));
  assert.equal(backup.list().length, 1);
  assert.equal(db.checkIntegrity(snapshot.file).ok, true);

  patients.create({ full_name: 'After Backup', phone: '0555222002' });
  assert.equal(patients.list('').length, 2);

  backup.restore(snapshot.file);
  assert.equal(patients.list('').length, 1);
  assert.equal(patients.list('')[0].full_name, 'Before Backup');
  // A safety copy of the replaced database must exist.
  const safety = fs.readdirSync(path.join(dataDir, 'backups')).filter((name) => name.startsWith('before-restore-'));
  assert.equal(safety.length, 1);
});

test('backup pruning keeps only the configured number of files', (t) => {
  const ctx = useTempDb();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dentardv-prune-'));
  t.after(() => {
    backup.stopScheduler();
    ctx.cleanup();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  settings.setMany({ backup_enabled: '1', backup_keep: '2' });
  backup.init(dataDir);
  const snapshot = backup.create();
  const dir = path.join(dataDir, 'backups');
  // Distinct file names: the stamp has a one-second resolution.
  for (let i = 0; i < 4; i += 1) {
    fs.copyFileSync(snapshot.file, path.join(dir, `dentardv-2020-01-0${i + 1}_000000.sqlite`));
  }
  assert.equal(backup.list().length, 5);
  backup.prune();
  assert.equal(backup.list().length, 2);
});
