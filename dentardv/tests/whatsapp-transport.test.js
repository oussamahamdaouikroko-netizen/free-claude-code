'use strict';
/**
 * Transport-level tests that do not need a phone:
 * JID conversion, message extraction, rate limiting and reminder scheduling.
 * The Baileys socket itself is replaced by a small fake.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { useTempDb, safeRemove } = require('./helpers');
const { WhatsAppService, toJid, fromJid, extractText } = require('../src/main/whatsapp/service');
const settings = require('../src/main/services/settings');
const patients = require('../src/main/services/patients');
const appointments = require('../src/main/services/appointments');
const db = require('../src/main/db');
const dates = require('../src/main/utils/dates');

function freshService(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dentardv-wa-'));
  // Test speed: no real 15–35 s pauses between reminder recipients.
  const service = new WhatsAppService({ authDir: dir, reminderPauseMs: [5, 10], ...overrides });
  return { service, dir };
}

test('phone numbers become WhatsApp JIDs and back', () => {
  assert.equal(toJid('0555123456'), '213555123456@s.whatsapp.net');
  assert.equal(toJid('+213 555 12 34 56'), '213555123456@s.whatsapp.net');
  assert.equal(toJid('00213555123456'), '213555123456@s.whatsapp.net');
  assert.equal(toJid('555123456'), '213555123456@s.whatsapp.net');
  assert.equal(toJid(''), null);
  assert.equal(toJid(null), null);
  assert.equal(fromJid('213555123456@s.whatsapp.net'), '213555123456');
});

test('text is extracted from every WhatsApp message shape', () => {
  assert.equal(extractText({ conversation: 'salut' }), 'salut');
  assert.equal(extractText({ extendedTextMessage: { text: 'موعدي' } }), 'موعدي');
  assert.equal(extractText({ imageMessage: {} }), '');
  assert.equal(extractText(undefined), '');
});

test('per-sender and global rate limits are enforced', (t) => {
  const ctx = useTempDb();
  const { service, dir } = freshService();
  t.after(() => {
    ctx.cleanup();
    safeRemove(dir);
  });

  settings.setMany({ max_replies_per_hour: '3', max_replies_per_day: '100' });
  assert.equal(service.canReply('0555000001'), true);
  assert.equal(service.canReply('0555000001'), true);
  assert.equal(service.canReply('0555000001'), true);
  assert.equal(service.canReply('0555000001'), false, 'fourth reply within the hour is blocked');
  assert.equal(service.canReply('0555000002'), true, 'other senders keep their own budget');

  settings.setMany({ max_replies_per_hour: '50', max_replies_per_day: '4' });
  service.globalDay = { day: dates.toISODate(), count: 4 };
  assert.equal(service.canReply('0555000009'), false, 'daily cap blocks everything');
});

test('human-like delays stay inside the configured window', (t) => {
  const ctx = useTempDb();
  const { service, dir } = freshService();
  t.after(() => {
    ctx.cleanup();
    safeRemove(dir);
  });

  settings.setMany({ send_min_delay_ms: '3000', send_max_delay_ms: '8000' });
  for (const length of [1, 50, 400]) {
    const delay = service.typingDelay('x'.repeat(length));
    assert.ok(delay >= 3000 && delay <= 8000, `delay ${delay} out of range`);
  }

  // The minimum always wins over the reading estimate.
  settings.setMany({ send_min_delay_ms: '15000', send_max_delay_ms: '16000' });
  assert.ok(service.typingDelay('short') >= 15000);
});

test('duplicate message ids are ignored', (t) => {
  const ctx = useTempDb();
  const { service, dir } = freshService();
  t.after(() => {
    ctx.cleanup();
    safeRemove(dir);
  });

  assert.equal(service.isDuplicate('ABC123'), false);
  assert.equal(service.isDuplicate('ABC123'), true);
  assert.equal(service.isDuplicate(undefined), false);
});

test('incoming messages are answered with a human delay and logged', async (t) => {
  const ctx = useTempDb();
  const sent = [];
  const { service, dir } = freshService();
  t.after(() => {
    ctx.cleanup();
    safeRemove(dir);
  });

  settings.setMany({
    clinic_name: 'Cabinet Test',
    working_days: '0,1,2,3,4,5,6',
    daily_capacity: '5',
    send_min_delay_ms: '1500',
    send_max_delay_ms: '2000',
    max_replies_per_hour: '10',
  });

  service.sock = {
    async sendPresenceUpdate() {},
    async sendMessage(jid, payload) {
      sent.push({ jid, payload });
    },
    async end() {},
  };
  service.state = 'connected';

  await service.handleIncoming({
    key: { remoteJid: '213555123456@s.whatsapp.net', id: 'MSG1', fromMe: false },
    message: { conversation: 'Mohamed Test' },
    messageTimestamp: Math.floor(Date.now() / 1000),
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].jid, '213555123456@s.whatsapp.net');
  assert.match(sent[0].payload.text, /Rendez-vous confirmé/);

  const log = db.getDb().prepare('SELECT * FROM bot_messages ORDER BY id').all();
  assert.equal(log.length, 2, 'incoming and outgoing messages are stored');
  assert.equal(log[0].direction, 'in');
  assert.equal(log[1].direction, 'out');

  // The patient now exists with a normalized phone and an appointment.
  const patient = patients.findByPhone('213555123456');
  assert.ok(patient);
  assert.ok(appointments.upcomingForPatient(patient.id));
});

test('groups, own messages and stale messages are never answered', async (t) => {
  const ctx = useTempDb();
  const sent = [];
  const { service, dir } = freshService();
  t.after(() => {
    ctx.cleanup();
    safeRemove(dir);
  });

  service.sock = {
    async sendPresenceUpdate() {},
    async sendMessage(jid, payload) {
      sent.push(payload);
    },
    async end() {},
  };
  service.state = 'connected';

  const base = { message: { conversation: 'Ali' } };
  await service.handleIncoming({ ...base, key: { remoteJid: '123-456@g.us', id: 'G1' } });
  await service.handleIncoming({ ...base, key: { remoteJid: '213555@s.whatsapp.net', id: 'O1', fromMe: true } });
  await service.handleIncoming({
    ...base,
    key: { remoteJid: '213555111222@s.whatsapp.net', id: 'OLD1' },
    messageTimestamp: Math.floor(Date.now() / 1000) - 3600,
  });

  assert.equal(sent.length, 0);
});

/** Speed up replies: no 4-9 s typing delay during tests. */
function fastSettings() {
  settings.setMany({
    clinic_name: 'Cabinet Test',
    working_days: '0,1,2,3,4,5,6',
    daily_capacity: '5',
    send_min_delay_ms: '1500',
    send_max_delay_ms: '1600',
    max_replies_per_hour: '50',
    max_replies_per_day: '500',
  });
}

