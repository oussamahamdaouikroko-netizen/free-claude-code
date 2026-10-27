'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { useTempDb } = require('./helpers');

const settings = require('../src/main/services/settings');
const patients = require('../src/main/services/patients');
const appointments = require('../src/main/services/appointments');
const bot = require('../src/main/whatsapp/bot');
const dates = require('../src/main/utils/dates');

function setupDatePickerDb(t) {
  const ctx = useTempDb();
  settings.set('working_days', '0,1,2,3,4,5,6');
  settings.set('allow_same_day_booking', '1');
  settings.set('daily_capacity', '2');
  settings.set('booking_horizon_days', '14');
  settings.set('bot_choose_day_enabled', '1');
  settings.set('bot_max_day_choices', '5');
  settings.set('bot_language', 'auto');
  bot.resetMemory();
  t.after(() => {
    bot.resetMemory();
    ctx.cleanup();
  });
  return ctx;
}

test('WhatsApp date picker dynamically computes available days from real bookings, capacity, and cancellations', (t) => {
  setupDatePickerDb(t);
  const today = dates.toISODate();
  const tomorrow = dates.addDays(today, 1);
  const dayAfter = dates.addDays(today, 2);

  // Fill today completely (capacity = 2)
  const p1 = patients.create({ full_name: 'Patient Un', phone: '0551000001' });
  const p2 = patients.create({ full_name: 'Patient Deux', phone: '0551000002' });
  const a1 = appointments.create({ patient_id: p1.id, day: today });
  appointments.create({ patient_id: p2.id, day: today });

  // Book 1 of 2 slots on tomorrow
  const p3 = patients.create({ full_name: 'Patient Trois', phone: '0551000003' });
  appointments.create({ patient_id: p3.id, day: tomorrow });

  // Close dayAfter by excluding its weekday
  const closedWeekday = new Date(`${dayAfter}T12:00:00Z`).getUTCDay();
  const openWeekdays = [0, 1, 2, 3, 4, 5, 6].filter((w) => w !== closedWeekday).join(',');
  settings.set('working_days', openWeekdays);

  const avail = appointments.listAvailableDays({ offset: 0 });
  assert.ok(avail.days.length > 0);
  // Today is full, so it must NOT appear
  assert.ok(!avail.days.some((d) => d.day === today), 'full day excluded');
  // Tomorrow has 1 place left
  const tomorrowEntry = avail.days.find((d) => d.day === tomorrow);
  if (openWeekdays.includes(String(new Date(`${tomorrow}T12:00:00Z`).getUTCDay()))) {
    assert.ok(tomorrowEntry, 'partially booked working day included');
    assert.equal(tomorrowEntry.left, 1);
  }
  // Closed weekday must NOT appear
  assert.ok(!avail.days.some((d) => d.day === dayAfter), 'closed weekday excluded');

  // Cancelling a1 on today immediately re-opens today with 1 place left (if today's weekday is open)
  settings.set('working_days', '0,1,2,3,4,5,6');
  appointments.cancel(a1.id);
  const availAfterCancel = appointments.listAvailableDays({ offset: 0 });
  assert.equal(availAfterCancel.days[0].day, today);
  assert.equal(availAfterCancel.days[0].left, 1);
});

