'use strict';
/**
 * WhatsApp transport (Baileys).
 *
 * Design goals, in order:
 *  1. never get the clinic number banned;
 *  2. never lose a booking.
 *
 * Therefore:
 *  - the bot only *answers* incoming private messages (no bulk, no groups);
 *  - messages older than 10 minutes are ignored (no replying to a backlog
 *    after a reconnection, which looks like spam);
 *  - every reply has a human-like typing delay and a random pause;
 *  - per-number and global rate limits are enforced;
 *  - credentials are persisted on disk, so the QR code is scanned only once.
 *
 * The Baileys package is ESM: it is imported lazily so the rest of the app
 * (dashboard, patients, reports) works even if the bot is never enabled.
 */

const fs = require('node:fs');
const path = require('node:path');
const QRCode = require('qrcode');
const settings = require('../services/settings');
const appointments = require('../services/appointments');
const patients = require('../services/patients');
const { getDb } = require('../db');
const { nowLocal } = require('../utils/common');
const { toISODate, addDays } = require('../utils/dates');
const bot = require('./bot');

const MAX_MESSAGE_AGE_SECONDS = 600;
const SEEN_LIMIT = 800;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const randomBetween = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

/** Convert any local number to a WhatsApp JID (Algeria by default). */
function toJid(phone) {
  let digits = String(phone ?? '').replace(/\D/g, '');
  if (!digits) return null;
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('0')) digits = `213${digits.slice(1)}`;
  if (digits.length === 9) digits = `213${digits}`; // 5XXXXXXXX → 2135XXXXXXXX
  if (digits.length < 10) return null;
  return `${digits}@s.whatsapp.net`;
}

function fromJid(jid) {
  return String(jid || '').split('@')[0];
}

function extractText(message) {
  if (!message) return '';
  // Unwrap the envelopes WhatsApp uses for ephemeral (disappearing) chats.
  const inner =
    message.ephemeralMessage?.message ||
    message.viewOnceMessage?.message ||
    message.viewOnceMessageV2?.message ||
    message.documentWithCaptionMessage?.message ||
    message;
  return (
    inner.conversation ||
    inner.extendedTextMessage?.text ||
    inner.buttonsResponseMessage?.selectedButtonId ||
    inner.listResponseMessage?.singleSelectReply?.selectedRowId ||
    inner.templateButtonReplyMessage?.selectedId ||
    ''
  ).trim();
}

class WhatsAppService {
  /**
   * @param {{authDir: string, onStatus?: (status: object) => void,
   *          onEvent?: (event: {type: string, payload: object}) => void,
   *          reminderPauseMs?: [number, number]}} options
   */
  constructor({ authDir, onStatus, onEvent, reminderPauseMs }) {
    this.authDir = authDir;
    // Pause between two reminder recipients. Randomized and long on purpose:
    // a message every 2 seconds is the classic signature of a bot.
    this.reminderPauseMs = reminderPauseMs || [15000, 35000];
    this.onStatus = onStatus || (() => {});
    this.onEvent = onEvent || (() => {});
    this.sock = null;
    this.state = 'stopped';
    this.qrDataUrl = null;
    this.phone = null;
    this.lastError = null;
    this.updatedAt = nowLocal();
    this.attempts = 0;
    this.reconnectTimer = null;
    this.starting = false;
    this.stopping = false;
    this.seen = new Set();
    this.seenOrder = [];
    this.sendChain = Promise.resolve();
    // QR generation is async: serialise updates so a late QR cannot overwrite
    // the "connected" state.
    this.updateChain = Promise.resolve();
    this.limits = new Map();
    this.globalDay = { day: toISODate(), count: 0 };
    this.remindersRunning = false;
    this.botEnabled = false;
  }

  publicStatus() {
    return {
      state: this.state,
      qr: this.qrDataUrl,
      phone: this.phone,
      last_error: this.lastError,
      updated_at: this.updatedAt,
      replies_today: this.globalDay.day === toISODate() ? this.globalDay.count : 0,
      connected: this.state === 'connected',
    };
  }

  setState(state, extra = {}) {
    this.state = state;
    this.updatedAt = nowLocal();
    if (extra.error !== undefined) this.lastError = extra.error;
    this.onStatus(this.publicStatus());
  }