test('a message addressed by LID (no phone number) is still answered', async (t) => {
  // WhatsApp now hides the number behind a LID: remoteJid = "<id>@lid" and the
  // phone arrives in remoteJidAlt. Dropping those messages made the bot silent
  // even though it was linked.
  const ctx = useTempDb();
  const sent = [];
  const { service, dir } = freshService();
  t.after(() => {
    ctx.cleanup();
    safeRemove(dir);
  });

  fastSettings();
  service.sock = {
    async sendPresenceUpdate() {},
    async sendMessage(jid, payload) {
      sent.push({ jid, payload });
    },
    async end() {},
  };
  service.state = 'connected';

  await service.handleIncoming({
    key: {
      remoteJid: '271234567890123@lid',
      remoteJidAlt: '213555100999@s.whatsapp.net',
      id: 'LID1',
      fromMe: false,
    },
    message: { conversation: 'Yacine Test' },
    messageTimestamp: Math.floor(Date.now() / 1000),
  });

  assert.equal(sent.length, 1, 'the LID message is answered');
  assert.equal(sent[0].jid, '213555100999@s.whatsapp.net', 'reply goes to the phone JID');
  assert.match(sent[0].payload.text, /Rendez-vous confirmé/);

  const patient = patients.findByPhone('213555100999');
  assert.ok(patient, 'the patient is registered with the phone number, not the LID');
  assert.ok(appointments.upcomingForPatient(patient.id), 'the appointment is booked');
  assert.equal(service.stats.received, 1);
  assert.equal(service.stats.replied, 1);
});

test('a LID-only message is mapped back to the phone number', async (t) => {
  const ctx = useTempDb();
  const sent = [];
  const { service, dir } = freshService();
  t.after(() => {
    ctx.cleanup();
    safeRemove(dir);
  });

  fastSettings();
  let asked = null;
  service.sock = {
    signalRepository: {
      lidMapping: {
        async getPNForLID(jid) {
          asked = jid;
          return '213555100777@s.whatsapp.net';
        },
      },
    },
    async sendPresenceUpdate() {},
    async sendMessage(jid, payload) {
      sent.push({ jid, payload });
    },
    async end() {},
  };
  service.state = 'connected';

  await service.handleIncoming({
    key: { remoteJid: '999888777@lid', id: 'LID2', fromMe: false },
    message: { conversation: 'Nadia LID' },
    messageTimestamp: Math.floor(Date.now() / 1000),
  });

  assert.equal(asked, '999888777@lid', 'the LID mapping store is asked for the number');
  assert.equal(sent.length, 1);
  assert.ok(patients.findByPhone('213555100777'), 'stored under the real number');
});

