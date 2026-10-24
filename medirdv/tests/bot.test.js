'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { useTempDb } = require('./helpers');
const intents = require('../src/main/whatsapp/intents');
const bot = require('../src/main/whatsapp/bot');
const settings = require('../src/main/services/settings');
const patients = require('../src/main/services/patients');
const appointments = require('../src/main/services/appointments');

function fresh() {
  const ctx = useTempDb();
  settings.setMany({
    clinic_name: 'Cabinet Test',
    working_days: '0,1,2,3,4,5,6',
    daily_capacity: '5',
    booking_horizon_days: '10',
  });
  return ctx;
}

test('intent detection: French and Arabic commands', () => {
  assert.equal(intents.detect('ANNULER').intent, 'cancel');
  assert.equal(intents.detect('annuler mon rendez-vous').intent, 'cancel');
  assert.equal(intents.detect('إلغاء').intent, 'cancel');
  assert.equal(intents.detect('الغاء الموعد').intent, 'cancel');
  assert.equal(intents.detect('mon rdv').intent, 'my_appointment');
  assert.equal(intents.detect('موعدي').intent, 'my_appointment');
  assert.equal(intents.detect('وقتاش موعدي').intent, 'my_appointment');
  assert.equal(intents.detect('bonjour').intent, 'help');
  assert.equal(intents.detect('السلام عليكم').intent, 'help');
  assert.equal(intents.detect('Mohamed Ben Ali').intent, 'name');
  assert.equal(intents.detect('أمين قادري').intent, 'name');
  assert.equal(intents.detect('12345').intent, 'unsupported');
  assert.equal(intents.detect('').intent, 'unsupported');
});

test('Arabic detection survives diacritics and letter variants', () => {
  assert.equal(intents.detect('إِلْغَاء').intent, 'cancel');
  assert.equal(intents.detect('إلغاء').isArabic, true);
  assert.equal(intents.detect('Annuler').isArabic, false);
});

test('a new patient books the first free day and gets a queue number', (t) => {
  const ctx = fresh();
  t.after(() => ctx.cleanup());

  const result = bot.handle({ phone: '213555111222', text: 'Mohamed Ben Ali' });
  assert.equal(result.action, 'booked');
  assert.equal(result.lang, 'fr');
  assert.match(result.reply, /Rendez-vous confirmé/);
  assert.match(result.reply, /Numéro de passage : 1/);
  assert.match(result.reply, /Cabinet Test/);

  const patient = patients.findByPhone('0555111222');
  assert.ok(patient, 'patient created and matched through the WhatsApp JID');
  assert.equal(patient.full_name, 'Mohamed Ben Ali');
  assert.equal(appointments.upcomingForPatient(patient.id).queue_number, 1);
});

test('sending the name twice returns the existing appointment', (t) => {
  const ctx = fresh();
  t.after(() => ctx.cleanup());

  bot.handle({ phone: '213555111223', text: 'Amina Kaddour' });
  const again = bot.handle({ phone: '213555111223', text: 'Amina Kaddour' });
  assert.equal(again.action, 'already_booked');
  assert.match(again.reply, /déjà un rendez-vous/);
});

test('MON RDV and ANNULER work in French', (t) => {
  const ctx = fresh();
  t.after(() => ctx.cleanup());

  bot.handle({ phone: '213555111224', text: 'Yacine Belkacem' });
  const info = bot.handle({ phone: '213555111224', text: 'mon rdv' });
  assert.equal(info.action, 'appointment_info');
  assert.match(info.reply, /Votre rendez-vous/);

  const cancelled = bot.handle({ phone: '213555111224', text: 'annuler' });
  assert.equal(cancelled.action, 'cancelled');

  const after = bot.handle({ phone: '213555111224', text: 'mon rdv' });
  assert.equal(after.action, 'no_appointment');
});

test('Arabic conversation: booking, reminder of appointment and cancellation', (t) => {
  const ctx = fresh();
  t.after(() => ctx.cleanup());

  const phone = '213666222333';
  const booked = bot.handle({ phone, text: 'أمين قادري' });
  assert.equal(booked.action, 'booked');
  assert.equal(booked.lang, 'ar');
  assert.match(booked.reply, /تم تأكيد الموعد/);

  const mine = bot.handle({ phone, text: 'موعدي' });
  assert.equal(mine.action, 'appointment_info');
  assert.match(mine.reply, /موعدكم/);

  const cancelled = bot.handle({ phone, text: 'إلغاء' });
  assert.equal(cancelled.action, 'cancelled');
  assert.match(cancelled.reply, /تم إلغاء موعدكم/);
});

test('help and unsupported messages never create a booking', (t) => {
  const ctx = fresh();
  t.after(() => ctx.cleanup());

  assert.equal(bot.handle({ phone: '213777000111', text: 'bonjour' }).action, 'help');
  assert.equal(bot.handle({ phone: '213777000112', text: '12345' }).action, 'unsupported');
  assert.equal(patients.list('').length, 0);
});

test('full planning adds the patient to the waiting list', (t) => {
  const ctx = fresh();
  t.after(() => ctx.cleanup());
  // One patient per day, tomorrow + the day after: the third caller waits.
  settings.setMany({ daily_capacity: '1', booking_horizon_days: '1' });

  assert.equal(bot.handle({ phone: '213555999111', text: 'First Patient' }).action, 'booked');
  assert.equal(bot.handle({ phone: '213555999112', text: 'Second Patient' }).action, 'booked');

  const third = bot.handle({ phone: '213555999113', text: 'Third Patient' });
  assert.equal(third.action, 'waiting_list');
  assert.equal(appointments.waitingList().length, 1);
  assert.equal(appointments.waitingList()[0].phone, '213555999113');
});

test('reminder template is localized and includes the day and queue', (t) => {
  const ctx = fresh();
  t.after(() => ctx.cleanup());
  const fr = bot.reminderText({ name: 'Nadia', day: '2026-11-02', queue: 3, lang: 'fr' });
  const ar = bot.reminderText({ name: 'نادية', day: '2026-11-02', queue: 3, lang: 'ar' });
  assert.match(fr, /Rappel/);
  assert.match(fr, /02\/11\/2026|2 novembre 2026/);
  assert.match(ar, /تذكير/);
});
