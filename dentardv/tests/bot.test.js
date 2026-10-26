'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { useTempDb, today } = require('./helpers');
const intents = require('../src/main/whatsapp/intents');
const bot = require('../src/main/whatsapp/bot');
const settings = require('../src/main/services/settings');
const appointments = require('../src/main/services/appointments');
const patients = require('../src/main/services/patients');
const intake = require('../src/main/services/intake');
const { addDays } = require('../src/main/utils/dates');

let ctx;
test.beforeEach(() => {
  ctx = useTempDb();
  settings.set('working_days', '0,1,2,3,4,5,6');
});
test.afterEach(() => ctx.cleanup());

test('intents.detect understands French, Arabic and Darija commands, greetings and names', () => {
  assert.equal(intents.detect('bonjour').isGreeting, true);
  assert.equal(intents.detect('السلام عليكم').isGreeting, true);
  assert.equal(intents.detect('سلام حاب ندي رنديفو').isGreeting, true);
  assert.equal(intents.detect('annuler').intent, 'cancel');
  assert.equal(intents.detect('إلغاء موعدي').intent, 'cancel');
  assert.equal(intents.detect('confirmer').intent, 'confirm');
  assert.equal(intents.detect('تأكيد').intent, 'confirm');
  assert.equal(intents.detect('mon rdv').intent, 'my_appointment');
  assert.equal(intents.detect('موعدي').intent, 'my_appointment');
  const frName = intents.detect('Karim Benali');
  assert.equal(frName.intent, 'name');
  assert.equal(frName.name, 'Karim Benali');
  const arName = intents.detect('كريم بن علي');
  assert.equal(arName.intent, 'name');
  assert.equal(arName.name, 'كريم بن علي');
  assert.equal(intents.detect('12345').intent, 'unsupported');
});

test('greeting gate asks for full name before booking, then books cleanly', () => {
  const greet = bot.handle({ phone: '0555999000', text: 'السلام عليكم دكتور' });
  assert.equal(greet.action, 'help');
  assert.match(greet.reply, /اسمك الكامل/);
  assert.equal(patients.findByPhone('0555999000'), null);

  const singleWord = bot.handle({ phone: '0555999000', text: 'محمد' });
  assert.equal(singleWord.action, 'unsupported');

  const booked = bot.handle({ phone: '0555999000', text: 'محمد أمين بن علي' });
  assert.equal(booked.action, 'booked');
  assert.equal(booked.appointment.queue_number, 1);
  assert.match(booked.reply, /تأكيد الموعد/);
});

test('booking creates patient + appointment, supports CONFIRMER, 2-step ANNULER and 30-min cooldown', () => {
  settings.set('intake_enabled', '0');
  const baseNow = Date.now();

  const first = bot.handle({ phone: '0555000111', text: 'Amina Kaddour', nowMs: baseNow });
  assert.equal(first.action, 'booked');
  assert.equal(first.appointment.queue_number, 1);

  const patient = patients.findByPhone('0555000111');
  assert.equal(patient.full_name, 'Amina Kaddour');

  // Re-sending name returns existing appointment
  const again = bot.handle({ phone: '0555000111', text: 'Amina Kaddour', nowMs: baseNow + 1000 });
  assert.equal(again.action, 'already_booked');

  // CONFIRMER marks attendance confirmed
  const conf = bot.handle({ phone: '0555000111', text: 'CONFIRMER', nowMs: baseNow + 2000 });
  assert.equal(conf.action, 'confirmed');
  const refreshed = appointments.get(first.appointment.id);
  assert.equal(refreshed.confirmation_status, 'confirmed');

  // MON RDV returns status
  const mine = bot.handle({ phone: '0555000111', text: 'mon rdv', nowMs: baseNow + 3000 });
  assert.equal(mine.action, 'appointment_info');
  assert.match(mine.reply, /1/);

  // 2-step cancellation: ANNULER asks OUI/NON, NON keeps appointment, ANNULER -> OUI cancels
  const askCancel = bot.handle({ phone: '0555000111', text: 'ANNULER', nowMs: baseNow + 4000 });
  assert.equal(askCancel.action, 'cancel_confirm');
  assert.equal(appointments.get(first.appointment.id).status, 'booked');

  const keepIt = bot.handle({ phone: '0555000111', text: 'NON', nowMs: baseNow + 5000 });
  assert.equal(keepIt.action, 'cancel_aborted');
  assert.equal(appointments.get(first.appointment.id).status, 'booked');

  bot.handle({ phone: '0555000111', text: 'ANNULER', nowMs: baseNow + 6000 });
  const cancelled = bot.handle({ phone: '0555000111', text: 'OUI', nowMs: baseNow + 7000 });
  assert.equal(cancelled.action, 'cancelled');
  assert.equal(appointments.get(first.appointment.id).status, 'cancelled');

  // Immediate re-booking within 30 minutes is blocked by anti-abuse cooldown
  const cooldown = bot.handle({ phone: '0555000111', text: 'Amina Kaddour', nowMs: baseNow + 60_000 });
  assert.equal(cooldown.action, 'cooldown_blocked');

  // Advance clock programmatically past the 30-minute cooldown -> re-booking succeeds!
  const rebooked = bot.handle({
    phone: '0555000111',
    text: 'Amina Kaddour',
    nowMs: baseNow + 32 * 60_000,
  });
  assert.equal(rebooked.action, 'booked');
});

