'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dbMod = require('../src/main/db');
const { activateTestLicense } = require('./helpers');
const { CANCEL_COOLDOWN_MINUTES } = require('../src/main/config');
const bot = require('../src/main/whatsapp/bot');
const patients = require('../src/main/services/patients');
const departments = require('../src/main/services/departments');
const appointments = require('../src/main/services/appointments');
const prescriptions = require('../src/main/services/prescriptions');
const settings = require('../src/main/services/settings');

test('Feature 2 — 30-min post-cancel cooldown across all booking paths, survives restart, UTC+1 Algiers display, non-cumulative & preserves other features', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'medirdv-cd-'));
  const dbPath = path.join(dir, 'cooldown.sqlite');
  try {
    dbMod.open(dbPath);
    activateTestLicense(dir, {
      clock: () => Date.parse('2026-10-25T08:00:00.000Z'),
      dbActivityProvider: () => ({ utcExactMs: 0, localNaiveMs: 0 }),
    });
    settings.setMany({
      bot_language: 'ar',
      working_days: '0,1,2,3,4,5,6',
    });

    assert.equal(CANCEL_COOLDOWN_MINUTES, 30);

    // Create 2 departments to test multi-department step-1 cooldown + viewing an appointment in another department!
    const deptCardio = departments.create({
      name_fr: 'Cardiologie',
      name_ar: 'طب القلب',
      specialty: 'Cardiologie',
      consultation_fee: 2500,
      daily_capacity: 15,
    });
    const deptOphta = departments.create({
      name_fr: 'Ophtalmologie',
      name_ar: 'طب العيون',
      specialty: 'Ophtalmologie',
      consultation_fee: 2000,
      daily_capacity: 15,
    });

    const phoneBlocked = '213557000001';
    const phoneOther = '213557000002';

    // Base time: 2026-10-25T09:00:00.000Z === 10:00 in Algeria (UTC+1)
    const t0 = Date.parse('2026-10-25T09:00:00.000Z');

    // Book in Dept 1 (Cardio) AND Dept 2 (Ophta) so patient also has another active appointment to view while blocked
    const step1 = bot.handle({ phone: phoneBlocked, text: 'أسامة حمداوي', delivery: 'local', nowMs: t0 });
    assert.equal(step1.action, 'choose_department');
    const chooseDay1 = bot.handle({ phone: phoneBlocked, text: '1', delivery: 'local', nowMs: t0 });
    assert.equal(chooseDay1.action, 'choose_day');
    const booked1 = bot.handle({ phone: phoneBlocked, text: '1', delivery: 'local', nowMs: t0 });
    assert.equal(booked1.action, 'booked');
    const apptCardio = booked1.appointment;

    // Clear intake prompt and also book Ophta manually/via bot so patient has a second appointment
    bot.clearPending(phoneBlocked);
    const chooseDay2 = bot.handle({ phone: phoneBlocked, text: '2', delivery: 'local', nowMs: t0 });
    assert.equal(chooseDay2.action, 'choose_day');
    const booked2 = bot.handle({ phone: phoneBlocked, text: '1', delivery: 'local', nowMs: t0 });
    assert.equal(booked2.action, 'booked');
    const apptOphta = booked2.appointment;

    // Cancel apptCardio via explicit callback `cancel_ask:<id>` -> `cancel_yes:<id>` at t0 (09:00 UTC / 10:00 Algiers)
    const ask = bot.handle({
      phone: phoneBlocked,
      text: `cancel_ask:${apptCardio.id}`,
      callbackData: `cancel_ask:${apptCardio.id}`,
      delivery: 'local',
      nowMs: t0,
    });
    assert.equal(ask.action, 'cancel_confirm');

    const cancelled = bot.handle({
      phone: phoneBlocked,
      text: `cancel_yes:${apptCardio.id}`,
      callbackData: `cancel_yes:${apptCardio.id}`,
      delivery: 'local',
      nowMs: t0,
    });
    assert.equal(cancelled.action, 'cancelled');
    // Blocked until 09:30 UTC === 10:30 Algeria time (UTC+1)
    assert.equal(cancelled.blockedUntilUtc, '2026-10-25T09:30:00.000Z');
    assert.equal(cancelled.rebookTime, '10:30');

    // 1. Attempt booking 1 minute after cancel (t0 + 1 min) -> BLOCKED at step 1 with 29 minutes remaining & 10:30!
    const tPlus1 = t0 + 1 * 60 * 1000;
    const try1 = bot.handle({ phone: phoneBlocked, text: 'أسامة حمداوي', delivery: 'local', nowMs: tPlus1 });
    assert.equal(try1.action, 'cooldown_blocked', 'Blocked right at step 1 BEFORE chooseDepartment!');
    assert.equal(try1.remainingMinutes, 29);
    assert.match(try1.reply, /29 دقيقة/);
    assert.match(try1.reply, /10:30/);

    // 2. Attempt booking 29 minutes after cancel (t0 + 29 min) -> STILL BLOCKED (1 minute remaining)!
    const tPlus29 = t0 + 29 * 60 * 1000;
    const try29 = bot.handle({ phone: phoneBlocked, text: 'حجز موعد', delivery: 'local', nowMs: tPlus29 });
    assert.equal(try29.action, 'cooldown_blocked');
    assert.equal(try29.remainingMinutes, 1);
    assert.match(try29.reply, /1 دقيقة/);
    assert.match(try29.reply, /10:30/);

    // 3. Verify EVERY booking path is protected by `can_user_book` during cooldown:
    //  - Button `book_start`
    assert.equal(
      bot.handle({ phone: phoneBlocked, text: 'book_start', callbackData: 'book_start', delivery: 'local', nowMs: tPlus1 }).action,
      'cooldown_blocked',
    );
    //  - Button `dept_select:<id>`
    assert.equal(
      bot.handle({
        phone: phoneBlocked,
        text: `dept_select:${deptCardio.id}`,
        callbackData: `dept_select:${deptCardio.id}`,
        delivery: 'local',
        nowMs: tPlus1,
      }).action,
      'cooldown_blocked',
    );
    //  - Department number `"1"`
    assert.equal(
      bot.handle({ phone: phoneBlocked, text: '1', delivery: 'local', nowMs: tPlus1 }).action,
      'cooldown_blocked',
    );
    //  - Direct service call `appointments.create({ source: 'whatsapp' })`
    const pBlocked = patients.findByPhone(phoneBlocked);
    assert.throws(
      () => appointments.create({ patient_id: pBlocked.id, department_id: deptCardio.id, source: 'whatsapp', nowMs: tPlus1 }),
      (err) => err.code === 'BOOKING_COOLDOWN',
    );
    assert.equal(appointments.can_user_book(pBlocked.id, tPlus1).allowed, false);

    // 4. Bot / DB restart + `/start` cannot bypass cooldown!
    dbMod.close();
    dbMod.open(dbPath);
    const afterStart = bot.handle({ phone: phoneBlocked, text: '/start', delivery: 'local', nowMs: tPlus29 });
    assert.equal(afterStart.action, 'help');
    const stillBlocked = bot.handle({ phone: phoneBlocked, text: '1', delivery: 'local', nowMs: tPlus29 });
    assert.equal(stillBlocked.action, 'cooldown_blocked');

    // 5. Blocked patient CAN still search medications & view their other active appointment (`apptOphta`)!
    const meds = prescriptions.searchMedications({ query: 'doliprane', limit: 5 });
    assert.ok(meds.length > 0, 'Medication search works normally while patient is on booking cooldown');

    const myOtherAppt = bot.handle({ phone: phoneBlocked, text: 'موعدي', delivery: 'local', nowMs: tPlus1 });
    assert.equal(myOtherAppt.action, 'appointment_info');
    assert.equal(myOtherAppt.appointment.id, apptOphta.id);

    // 6. Another patient who did NOT cancel is completely unaffected!
    const otherStep1 = bot.handle({ phone: phoneOther, text: 'ياسين بلقاسم', delivery: 'local', nowMs: tPlus1 });
    assert.equal(otherStep1.action, 'choose_department');
    const otherChooseDay = bot.handle({ phone: phoneOther, text: '1', delivery: 'local', nowMs: tPlus1 });
    assert.equal(otherChooseDay.action, 'choose_day');
    const otherBooked = bot.handle({ phone: phoneOther, text: '1', delivery: 'local', nowMs: tPlus1 });
    assert.equal(otherBooked.action, 'booked');

    // 7. After 31 minutes (t0 + 31 min) -> ALLOWED! And cancelling a second time gives a fresh 30 min (NOT 60 min)!
    const tPlus31 = t0 + 31 * 60 * 1000;
    assert.equal(appointments.can_user_book(pBlocked.id, tPlus31).allowed, true);
    const rebookChooseDay = bot.handle({ phone: phoneBlocked, text: '1', delivery: 'local', nowMs: tPlus31 });
    assert.equal(rebookChooseDay.action, 'choose_day');
    const rebookOk = bot.handle({ phone: phoneBlocked, text: '1', delivery: 'local', nowMs: tPlus31 });
    assert.equal(rebookOk.action, 'booked');

    // Second cancellation at tPlus31 -> blocked_until = tPlus31 + 30 min (non-cumulative!)
    bot.clearPending(phoneBlocked);
    bot.handle({
      phone: phoneBlocked,
      text: `cancel_ask:${rebookOk.appointment.id}`,
      callbackData: `cancel_ask:${rebookOk.appointment.id}`,
      delivery: 'local',
      nowMs: tPlus31,
    });
    const secondCancel = bot.handle({
      phone: phoneBlocked,
      text: `cancel_yes:${rebookOk.appointment.id}`,
      callbackData: `cancel_yes:${rebookOk.appointment.id}`,
      delivery: 'local',
      nowMs: tPlus31,
    });
    assert.equal(secondCancel.action, 'cancelled');
    assert.equal(
      Date.parse(secondCancel.blockedUntilUtc) - tPlus31,
      30 * 60 * 1000,
      'Second cancellation after expiry starts a fresh 30-min cooldown without doubling',
    );
  } finally {
    dbMod.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
