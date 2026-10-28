/* Tests for Doctor Off-Days / Holidays / Sick Leave & 24/24 Non-Stop Clinic mode. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');

const { useTempDb, safeRemove } = require('./helpers');
const { startDemo } = require('../demo/server');
const dates = require('../src/main/utils/dates');
const settings = require('../src/main/services/settings');
const holidays = require('../src/main/services/holidays');
const patients = require('../src/main/services/patients');
const appointments = require('../src/main/services/appointments');
const bot = require('../src/main/whatsapp/bot');

test('Doctor holidays & sick-leave days block bookings, skip in nextFreeDay/listAvailableDays, track conflicts, and reopen cleanly', (t) => {
  const ctx = useTempDb();
  t.after(() => ctx.cleanup());

  const today = dates.toISODate();
  const tomorrow = dates.addDays(today, 1);
  const day2 = dates.addDays(today, 2);
  const day3 = dates.addDays(today, 3);

  settings.setMany({
    working_days: '0,1,2,3,4,5,6',
    allow_same_day_booking: '0',
    daily_capacity: '15',
  });

  // Pre-existing booked appointment on tomorrow before doctor gets sick -> tracked in booked_conflicts
  const existingPatient = patients.create({ full_name: 'Karim Prebooked', phone: '0551000010' });
  appointments.create({ patient_id: existingPatient.id, day: tomorrow });

  // Invalid range rejected
  assert.throws(
    () => holidays.create({ start_day: day2, end_day: tomorrow, reason_type: 'vacation' }),
    (err) => err && err.code === 'HOLIDAY_END_BEFORE_START',
  );

  // Doctor marks tomorrow + day2 as sick leave
  const leave = holidays.create({
    start_day: tomorrow,
    end_day: day2,
    reason_type: 'sick',
    label: 'Repos médical 48h',
    block_all_wa: false,
  });
  assert.equal(leave.reason_type, 'sick');
  assert.equal(leave.booked_conflicts, 1, 'reports 1 pre-existing appointment without deleting clinic data');

  // Day info shows holiday and working=false
  const infoTomorrow = appointments.dayInfo(tomorrow);
  assert.equal(infoTomorrow.working, false);
  assert.ok(infoTomorrow.holiday);
  assert.equal(infoTomorrow.holiday.id, leave.id);

  // Direct booking & rescheduling onto tomorrow or day2 rejected with DOCTOR_ON_LEAVE
  const pNew = patients.create({ full_name: 'Nadia Test', phone: '0551000020' });
  assert.throws(
    () => appointments.create({ patient_id: pNew.id, day: tomorrow }),
    (err) => err && err.code === 'DOCTOR_ON_LEAVE',
  );
  assert.throws(
    () => appointments.create({ patient_id: pNew.id, day: day2 }),
    (err) => err && err.code === 'DOCTOR_ON_LEAVE',
  );

  // Automatic next free day & listAvailableDays skip tomorrow and day2 -> start at day3
  assert.equal(appointments.findNextFreeDay(), day3);
  const avail = appointments.listAvailableDays({ limit: 5 });
  assert.equal(avail.days[0].day, day3);
  assert.ok(!avail.days.some((d) => d.day === tomorrow || d.day === day2));

  // checkDayAvailability reports exact reason 'holiday'
  const check = appointments.checkDayAvailability(tomorrow);
  assert.equal(check.bookable, false);
  assert.equal(check.reason, 'holiday');

  // Removing the holiday reopens tomorrow immediately
  holidays.remove(leave.id);
  assert.equal(appointments.dayInfo(tomorrow).working, true);
  assert.equal(appointments.findNextFreeDay(), tomorrow);
  const bookedAfterReopen = appointments.create({ patient_id: pNew.id, day: tomorrow });
  assert.equal(bookedAfterReopen.day, tomorrow);
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

  // Arabic patient starts booking: sees holiday notice ("الطبيب في عطلة"), NEVER sees "مرض" or "Grippe", and offered list skips tomorrow!
  const step1 = bot.handle({
    phone: '0552111001',
    text: 'أمين بوزيد',
    nowMs: 1_700_000_000_000,
  });
  assert.equal(step1.action, 'choose_day');
  assert.match(step1.reply, /الطبيب في عطلة/);
  assert.doesNotMatch(step1.reply, /مرض|Grippe/i, 'internal sick reason stays private');
  assert.equal(step1.availableDays[0].day, day2);

  // Patient tries typing tomorrow's date (DD/MM) manually -> gets polite holiday unavailability message
  const [yyyy, mm, dd] = tomorrow.split('-');
  const stepHolidayTry = bot.handle({
    phone: '0552111001',
    text: `${dd}/${mm}`,
    nowMs: 1_700_000_005_000,
  });
  assert.equal(stepHolidayTry.action, 'day_unavailable');
  assert.match(stepHolidayTry.reply, /الطبيب في عطلة/);

  // Patient selects #1 (day2) -> booked cleanly on day2!
  const stepBooked = bot.handle({
    phone: '0552111001',
    text: '1',
    nowMs: 1_700_000_010_000,
  });
  assert.equal(stepBooked.action, 'booked');
  assert.equal(stepBooked.appointment.day, day2);
  bot.resetMemory();

  // 2) Doctor activates an active multi-day holiday starting TODAY with `block_all_wa: true`
  const fullPause = holidays.create({
    start_day: today,
    end_day: day2,
    reason_type: 'vacation',
    label: 'Congé annuel',
    block_all_wa: true,
  });

  // New Arabic & French patients trying to book receive `doctor_on_leave` with resume date (day3)
  const pausedAr = bot.handle({
    phone: '0552111002',
    text: 'السلام عليكم',
    nowMs: 1_700_000_020_000,
  });
  assert.equal(pausedAr.action, 'doctor_on_leave');
  assert.match(pausedAr.reply, /الطبيب في عطلة/);
  assert.equal(pausedAr.resumeDay, day3);

  const pausedFr = bot.handle({
    phone: '0552111003',
    text: 'Bonjour Docteur',
    nowMs: 1_700_000_025_000,
  });
  assert.equal(pausedFr.action, 'doctor_on_leave');
  assert.match(pausedFr.reply, /en congé/i);
  assert.equal(pausedFr.resumeDay, day3);

  // Darija mode also works cleanly
  settings.set('bot_darija_mode', '1');
  const pausedDarija = bot.handle({
    phone: '0552111004',
    text: 'سلام طبيب نقدر نحجز',
    nowMs: 1_700_000_030_000,
  });
  assert.equal(pausedDarija.action, 'doctor_on_leave');
  assert.match(pausedDarija.reply, /عطلة/);
  settings.set('bot_darija_mode', '0');

  // Existing booked patient (`0552111001`) can STILL check `موعدي` (`appointment_info`) even during `block_all_wa`!
  const mineRes = bot.handle({
    phone: '0552111001',
    text: 'موعدي',
    nowMs: 1_700_000_035_000,
  });
  assert.equal(mineRes.action, 'appointment_info');

  holidays.remove(fullPause.id);
});

test('24/24 non-stop clinic mode supports high daily capacities, same-day 7/7 schedule, and 24/24 WhatsApp notices', (t) => {
  const ctx = useTempDb();
  t.after(() => ctx.cleanup());

  const today = dates.toISODate();

  settings.setMany({
    clinic_24h_enabled: '1',
    working_days: '0,1,2,3,4,5,6',
    allow_same_day_booking: '1',
    daily_capacity: '300',
    bot_choose_day_enabled: '1',
  });

  assert.equal(settings.is24hClinic(), true);
  assert.equal(settings.getInt('daily_capacity'), 300);
  assert.match(settings.formatScheduleSummary('ar'), /24\/24/);
  assert.match(settings.formatScheduleSummary('fr'), /24h\/24/);

  // Help, day-picker & booking replies advertise 24/24 non-stop service in Arabic & French
  const helpAr = bot.handle({
    phone: '0553222001',
    text: 'مساعدة',
    nowMs: 1_700_000_100_000,
  });
  assert.equal(helpAr.action, 'help');
  assert.match(helpAr.reply, /24\/24/);

  const chooseFr = bot.handle({
    phone: '0553222002',
    text: 'Rami Benali',
    nowMs: 1_700_000_105_000,
  });
  assert.equal(chooseFr.action, 'choose_day');
  assert.equal(chooseFr.availableDays[0].day, today, 'today is offered as #1 in 24/24 mode');

  const bookedFr = bot.handle({
    phone: '0553222002',
    text: '1',
    nowMs: 1_700_000_106_000,
  });
  assert.equal(bookedFr.action, 'booked');
  assert.equal(bookedFr.appointment.day, today, 'same-day booking succeeds immediately in 24/24 mode');
  assert.match(bookedFr.reply, /24h\/24/);

  // Standard opening/closing hours validation when 24/24 is disabled
  settings.setMany({
    clinic_24h_enabled: '0',
    work_start_hour: '8:30',
    work_end_hour: '18:00',
  });
  assert.equal(settings.is24hClinic(), false);
  assert.equal(settings.get('work_start_hour'), '08:30');
  assert.equal(settings.get('work_end_hour'), '18:00');
  assert.equal(settings.formatScheduleSummary('fr'), '08:30 – 18:00');
});

test('Renderer UI (JSDOM) supports 24/24 clinic toggle, doctor holiday management in Settings, and holiday badges on Agenda/Dashboard', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dentardv-24h-holidays-ui-'));
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
          addEventListener() {},
          removeEventListener() {},
        }));
    },
  });

  const { window } = dom;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, timeout = 8000) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const v = fn();
      if (v) return v;
      await sleep(40);
    }
    throw new Error('Timeout waiting in 24/24 & Holidays UI test');
  };

  t.after(async () => {
    dom.window.close();
    await sleep(150);
    await demo.stop();
    safeRemove(dataDir);
  });

  // 1) Wait for initial Dashboard `.kpi` render
  await waitFor(() => window.document.querySelector('.kpi'), 10000);

  // Switch to Arabic RTL (`ar`) and navigate to Settings
  window.document.querySelector('.sidebar-foot button').click();
  await waitFor(() => window.document.documentElement.dir === 'rtl');
  await waitFor(() => window.document.querySelector('.kpi'));

  window.document.querySelector('[data-page="settings"]').click();
  await waitFor(() =>
    window.document.querySelector('.content')?.textContent.includes(window.I18N.t('holidays.title')),
  );

  // Verify Holidays card & 24/24 toggle are rendered in Arabic
  const settingsText = window.document.querySelector('.content').textContent;
  assert.ok(settingsText.includes('24/24'), 'Settings page renders 24/24 clinic switch');
  assert.ok(settingsText.includes(window.I18N.t('holidays.addBtn')), 'Settings page renders Add Holiday button');

  // Enable 24/24 mode and create a holiday on `tomorrow` via demo API, then verify Settings, Dashboard, and Agenda reflect both!
  const setRes = await (
    await fetch(`${demo.url}/api/invoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'settings:set',
        payload: {
          clinic_24h_enabled: '1',
          working_days: '0,1,2,3,4,5,6',
          allow_same_day_booking: '1',
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
          label: 'راحة طبية',
          block_all_wa: false,
        },
      }),
    })
  ).json();
  assert.equal(holRes.ok, true);

  // Refresh Settings and confirm the holiday item + sick badge appear
  await window.App.renderPage();
  await waitFor(() =>
    window.document.querySelector('.content')?.textContent.includes('راحة طبية'),
  );
  assert.ok(
    window.document.querySelector('.content').textContent.includes(window.I18N.t('holidays.reasonSick')),
    'Settings holiday list displays internal sick-leave badge',
  );

  // Navigate to Dashboard and verify 24/24 badge appears
  window.document.querySelector('[data-page="dashboard"]').click();
  await waitFor(() =>
    window.document.querySelector('.content')?.textContent.includes(window.I18N.t('dash.open24hBadge')),
  );

  // Navigate to Agenda for `tomorrow` and verify Doctor On Leave badge + disabled new appointment button
  window.App.day = tomorrow;
  window.document.querySelector('[data-page="agenda"]').click();
  await waitFor(() =>
    window.document.querySelector('.content')?.textContent.includes(window.I18N.t('agenda.doctorOnLeave')),
  );

  const agendaContent = window.document.querySelector('.content').textContent;
  assert.ok(agendaContent.includes(window.I18N.t('dash.open24hBadge')), 'Agenda displays 24/24 badge');
  assert.ok(agendaContent.includes(window.I18N.t('agenda.doctorOnLeave')), 'Agenda displays Doctor On Leave badge');

  const newApptBtn = [...window.document.querySelectorAll('button')].find((b) =>
    b.textContent.includes(window.I18N.t('agenda.newAppointment')),
  );
  assert.ok(newApptBtn && newApptBtn.disabled, 'New appointment button is disabled on doctor off-day');
});