test('messages replayed after a reconnection (upsert type "append") are handled', async (t) => {
  // The laptop sleeps, the socket reconnects and Baileys replays recent
  // messages as `append` instead of `notify`. Those are recent real messages
  // and must be answered; only the age filter may drop a backlog.
  const ctx = useTempDb();
  const sent = [];
  const { service, dir } = freshService();
  t.after(() => {
    ctx.cleanup();
    safeRemove(dir);
  });

  fastSettings();
  service.sock = {
    async sendPresenceUpdate() {},
    async sendMessage(jid, payload) {
      sent.push({ jid, payload });
    },
    async end() {},
  };
  service.state = 'connected';

  await service.onMessagesUpsert({
    type: 'append',
    messages: [
      {
        key: { remoteJid: '213555100555@s.whatsapp.net', id: 'APP1', fromMe: false },
        message: { conversation: 'Samir Append' },
        messageTimestamp: Math.floor(Date.now() / 1000) - 30,
      },
    ],
  });

  assert.equal(sent.length, 1, 'a recent appended message is answered');
  assert.ok(patients.findByPhone('213555100555'));

  // A stale backlog is still ignored, so a reconnection cannot spam patients.
  await service.onMessagesUpsert({
    type: 'append',
    messages: [
      {
        key: { remoteJid: '213555100666@s.whatsapp.net', id: 'APP2', fromMe: false },
        message: { conversation: 'Old Append' },
        messageTimestamp: Math.floor(Date.now() / 1000) - 7200,
      },
    ],
  });
  assert.equal(sent.length, 1, 'a two-hour-old message is dropped');
  assert.equal(service.stats.skipped, 1);
  assert.equal(service.stats.last_skip?.reason || service.stats.lastSkip.reason, 'too_old');
});

test('every ignored message records a reason for the dentist', async (t) => {
  const ctx = useTempDb();
  const { service, dir } = freshService();
  t.after(() => {
    ctx.cleanup();
    safeRemove(dir);
  });

  fastSettings();
  service.sock = { async sendMessage() {}, async sendPresenceUpdate() {}, async end() {} };
  service.state = 'connected';

  await service.handleIncoming({
    key: { remoteJid: '120363000000000000@g.us', id: 'GRP1', fromMe: false },
    message: { conversation: 'hello' },
    messageTimestamp: Math.floor(Date.now() / 1000),
  });

  const status = service.publicStatus();
  assert.equal(status.messages.skipped, 1);
  assert.equal(status.messages.last_skip.reason, 'not_a_private_chat');
  assert.equal(status.messages.received, 0);
});

test('reminders are sent once, only for tomorrow, with a long pause', async (t) => {
  const ctx = useTempDb();
  const sent = [];
  const { service, dir } = freshService();
  t.after(() => {
    ctx.cleanup();
    safeRemove(dir);
  });

  settings.setMany({
    clinic_name: 'Cabinet Test',
    reminder_enabled: '1',
    reminder_hour: '0',
    working_days: '0,1,2,3,4,5,6',
    daily_capacity: '10',
    send_min_delay_ms: '1500',
    send_max_delay_ms: '1600',
  });

  const tomorrow = dates.addDays(dates.toISODate(), 1);
  const p1 = patients.create({ full_name: 'Reminder One', phone: '0555111222' });
  const p2 = patients.create({ full_name: 'Reminder Two', phone: '0555333444' });
  appointments.create({ patient_id: p1.id, day: tomorrow });
  appointments.create({ patient_id: p2.id, day: tomorrow });

  service.sock = {
    async sendPresenceUpdate() {},
    async sendMessage(jid, payload) {
      sent.push({ jid, payload });
    },
    async onWhatsApp(jid) {
      return [{ jid, exists: true }];
    },
    async end() {},
  };
  service.state = 'connected';

  const first = await service.sendReminders({ force: false });
  assert.equal(first.sent, 2);
  assert.equal(sent.length, 2);
  assert.match(sent[0].payload.text, /Rappel de votre rendez-vous/);
  assert.match(sent[0].payload.text, /Reminder One/);

  const second = await service.sendReminders({ force: true });
  assert.equal(second.sent, 0, 'a reminder is never sent twice');
  assert.equal(sent.length, 2);

  const rows = db.getDb().prepare('SELECT * FROM reminders').all();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].status, 'sent');
});

test('numbers that are not on WhatsApp are marked, not retried forever', async (t) => {
  const ctx = useTempDb();
  const { service, dir } = freshService();
  t.after(() => {
    ctx.cleanup();
    safeRemove(dir);
  });

  settings.setMany({
    reminder_enabled: '1',
    reminder_hour: '0',
    working_days: '0,1,2,3,4,5,6',
    send_min_delay_ms: '1500',
    send_max_delay_ms: '1600',
  });
  const tomorrow = dates.addDays(dates.toISODate(), 1);
  const p = patients.create({ full_name: 'No WhatsApp', phone: '0555999888' });
  appointments.create({ patient_id: p.id, day: tomorrow });

  service.sock = {
    async sendPresenceUpdate() {},
    async sendMessage() {
      throw new Error('should not send');
    },
    async onWhatsApp() {
      return [{ exists: false }];
    },
    async end() {},
  };
  service.state = 'connected';

  const result = await service.sendReminders({ force: false });
  assert.equal(result.sent, 0);
  assert.equal(result.invalid, 1);
  const row = db.getDb().prepare('SELECT * FROM reminders').get();
  assert.equal(row.status, 'not_on_whatsapp');
});

test('reminders are skipped when the bot is not connected', async (t) => {
  const ctx = useTempDb();
  const { service, dir } = freshService();
  t.after(() => {
    ctx.cleanup();
    safeRemove(dir);
  });
  const result = await service.sendReminders({ force: true });
  assert.deepEqual(result, { skipped: 'not_connected' });
});
