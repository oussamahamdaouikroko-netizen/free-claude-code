'use strict';
/**
 * Tests for MediRDV v2.5.0:
 *  1. Doctor Off-Days / Holidays / Sick Leave (`عطلة / مرض`) — solo & multi-department
 *  2. WhatsApp Holiday Notices, Privacy (`مرض` stays private), and Vacation Pause
 *  3. Work Schedule Control, Net Hours Duration, Two-Shift System (`08:00–17:00` + `21:00–00:00`),
 *     Doctor Break (`12:30–13:30`), and `24/24` Non-Stop Clinic Mode
 *  4. Renderer UI (JSDOM RTL end-to-end)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');

const { useTempDb, safeRemove } = require('./helpers');
const dates = require('../src/main/utils/dates');
const settings = require('../src/main/services/settings');
const departments = require('../src/main/services/departments');
const holidays = require('../src/main/services/holidays');
const operations = require('../src/main/services/operations');
const patients = require('../src/main/services/patients');
const appointments = require('../src/main/services/appointments');
const bot = require('../src/main/whatsapp/bot');

test('Doctor holidays & sick-leave days block bookings, skip in nextFreeDay/listAvailableDays, support per-department leave, and reopen cleanly', (t) => {
  const ctx = useTempDb();
  t.after(() => ctx.cleanup());

  const today = dates.toISODate();
  const tomorrow = dates.addDays(today, 1);
  const day2 = dates.addDays(today, 2);
  const day3 = dates.addDays(today, 3);

  settings.setMany({
    working_days: '0,1,2,3,4,5,6',
    allow_same_day_booking: '0',
    daily_capacity: '20',
  });

  // Pre-existing booked appointment on tomorrow -> tracked in booked_conflicts without data loss
  const preBooked = patients.create({ full_name: 'Karim Prebooked', phone: '0551000010' });
  appointments.create({ patient_id: preBooked.id, day: tomorrow });

  // Invalid date range rejected
  assert.throws(
    () => holidays.create({ start_day: day2, end_day: tomorrow, reason_type: 'vacation' }),
    (err) => err && err.code === 'HOLIDAY_END_BEFORE_START',
  );

  // Global sick leave across tomorrow + day2
  const leave = holidays.create({
    start_day: tomorrow,
    end_day: day2,
    reason_type: 'sick',
    label: 'Repos médical 48h',
    block_all_wa: false,
  });
  assert.equal(leave.booked_conflicts, 1);
  assert.equal(appointments.dayInfo(tomorrow).working, false);
  assert.equal(appointments.dayInfo(tomorrow).holiday.id, leave.id);

  const pNew = patients.create({ full_name: 'Nadia Test', phone: '0551000020' });
  assert.throws(
    () => appointments.create({ patient_id: pNew.id, day: tomorrow }),
    (err) => err && err.code === 'DOCTOR_ON_LEAVE',
  );
  assert.equal(appointments.findNextFreeDay(), day3);
  assert.equal(appointments.listAvailableDays({ limit: 5 }).days[0].day, day3);
  assert.equal(appointments.checkDayAvailability(tomorrow).reason, 'holiday');

  // Reopen global leave, then test department-specific leave in a polyclinic
  holidays.remove(leave.id);
  assert.equal(appointments.findNextFreeDay(), tomorrow);

  const cardio = departments.create({
    name_fr: 'Cardiologie',
    name_ar: 'طب القلب',
    working_days: '0,1,2,3,4,5,6',
    daily_capacity: 15,
  });
  const ophtalmo = departments.create({
    name_fr: 'Ophtalmologie',
    name_ar: 'طب العيون',
    working_days: '0,1,2,3,4,5,6',
    daily_capacity: 15,
  });

  const cardioLeave = holidays.create({
    start_day: tomorrow,
    end_day: tomorrow,
    department_id: cardio.id,
    reason_type: 'vacation',
  });
  assert.equal(appointments.dayInfo(tomorrow, cardio.id).working, false);
  assert.equal(appointments.dayInfo(tomorrow, ophtalmo.id).working, true, 'other department stays open');
  assert.equal(appointments.findNextFreeDay({ departmentId: cardio.id }), day2);
  assert.equal(appointments.findNextFreeDay({ departmentId: ophtalmo.id }), tomorrow);
  holidays.remove(cardioLeave.id);
});

test('WhatsApp bot informs patients that doctor is on holiday (keeping sick reason private) and supports full vacation pause', (t) => {
  const ctx = useTempDb();
  t.after(() => ctx.cleanup());

  const today = dates.toISODate();
  const tomorrow = dates.addDays(today, 1);
  const day2 = dates.addDays(today, 2);
  const day3 = dates.addDays(today, 3);

  settings.setMany({
    working_days: '0,1,2,3,4,5,6',
    allow_same_day_booking: '0',
    bot_choose_day_enabled: '1',
    daily_capacity: '20',
  });

  // 1) Doctor marks tomorrow as SICK leave (`reason_type: 'sick'`) without full WhatsApp pause
  holidays.create({
    start_day: tomorrow,
    end_day: tomorrow,
    reason_type: 'sick',
    label: 'Grippe interne',
    block_all_wa: false,
  });

  const baseNow = Date.now() + 60_000;
  const step1 = bot.handle({
    phone: '0552111001',
    text: 'أمين بوزيد',
    nowMs: baseNow,
  });
  assert.equal(step1.action, 'choose_day');
  assert.match(step1.reply, /الطبيب في عطلة/);
  assert.doesNotMatch(step1.reply, /مرض|Grippe/i, 'internal sick reason never leaks to WhatsApp');
  assert.equal(step1.availableDays[0].day, day2);

  // Patient tries typing tomorrow's DD/MM manually -> gets polite holiday unavailability message
  const [, mm, dd] = tomorrow.split('-');
  const stepHolidayTry = bot.handle({
    phone: '0552111001',
    text: `${dd}/${mm}`,
    nowMs: baseNow + 5_000,
  });
  assert.equal(stepHolidayTry.action, 'day_unavailable');
  assert.match(stepHolidayTry.reply, /الطبيب في عطلة/);

  // Patient picks #1 (day2) -> booked cleanly
  const stepBooked = bot.handle({
    phone: '0552111001',
    text: '1',
    nowMs: baseNow + 10_000,
  });
  assert.equal(stepBooked.action, 'booked');
  assert.equal(stepBooked.appointment.day, day2);

  // 2) Full WhatsApp booking pause (`block_all_wa: true`) starting today through day2
  const fullPause = holidays.create({
    start_day: today,
    end_day: day2,
    reason_type: 'vacation',
    label: 'Congé annuel',
    block_all_wa: true,
  });

  const pausedAr = bot.handle({
    phone: '0552111002',
    text: 'السلام عليكم',
    nowMs: baseNow + 20_000,
  });
  assert.equal(pausedAr.action, 'doctor_on_leave');
  assert.match(pausedAr.reply, /الطبيب في عطلة/);
  assert.equal(pausedAr.resumeDay, day3);

  const pausedFr = bot.handle({
    phone: '0552111003',
    text: 'Bonjour Docteur',
    nowMs: baseNow + 25_000,
  });
  assert.equal(pausedFr.action, 'doctor_on_leave');
  assert.match(pausedFr.reply, /en congé/i);
  assert.equal(pausedFr.resumeDay, day3);

  // Darija mode
  settings.set('bot_darija_mode', '1');
  const pausedDarija = bot.handle({
    phone: '0552111004',
    text: 'سلام طبيب نقدر نحجز',
    nowMs: baseNow + 30_000,
  });
  assert.equal(pausedDarija.action, 'doctor_on_leave');
  assert.match(pausedDarija.reply, /عطلة/);
  settings.set('bot_darija_mode', '0');

  // Existing booked patient (`0552111001`) can still query `موعدي`!
  const mineRes = bot.handle({
    phone: '0552111001',
    text: 'موعدي',
    nowMs: baseNow + 35_000,
  });
  assert.equal(mineRes.action, 'appointment_info');

  holidays.remove(fullPause.id);
});

test('Two-shift schedule (08:00–17:00 + 21:00–00:00 midnight), doctor break (12:30–13:30), net hours calculation, and 24/24 mode work end-to-end', (t) => {
  const ctx = useTempDb();
  t.after(() => ctx.cleanup());

  const today = dates.toISODate();

  // Exact scenario requested by user:
  // Shift 1: 08:00 -> 17:00 (9h)
  // Break:   12:30 -> 13:30 (-1h)
  // Shift 2: 21:00 -> 00:00 midnight (+3h)
  // Net:     11 hours (660 minutes)!
  settings.setMany({
    clinic_24h_enabled: '0',
    work_start_hour: '08:00',
    work_end_hour: '17:00',
    two_shifts_enabled: '1',
    shift2_start_hour: '21:00',
    shift2_end_hour: '00:00',
    break_enabled: '1',
    break_start_hour: '12:30',
    break_end_hour: '13:30',
    avg_session_minutes: '30',
    working_days: '0,1,2,3,4,5,6',
    allow_same_day_booking: '1',
    bot_choose_day_enabled: '1',
  });

  const sched = settings.getWorkSchedule();
  assert.equal(sched.shift1Minutes, 540, '08:00 to 17:00 = 9h (540m)');
  assert.equal(sched.shift2Minutes, 180, '21:00 to 00:00 midnight = 3h (180m)');
  assert.equal(sched.grossMinutes, 720, 'gross = 12h (720m)');
  assert.equal(sched.deductedBreakMinutes, 60, '1h break deducted');
  assert.equal(sched.netMinutes, 660, 'net = 11h (660m)');
  assert.equal(sched.netHours, 11);

  assert.equal(settings.isTimeWithinWorkSchedule('09:00'), true);
  assert.equal(settings.isTimeInBreak('12:45'), true);
  assert.equal(settings.isTimeWithinWorkSchedule('12:45'), false, 'break window excluded');
  assert.equal(settings.isTimeWithinWorkSchedule('19:00'), false, 'gap between shifts excluded');
  assert.equal(settings.isTimeWithinWorkSchedule('22:30'), true, '2nd shift 21:00–00:00 included');

  // Time slots generator covers both shifts and skips break!
  const slots = operations.generateTimeSlots(null);
  assert.ok(slots.includes('08:00') && slots.includes('16:30'), 'Shift 1 slots generated');
  assert.ok(!slots.includes('12:30') && !slots.includes('13:00'), 'Break slots 12:30 & 13:00 skipped');
  assert.ok(slots.includes('21:00') && slots.includes('23:30'), 'Shift 2 night slots generated');

  // Manual slot_time inside doctor break rejected with DOCTOR_BREAK_TIME, while 21:30 succeeds
  const pat = patients.create({ full_name: 'Samir NightShift', phone: '0553111009' });
  assert.throws(
    () => appointments.create({ patient_id: pat.id, day: today, slot_time: '12:45' }),
    (err) => err && err.code === 'DOCTOR_BREAK_TIME',
  );
  const nightAppt = appointments.create({ patient_id: pat.id, day: today, slot_time: '21:30' });
  assert.equal(nightAppt.slot_time, '21:30');

  // WhatsApp help message in Arabic shows both shifts (08:00–17:00 + 21:00–00:00) AND doctor break (12:30–13:30)
  const baseNow = Date.now() + 60_000;
  const helpAr = bot.handle({
    phone: '0553222001',
    text: 'مساعدة',
    nowMs: baseNow,
  });
  assert.equal(helpAr.action, 'help');
  assert.match(helpAr.reply, /08:00 – 17:00/);
  assert.match(helpAr.reply, /21:00 – 00:00/);
  assert.match(helpAr.reply, /12:30 – 13:30/);

  // Enable 24/24 non-stop clinic mode with high capacity (350)
  settings.setMany({
    clinic_24h_enabled: '1',
    daily_capacity: '350',
  });
  assert.equal(settings.is24hClinic(), true);
  assert.equal(settings.getWorkSchedule().netHours, 24);
  assert.equal(settings.getInt('daily_capacity'), 350);

  const help24 = bot.handle({
    phone: '0553222002',
    text: 'مساعدة',
    nowMs: baseNow + 10_000,
  });
  assert.match(help24.reply, /24\/24/);
});

test('Renderer UI (JSDOM) renders interactive hours/two-shifts/break calculator, 24/24 mode, and doctor holidays across Settings, Dashboard & Agenda', async (t) => {
  const { startDemo } = require('../demo/server');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'medirdv-schedule-holidays-ui-'));
  const demo = await startDemo({ port: 0, host: '127.0.0.1', dataDir });

  const today = dates.toISODate();
  const tomorrow = dates.addDays(today, 1);

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
  const waitFor = async (fn, timeout = 10000) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const v = fn();
      if (v) return v;
      await sleep(40);
    }
    throw new Error('Timeout waiting in MediRDV Schedule & Holidays UI test');
  };

  t.after(async () => {
    dom.window.close();
    await sleep(150);
    await demo.stop();
    safeRemove(dataDir);
  });

  // 1) Wait for initial Dashboard `.kpi` render, then switch to Arabic RTL (`ar`)
  await waitFor(() => window.document.querySelector('.kpi'), 10000);
  window.document.querySelector('.sidebar-foot button').click();
  await waitFor(() => window.document.documentElement.dir === 'rtl');
  await waitFor(() => window.document.querySelector('.kpi'));

  // 2) Configure two-shifts (08:00–17:00 + 21:00–00:00) + break (12:30–13:30) + sick holiday on tomorrow via API
  const setRes = await (
    await fetch(`${demo.url}/api/invoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'settings:set',
        payload: {
          clinic_24h_enabled: '0',
          work_start_hour: '08:00',
          work_end_hour: '17:00',
          two_shifts_enabled: '1',
          shift2_start_hour: '21:00',
          shift2_end_hour: '00:00',
          break_enabled: '1',
          break_start_hour: '12:30',
          break_end_hour: '13:30',
          working_days: '0,1,2,3,4,5,6',
        },
      }),
    })
  ).json();
  assert.equal(setRes.ok, true);
  window.App.settings = setRes.data;

  const holRes = await (
    await fetch(`${demo.url}/api/invoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'holidays:create',
        payload: {
          start_day: tomorrow,
          end_day: tomorrow,
          reason_type: 'sick',
          label: 'استراحة مرضية',
          block_all_wa: false,
        },
      }),
    })
  ).json();
  assert.equal(holRes.ok, true);

  // 3) Navigate to Settings and verify live 11-hour net summary + two-shifts + break + holiday list
  window.document.querySelector('[data-page="settings"]').click();
  await waitFor(() =>
    window.document.querySelector('[data-role="net-hours-summary"]')?.textContent.includes('11'),
  );
  const netSummaryText = window.document.querySelector('[data-role="net-hours-summary"]').textContent;
  assert.ok(netSummaryText.includes('11') && netSummaryText.includes('60'), `Expected 11h net & 60m break, got: ${netSummaryText}`);
  assert.ok(
    window.document.querySelector('.content').textContent.includes('استراحة مرضية'),
    'Settings holiday list shows created sick-leave entry',
  );

  // 4) Navigate to Agenda on `tomorrow` and verify two-shift badge + break badge + Doctor On Leave badge + disabled New Appointment button
  window.App.day = tomorrow;
  window.document.querySelector('[data-page="agenda"]').click();
  await waitFor(() =>
    window.document.querySelector('.content')?.textContent.includes(window.I18N.t('agenda.doctorOnLeave')),
  );
  const agendaText = window.document.querySelector('.content').textContent;
  assert.ok(agendaText.includes('08:00–17:00') && agendaText.includes('21:00–00:00'), 'Agenda shows two-shift schedule badge');
  assert.ok(agendaText.includes('12:30–13:30'), 'Agenda shows doctor break badge');

  const newApptBtn = [...window.document.querySelectorAll('button')].find((b) =>
    b.textContent.includes(window.I18N.t('agenda.newAppointment')),
  );
  assert.ok(newApptBtn && newApptBtn.disabled, 'New appointment button is disabled on doctor off-day');
});
