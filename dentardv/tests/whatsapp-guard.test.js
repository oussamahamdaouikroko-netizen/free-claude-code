'use strict';
/**
 * Safety rules that protect the clinic number from being flagged as spam:
 * which messages we never answer, and which ones we must understand.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { useTempDb, safeRemove } = require('./helpers');
const { WhatsAppService, extractText } = require('../src/main/whatsapp/service');
const settings = require('../src/main/services/settings');

function service() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dentardv-guard-'));
  const instance = new WhatsAppService({ authDir: dir, reminderPauseMs: [1, 1] });
  instance.sock = {
    sent: [],
    async sendPresenceUpdate() {},
    async sendMessage(jid, payload) {
      this.sent.push({ jid, payload });
    },
    async end() {},
  };
  instance.state = 'connected';
  return { instance, dir };
}

test('ephemeral and view-once text messages are understood', () => {
  assert.equal(extractText({ ephemeralMessage: { message: { conversation: 'موعدي' } } }), 'موعدي');
  assert.equal(
    extractText({ viewOnceMessageV2: { message: { extendedTextMessage: { text: 'mon rdv' } } } }),
    'mon rdv',
  );
  assert.equal(
    extractText({ documentWithCaptionMessage: { message: { extendedTextMessage: { text: 'Ali' } } } }),
    'Ali',
  );
  assert.equal(extractText({ conversation: '  Ali  ' }), 'Ali');
});

test('reactions, deletes and protocol messages never trigger a reply', async (t) => {
  const ctx = useTempDb();
  const { instance, dir } = service();
  t.after(() => {
    ctx.cleanup();
    safeRemove(dir);
  });
  settings.setMany({
    clinic_name: 'Cabinet Test',
    working_days: '0,1,2,3,4,5,6',
    send_min_delay_ms: '1500',
    send_max_delay_ms: '1600',
  });

  const now = Math.floor(Date.now() / 1000);
  const jid = '213555111000@s.whatsapp.net';
  const base = { key: { remoteJid: jid, fromMe: false }, messageTimestamp: now };

  await instance.handleIncoming({ ...base, key: { ...base.key, id: 'R1' }, message: { reactionMessage: { text: '❤' } } });
  await instance.handleIncoming({ ...base, key: { ...base.key, id: 'P1' }, message: { protocolMessage: { type: 0 } } });
  await instance.handleIncoming({ ...base, key: { ...base.key, id: 'S1' }, message: { senderKeyDistributionMessage: {} } });

  assert.equal(instance.sock.sent.length, 0, 'no reply to non-conversational messages');

  // A real question still gets an answer.
  await instance.handleIncoming({ ...base, key: { ...base.key, id: 'T1' }, message: { conversation: 'Sofiane Test' } });
  assert.equal(instance.sock.sent.length, 1);
});

test('a stale backlog after reconnection stays unanswered', async (t) => {
  const ctx = useTempDb();
  const { instance, dir } = service();
  t.after(() => {
    ctx.cleanup();
    safeRemove(dir);
  });
  settings.setMany({ clinic_name: 'Cabinet Test', working_days: '0,1,2,3,4,5,6' });

  const old = Math.floor(Date.now() / 1000) - 24 * 3600;
  await instance.handleIncoming({
    key: { remoteJid: '213555222000@s.whatsapp.net', id: 'OLD', fromMe: false },
    message: { conversation: 'Mohamed Old' },
    messageTimestamp: old,
  });
  assert.equal(instance.sock.sent.length, 0);
});
