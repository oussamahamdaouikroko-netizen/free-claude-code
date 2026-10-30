'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');
const { useTempDb, safeRemove } = require('./helpers');
const { startDemo } = require('../demo/server');

const settings = require('../src/main/services/settings');
const patients = require('../src/main/services/patients');
const appointments = require('../src/main/services/appointments');
const dbMod = require('../src/main/db');
const dates = require('../src/main/utils/dates');

test('Backend enforces strict APPOINTMENT_FUTURE_DAY and QUEUE_OUT_OF_TURN rules while respecting urgent priority & rescheduling', (t) => {
  const ctx = useTempDb();
  settings.set('working_days', '0,1,2,3,4,5,6');
  settings.set('daily_capacity', '10');
  t.after(() => ctx.cleanup());

  const today = dates.toISODate();
  const dayAfterTomorrow = dates.addDays(today, 2);

  const pToday1 = patients.create({ full_name: 'مريض اليوم الأول', phone: '0554000001' });
  const pToday2 = patients.create({ full_name: 'مريض اليوم الثاني', phone: '0554000002' });
  const pFuture = patients.create({ full_name: 'صديقي بعد الغد', phone: '0554000003' });
  const pUnscheduled = patients.create({ full_name: 'مريض بدون موعد', phone: '0554000004' });

  const aToday1 = appointments.create({ patient_id: pToday1.id, day: today });
  const aToday2 = appointments.create({ patient_id: pToday2.id, day: today });
  const aFuture = appointments.create({ patient_id: pFuture.id, day: dayAfterTomorrow });

  // 1) Grouped view separates today, dayAfterTomorrow, and unscheduled patients
  const grouped = patients.byDayGroups({ includePast: true });
  assert.equal(grouped.groups.length, 2);
  assert.equal(grouped.groups[0].day, today);
  assert.equal(grouped.groups[0].isToday, true);
  assert.equal(grouped.groups[0].items.length, 2);
  assert.equal(grouped.groups[0].items[0].is_current_turn, true);
  assert.equal(grouped.groups[0].items[1].is_current_turn, false);
  assert.equal(grouped.groups[0].items[1].ahead_count, 1);

  assert.equal(grouped.groups[1].day, dayAfterTomorrow);
  assert.equal(grouped.groups[1].isFuture, true);
  assert.equal(grouped.groups[1].items[0].patient_id, pFuture.id);
  assert.equal(grouped.groups[1].items[0].is_current_turn, false);

  assert.equal(grouped.unscheduled.length, 1);
  assert.equal(grouped.unscheduled[0].id, pUnscheduled.id);

  // 2) Searching for #2 on today MUST NOT falsely promote #2 to is_current_turn = true!
  const filteredSearch = patients.byDayGroups({ search: 'الثاني', day: today });
  assert.equal(filteredSearch.groups.length, 1);
  assert.equal(filteredSearch.groups[0].items.length, 1);
  assert.equal(filteredSearch.groups[0].items[0].id, aToday2.id);
  assert.equal(filteredSearch.groups[0].items[0].is_current_turn, false);
  assert.equal(filteredSearch.groups[0].items[0].blocking_patient.queue_number, 1);

  // 3) Future-day patient CANNOT be marked done or no_show before their appointment date!
  assert.throws(
    () => appointments.setStatus(aFuture.id, 'done'),
    (err) => err && err.code === 'APPOINTMENT_FUTURE_DAY',
  );
  assert.throws(
    () => appointments.setStatus(aFuture.id, 'no_show'),
    (err) => err && err.code === 'APPOINTMENT_FUTURE_DAY',
  );
  assert.throws(
    () => appointments.completeAndAdvance(aFuture.id),
    (err) => err && err.code === 'APPOINTMENT_FUTURE_DAY',
  );

  // 4) Today's #2 CANNOT be marked done while #1 is still booked!
  assert.throws(
    () => appointments.setStatus(aToday2.id, 'done'),
    (err) => err && err.code === 'QUEUE_OUT_OF_TURN',
  );
  assert.throws(
    () => appointments.completeAndAdvance(aToday2.id),
    (err) => err && err.code === 'QUEUE_OUT_OF_TURN',
  );

  // 5) Emergency override: if an urgent dental patient arrives (#3), urgent priority goes first
  const pUrgent = patients.create({ full_name: 'حالة استعجالية', phone: '0554000005' });
  const aUrgent = appointments.create({ patient_id: pUrgent.id, day: today });
  dbMod.getDb().prepare("UPDATE appointments SET priority = 'urgent' WHERE id = ?").run(aUrgent.id);

  const urgentDone = appointments.completeAndAdvance(aUrgent.id);
  assert.equal(urgentDone.appointment.status, 'done');

  // 6) Now complete #1 -> unlocks #2!
  const done1 = appointments.completeAndAdvance(aToday1.id);
  assert.equal(done1.appointment.status, 'done');

  const done2 = appointments.completeAndAdvance(aToday2.id);
  assert.equal(done2.appointment.status, 'done');

  // 7) If the future patient arrives early today, rescheduling to today unlocks completion cleanly
  const movedToday = appointments.reschedule({ id: aFuture.id, day: today });
  assert.equal(movedToday.day, today);
  const doneMoved = appointments.completeAndAdvance(movedToday.id);
  assert.equal(doneMoved.appointment.status, 'done');

  // 8) patients.list separates next_visit vs last_visit accurately
  const pFuture2 = patients.create({ full_name: 'موعد قادم', phone: '0554000006' });
  const nextWeek = dates.addDays(today, 5);
  appointments.create({ patient_id: pFuture2.id, day: nextWeek });
  const listed = patients.list({ search: 'موعد قادم' });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].next_visit, nextWeek);
  assert.equal(listed[0].last_visit, null);
});

