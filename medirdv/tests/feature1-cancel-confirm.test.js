'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const { useTempDb } = require('./helpers');

const dbMod = require('../src/main/db');
const { ensureIdempotentColumns } = require('../src/main/db/schema');
const bot = require('../src/main/whatsapp/bot');
const { WhatsAppService } = require('../src/main/whatsapp/service');
const patients = require('../src/main/services/patients');
const appointments = require('../src/main/services/appointments');
const settings = require('../src/main/services/settings');
const { createHandlers } = require('../src/main/handlers');

test('Feature 1 — Cancellation requires confirmation, handles Yes/No, double-click idempotency, stale IDs, ownership & staff cancel without penalty', async () => {
  const ctx = useTempDb();
  try {
    // Idempotent migration can run multiple times safely without error
    ensureIdempotentColumns(dbMod.getDb());
    ensureIdempotentColumns(dbMod.getDb());

    settings.setMany({
      bot_language: 'ar',
      working_days: '0,1,2,3,4,5,6',
      send_min_delay_ms: '0',
      send_max_delay_ms: '1',
    });

    const phoneA = '213556100001';
    const phoneB = '213556100002';

    const bookedA = bot.handle({ phone: phoneA, text: 'أسامة حمداوي', delivery: 'local' });
    assert.equal(bookedA.action, 'booked');
    const apptA = bookedA.appointment;
    const patientA = patients.findByPhone(phoneA);

    const bookedB = bot.handle({ phone: phoneB, text: 'كريم بن علي', delivery: 'local' });
    assert.equal(bookedB.action, 'booked');
    const apptB = bookedB.appointment;

    // 1. Pressing "إلغاء" -> confirmation prompt with date, queue/time, 30-min warning & callback buttons carrying apptA.id; NOTHING cancelled!
    const ask1 = bot.handle({ phone: phoneA, text: 'إلغاء', delivery: 'local' });
    assert.equal(ask1.action, 'cancel_confirm');
    assert.match(ask1.reply, /هل أنت متأكد من إلغاء موعدك/);
    assert.match(ask1.reply, /30 دقيقة/);
    assert.ok(Array.isArray(ask1.buttons) && ask1.buttons.length === 2);
    assert.equal(ask1.buttons[0].id, `cancel_yes:${apptA.id}`);
    assert.equal(ask1.buttons[1].id, `cancel_no:${apptA.id}`);
    assert.equal(appointments.get(apptA.id).status, 'booked', 'Appointment must NOT be cancelled yet');
    assert.equal(patients.get(patientA.id).blocked_until, null);

    // 2. Choosing "لا" ("❌ لا، احتفظ بالموعد") -> keeps appointment, no cooldown penalty
    const keepRes = bot.handle({ phone: phoneA, text: '❌ لا، احتفظ بالموعد', delivery: 'local' });
    assert.equal(keepRes.action, 'cancel_aborted');
    assert.match(keepRes.reply, /تم الاحتفاظ بموعدك/);
    assert.equal(appointments.get(apptA.id).status, 'booked');
    assert.equal(patients.get(patientA.id).blocked_until, null);

    // 3. Forged callback: Patient A tries to cancel Patient B's appointment via `cancel_yes:<apptB.id>` -> REJECTED!
    const forged = bot.handle({
      phone: phoneA,
      text: `cancel_yes:${apptB.id}`,
      callbackData: `cancel_yes:${apptB.id}`,
      delivery: 'local',
    });
    assert.equal(forged.action, 'forbidden');
    assert.equal(appointments.get(apptB.id).status, 'booked', 'Patient B appointment must stay intact');

    // 4. Stale / non-existent appointment ID -> polite message without error
    const nonExistent = bot.handle({
      phone: phoneA,
      text: 'cancel_yes:999999',
      callbackData: 'cancel_yes:999999',
      delivery: 'local',
    });
    assert.equal(nonExistent.action, 'stale_appointment');
    assert.match(nonExistent.reply, /هذا الموعد لم يعد قائماً/);

    // 5. Request cancel again -> choose "نعم" at exact UTC timestamp 2026-10-25T13:00:00.000Z (14:00 Algeria UTC+1)
    const baseMs = Date.parse('2026-10-25T13:00:00.000Z');
    const ask2 = bot.handle({ phone: phoneA, text: 'إلغاء', delivery: 'local', nowMs: baseMs });
    assert.equal(ask2.action, 'cancel_confirm');

    const confirmYes = bot.handle({
      phone: phoneA,
      text: '✅ نعم، ألغِ الموعد',
      delivery: 'local',
      nowMs: baseMs,
    });
    assert.equal(confirmYes.action, 'cancelled');
    assert.equal(confirmYes.callbackAnswered, true);
    assert.equal(appointments.get(apptA.id).status, 'cancelled');
    assert.equal(patients.get(patientA.id).blocked_until, '2026-10-25T13:30:00.000Z');
    // Algeria time is UTC+1 -> 13:30 UTC === 14:30 in Algiers!
    assert.match(confirmYes.reply, /14:30/);

    // 6. Double-click / second "نعم" (`cancel_yes:<apptA.id>`) 10 minutes later -> NOT executed again, blocked_until NOT shifted!
    const doubleClick = bot.handle({
      phone: phoneA,
      text: `cancel_yes:${apptA.id}`,
      callbackData: `cancel_yes:${apptA.id}`,
      delivery: 'local',
      nowMs: baseMs + 10 * 60 * 1000,
    });
    assert.equal(doubleClick.action, 'stale_appointment');
    assert.match(doubleClick.reply, /هذا الموعد لم يعد قائماً/);
    assert.equal(
      patients.get(patientA.id).blocked_until,
      '2026-10-25T13:30:00.000Z',
      'Double-click must NOT extend or re-apply penalty',
    );

    // 7. Secretary cancels Patient B's appointment via clinic UI handler -> NO cooldown penalty applied!
    const handlers = createHandlers({ version: '2.1.1', dataDir: os.tmpdir(), wa: null, demo: false });
    const secCancelled = handlers['appointments:cancel']({ id: apptB.id });
    assert.equal(secCancelled.status, 'cancelled');
    const patientB = patients.findByPhone(phoneB);
    assert.equal(patientB.blocked_until, null, 'Secretary cancellation must NEVER penalize the patient');

    // 8. Verify WhatsAppService acknowledges interactive button callback queries (`readMessages`)
    let ackedKeys = 0;
    const svc = new WhatsAppService({
      authDir: os.tmpdir(),
      onStatus: () => {},
      onEvent: () => {},
    });
    svc.state = 'connected';
    svc.typingDelay = () => 0;
    svc.sock = {
      user: { id: '213500000000:1@s.whatsapp.net' },
      readMessages: async (keys) => {
        ackedKeys += keys.length;
      },
      sendPresenceUpdate: async () => {},
      sendMessage: async () => {},
    };
    await svc.handleIncoming({
      key: { id: 'CB-BTN-1', remoteJid: `${phoneA}@s.whatsapp.net`, fromMe: false },
      messageTimestamp: Math.floor(Date.now() / 1000),
      message: {
        buttonsResponseMessage: {
          selectedButtonId: `cancel_yes:${apptA.id}`,
          selectedDisplayText: '✅ نعم، ألغِ الموعد',
        },
      },
    });
    await svc.sendChain;
    assert.equal(ackedKeys, 1, 'Button callback query was acknowledged immediately');
  } finally {
    ctx.cleanup();
  }
});
