'use strict';
/**
 * MediRDV v2.1.0 verification suite:
 *  1. Bundled 5,381 Official Algerian Medications out-of-the-box + upgrade seeding.
 *  2. Streamlined WhatsApp pre-visit intake (Age + Weight + Optional Symptoms ONLY).
 *  3. Automatic WhatsApp queue-approaching alerts with remaining patients ahead.
 *  4. Automatic UI/queue removal on WhatsApp cancellation + queue advance behind cancelled slot.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { useTempDb } = require('./helpers');
const nomenclature = require('../src/main/services/nomenclature');
const prescriptions = require('../src/main/services/prescriptions');
const patients = require('../src/main/services/patients');
const appointments = require('../src/main/services/appointments');
const operations = require('../src/main/services/operations');
const settings = require('../src/main/services/settings');
const bot = require('../src/main/whatsapp/bot');
const { WhatsAppService } = require('../src/main/whatsapp/service');
const { createHandlers } = require('../src/main/handlers');
const { toISODate } = require('../src/main/utils/dates');

test('v2.1.0 — All 5,381 official Algerian medications are seeded out-of-the-box and searchable', (t) => {
  const ctx = useTempDb();
  t.after(() => ctx.cleanup());

  const summary = nomenclature.nomenclatureSummary();
  assert.ok(
    summary.total >= 5450,
    `expected >= 5,450 total medications (5,381 official + starter), got ${summary.total}`,
  );
  assert.equal(summary.imported, 5381, 'all 5,381 official Algerian Nomenclature entries seeded');

  // Verify real Algerian brands, laboratories, registration numbers & packaging from medications.csv
  const saidalHits = prescriptions.searchMedications({ query: 'SAIDAL', limit: 25 });
  assert.ok(saidalHits.length >= 10, 'Saidal medications searchable by laboratory');

  const biopamoxHits = prescriptions.searchMedications({ query: 'BIOPAMOX', limit: 20 });
  assert.ok(biopamoxHits.some((m) => m.laboratory.includes('BIOCARE')));
  assert.ok(biopamoxHits.some((m) => m.form.includes('B/12') || m.form.includes('FLC DE 60ML')));

  const stupHits = prescriptions.searchMedications({ query: 'MORPHINE', limit: 20 });
  assert.ok(stupHits.length >= 1, 'controlled Algerian hospital/retail specialties present');
});

test('v2.1.0 — WhatsApp queue-approaching alert & automatic removal + queue advance on WhatsApp cancel', async (t) => {
  const ctx = useTempDb();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'medirdv-v21-wa-'));
  t.after(() => {
    ctx.cleanup();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const today = toISODate();
  settings.setMany({
    clinic_name: 'عيادة الشفاء',
    working_days: '0,1,2,3,4,5,6',
    allow_same_day_booking: '1',
    daily_capacity: '20',
    avg_session_minutes: '15',
    queue_notify_enabled: '1',
    bot_language: 'ar',
  });

  // Create 4 booked patients on TODAY's queue (#1 .. #4)
  const p1 = patients.create({ full_name: 'أحمد بن علي', phone: '0551000001' });
  const p2 = patients.create({ full_name: 'كريم بوزيد', phone: '0551000002' });
  const p3 = patients.create({ full_name: 'سليمة منصوري', phone: '0551000003' });
  const p4 = patients.create({ full_name: 'ياسين خلوفي', phone: '0551000004' });

  const a1 = appointments.create({ patient_id: p1.id, day: today });
  const a2 = appointments.create({ patient_id: p2.id, day: today });
  const a3 = appointments.create({ patient_id: p3.id, day: today });
  const a4 = appointments.create({ patient_id: p4.id, day: today });

  assert.equal(a1.queue_number, 1);
  assert.equal(a2.queue_number, 2);
  assert.equal(a3.queue_number, 3);
  assert.equal(a4.queue_number, 4);

  // Set up WhatsAppService with fast delays + mock Baileys socket
  const events = [];
  const sentMessages = [];
  const wa = new WhatsAppService({
    dataDir: tmpDir,
    onEvent: (ev) => events.push(ev),
    onStatus: () => {},
  });
  wa.state = 'connected';
  wa.botEnabled = true;
  wa.queuePauseMs = [1, 2];
  wa.reply = async (phone, jid, text) => {
    sentMessages.push({ phone, jid, text });
    return true;
  };
  wa.sock = {
    onWhatsApp: async () => [{ exists: true }],
  };

  const handlers = createHandlers({ wa, emit: (ev) => events.push(ev) });

  // 1. Doctor completes #1 -> #2 gets turnNow, #3 gets queueAhead (1 ahead, "اقترب دوركم"), #4 gets queueAhead (2 ahead)
  const completeRes = handlers['appointments:complete']({ id: a1.id });
  assert.equal(completeRes.notifications.length, 3);
  assert.equal(completeRes.notifications[0].kind, 'turn_now');
  assert.equal(completeRes.notifications[1].kind, 'queue_ahead');
  assert.equal(completeRes.notifications[1].ahead_count, 1);
  assert.match(completeRes.notifications[1].body, /اقترب دوركم/);
  assert.match(completeRes.notifications[1].body, /مريض واحد \(1\)/);
  assert.equal(completeRes.notifications[2].ahead_count, 2);
  assert.match(completeRes.notifications[2].body, /مريضان \(2\)/);

  // Wait briefly for async notifyQueueAdvance
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(sentMessages.length, 3, 'all 3 waiting patients received WhatsApp turn/approaching alerts');

  // 2. Now patient #3 (سليمة منصوري) sends "إلغاء" on WhatsApp!
  sentMessages.length = 0;
  events.length = 0;

  await wa.handleIncoming({
    key: { id: 'MSG-CANCEL-P3', remoteJid: '213551000003@s.whatsapp.net', fromMe: false },
    messageTimestamp: Math.floor(Date.now() / 1000),
    message: { conversation: 'إلغاء' },
  });
  await new Promise((r) => setTimeout(r, 30));

  // Verify instant appointment_changed event fired BEFORE message completion
  const instantIdx = events.findIndex((e) => e.type === 'appointment_changed' && e.payload?.action === 'cancelled');
  const finalMsgIdx = events.findIndex((e) => e.type === 'message' && e.payload?.action === 'cancelled');
  assert.ok(instantIdx >= 0, 'instant appointment_changed event emitted');
  assert.ok(instantIdx < finalMsgIdx, 'UI refresh event fires immediately before reply completion');

  // Verify #3 is AUTOMATICALLY removed from Agenda, Dashboard today queue, AND Waiting Room TV board!
  const todayAgenda = handlers['appointments:agenda']({ day: today });
  assert.ok(!todayAgenda.some((r) => r.id === a3.id), 'cancelled patient automatically removed from Agenda');

  const dash = handlers['dashboard:today']();
  assert.ok(!dash.agenda.some((r) => r.id === a3.id), 'cancelled patient automatically removed from Dashboard');

  const board = operations.waitingRoomBoard(today);
  assert.ok(!board.some((r) => r.id === a3.id), 'cancelled patient automatically removed from Waiting Room board');

  // Verify patient #4 (who was behind #3, while #2 ahead of #3 was untouched!) automatically got updated queueAhead (now 1 ahead!)
  assert.equal(sentMessages.length, 2, '1 cancel reply to #3 + 1 queue-closer alert to #4 (without spamming #2)');
  assert.equal(sentMessages[0].phone, '213551000003');
  assert.match(sentMessages[0].text, /تم إلغاء موعدكم/);
  assert.equal(sentMessages[1].phone, '213551000004');
  assert.match(sentMessages[1].text, /اقترب دوركم/);
  assert.match(sentMessages[1].text, /مريض واحد \(1\)/);
});