  /** Load Baileys only when the dentist actually enables the bot. */
  async loadBaileys() {
    if (!this.baileys) {
      this.baileys = await import('@whiskeysockets/baileys');
    }
    return this.baileys;
  }

  async start() {
    if (this.starting || this.state === 'connected' || this.state === 'connecting') {
      return this.publicStatus();
    }
    this.starting = true;
    this.stopping = false;
    this.botEnabled = true;
    this.setState('connecting', { error: '' });
    try {
      await this.connect();
    } catch (error) {
      this.lastError = error.message;
      this.setState('error', { error: error.message });
      throw error;
    } finally {
      this.starting = false;
    }
    return this.publicStatus();
  }

  async connect() {
    if (this.stopping) return;
    const baileys = await this.loadBaileys();
    const { makeWASocket, useMultiFileAuthState, Browsers, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = baileys;

    fs.mkdirSync(this.authDir, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);

    let version;
    try {
      ({ version } = await fetchLatestBaileysVersion());
    } catch (error) {
      console.warn('[wa] cannot fetch latest version, using default:', error.message);
    }

    const logger = require('pino')({ level: 'error' });

    const sock = makeWASocket({
      version,
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
      logger,
      browser: Browsers.ubuntu('Chrome'),
      printQRInTerminal: false,
      // Staying "offline" and not syncing history keeps the session light and
      // less suspicious than a permanently-online linked device.
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 25000,
      // Needed when a patient replies to one of our messages.
      getMessage: async () => undefined,
      shouldIgnoreJid: (jid) => {
        // Statuses, newsletters and groups are always ignored.
        return (
          jid === 'status@broadcast' ||
          jid.endsWith('@broadcast') ||
          jid.endsWith('@newsletter') ||
          jid.endsWith('@g.us')
        );
      },
    });
    this.sock = sock;

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', (update) => {
      this.updateChain = this.updateChain
        .then(() => this.onConnectionUpdate(update))
        .catch((error) => console.error('[wa] connection update failed:', error.message));
    });
    sock.ev.on('messages.upsert', (event) => {
      this.onMessagesUpsert(event).catch((error) => {
        console.error('[wa] message handling failed:', error.message);
      });
    });
  }

  async onConnectionUpdate(update) {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      try {
        this.qrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
      } catch (error) {
        this.qrDataUrl = null;
        console.error('[wa] QR generation failed', error.message);
      }
      this.setState('qr', { error: '' });
    }

    if (connection === 'open') {
      this.attempts = 0;
      this.qrDataUrl = null;
      const id = this.sock?.user?.id || '';
      this.phone = fromJid(id);
      this.setState('connected', { error: '' });
      console.log('[wa] connected as', this.phone);
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = statusCode === 401;
      this.sock = null;
      this.qrDataUrl = null;

      if (this.stopping || !this.botEnabled) {
        this.setState('stopped');
        return;
      }
      if (loggedOut) {
        this.phone = null;
        this.setState('logged_out', { error: 'Session expirée, scannez le QR code à nouveau.' });
        settings.set('bot_enabled', '0');
        return;
      }
      this.attempts += 1;
      const delay = Math.min(60000, 3000 * this.attempts);
      this.setState('connecting', { error: lastDisconnect?.error?.message || 'Connexion perdue' });
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => {
        this.connect().catch((error) => {
          this.setState('error', { error: error.message });
        });
      }, delay);
    }
  }

  async onMessagesUpsert(event) {
    if (event.type !== 'notify' || !this.sock) return;
    for (const msg of event.messages || []) {
      await this.handleIncoming(msg);
    }
  }

  isDuplicate(id) {
    if (!id) return false;
    if (this.seen.has(id)) return true;
    this.seen.add(id);
    this.seenOrder.push(id);
    if (this.seenOrder.length > SEEN_LIMIT) {
      const oldest = this.seenOrder.shift();
      this.seen.delete(oldest);
    }
    return false;
  }

  async handleIncoming(msg) {
    const key = msg.key || {};
    const jid = key.remoteJid || '';
    const kind = msg.message ? Object.keys(msg.message)[0] : '';

    // Only private chats, never our own messages, groups, statuses or channels.
    if (!jid.endsWith('@s.whatsapp.net')) return;
    if (key.fromMe) return;
    // Receipts, reactions, deletions and edits are not patient questions and
    // must never trigger a reply (replying to a reaction looks like spam).
    if (['protocolMessage', 'reactionMessage', 'senderKeyDistributionMessage'].includes(kind)) return;
    if (this.isDuplicate(key.id)) return;

    const ageSeconds = Math.abs(Date.now() / 1000 - Number(msg.messageTimestamp || 0));
    if (msg.messageTimestamp && ageSeconds > MAX_MESSAGE_AGE_SECONDS) {
      console.log('[wa] skipping old message', key.id);
      return;
    }

    const text = extractText(msg.message);
    const phone = fromJid(jid);
    if (!phone) return;

    if (!text) {
      if (!this.canReply(phone)) return;
      const lang = settings.get('bot_language');
      const { message: tpl } = require('./messages');
      const answer = tpl(lang, 'unsupported', {
        clinic: settings.get('clinic_name'),
        phone: settings.get('clinic_phone'),
        currency: settings.get('currency'),
      });
      await this.reply(phone, jid, answer);
      return;
    }

    if (!this.canReply(phone)) {
      console.log('[wa] rate limit reached for', phone);
      return;
    }

    this.logMessage(phone, 'in', text);
    const result = bot.handle({ phone, text });
    if (!result || !result.reply) return;

    const sent = await this.reply(phone, jid, result.reply);
    if (sent) this.logMessage(phone, 'out', result.reply);
    this.onEvent({ type: 'message', payload: { phone, action: result.action } });
  }

  /** Sliding-window rate limit: per sender and globally. */
  canReply(phone) {
    const now = Date.now();
    const today = toISODate();
    if (this.globalDay.day !== today) this.globalDay = { day: today, count: 0 };
    if (this.globalDay.count >= settings.getInt('max_replies_per_day')) return false;

    const entry = this.limits.get(phone) || {
      hourStart: now,
      hourCount: 0,
      dayKey: today,
      dayCount: 0,
    };
    if (now - entry.hourStart > 60 * 60 * 1000) {
      entry.hourStart = now;
      entry.hourCount = 0;
    }
    if (entry.dayKey !== today) {
      entry.dayKey = today;
      entry.dayCount = 0;
    }
    if (entry.hourCount >= settings.getInt('max_replies_per_hour')) {
      this.limits.set(phone, entry);
      return false;
    }
    if (entry.dayCount >= settings.getInt('max_replies_per_day')) {
      this.limits.set(phone, entry);
      return false;
    }
    entry.hourCount += 1;
    entry.dayCount += 1;
    this.limits.set(phone, entry);
    this.globalDay.count += 1;
    return true;
  }

  /** Human-like delay, proportional to the reply length, clamped by settings. */
  typingDelay(text) {
    const min = settings.getInt('send_min_delay_ms');
    const max = Math.max(min + 500, settings.getInt('send_max_delay_ms'));
    const reading = Math.min(max, 1200 + String(text).length * 45);
    return randomBetween(Math.max(min, reading - 600), max);
  }

  /** Serialized sender: one message at a time, with jitter between messages. */
  reply(phone, jid, text) {
    if (!this.sock) {
      this.sendChain = this.sendChain.then(() => false);
      return this.sendChain;
    }
    const task = async () => {
      try {
        if (this.sock && this.state === 'connected') {
          await this.sock.sendPresenceUpdate('composing', jid).catch(() => {});
          await sleep(this.typingDelay(text));
          await this.sock.sendMessage(jid, { text });
          await sleep(randomBetween(800, 2200));
          await this.sock.sendPresenceUpdate('paused', jid).catch(() => {});
          return true;
        }
        return false;
      } catch (error) {
        console.error('[wa] send failed:', error.message);
        this.setState(this.state, { error: error.message });
        return false;
      }
    };
    this.sendChain = this.sendChain.then(task, task);
    return this.sendChain;
  }

  logMessage(phone, direction, body) {
    try {
      getDb()
        .prepare('INSERT INTO bot_messages (phone, direction, body, created_at) VALUES (?, ?, ?, ?)')
        .run(phone, direction, String(body).slice(0, 2000), nowLocal());
    } catch (error) {
      console.error('[wa] cannot log message', error.message);
    }
  }

  async stop({ logout = false } = {}) {
    this.stopping = true;
    this.botEnabled = false;
    clearTimeout(this.reconnectTimer);
    const sock = this.sock;
    this.sock = null;
    try {
      if (sock) {
        if (logout) await sock.logout();
        await sock.end(undefined);
      }
    } catch (error) {
      console.warn('[wa] stop error', error.message);
    }
    if (logout) {
      fs.rmSync(this.authDir, { recursive: true, force: true });
      this.phone = null;
      this.qrDataUrl = null;
      settings.set('bot_enabled', '0');
      this.setState('logged_out');
    } else {
      this.setState('stopped');
    }
    return this.publicStatus();
  }

  /**
   * Send the reminder to every patient booked tomorrow.
   * Runs at most once per appointment (logged in the `reminders` table).
   * @param {{now?: Date, force?: boolean}} [options]
   */
  async sendReminders(options = {}) {
    const now = options.now || new Date();
    if (this.remindersRunning) return { skipped: 'running' };
    if (this.state !== 'connected' || !this.sock) return { skipped: 'not_connected' };
    if (!settings.getBool('reminder_enabled') && !options.force) return { skipped: 'disabled' };

    const hour = settings.getInt('reminder_hour');
    if (!options.force && now.getHours() < hour) return { skipped: 'too_early' };

    const tomorrow = addDays(toISODate(now), 1);
    const due = getDb()
      .prepare(
        `SELECT a.id, a.day, a.queue_number, p.full_name, p.phone
         FROM appointments a
         JOIN patients p ON p.id = a.patient_id
         WHERE a.day = ? AND a.status = 'booked' AND p.phone IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM reminders r WHERE r.appointment_id = a.id)
         ORDER BY a.queue_number ASC
         LIMIT 60`,
      )
      .all(tomorrow);

    if (due.length === 0) return { sent: 0, day: tomorrow };

    this.remindersRunning = true;
    const mark = getDb().prepare(
      'INSERT INTO reminders (appointment_id, sent_at, status) VALUES (?, ?, ?)',
    );
    let sent = 0;
    let invalid = 0;

    try {
      for (const appointment of due) {
        if (this.state !== 'connected' || !this.sock) break;
        const jid = toJid(appointment.phone);
        if (!jid) {
          mark.run(appointment.id, nowLocal(), 'invalid_phone');
          invalid += 1;
          continue;
        }
        // Verify the number exists before writing (avoids silent failures).
        let exists = true;
        try {
          const [result] = await this.sock.onWhatsApp(jid);
          exists = Boolean(result?.exists);
        } catch (error) {
          console.warn('[wa] onWhatsApp failed', error.message);
        }
        if (!exists) {
          mark.run(appointment.id, nowLocal(), 'not_on_whatsapp');
          invalid += 1;
          continue;
        }

        const text = bot.reminderText({
          name: appointment.full_name,
          day: appointment.day,
          queue: appointment.queue_number,
          lang: settings.get('bot_language'),
        });
        const ok = await this.reply(fromJid(jid), jid, text);
        if (ok) {
          mark.run(appointment.id, nowLocal(), 'sent');
          this.logMessage(fromJid(jid), 'out', text);
          sent += 1;
        } else {
          break; // connection lost: leave the rest for the next run
        }
        // Long, random pause between patients: identical timing is a bot tell.
        await sleep(randomBetween(this.reminderPauseMs[0], this.reminderPauseMs[1]));
      }
    } finally {
      this.remindersRunning = false;
    }

    this.onEvent({ type: 'reminders', payload: { day: tomorrow, sent, invalid } });
    return { sent, invalid, day: tomorrow };
  }

  /** Preview of tomorrow's reminders (used by the settings screen). */
  reminderPreview(now = new Date()) {
    const tomorrow = addDays(toISODate(now), 1);
    return getDb()
      .prepare(
        `SELECT a.id, a.day, a.queue_number, p.full_name, p.phone,
          (SELECT status FROM reminders r WHERE r.appointment_id = a.id) AS reminder_status
         FROM appointments a
         JOIN patients p ON p.id = a.patient_id
         WHERE a.day = ? AND a.status = 'booked'
         ORDER BY a.queue_number ASC`,
      )
      .all(tomorrow);
  }
}

module.exports = { WhatsAppService, toJid, fromJid, extractText };
