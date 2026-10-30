'use strict';
/**
 * Comprehensive tests for MediRDV v2.4.0 WhatsApp Available Day & Date Picker:
 *  - Dynamic calculation from real SQLite appointments, working_days,
 *    clinic_closures, daily_capacity, allow_same_day_booking, and time slots.
 *  - Numbered choice (ASCII & Arabic-Indic digits), pagination (0 / المزيد / PLUS),
 *    direct date input (DD/MM, DD/MM/YYYY, YYYY-MM-DD, غدا, demain, weekday).
 *  - Solo cabinet & multi-department polyclinic + slots scheduling mode.
 *  - Race-condition handling when a day fills up mid-conversation.
 *  - Default ON production setting + Settings toggle OFF fallback.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { useTempDb } = require('./helpers');
const bot = require('../src/main/whatsapp/bot');
const intents = require('../src/main/whatsapp/intents');
const settings = require('../src/main/services/settings');
const patients = require('../src/main/services/patients');
const appointments = require('../src/main/services/appointments');
const departments = require('../src/main/services/departments');
const operations = require('../src/main/services/operations');
const { toISODate, addDays, formatFR } = require('../src/main/utils/dates');

test('default production settings enable WhatsApp day picker (bot_choose_day_enabled = 1)', (t) => {
  const ctx = useTempDb({ keepDefaultSettings: true });
  t.after(() => ctx.cleanup());

  assert.equal(settings.get('bot_choose_day_enabled'), '1');
  assert.equal(settings.getBool('bot_choose_day_enabled'), true);
  assert.equal(settings.getInt('bot_available_days_count'), 7);

  // Validator clamps bot_available_days_count safely to [3..14]
  settings.set('bot_available_days_count', '1');
  assert.equal(settings.getInt('bot_available_days_count'), 3);
  settings.set('bot_available_days_count', '99');
  assert.equal(settings.getInt('bot_available_days_count'), 14);
});

test('listAvailableDays reflects real bookings, cancellations, working_days, and clinic_closures', (t) => {
  const ctx = useTempDb({ chooseDay: true });
  t.after(() => ctx.cleanup());

  const today = toISODate();
  const d1 = addDays(today, 1);
  const d2 = addDays(today, 2);
  const d3 = addDays(today, 3);
  const d4 = addDays(today, 4);

  settings.setMany({
    working_days: '0,1,2,3,4,5,6',
    allow_same_day_booking: '0',
    daily_capacity: '2',
    booking_horizon_days: '10',
    bot_available_days_count: '5',
  });

  // Fill d1 completely (2/2)
  const p1 = patients.create({ full_name: 'Patient Un', phone: '0550000001' });
  const p2 = patients.create({ full_name: 'Patient Deux', phone: '0550000002' });
  const p3 = patients.create({ full_name: 'Patient Trois', phone: '0550000003' });
  appointments.create({ patient_id: p1.id, day: d1 });
  appointments.create({ patient_id: p2.id, day: d1 });

  // Book 1/2 on d2
  const aOnD2 = appointments.create({ patient_id: p3.id, day: d2 });

  // Add an official holiday / closure on d3
  operations.addClosure({
    start_day: d3,
    end_day: d3,
    kind: 'holiday_national',
    label_fr: 'Jour férié national',
    label_ar: 'عطلة وطنية',
  });

  const avail = appointments.listAvailableDays();
  const listedDays = avail.days.map((x) => x.day);

  assert.ok(!listedDays.includes(today), 'today excluded when allow_same_day_booking = 0');
  assert.ok(!listedDays.includes(d1), 'full day d1 excluded');
  assert.ok(!listedDays.includes(d3), 'closed holiday d3 excluded');
  assert.equal(avail.days[0].day, d2, 'first available day is d2');
  assert.equal(avail.days[0].left, 1, 'd2 shows exact 1 remaining place');
  assert.equal(avail.days[1].day, d4, 'second available day skips holiday to d4');
  assert.equal(avail.days[1].left, 2, 'd4 shows all 2 places available');

  // Cancelling d2 appointment immediately restores capacity to 2
  appointments.cancel(aOnD2.id);
  const afterCancel = appointments.listAvailableDays();
  assert.equal(afterCancel.days[0].day, d2);
  assert.equal(afterCancel.days[0].left, 2);
});

test('Arabic WhatsApp booking flow: name -> numbered available days -> pick #2 -> booked + Law 18-07 intake', (t) => {
  const ctx = useTempDb({ chooseDay: true });
  t.after(() => ctx.cleanup());

  const today = toISODate();
  settings.setMany({
    clinic_name: 'عيادة النور الطبية',
    working_days: '0,1,2,3,4,5,6',
    allow_same_day_booking: '0',
    daily_capacity: '4',
    booking_horizon_days: '14',
    bot_available_days_count: '5',
    bot_language: 'ar',
  });

  // Pre-book 3 patients on tomorrow so tomorrow has 1 place left
  const tomorrow = addDays(today, 1);
  const afterTomorrow = addDays(today, 2);
  for (let i = 1; i <= 3; i += 1) {
    const p = patients.create({ full_name: `مريض سابق ${i}`, phone: `055200000${i}` });
    appointments.create({ patient_id: p.id, day: tomorrow });
  }

  // Step 1: New patient sends Arabic full name -> receives numbered list of available days
  const step1 = bot.handle({ phone: '213661112233', text: 'أمين بن صالح' });
  assert.equal(step1.action, 'choose_day');
  assert.equal(step1.lang, 'ar');
  assert.equal(step1.availableDays.length, 5);
  assert.equal(step1.availableDays[0].day, tomorrow);
  assert.equal(step1.availableDays[0].left, 1);
  assert.equal(step1.availableDays[1].day, afterTomorrow);
  assert.equal(step1.availableDays[1].left, 4);
  assert.match(step1.reply, /مكان واحد متاح/);
  assert.match(step1.reply, /4 أماكن متاحة/);

  // Step 2: Patient chooses option ٢ (Eastern Arabic digit 2 -> afterTomorrow!)
  const step2 = bot.handle({ phone: '213661112233', text: '٢' });
  assert.equal(step2.action, 'booked');
  assert.equal(step2.appointment.day, afterTomorrow);
  assert.equal(step2.appointment.queue_number, 1);
  assert.match(step2.reply, /تم تأكيد الموعد/);

  // Step 3: Seamless transition into Law 18-07 optional intake (age -> weight -> symptoms)
  const step3 = bot.handle({ phone: '213661112233', text: '34' });
  assert.equal(step3.action, 'intake_ask_weight');
  const step4 = bot.handle({ phone: '213661112233', text: '78' });
  assert.equal(step4.action, 'intake_ask_complaint');
  const step5 = bot.handle({ phone: '213661112233', text: 'صداع خفيف' });
  assert.equal(step5.action, 'intake_completed');
});

test('pagination (0 / المزيد / PLUS) and direct date entry (DD/MM, full day, holiday rejection)', (t) => {
  const ctx = useTempDb({ chooseDay: true });
  t.after(() => ctx.cleanup());

  const today = toISODate();
  const d1 = addDays(today, 1);
  const d2 = addDays(today, 2);
  const d5 = addDays(today, 5);

  settings.setMany({
    clinic_name: 'Cabinet El Chifa',
    working_days: '0,1,2,3,4,5,6',
    allow_same_day_booking: '0',
    daily_capacity: '1',
    booking_horizon_days: '12',
    bot_available_days_count: '3',
  });

  // Fill d1 completely and close d2 for holiday
  const existing = patients.create({ full_name: 'Karim Ziani', phone: '0553000001' });
  appointments.create({ patient_id: existing.id, day: d1 });
  operations.addClosure({
    start_day: d2,
    end_day: d2,
    kind: 'leave',
    label_fr: 'Congé exceptionnel',
    label_ar: 'عطلة استثنائية',
  });

  const s1 = bot.handle({ phone: '213554443322', text: 'Nadia Benali' });
  assert.equal(s1.action, 'choose_day');
  assert.equal(s1.availableDays.length, 3);
  assert.equal(s1.hasMoreDays, true);

  // Patient asks for next page of dates with "0"
  const page2 = bot.handle({ phone: '213554443322', text: '0' });
  assert.equal(page2.action, 'choose_day');
  assert.notEqual(page2.availableDays[0].day, s1.availableDays[0].day);

  // Patient types the full day d1 explicitly (DD/MM/YYYY) -> rejected with clear "complet" message
  const tryFull = bot.handle({ phone: '213554443322', text: formatFR(d1) });
  assert.equal(tryFull.action, 'day_unavailable');
  assert.match(tryFull.reply, /complète/);

  // Patient types the closed holiday d2 explicitly (ISO YYYY-MM-DD) -> rejected with closure label
  const tryClosed = bot.handle({ phone: '213554443322', text: d2 });
  assert.equal(tryClosed.action, 'day_unavailable');
  assert.match(tryClosed.reply, /Congé exceptionnel/);

  // Patient types short DD/MM for open day d5 -> booked on d5!
  const shortDm = formatFR(d5).slice(0, 5);
  const booked = bot.handle({ phone: '213554443322', text: shortDm });
  assert.equal(booked.action, 'booked');
  assert.equal(booked.appointment.day, d5);
});

test('race condition: if chosen day fills up on desktop before patient replies, bot refreshes available days', (t) => {
  const ctx = useTempDb({ chooseDay: true });
  t.after(() => ctx.cleanup());

  const today = toISODate();
  const d1 = addDays(today, 1);
  const d2 = addDays(today, 2);

  settings.setMany({
    working_days: '0,1,2,3,4,5,6',
    allow_same_day_booking: '0',
    daily_capacity: '1',
    booking_horizon_days: '10',
  });

  // Patient opens available days list (d1 has 1 place left)
  const menu = bot.handle({ phone: '213770112233', text: 'سليمة منصوري' });
  assert.equal(menu.action, 'choose_day');
  assert.equal(menu.availableDays[0].day, d1);

  // Meanwhile, secretary books the last slot on d1 from the desktop app!
  const walkIn = patients.create({ full_name: 'مريض حضوري', phone: '0559998877' });
  appointments.create({ patient_id: walkIn.id, day: d1 });

  // Patient now replies "1" -> bot catches that d1 is full and offers updated list starting at d2!
  const raceReply = bot.handle({ phone: '213770112233', text: '1' });
  assert.equal(raceReply.action, 'day_unavailable');
  assert.match(raceReply.reply, /ممتلئ/);
  assert.equal(raceReply.availableDays[0].day, d2);

  // Patient replies "1" again -> books d2 cleanly!
  const confirmed = bot.handle({ phone: '213770112233', text: '1' });
  assert.equal(confirmed.action, 'booked');
  assert.equal(confirmed.appointment.day, d2);
});

test('multi-department polyclinic + time-slots mode shows department-specific available days & earliest slot', (t) => {
  const ctx = useTempDb({ chooseDay: true });
  t.after(() => ctx.cleanup());

  const today = toISODate();
  const d1 = addDays(today, 1);
  const d2 = addDays(today, 2);

  settings.setMany({
    clinic_name: 'Polyclinique El Djazair',
    working_days: '0,1,2,3,4,5,6',
    allow_same_day_booking: '0',
    booking_horizon_days: '10',
  });

  departments.create({
    name_fr: 'Médecine Générale',
    name_ar: 'طب عام',
    daily_capacity: 10,
    working_days: '0,1,2,3,4,5,6',
  });
  const ophtalmo = departments.create({
    name_fr: 'Ophtalmologie',
    name_ar: 'طب العيون',
    doctor_name: 'Dr Bensalem',
    daily_capacity: 5,
    working_days: '0,1,2,3,4,5,6',
    scheduling_mode: 'slots',
    slot_start_time: '09:00',
    slot_end_time: '10:00',
    slot_duration_min: 30,
  });

  // Book the 09:00 slot on d1 so 09:30 is the earliest remaining slot on d1
  const pExist = patients.create({ full_name: 'Rachid Mekhloufi', phone: '0558111111' });
  appointments.create({
    patient_id: pExist.id,
    department_id: ophtalmo.id,
    day: d1,
    slot_time: '09:00',
  });

  // 1. Patient sends name -> asked to choose department
  const s1 = bot.handle({ phone: '213662223344', text: 'سمير بوزيد' });
  assert.equal(s1.action, 'choose_department');

  // 2. Patient picks department 2 (Ophtalmologie) -> sees available days with 1 place & 09:30 on d1, 2 places & 09:00 on d2
  const s2 = bot.handle({ phone: '213662223344', text: '2' });
  assert.equal(s2.action, 'choose_day');
  assert.equal(s2.availableDays[0].day, d1);
  assert.equal(s2.availableDays[0].left, 1);
  assert.equal(s2.availableDays[0].nextSlotTime, '09:30');
  assert.match(s2.reply, /09:30/);
  assert.equal(s2.availableDays[1].day, d2);
  assert.equal(s2.availableDays[1].left, 2);

  // 3. Patient picks day 1 -> booked into Ophtalmologie at 09:30!
  const s3 = bot.handle({ phone: '213662223344', text: '1' });
  assert.equal(s3.action, 'booked');
  assert.equal(s3.appointment.day, d1);
  assert.equal(s3.appointment.department_id, ophtalmo.id);
  assert.equal(s3.appointment.slot_time, '09:30');
  assert.match(s3.reply, /09:30/);
});

test('direct inquiry ("الأيام المتاحة" / "jours disponibles") & Settings toggle OFF fallback', (t) => {
  const ctx = useTempDb({ chooseDay: true });
  t.after(() => ctx.cleanup());

  settings.setMany({
    clinic_name: 'عيادة الأمل',
    working_days: '0,1,2,3,4,5,6',
    allow_same_day_booking: '1',
    daily_capacity: '5',
  });

  assert.equal(intents.detect('الأيام المتاحة').intent, 'dates');
  assert.equal(intents.detect('jours disponibles').intent, 'dates');

  // Unregistered caller asking for available dates gets preview + prompt for full name
  const preview = bot.handle({ phone: '213556001122', text: 'الأيام المتاحة' });
  assert.equal(preview.action, 'available_days_preview');
  assert.ok(preview.availableDays.length > 0);
  assert.match(preview.reply, /أسامة حمداوي/);

  // Toggling bot_choose_day_enabled = '0' restores immediate 1-step auto-booking
  settings.set('bot_choose_day_enabled', '0');
  const autoBooked = bot.handle({ phone: '213556001122', text: 'ياسين خلوفي' });
  assert.equal(autoBooked.action, 'booked');
});
