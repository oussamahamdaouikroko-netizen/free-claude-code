'use strict';
/**
 * Demo seeding must work any day of the week.
 *
 * The sample agenda is created for "today"; when today is a closed day (Friday
 * in Algeria) the booking service legitimately refuses a normal appointment,
 * and the demo used to crash with NOT_WORKING_DAY. This caught a real bug on a
 * Friday, so it is now deterministic: the test forces today to be closed.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { safeRemove } = require('./helpers');
const db = require('../src/main/db');
const settings = require('../src/main/services/settings');
const { toISODate, weekday } = require('../src/main/utils/dates');
const { startDemo } = require('../demo/server');

test('the demo seeds a full day even when today is closed', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dentardv-demo-closed-'));

  // Prepare the database with every weekday closed except the other six, so
  // "today" is guaranteed to be a non-working day.
  const today = weekday(toISODate());
  const closed = [0, 1, 2, 3, 4, 5, 6].filter((day) => day !== today);
  db.open(path.join(dataDir, 'dentardv.sqlite'));
  settings.setMany({ working_days: closed.join(','), daily_capacity: '8' });
  db.close();

  let demo;
  t.after(async () => {
    if (demo) await demo.stop();
    safeRemove(dataDir);
  });

  demo = await startDemo({ port: 0, host: '127.0.0.1', dataDir });
  assert.ok(demo.url.startsWith('http://127.0.0.1:'));

  // The sample agenda exists and every patient was created.
  const patients = db.getDb().prepare('SELECT COUNT(*) AS n FROM patients').get().n;
  assert.ok(patients >= 8, `expected the demo patients, got ${patients}`);

  const todayAppointments = db
    .getDb()
    .prepare('SELECT COUNT(*) AS n FROM appointments WHERE day = ?')
    .get(toISODate()).n;
  assert.ok(todayAppointments >= 1, 'the demo shows an agenda for today');
});