test('WhatsApp bot offers numbered day choices in Arabic & French, supports pagination, direct DD/MM dates, and race-condition refresh', (t) => {
  setupDatePickerDb(t);
  const today = dates.toISODate();
  const day3 = dates.addDays(today, 2);

  // 1) Arabic caller sends full name -> gets numbered day list -> picks #3 (dayAfterTomorrow)
  const step1 = bot.handle({ phone: '0552111001', text: 'أسامة حمداوي' });
  assert.equal(step1.action, 'choose_day');
  assert.equal(step1.lang, 'ar');
  assert.equal(step1.availableDays.length, 5);
  assert.equal(step1.availableDays[2].day, day3);

  const step2 = bot.handle({ phone: '0552111001', text: '3' });
  assert.equal(step2.action, 'booked');
  assert.equal(step2.appointment.day, day3);
  assert.equal(step2.appointment.queue_number, 1);

  // 2) Friend books on a different date via pagination ('0' / 'المزيد') -> picks #1 on page 2
  const f1 = bot.handle({ phone: '0552111002', text: 'أمين بن سالم' });
  assert.equal(f1.action, 'choose_day');
  const page2 = bot.handle({ phone: '0552111002', text: 'المزيد' });
  assert.equal(page2.action, 'choose_day');
  const expectedDay6 = dates.addDays(today, 5);
  assert.equal(page2.availableDays[0].day, expectedDay6);

  const fBooked = bot.handle({ phone: '0552111002', text: '١' }); // Arabic-Indic digit 1
  assert.equal(fBooked.action, 'booked');
  assert.equal(fBooked.appointment.day, expectedDay6);

  // 3) French caller asks 'Jours disponibles' before registering -> preview -> sends name -> picks by DD/MM
  const preview = bot.handle({ phone: '0552111003', text: 'Jours disponibles' });
  assert.equal(preview.action, 'available_days');
  assert.equal(preview.lang, 'fr');

  const frChoose = bot.handle({ phone: '0552111003', text: 'Karim Meziane' });
  assert.equal(frChoose.action, 'choose_day');
  const targetISO = dates.addDays(today, 3);
  const ddmm = dates.formatFR(targetISO).slice(0, 5); // DD/MM
  const frBooked = bot.handle({ phone: '0552111003', text: ddmm });
  assert.equal(frBooked.action, 'booked');
  assert.equal(frBooked.appointment.day, targetISO);

  // 4) Race condition: caller sees day3 as available, desktop fills the last slot on day3 before caller replies '3'
  const deskPatient = patients.create({ full_name: 'Desktop Slot Filler', phone: '0552999001' });
  const r1 = bot.handle({ phone: '0552111004', text: 'ياسين بلقاسم' });
  assert.equal(r1.action, 'choose_day');
  assert.ok(r1.availableDays.some((d) => d.day === day3));

  // Fill remaining capacity on day3 from desktop
  appointments.create({ patient_id: deskPatient.id, day: day3 });
  assert.equal(appointments.checkDayAvailability(day3).bookable, false);

  // Caller now replies with day3's index -> bot detects day3 is full and re-prompts cleanly
  const idxDay3 = r1.availableDays.findIndex((d) => d.day === day3) + 1;
  const raceReply = bot.handle({ phone: '0552111004', text: String(idxDay3) });
  assert.equal(raceReply.action, 'day_unavailable');
  assert.ok(!raceReply.availableDays.some((d) => d.day === day3));

  // Caller then picks #1 from refreshed list -> succeeds!
  const recovered = bot.handle({ phone: '0552111004', text: '1' });
  assert.equal(recovered.action, 'booked');
  assert.equal(recovered.appointment.day, today);
});

test('WhatsApp callback buttons (day_select, day_more) and bot_choose_day_enabled=0 toggle work seamlessly', (t) => {
  setupDatePickerDb(t);
  const today = dates.toISODate();
  const tomorrow = dates.addDays(today, 1);

  const c1 = bot.handle({ phone: '0553000001', text: 'Nadia Cherif' });
  assert.equal(c1.action, 'choose_day');
  assert.ok(Array.isArray(c1.buttons) && c1.buttons.length >= 2);

  const cbMore = bot.handle({ phone: '0553000001', callbackData: 'day_more:5' });
  assert.equal(cbMore.action, 'choose_day');
  assert.equal(cbMore.availableDays[0].day, dates.addDays(today, 5));

  const cbSelect = bot.handle({ phone: '0553000001', callbackData: `day_select:${tomorrow}` });
  assert.equal(cbSelect.action, 'booked');
  assert.equal(cbSelect.appointment.day, tomorrow);

  // Disable day picker -> immediate auto-assigned next-working-day booking (legacy 1-step mode)
  settings.set('bot_choose_day_enabled', '0');
  const direct = bot.handle({ phone: '0553000002', text: 'Sofiane Haddad' });
  assert.equal(direct.action, 'booked');
  assert.equal(direct.appointment.day, tomorrow);
});