test('Law 18-07 post-booking dental intake collects ONLY Age, Weight and optional symptoms', () => {
  settings.set('intake_enabled', '1');

  const booked = bot.handle({ phone: '0661222333', text: 'ياسين بلقاسم' });
  assert.equal(booked.action, 'booked');
  assert.match(booked.reply, /18-07/);

  // Consent YES -> asks Age
  const stepAge = bot.handle({ phone: '0661222333', text: 'نعم' });
  assert.equal(stepAge.action, 'intake_started');

  // Age -> asks Weight
  const stepWeight = bot.handle({ phone: '0661222333', text: '34' });
  assert.equal(stepWeight.action, 'intake_ask_weight');

  // Weight -> asks optional dental symptoms
  const stepSymptoms = bot.handle({ phone: '0661222333', text: '78' });
  assert.equal(stepSymptoms.action, 'intake_ask_complaint');

  // Symptoms -> finishes and saves unverified intake (never overwrites clinical record before doctor review)
  const done = bot.handle({ phone: '0661222333', text: 'ألم حاد في ضرس العقل السفلي' });
  assert.equal(done.action, 'intake_completed');

  const pending = intake.latestPendingForPatient(booked.appointment.patient_id);
  assert.ok(pending);
  assert.equal(pending.status, 'pending');
  assert.equal(pending.age_years, 34);
  assert.equal(pending.weight_kg, 78);
  assert.match(pending.chief_complaint, /ضرس العقل/);
});

test('Arabic messages get Arabic replies and Darija mode switches templates', () => {
  settings.set('intake_enabled', '0');
  const res = bot.handle({ phone: '0661000222', text: 'فاطمة الزهراء سعيدي' });
  assert.equal(res.action, 'booked');
  assert.equal(res.lang, 'ar');
  assert.match(res.reply, /تم تأكيد الموعد/);

  settings.set('bot_darija_mode', '1');
  const dar = bot.handle({ phone: '0661000333', text: 'سفيان حداد' });
  assert.equal(dar.action, 'booked');
  assert.ok(dar.reply.length > 10);
});

test('places the patient on the waiting list when every day in the horizon is full', () => {
  settings.set('daily_capacity', '1');
  settings.set('booking_horizon_days', '1');
  settings.set('allow_same_day_booking', '0');

  const p1 = patients.create({ full_name: 'Ali Ben' });
  const p2 = patients.create({ full_name: 'Badr Kaci' });
  appointments.create({ patient_id: p1.id, day: addDays(today(), 1) });
  appointments.create({ patient_id: p2.id, day: addDays(today(), 2) });

  const reply = bot.handle({ phone: '0770111222', text: 'Sofiane Haddad' });
  assert.equal(reply.action, 'waiting_list');
  assert.equal(appointments.waitingList().length, 1);
});
