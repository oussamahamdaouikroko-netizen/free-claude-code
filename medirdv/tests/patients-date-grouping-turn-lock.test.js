'use strict';
/**
 * MediRDV v2.4.1 — Patients Date Grouping + Strict Date & Queue-Turn Enforcement:
 *  1. Patients registered on different dates (today vs tomorrow vs day after tomorrow)
 *     are grouped chronologically into distinct day/date sections in `patients:by-day`.
 *  2. Future appointments (`day > today`) CANNOT be marked `done` or `no_show`
 *     (`APPOINTMENT_FUTURE_DAY`).
 *  3. Same-day appointments (`day === today`) MUST respect queue turn order per
 *     department/clinic (`#1` before `#2`..., unless `#1` is `no_show`/`cancelled`
 *     or urgent priority) (`QUEUE_OUT_OF_TURN`).
 *  4. Full JSDOM Arabic RTL UI verification of `Pages.patients` day cards & turn locks.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');
const { useTempDb, safeRemove } = require('./helpers');

const auth = require('../src/main/services/auth');
const settings = require('../src/main/services/settings');
const departments = require('../src/main/services/departments');
const patients = require('../src/main/services/patients');
const appointments = require('../src/main/services/appointments');
const { createHandlers } = require('../src/main/handlers');
const dates = require('../src/main/utils/dates');
const { startDemo } = require('../demo/server');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, { timeout = 5000, label = 'condition' } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = check();
    if (value) return value;
    await sleep(30);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

test('patients.byDayGroups separates today, tomorrow, day-after-tomorrow, and unscheduled patients chronologically', (t) => {
  useTempDb(t);
  settings.setMany({ working_days: '0,1,2,3,4,5,6', daily_capacity: '20' });

  const today = dates.toISODate();
  const tomorrow = dates.addDays(today, 1);
  const dayAfterTomorrow = dates.addDays(today, 2);
  const yesterday = dates.addDays(today, -1);

  const pToday1 = patients.create({ full_name: 'أمين مريض اليوم 1', phone: '0551100001' });
  const pToday2 = patients.create({ full_name: 'كمال مريض اليوم 2', phone: '0551100002' });
  const pFriendFuture = patients.create({ full_name: 'صديقي بعد الغد', phone: '0551100003' });
  const pTomorrow = patients.create({ full_name: 'سارة مريضة الغد', phone: '0551100004' });
  const pPast = patients.create({ full_name: 'مريض الأمس', phone: '0551100005' });
  const pUnscheduled = patients.create({ full_name: 'ملف بدون موعد', phone: '0551100006' });

  appointments.create({ patient_id: pToday1.id, day: today });
  appointments.create({ patient_id: pToday2.id, day: today });
  appointments.create({ patient_id: pFriendFuture.id, day: dayAfterTomorrow });
  appointments.create({ patient_id: pTomorrow.id, day: tomorrow });
  const pastAppt = appointments.create({ patient_id: pPast.id, day: yesterday, historical: true });
  appointments.setStatus(pastAppt.id, 'done');

  const res = patients.byDayGroups({ today });
  // Upcoming & today groups come chronologically ASC first, then past days newest-first.
  assert.deepEqual(
    res.groups.map((g) => g.day),
    [today, tomorrow, dayAfterTomorrow, yesterday],
  );

  const gToday = res.groups[0];
  assert.equal(gToday.day_relation, 'today');
  assert.equal(gToday.days_from_today, 0);
  assert.equal(gToday.total_count, 2);
  assert.equal(gToday.items[0].patient_id, pToday1.id);
  assert.equal(gToday.items[0].is_current_turn, true);
  assert.equal(gToday.items[0].can_complete, true);
  assert.equal(gToday.items[1].patient_id, pToday2.id);
  assert.equal(gToday.items[1].is_current_turn, false);
  assert.equal(gToday.items[1].can_complete, false);
  assert.equal(gToday.items[1].blocking_queue_number, 1);
  assert.equal(gToday.items[1].blocking_patient_name, 'أمين مريض اليوم 1');

  const gAfterTomorrow = res.groups[2];
  assert.equal(gAfterTomorrow.day, dayAfterTomorrow);
  assert.equal(gAfterTomorrow.day_relation, 'future');
  assert.equal(gAfterTomorrow.days_from_today, 2);
  assert.equal(gAfterTomorrow.items[0].patient_id, pFriendFuture.id);
  assert.equal(gAfterTomorrow.items[0].can_complete, false);
  assert.equal(gAfterTomorrow.items[0].can_mark_no_show, false);

  assert.equal(res.unscheduled.length, 1);
  assert.equal(res.unscheduled[0].id, pUnscheduled.id);

  // Search filter must NOT bypass turn computation for #2 when #1 is filtered out!
  const searched = patients.byDayGroups({ today, search: 'كمال' });
  assert.equal(searched.groups.length, 1);
  assert.equal(searched.groups[0].items.length, 1);
  assert.equal(searched.groups[0].items[0].patient_id, pToday2.id);
  assert.equal(searched.groups[0].items[0].is_current_turn, false);
  assert.equal(searched.groups[0].items[0].can_complete, false);
  assert.equal(searched.groups[0].items[0].blocking_queue_number, 1);
});

test('secretary cannot complete or mark absent a future-day patient ahead of today patient, and must respect queue turn order', (t) => {
  useTempDb(t);
  settings.setMany({ working_days: '0,1,2,3,4,5,6', daily_capacity: '20' });
  auth.setup({ password: '1234', confirm: '1234' });
  auth.login('1234');

  const handlers = createHandlers({ version: '2.4.1', dataDir: os.tmpdir(), wa: null, demo: false });
  const today = dates.toISODate();
  const dayAfterTomorrow = dates.addDays(today, 2);

  const meToday = patients.create({ full_name: 'المريض الأول اليوم', phone: '0552200001' });
  const secondToday = patients.create({ full_name: 'المريض الثاني اليوم', phone: '0552200002' });
  const friendFuture = patients.create({ full_name: 'صديقي المسجل بعد الغد', phone: '0552200003' });

  const apToday1 = handlers['appointments:create']({ patient_id: meToday.id, day: today });
  const apToday2 = handlers['appointments:create']({ patient_id: secondToday.id, day: today });
  const apFuture = handlers['appointments:create']({ patient_id: friendFuture.id, day: dayAfterTomorrow });

  // 1. Secretary tries to complete the day-after-tomorrow patient -> strictly rejected!
  assert.throws(
    () => handlers['appointments:complete']({ id: apFuture.id }),
    (err) => err.code === 'APPOINTMENT_FUTURE_DAY',
  );
  assert.throws(
    () => handlers['appointments:status']({ id: apFuture.id, status: 'done' }),
    (err) => err.code === 'APPOINTMENT_FUTURE_DAY',
  );
  assert.throws(
    () => handlers['appointments:status']({ id: apFuture.id, status: 'no_show' }),
    (err) => err.code === 'APPOINTMENT_FUTURE_DAY',
  );
  assert.equal(appointments.get(apFuture.id).status, 'booked');

  // 2. Secretary tries to complete #2 on today while #1 is still booked -> strictly rejected!
  assert.throws(
    () => handlers['appointments:complete']({ id: apToday2.id }),
    (err) => err.code === 'QUEUE_OUT_OF_TURN',
  );
  assert.throws(
    () => handlers['appointments:status']({ id: apToday2.id, status: 'done' }),
    (err) => err.code === 'QUEUE_OUT_OF_TURN',
  );

  // 3. Even if the future patient arrives today and is rescheduled to today (#3), they still cannot skip #1 & #2!
  const movedFuture = handlers['appointments:reschedule']({ id: apFuture.id, day: today });
  assert.equal(movedFuture.day, today);
  assert.equal(movedFuture.queue_number, 3);
  assert.throws(
    () => handlers['appointments:complete']({ id: movedFuture.id }),
    (err) => err.code === 'QUEUE_OUT_OF_TURN',
  );

  // 4. Completing #1 succeeds and advances #2 to active turn.
  const done1 = handlers['appointments:complete']({ id: apToday1.id });
  assert.equal(done1.appointment.status, 'done');
  assert.equal(done1.next_patient.id, apToday2.id);

  // 5. Suppose #2 is absent (`no_show`) -> now #3 (movedFuture) becomes active turn and CAN be completed!
  handlers['appointments:status']({ id: apToday2.id, status: 'no_show' });
  const done3 = handlers['appointments:complete']({ id: movedFuture.id });
  assert.equal(done3.appointment.status, 'done');
});

test('urgent priority on today and independent departments work properly with turn enforcement', (t) => {
  useTempDb(t);
  settings.setMany({ working_days: '0,1,2,3,4,5,6', daily_capacity: '20' });
  const today = dates.toISODate();

  const cardio = departments.create({
    name_fr: 'Cardiologie',
    name_ar: 'طب القلب',
    daily_capacity: 15,
    working_days: '0,1,2,3,4,5,6',
  });
  const ophtalmo = departments.create({
    name_fr: 'Ophtalmologie',
    name_ar: 'طب العيون',
    daily_capacity: 15,
    working_days: '0,1,2,3,4,5,6',
  });

  const pCardio1 = patients.create({ full_name: 'Cardio Normal 1', phone: '0553300001' });
  const pCardioUrgent = patients.create({ full_name: 'Cardio Urgent 2', phone: '0553300002' });
  const pOpht1 = patients.create({ full_name: 'Ophtalmo 1', phone: '0553300003' });

  const apCardio1 = appointments.create({
    patient_id: pCardio1.id,
    department_id: cardio.id,
    day: today,
    priority: 'normal',
  });
  const apCardioUrgent = appointments.create({
    patient_id: pCardioUrgent.id,
    department_id: cardio.id,
    day: today,
    priority: 'urgent',
  });
  const apOpht1 = appointments.create({
    patient_id: pOpht1.id,
    department_id: ophtalmo.id,
    day: today,
  });

  // Ophtalmologie #1 can finish independently of Cardiologie's queue.
  assert.equal(appointments.completeAndAdvance(apOpht1.id).appointment.status, 'done');

  // In Cardiologie, urgent patient is ahead of normal #1, so normal #1 cannot jump urgent, while urgent CAN complete!
  assert.throws(
    () => appointments.completeAndAdvance(apCardio1.id),
    (err) => err.code === 'QUEUE_OUT_OF_TURN',
  );
  assert.equal(appointments.completeAndAdvance(apCardioUrgent.id).appointment.status, 'done');
  assert.equal(appointments.completeAndAdvance(apCardio1.id).appointment.status, 'done');
});

test('Patients UI in Arabic RTL renders separate date cards, locks future appointments, and enforces turn order', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'medirdv-v241-ui-'));
  const demo = await startDemo({ port: 0, host: '127.0.0.1', dataDir });

  // Add a Day-After-Tomorrow patient so the UI has Today + Day-After-Tomorrow groups.
  const today = dates.toISODate();
  const dayAfterTomorrow = dates.addDays(today, 2);
  const pFuture = patients.create({ full_name: 'صديقي المسجل بعد الغد', phone: '0554400099' });
  appointments.create({ patient_id: pFuture.id, day: dayAfterTomorrow, historical: true });

  const virtualConsole = new VirtualConsole();
  const dom = await JSDOM.fromURL(demo.url, {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      window.fetch = (input, init) => fetch(new URL(String(input), demo.url), init);
      window.matchMedia = window.matchMedia || (() => ({
        matches: false,
        addListener() {},
        removeListener() {},
        addEventListener() {},
        removeEventListener() {},
      }));
    },
  });

  const { window } = dom;
  const $ = (sel) => window.document.querySelector(sel);
  const $$ = (sel) => [...window.document.querySelectorAll(sel)];

  t.after(async () => {
    dom.window.close();
    await sleep(120);
    await demo.stop();
    safeRemove(dataDir);
  });

  await waitFor(() => $('.sidebar'), { label: 'sidebar ready' });

  // Switch to Arabic RTL
  if (window.document.documentElement.dir !== 'rtl') {
    $('.sidebar-foot button').click();
    await waitFor(() => window.document.documentElement.dir === 'rtl', { label: 'Arabic RTL active' });
  }

  // Navigate to Patients page (`خانة المرضى`)
  $('[data-page="patients"]').click();
  await waitFor(() => $$('.content .card table.list').length >= 2, {
    label: 'separate day/date cards rendered in Patients page',
  });

  const cards = $$('.content .card');
  const futureCard = cards.find((c) => c.textContent.includes('بعد الغد'));
  const todayCard = cards.find((c) => c.textContent.includes('اليوم'));

  assert.ok(todayCard, 'Today card (`اليوم`) is rendered separately');
  assert.ok(futureCard, 'Day-after-tomorrow card (`بعد الغد`) is rendered in its own distinct date card');
  assert.ok(
    futureCard.textContent.includes('موعد مستقبلي مقفل'),
    'Future date card displays locked future-appointment badge',
  );

  // Verify the future patient row has ZERO `✓` complete button and ZERO `🚫` absent button!
  const futureButtons = [...futureCard.querySelectorAll('tbody button')].map((b) => b.textContent.trim());
  assert.ok(!futureButtons.includes('✓'), 'Future date card must NOT expose examine/complete button');
  assert.ok(!futureButtons.includes('🚫'), 'Future date card must NOT expose no_show button');
});
