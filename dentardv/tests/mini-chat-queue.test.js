'use strict';
/**
 * Tests for v1.2 features:
 *  1. Mini Chat feed (booking confirmations, cancellations, queue turn alerts);
 *  2. Automatic removal from the active list on cancellation + live queue re-count;
 *  3. Secretary "treatment finished" action → calls next patient ("your turn")
 *     and warns distant patients with remaining count + estimated wait time.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { useTempDb, safeRemove } = require('./helpers');
const settings = require('../src/main/services/settings');
const patients = require('../src/main/services/patients');
const appointments = require('../src/main/services/appointments');
const chat = require('../src/main/services/chat');
const auth = require('../src/main/services/auth');
const bot = require('../src/main/whatsapp/bot');
const { WhatsAppService } = require('../src/main/whatsapp/service');
const { createHandlers } = require('../src/main/handlers');
const { toISODate, addDays } = require('../src/main/utils/dates');

function setupClinic() {
  const ctx = useTempDb();
  settings.setMany({
    clinic_name: 'عيادة النور لطب الأسنان',
    working_days: '0,1,2,3,4,5,6',
    daily_capacity: '10',
    allow_same_day_booking: '1',
    avg_session_minutes: '25',
    queue_notify_enabled: '1',
    language: 'ar',
    bot_language: 'ar',
  });
  return ctx;
}

test('WhatsApp booking & cancellation populate Mini Chat and auto-remove from active list', (t) => {
  const ctx = setupClinic();
  t.after(() => ctx.cleanup());

  const b1 = bot.handle({ phone: '213555100001', text: 'أحمد بن علي', delivery: 'local' });
  const b2 = bot.handle({ phone: '213555100002', text: 'سارة قادري', delivery: 'local' });
  const b3 = bot.handle({ phone: '213555100003', text: 'ياسين بلقاسم', delivery: 'local' });

  assert.equal(b1.action, 'booked');
  assert.equal(b2.action, 'booked');
  assert.equal(b3.action, 'booked');

  const day = b1.appointment.day;
  assert.equal(appointments.agenda(day).length, 3, 'all three patients are on the list');

  // Patient #2 cancels via WhatsApp → automatically removed from the list!
  const cancelled = bot.handle({ phone: '213555100002', text: 'إلغاء', delivery: 'local' });
  assert.equal(cancelled.action, 'cancelled');

  const afterCancel = appointments.agenda(day);
  assert.equal(afterCancel.length, 2, 'cancelled patient is automatically removed from the active list');
  assert.deepEqual(
    afterCancel.map((row) => row.full_name),
    ['أحمد بن علي', 'ياسين بلقاسم'],
  );
  // Patient #3 now only has 1 person ahead of him (instead of 2), ETA = 25 min.
  assert.equal(afterCancel[0].ahead_count, 0);
  assert.equal(afterCancel[1].ahead_count, 1);
  assert.equal(afterCancel[1].eta_minutes, 25);

  // Mini Chat holds the 3 confirmations + 1 cancellation.
  const allFeed = chat.feed({ kind: 'all' });
  assert.equal(allFeed.items.length, 4);
  assert.equal(chat.feed({ kind: 'booked' }).items.length, 3);
  assert.equal(chat.feed({ kind: 'cancelled' }).items.length, 1);
  assert.equal(chat.feed({ kind: 'cancelled' }).items[0].patient_name, 'سارة قادري');
});

test('a completed appointment cannot be cancelled later via WhatsApp', (t) => {
  const ctx = setupClinic();
  t.after(() => ctx.cleanup());

  const today = toISODate();
  const p = patients.create({ full_name: 'كريم بوزيان', phone: '0661777888' });
  const appt = appointments.create({ patient_id: p.id, day: today, price: 4000 });
  appointments.setStatus(appt.id, 'done');

  const attempt = bot.handle({ phone: '213661777888', text: 'إلغاء', delivery: 'local' });
  assert.equal(attempt.action, 'nothing_to_cancel');
  assert.equal(appointments.get(appt.id).status, 'done', 'completed visit stays done');
});

test('secretary confirms treatment finished → calls next patient and warns distant patients with count + ETA', (t) => {
  const ctx = setupClinic();
  t.after(() => ctx.cleanup());

  const today = toISODate();
  const p1 = patients.create({ full_name: 'محمد أمين', phone: '0555200001' });
  const p2 = patients.create({ full_name: 'أمينة خالدي', phone: '0555200002' });
  const p3 = patients.create({ full_name: 'نذير بوزيد', phone: '0555200003' });
  const p4 = patients.create({ full_name: 'فاطمة الزهراء', phone: '0555200004' });

  const a1 = appointments.create({ patient_id: p1.id, day: today });
  appointments.create({ patient_id: p2.id, day: today });
  appointments.create({ patient_id: p3.id, day: today });
  appointments.create({ patient_id: p4.id, day: today });

  // Secretary confirms p1 finished treatment (avg_session_minutes = 25).
  const res = appointments.completeAndAdvance(a1.id);
  assert.equal(res.appointment.status, 'done');
  assert.equal(res.next_patient.full_name, 'أمينة خالدي');
  assert.equal(res.waiting_count, 3);
  assert.equal(res.distant_count, 2);
  assert.equal(res.notifications.length, 3);

  // 1) Immediately next patient gets "حان دوركم الآن!"
  const nNext = res.notifications[0];
  assert.equal(nNext.kind, 'turn_now');
  assert.equal(nNext.ahead_count, 0);
  assert.equal(nNext.eta_minutes, 0);
  assert.match(nNext.body, /حان دوركم الآن/);
  assert.match(nNext.body, /أمينة خالدي/);

  // 2) First distant patient (#3) has 1 patient ahead, ETA = 25 min
  const nFar1 = res.notifications[1];
  assert.equal(nFar1.kind, 'queue_ahead');
  assert.equal(nFar1.ahead_count, 1);
  assert.equal(nFar1.eta_minutes, 25);
  assert.match(nFar1.body, /مريض واحد \(1\)/);
  assert.match(nFar1.body, /25 دقيقة/);

  // 3) Second distant patient (#4) has 2 patients ahead, ETA = 50 min
  const nFar2 = res.notifications[2];
  assert.equal(nFar2.kind, 'queue_ahead');
  assert.equal(nFar2.ahead_count, 2);
  assert.equal(nFar2.eta_minutes, 50);
  assert.match(nFar2.body, /مريضان \(2\)/);
  assert.match(nFar2.body, /50 دقيقة/);

  // All 3 notifications are visible in the Mini Chat under the 'queue' filter.
  const queueFeed = chat.feed({ kind: 'queue' });
  assert.equal(queueFeed.items.length, 3);
  assert.equal(queueFeed.unread, 3);

  chat.markAllRead();
  assert.equal(chat.feed({ kind: 'all' }).unread, 0);
});

test('WhatsApp service sends turn_now and queue_ahead messages sequentially when connected', async (t) => {
  const ctx = setupClinic();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dentardv-queue-wa-'));
  t.after(() => {
    ctx.cleanup();
    safeRemove(dir);
  });

  settings.setMany({
    language: 'fr',
    bot_language: 'fr',
    avg_session_minutes: '20',
    send_min_delay_ms: '1500',
    send_max_delay_ms: '1600',
  });

  const sent = [];
  const wa = new WhatsAppService({ authDir: dir, queuePauseMs: [5, 10] });
  wa.sock = {
    async onWhatsApp() {
      return [{ exists: true }];
    },
    async sendPresenceUpdate() {},
    async sendMessage(jid, payload) {
      sent.push({ jid, text: payload.text });
    },
    async end() {},
  };
  wa.state = 'connected';

  const today = toISODate();
  const p1 = patients.create({ full_name: 'Claire Martin', phone: '0555300001' });
  const p2 = patients.create({ full_name: 'Karim Saidi', phone: '0555300002' });
  const p3 = patients.create({ full_name: 'Nadia Cherif', phone: '0555300003' });
  const a1 = appointments.create({ patient_id: p1.id, day: today });
  appointments.create({ patient_id: p2.id, day: today });
  appointments.create({ patient_id: p3.id, day: today });

  const step = appointments.completeAndAdvance(a1.id, { waConnected: true });
  assert.equal(step.notifications[0].delivery, 'queued');

  const delivery = await wa.notifyQueueAdvance(step.notifications);
  assert.equal(delivery.sent, 2);
  assert.equal(sent.length, 2);
  assert.match(sent[0].text, /C'est votre tour/);
  assert.match(sent[1].text, /1 patient/);
  assert.match(sent[1].text, /20 min/);

  const items = chat.feed({ kind: 'queue' }).items;
  assert.ok(items.every((item) => item.delivery === 'sent'));
});

test('handlers expose appointments:complete and enforce DEMO_ONLY on chat:simulate', (t) => {
  const ctx = setupClinic();
  t.after(() => ctx.cleanup());

  auth.setup({ password: '1234', confirm: '1234' });
  auth.login('1234');

  const prodHandlers = createHandlers({ version: '1.2.0', dataDir: os.tmpdir(), wa: null, demo: false });
  assert.throws(
    () => prodHandlers['chat:simulate']({ mode: 'book_new' }),
    (err) => err.code === 'DEMO_ONLY',
  );

  const demoHandlers = createHandlers({ version: '1.2.0', dataDir: os.tmpdir(), wa: null, demo: true });
  const booked = demoHandlers['chat:simulate']({ mode: 'book_new' });
  assert.equal(booked.action, 'booked');

  const second = demoHandlers['chat:simulate']({ mode: 'book_new' });
  assert.equal(second.action, 'booked');

  const completed = demoHandlers['appointments:complete']({ id: booked.appointment.id });
  assert.equal(completed.appointment.status, 'done');

  // If the remaining appointment is today, cancel_next removes it automatically.
  if (second.appointment.day === toISODate()) {
    const cancelled = demoHandlers['chat:simulate']({ mode: 'cancel_next' });
    assert.equal(cancelled.action, 'cancelled');
    assert.equal(appointments.agenda(toISODate()).filter((r) => r.status === 'booked').length, 0);
  }

  // Completing an appointment on another day marks done without sending "come now" alerts.
  const tomorrow = addDays(toISODate(), 1);
  const futureP = patients.create({ full_name: 'مريض الغد', phone: '0555400001' });
  const futureAppt = prodHandlers['appointments:create']({ patient_id: futureP.id, day: tomorrow });
  const futureDone = prodHandlers['appointments:complete']({ id: futureAppt.id });
  assert.equal(futureDone.appointment.status, 'done');
  assert.equal(futureDone.notifications.length, 0);
});
