'use strict';
/**
 * Comprehensive verification of English (`en`) language support across MediRDV:
 * - Date & weekday utilities (`utils/dates.js`)
 * - Settings validation & schedule/break summaries (`services/settings.js`)
 * - Appointments, reports & chat clinic settings (`day_label.en`, `scheduleTextEn`, `breakTextEn`)
 * - WhatsApp message templates (41/41 parity + Darija isolation for `en`)
 * - WhatsApp bot end-to-end English booking, date selection, Law 18-07 intake & cancellation
 * - Prescription HTML `lang="en"` (`print.js`)
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { useTempDb } = require('./helpers');
const dates = require('../src/main/utils/dates');
const settings = require('../src/main/services/settings');
const appointments = require('../src/main/services/appointments');
const patients = require('../src/main/services/patients');
const reports = require('../src/main/services/reports');
const chat = require('../src/main/services/chat');
const intake = require('../src/main/services/intake');
const holidays = require('../src/main/services/holidays');
const print = require('../src/main/print');
const { message, templates } = require('../src/main/whatsapp/messages');
const intents = require('../src/main/whatsapp/intents');
const bot = require('../src/main/whatsapp/bot');

test('English dates, weekday labels, settings validation, schedule & break summaries work cleanly', () => {
  const ctx = useTempDb();
  try {
    // 2026-10-30 is a Friday
    assert.equal(dates.formatLong('2026-10-30', 'en'), 'Friday, 30 October 2026');
    assert.equal(dates.weekdayName('2026-10-30', 'en'), 'Friday');

    // Settings accept 'en' for both UI language and WhatsApp bot_language
    const updated = settings.setMany({
      language: 'en',
      bot_language: 'en',
      work_start_hour: '08:00',
      work_end_hour: '17:00',
      two_shifts_enabled: '1',
      shift2_start_hour: '21:00',
      shift2_end_hour: '00:00',
      break_enabled: '1',
      break_start_hour: '12:00',
      break_end_hour: '13:30',
    });
    assert.equal(updated.language, 'en');
    assert.equal(updated.bot_language, 'en');

    assert.equal(
      settings.formatScheduleSummary('en'),
      '08:00 – 17:00 · 2nd shift: 21:00 – 00:00 (midnight)',
    );
    assert.equal(settings.formatBreakSummary('en'), 'Doctor break: 12:00 – 13:30');

    settings.set('clinic_24h_enabled', '1');
    assert.equal(settings.formatScheduleSummary('en'), 'Open 24/7 non-stop');
    settings.set('clinic_24h_enabled', '0');

    const wd = settings.dayLabels('en');
    assert.equal(wd[0].label, 'Sun');
    assert.equal(wd[5].label, 'Fri');

    // Appointments & reports expose day_label.en
    const today = dates.toISODate();
    const listDay = appointments.dayStats(today);
    assert.equal(listDay.day_label.en, dates.formatLong(today, 'en'));

    const daily = reports.daily(today);
    assert.equal(daily.day_label.en, dates.formatLong(today, 'en'));

    // Chat clinicSettings exposes scheduleTextEn & breakTextEn
    const cs = chat.clinicSettings();
    assert.equal(cs.scheduleTextEn, '08:00 – 17:00 · 2nd shift: 21:00 – 00:00 (midnight)');
    assert.equal(cs.breakTextEn, 'Doctor break: 12:00 – 13:30');
    assert.equal(chat.detectLanguage('John Carter'), 'en');
    assert.equal(chat.detectLanguage('السلام عليكم'), 'ar');

    // Prescription HTML sets lang="en" dir="ltr" when rx.lang === 'en'
    const html = print.prescriptionHtml({
      prescription: {
        id: 42,
        day: '2026-10-30',
        lang: 'en',
        patient_name: 'John Carter',
        items: [{ drug_name: 'Paracetamol', dci: 'Paracetamol', dosage: '1 tab 3x/day', duration: '5 days' }],
      },
      clinic: { name: 'El-Chifa Medical Clinic' },
    });
    assert.match(html, /<html lang="en" dir="ltr">/);
  } finally {
    ctx.cleanup();
  }
});

test('WhatsApp messages.js has 100% template key parity (fr/ar/en) and keeps English isolated from Darija', () => {
  const frKeys = Object.keys(templates.fr).sort();
  const arKeys = Object.keys(templates.ar).sort();
  const enKeys = Object.keys(templates.en || {}).sort();
  assert.deepEqual(enKeys, frKeys, 'templates.en must match templates.fr keys exactly');
  assert.deepEqual(enKeys, arKeys, 'templates.en must match templates.ar keys exactly');
  assert.equal(enKeys.length, 41);

  const sampleSettings = {
    clinic: 'Algiers Care Clinic',
    doctor: 'Dr. Ahmed Benali',
    specialty: 'Cardiology',
    address: 'Hydra, Algiers',
    phone: '0550 12 34 56',
    currency: 'DZD',
    darija: true, // Even with Darija enabled, English must stay English!
    is24h: false,
    scheduleTextFr: '08:00 – 17:00',
    scheduleTextAr: 'من 08:00 إلى 17:00',
    scheduleTextEn: '08:00 – 17:00',
    breakTextFr: 'Pause médecin 12:00 – 13:00',
    breakTextAr: 'استراحة الطبيب 12:00 – 13:00',
    breakTextEn: 'Doctor break 12:00 – 13:00',
  };

  const helpOut = message('en', 'help', sampleSettings, {});
  assert.match(helpOut, /Hello and welcome to Algiers Care Clinic/);
  assert.match(helpOut, /Hours: 08:00 – 17:00 \(☕ Doctor break 12:00 – 13:00\)/);
  assert.match(helpOut, /AVAILABLE DAYS/);
  assert.doesNotMatch(helpOut, /مرحبا بيك|Merhba/i, 'English must not be replaced by Darija');

  const leaveOut = message('en', 'doctorOnLeave', sampleSettings, {
    holiday: { start_day: '2026-11-01', end_day: '2026-11-03' },
    resumeDay: '2026-11-04',
  });
  assert.match(leaveOut, /currently on leave from Sunday, 1 November 2026 to Tuesday, 3 November 2026/);
  assert.match(leaveOut, /resuming|will resume starting Wednesday, 4 November 2026/);
});

test('WhatsApp bot handles full end-to-end English booking, date selection, intake, check & cancellation', () => {
  const ctx = useTempDb();
  try {
    const phone = '213559112233';
    bot.forgetLanguage(phone);
    settings.setMany({
      clinic_name: 'Algiers International Clinic',
      bot_language: 'en',
      bot_choose_day_enabled: '1',
      working_days: '0,1,2,3,4,5,6',
      allow_same_day_booking: '1',
    });

    const baseNow = Date.now() + 5_000;

    // 1. English greeting -> English welcomeAskName prompt + hours
    const r1 = bot.handle({ phone, text: 'Good morning!', delivery: 'local', nowMs: baseNow });
    assert.equal(r1.action, 'help');
    assert.match(r1.reply, /Welcome to Algiers International Clinic/);
    assert.match(r1.reply, /Please enter your full name/);

    // 1b. English HELP command -> English menu + commands
    const rHelp = bot.handle({ phone, text: 'help', delivery: 'local', nowMs: baseNow + 5_000 });
    assert.equal(rHelp.action, 'help');
    assert.match(rHelp.reply, /Hello and welcome to Algiers International Clinic/);
    assert.match(rHelp.reply, /AVAILABLE DAYS/);

    // 2. Ask for AVAILABLE DAYS in English
    const r2 = bot.handle({ phone, text: 'available days', delivery: 'local', nowMs: baseNow + 10_000 });
    assert.equal(r2.action, 'available_days_preview');
    assert.match(r2.reply, /Next available dates at Algiers International Clinic/);
    assert.match(r2.reply, /slots available/);

    // 3. Send full name -> Choose day list in English
    const r3 = bot.handle({ phone, text: 'John Carter', delivery: 'local', nowMs: baseNow + 20_000 });
    assert.equal(r3.action, 'choose_day');
    assert.match(r3.reply, /Hello John Carter, please choose your preferred day and date/);

    // 4. Reply "tomorrow" in English -> Booked in English + Law 18-07 intake prompt
    const tomorrow = dates.addDays(dates.toISODate(), 1);
    assert.deepEqual(intents.parseDaySelection('tomorrow', dates.toISODate()), {
      type: 'date',
      day: tomorrow,
    });
    const r4 = bot.handle({ phone, text: 'tomorrow', delivery: 'local', nowMs: baseNow + 30_000 });
    assert.equal(r4.action, 'booked');
    assert.match(r4.reply, /✅ Appointment confirmed/);
    assert.match(r4.reply, /Patient: John Carter/);
    assert.match(r4.reply, /Queue number: 1/);
    assert.match(r4.reply, /Law 18-07/);

    // 5. Complete Law 18-07 intake in English (Age + Weight + optional symptoms ONLY)
    const r5 = bot.handle({ phone, text: 'YES', delivery: 'local', nowMs: baseNow + 40_000 });
    assert.match(r5.reply, /1️⃣ What is the patient's age\?/);

    const r6 = bot.handle({ phone, text: '34 years', delivery: 'local', nowMs: baseNow + 50_000 });
    assert.match(r6.reply, /2️⃣ What is your approximate weight in kg\?/);

    const r7 = bot.handle({ phone, text: '78.5 kg', delivery: 'local', nowMs: baseNow + 60_000 });
    assert.match(r7.reply, /3️⃣ Would you like to briefly mention any symptoms/);

    const r8 = bot.handle({ phone, text: 'mild headache', delivery: 'local', nowMs: baseNow + 70_000 });
    assert.equal(r8.action, 'intake_completed');
    assert.match(r8.reply, /Age: 34 yrs/);
    assert.match(r8.reply, /Weight: 78\.5 kg/);
    assert.match(r8.reply, /Symptoms: mild headache/);

    // Unverified intake stays isolated until doctor confirms
    const savedPatient = patients.findByPhone(phone);
    assert.ok(savedPatient);
    const pendingDraft = intake.forAppointment(r4.appointment.id);
    assert.ok(pendingDraft, 'intake draft stored separately awaiting doctor verification');
    assert.equal(pendingDraft.weight_kg, 78.5);
    assert.equal(pendingDraft.status, 'pending');

    // 6. Check "MY APPOINTMENT" in English
    const r9 = bot.handle({ phone, text: 'my appointment', delivery: 'local', nowMs: baseNow + 80_000 });
    assert.equal(r9.action, 'appointment_info');
    assert.match(r9.reply, /📅 Your appointment/);
    assert.match(r9.reply, /Queue number: 1/);

    // 7. Cancel in English ("CANCEL" -> English buttons -> "YES")
    const r10 = bot.handle({ phone, text: 'cancel', delivery: 'local', nowMs: baseNow + 90_000 });
    assert.equal(r10.action, 'cancel_confirm');
    assert.match(r10.reply, /Are you sure you want to cancel your appointment/);
    assert.equal(r10.buttons[0].text, '✅ Yes, cancel appointment');
    assert.equal(r10.buttons[1].text, '❌ No, keep appointment');

    const r11 = bot.handle({ phone, text: 'yes', delivery: 'local', nowMs: baseNow + 100_000 });
    assert.equal(r11.action, 'cancelled');
    assert.match(r11.reply, /has been cancelled/);

    // 8. Privacy-preserving doctor leave message in English
    const leaveStart = dates.addDays(dates.toISODate(), 2);
    const leaveEnd = dates.addDays(dates.toISODate(), 3);
    holidays.create({
      start_day: leaveStart,
      end_day: leaveEnd,
      reason_type: 'sick',
      label: 'Private medical checkup',
      block_all_wa: false,
    });
    const r12 = bot.handle({
      phone: '213559445566',
      text: 'Sarah Connor',
      delivery: 'local',
      nowMs: baseNow + 110_000,
    });
    // Today is on sick leave with block_all_wa: booking attempts get doctor_on_leave without leaking 'sick'
    holidays.create({
      start_day: dates.toISODate(),
      end_day: tomorrow,
      reason_type: 'sick',
      label: 'Flu',
      block_all_wa: true,
    });
    const r13 = bot.handle({
      phone: '213559778899',
      text: 'Emma Watson',
      delivery: 'local',
      nowMs: baseNow + 120_000,
    });
    assert.equal(r13.action, 'doctor_on_leave');
    assert.match(r13.reply, /on leave/);
    assert.doesNotMatch(r13.reply, /sick|flu/i, 'Internal sick reason must never leak on WhatsApp');
    assert.ok(r12);
  } finally {
    ctx.cleanup();
  }
});