test('Patients UI groups scheduled patients into distinct date cards and locks future/out-of-turn buttons', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dentardv-patients-groups-'));
  const demo = await startDemo({ port: 0, host: '127.0.0.1', dataDir });

  // Add a future appointment (day after tomorrow) via demo API to verify future lock card in UI
  const today = dates.toISODate();
  const dayAfter = dates.addDays(today, 2);

  const sRes = await (
    await fetch(`${demo.url}/api/invoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'settings:set',
        payload: { working_days: '0,1,2,3,4,5,6' },
      }),
    })
  ).json();
  assert.equal(sRes.ok, true, `settings:set failed: ${JSON.stringify(sRes)}`);

  const pCreated = await (
    await fetch(`${demo.url}/api/invoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'patients:create',
        payload: { full_name: 'Ami Après-Demain', phone: '0559888777' },
      }),
    })
  ).json();
  assert.equal(pCreated.ok, true, `patients:create failed: ${JSON.stringify(pCreated)}`);

  const aCreated = await (
    await fetch(`${demo.url}/api/invoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'appointments:create',
        payload: { patient_id: pCreated.data.id, day: dayAfter },
      }),
    })
  ).json();
  assert.equal(aCreated.ok, true, `appointments:create failed: ${JSON.stringify(aCreated)}`);

  const virtualConsole = new VirtualConsole();
  const dom = await JSDOM.fromURL(demo.url, {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      window.fetch = (input, init) => fetch(new URL(String(input), demo.url), init);
      window.matchMedia =
        window.matchMedia ||
        (() => ({
          matches: false,
          addListener() {},
          removeListener() {},
          addEventListener() {},
          removeEventListener() {},
        }));
    },
  });

  const { window } = dom;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, timeout = 5000) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const v = fn();
      if (v) return v;
      await sleep(40);
    }
    throw new Error('Timeout waiting in Patients UI test');
  };

  t.after(async () => {
    dom.window.close();
    await sleep(150);
    await demo.stop();
    safeRemove(dataDir);
  });

  // Wait for initial dashboard render (.kpi) to settle so its async render never overwrites Patients
  await waitFor(() => window.document.querySelector('.kpi'), 10000);
  window.document.querySelector('[data-page="patients"]').click();
  await waitFor(
    () =>
      window.document.querySelector('[data-ready-mode="by_day"]') &&
      window.document.querySelectorAll('.content .card').length >= 2,
    10000,
  );

  const cards = [...window.document.querySelectorAll('.content .card')];
  const futureCard = cards.find((c) => c.textContent.includes('Ami Après-Demain'));
  const todayCard = cards.find(
    (c) => c.textContent.includes(`(${today})`) && c.textContent.includes('Yacine Belkacem'),
  );

  assert.ok(futureCard, 'future patient appears in its own distinct date card');
  assert.ok(todayCard, 'today patients appear in today date card, separate from future card');
  assert.notEqual(futureCard, todayCard, 'today and day-after-tomorrow are strictly separated');

  // Future card must show lock badge and NO finishTreatment button (note: icons.js converts emoji to <svg>)
  const lockedLabel = window.I18N.t('patients.futureLockedBadge');
  const finishLabel = window.I18N.t('queue.finishTreatment');
  const waitLabel = window.I18N.t('patients.waitTurnBadge', { q: 1 });

  assert.ok(futureCard.textContent.includes(lockedLabel), 'future card displays lock indicator');
  const futureCompleteBtn = [...futureCard.querySelectorAll('button')].find((b) =>
    b.textContent.includes(finishLabel),
  );
  assert.equal(futureCompleteBtn, undefined, 'no complete button rendered on future appointment');

  // In todayCard: #3 (Yacine Belkacem, first booked after #1 & #2 done) is active, #4 (Fatima Zohra Saidi) is disabled waiting turn
  const todayRows = [...todayCard.querySelectorAll('tbody tr')];
  const row3 = todayRows.find((r) => r.textContent.includes('Yacine Belkacem'));
  const row4 = todayRows.find((r) => r.textContent.includes('Fatima Zohra Saidi'));
  assert.ok(row3 && row4);

  const row3FinishBtn = [...row3.querySelectorAll('button')].find((b) =>
    b.textContent.includes(finishLabel),
  );
  assert.ok(row3FinishBtn && !row3FinishBtn.disabled, 'current turn patient has enabled complete button');

  const row4WaitBtn = [...row4.querySelectorAll('button')].find((b) =>
    b.textContent.includes(waitLabel),
  );
  assert.ok(row4WaitBtn && row4WaitBtn.disabled, 'subsequent booked patient has disabled wait-turn button');
});
