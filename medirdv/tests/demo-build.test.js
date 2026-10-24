'use strict';
/**
 * Portable demo build (the sales tool).
 *
 * `DentaRDV-Demo.exe` is handed to a dentist during a visit. It must:
 *  - be a single portable .exe (no installer),
 *  - seed sample data and open without a password,
 *  - never touch the real clinic database and never link WhatsApp,
 *  - show a permanent banner so nobody mistakes sample patients for records.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { safeRemove } = require('./helpers');
const yaml = require('js-yaml');
const db = require('../src/main/db');
const settings = require('../src/main/services/settings');
const auth = require('../src/main/services/auth');
const { seedDemoData, isSeeded } = require('../src/main/db/demo-seed');

const ROOT = path.join(__dirname, '..');

test('the demo build config is portable and carries the demo marker', () => {
  const config = yaml.load(fs.readFileSync(path.join(ROOT, 'electron-builder.demo.yml'), 'utf8'));

  assert.equal(config.productName, 'MediRDV-Demo');
  assert.equal(config.appId, 'dz.medirdv.desktop.demo', 'separate appId: no clash with the real app');
  assert.deepEqual(config.win.target, [{ target: 'portable', arch: ['x64'] }], 'one .exe, no installer');
  assert.match(config.win.artifactName, /MediRDV-Demo/);
  assert.equal(config.nsis, undefined, 'the demo is never installed');

  // The marker file switches src/main/index.js into demo mode.
  const marker = config.extraFiles.find((entry) => entry.to === 'demo.mode');
  assert.ok(marker, 'demo.mode is packed next to the executable');
  assert.ok(fs.existsSync(path.join(ROOT, marker.from)), `marker source exists: ${marker.from}`);
  assert.match(fs.readFileSync(path.join(ROOT, marker.from), 'utf8'), /demo/);

  // Same native-module handling as the real build.
  assert.equal(config.npmRebuild, true);
  assert.equal(config.afterPack, 'scripts/after-pack.js');
  const unpacked = JSON.stringify(config.asarUnpack);
  assert.match(unpacked, /better-sqlite3/);
});

test('the real installer never enables demo mode', () => {
  const config = yaml.load(fs.readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf8'));
  assert.equal(config.productName, 'MediRDV');
  assert.equal(config.extraFiles, undefined, 'no demo.mode in the real build');
  assert.ok(!JSON.stringify(config).includes('demo.mode'));
});

test('sample data is created once and is idempotent', (t) => {
  const ctx = (() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dentardv-demoseed-'));
    db.open(path.join(dir, 'dentardv.sqlite'));
    return {
      cleanup() {
        db.close();
        safeRemove(dir);
      },
    };
  })();
  t.after(() => ctx.cleanup());

  settings.setMany({ working_days: '0,1,2,3,4,5,6', daily_capacity: '8' });
  assert.equal(isSeeded(), false);
  assert.equal(seedDemoData(), true, 'the first call seeds');
  assert.equal(isSeeded(), true);

  const counts = () =>
    ['patients', 'appointments', 'payments', 'expenses'].map(
      (table) => db.getDb().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n,
    );
  const first = counts();
  assert.ok(first[0] >= 8, 'eight sample patients');
  assert.ok(first[1] >= 8, 'agenda for today and yesterday');
  assert.ok(first[2] >= 3, 'partial payments exist');
  assert.ok(first[3] >= 3, 'expenses exist for the report');

  assert.equal(seedDemoData(), false, 'a second call does nothing');
  assert.deepEqual(counts(), first, 'no duplicated data');

  // The demo opens unlocked with a known password (shown on the sales laptop).
  if (!auth.hasPassword()) auth.setup({ password: '1234', confirm: '1234' });
  assert.equal(auth.login('1234').unlocked, true);
});
