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
const chatService = require('../services/chat');
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

/**
 * WhatsApp addresses a chat with either a phone number (`@s.whatsapp.net`) or,
 * since the 2025 rollout, a LID (Linked ID, `@lid`) that hides the number.
 * Baileys 7 fills `key.remoteJidAlt` with the other side of the pair, and
 * `signalRepository.lidMapping` can translate when only the LID is known.
 *
 * Ignoring `@lid` used to make the bot completely silent: linked, but every
 * message dropped. Both suffixes must be accepted.
 */
const isPnJid = (jid) => jid.endsWith('@s.whatsapp.net') || jid.endsWith('@hosted');
const isLidJid = (jid) => jid.endsWith('@lid') || jid.endsWith('@hosted.lid');
const isUserJid = (jid) => Boolean(jid) && (isPnJid(jid) || isLidJid(jid));

/** Resolve a promise, but never wait more than `ms` for it. */
function withTimeout(promise, ms, fallback = null) {
  return Promise.race([
    Promise.resolve(promise).catch(() => fallback),
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
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
   *          reminderPauseMs?: [number, number],
   *          queuePauseMs?: [number, number]}} options
   */
  constructor({ authDir, onStatus, onEvent, reminderPauseMs, queuePauseMs }) {
    this.authDir = authDir;
    // Pause between two reminder recipients. Randomized and long on purpose:
    // a message every 2 seconds is the classic signature of a bot.
    this.reminderPauseMs = reminderPauseMs || [15000, 35000];
    this.queuePauseMs = queuePauseMs || [4500, 9500];
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
    // Diagnostics: the dentist must be able to see whether messages arrive at
    // all. Silent drops are what made "connected but no reply" impossible to
    // understand in the field.
    this.stats = {
      received: 0,
      replied: 0,
      skipped: 0,
      lastAt: null,
      lastFrom: null,
      lastSkip: null,
    };
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
      messages: {
        received: this.stats.received,
        replied: this.stats.replied,
        skipped: this.stats.skipped,
        last_at: this.stats.lastAt,
        last_from: this.stats.lastFrom,
        last_skip: this.stats.lastSkip,
      },
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
    if (!this.sock) return;
    // `notify` = live message, `append` = message that was queued while the
    // phone was offline/asleep. Accepting both is essential: the laptop of a
    // clinic sleeps, and Baileys then replays recent messages as `append`.
    // The 10-minute age filter below still discards a real backlog.
    if (event.type !== 'notify' && event.type !== 'append') return;
    for (const msg of event.messages || []) {
      await this.handleIncoming(msg);
    }
  }

  /**
   * Work out who wrote and where to answer.
   * @returns {Promise<{replyJid:string, phone:string, lid:string|null, viaLid:boolean}|null>}
   */
  async resolveChat(key) {
    const direct = String(key.remoteJid || '');
    const alt = String(key.remoteJidAlt || '');
    const pnJid = [direct, alt].find(isPnJid) || null;
    const lidJid = [direct, alt].find(isLidJid) || null;
    if (!isUserJid(direct) && !isUserJid(alt)) return null;

    let phone = pnJid ? fromJid(pnJid) : null;
    if (!phone && lidJid) {
      const mapped = await withTimeout(
        this.sock?.signalRepository?.lidMapping?.getPNForLID?.(lidJid),
        4000,
        null,
      );
      if (mapped) phone = fromJid(mapped);
    }
    // Last resort: keep the LID digits so the booking is not lost. Reminders
    // verify the number with onWhatsApp() before writing to anyone.
    if (!phone) phone = fromJid(lidJid || direct);

    return {
      // Prefer the phone JID for sending: it is the one every client accepts.
      replyJid: pnJid || direct || lidJid,
      phone,
      lid: lidJid,
      viaLid: !pnJid,
    };
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

  /** Record why a message produced no answer (visible in the log + UI). */
  skip(reason, details = {}) {
    this.stats.skipped += 1;
    this.stats.lastSkip = { reason, at: nowLocal(), ...details };
    const extra = Object.keys(details).length ? ` ${JSON.stringify(details)}` : '';
    console.log(`[wa] skipped (${reason})${extra}`);
    this.onStatus(this.publicStatus());
  }

  async handleIncoming(msg) {
    const key = msg.key || {};
    const jid = key.remoteJid || '';
    const alt = key.remoteJidAlt || '';
    const kind = msg.message ? Object.keys(msg.message)[0] : '';
    const tag = { jid, alt, kind, id: key.id };

    if (key.fromMe) return this.skip('own_message', tag);
    // Receipts, reactions, deletions and edits are not patient questions and
    // must never trigger a reply (replying to a reaction looks like spam).
    if (
      !kind ||
      ['protocolMessage', 'reactionMessage', 'senderKeyDistributionMessage'].includes(kind)
    ) {
      return this.skip('not_a_question', tag);
    }
    // Only private chats, never groups, statuses or channels. `@lid`
    // (WhatsApp's number-hiding IDs) is a private chat too and must be
    // accepted, otherwise every message from a LID-addressed patient is lost.
    const chat = await this.resolveChat(key);
    if (!chat) return this.skip('not_a_private_chat', tag);
    if (this.isDuplicate(key.id)) return this.skip('duplicate', tag);

    const ageSeconds = Math.abs(Date.now() / 1000 - Number(msg.messageTimestamp || 0));
    if (msg.messageTimestamp && ageSeconds > MAX_MESSAGE_AGE_SECONDS) {
      // No backlog flood after a reconnection: that looks exactly like a bot.
      return this.skip('too_old', { ...tag, age_seconds: Math.round(ageSeconds) });
    }

    const { phone, replyJid, lid, viaLid } = chat;
    if (!phone) return this.skip('no_phone', tag);

    const text = extractText(msg.message);
    this.stats.received += 1;
    this.stats.lastAt = nowLocal();
    this.stats.lastFrom = phone;
    console.log(`[wa] incoming message received (${kind || 'text'})`);

    // Store every incoming message, even when it is not answered: this is the
    // only proof for the dentist that the bot received something.
    this.logMessage(phone, 'in', text || `[${kind || 'media'}]`);

    if (!this.canReply(phone)) return this.skip('rate_limit', tag);

    const result = !text
      ? bot.handle({ phone, text: '', isMedia: true, delivery: 'queued' })
      : bot.handle({ phone, text, delivery: 'queued' });
    if (!result || !result.reply) return this.skip('no_reply', tag);

    // Broadcast database state changes IMMEDIATELY (before anti-ban typing delay)
    // so cancelled/booked appointments & intake updates reflect in the UI instantly
    // without any manual refresh by clinic staff.
    if (
      [
        'booked',
        'cancelled',
        'confirmed',
        'intake_completed',
        'intake_ask_weight',
        'intake_ask_complaint',
      ].includes(result.action)
    ) {
      this.onEvent({
        type: 'appointment_changed',
        payload: {
          phone,
          action: result.action,
          appointment: result.appointment || null,
        },
      });
    }

    const sent = await this.reply(phone, replyJid, result.reply);
    if (sent) {
      this.stats.replied += 1;
      this.logMessage(phone, 'out', result.reply);
      if (result.chatEvent?.id) chatService.setDelivery(result.chatEvent.id, 'sent');
    } else if (result.chatEvent?.id) {
      chatService.setDelivery(result.chatEvent.id, 'failed');
    }
    this.onEvent({
      type: 'message',
      payload: {
        phone,
        action: result.action,
        appointment: result.appointment || null,
        chat_event_id: result.chatEvent?.id || null,
      },
    });

    // If a patient cancelled today's appointment via WhatsApp, automatically
    // notify booked patients waiting behind them that their turn is closer.
    if (result.action === 'cancelled' && result.appointment) {
      const queueUpdates = appointments.advanceNotificationsAfterRemoval(result.appointment, {
        waConnected: this.state === 'connected',
        resolveLanguage: (ph, fullName) => bot.preferredLanguage(ph, fullName),
      });
      if (queueUpdates.length > 0) {
        this.notifyQueueAdvance(queueUpdates).catch((error) => {
          console.error('[wa] post-cancel queue advance failed:', error.message);
        });
      }
    }

    // Live counters in Réglages → WhatsApp: the dentist sees, message by
    // message, that the bot is receiving and answering.
    this.onStatus(this.publicStatus());
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
        // `sock.user` is set once the session is authenticated, which is more
        // reliable than our own state string right after a reconnection (the
        // moment when WhatsApp replays the messages we just accepted).
        const ready = this.sock && (this.state === 'connected' || Boolean(this.sock.user));
        if (ready) {
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

  /**
   * Deliver live queue notifications ("it's your turn" + "X ahead / ~Y min")
   * triggered when the secretary finishes the current patient's treatment.
   * Sent sequentially with human typing simulation and random pauses.
   */
  async notifyQueueAdvance(notifications = []) {
    if (!Array.isArray(notifications) || notifications.length === 0) {
      return { sent: 0, skipped: 0 };
    }
    if (this.state !== 'connected' || !this.sock) {
      for (const item of notifications) {
        if (item.event_id) chatService.setDelivery(item.event_id, 'local');
      }
      return { sent: 0, skipped: notifications.length, reason: 'not_connected' };
    }
    if (!settings.getBool('queue_notify_enabled')) {
      for (const item of notifications) {
        if (item.event_id) chatService.setDelivery(item.event_id, 'local');
      }
      return { sent: 0, skipped: notifications.length, reason: 'disabled' };
    }

    let sent = 0;
    let skipped = 0;
    const today = toISODate();
    if (this.globalDay.day !== today) this.globalDay = { day: today, count: 0 };

    for (let i = 0; i < notifications.length; i += 1) {
      const item = notifications[i];
      if (this.state !== 'connected' || !this.sock) {
        if (item.event_id) chatService.setDelivery(item.event_id, 'local');
        skipped += 1;
        continue;
      }
      if (this.globalDay.count >= settings.getInt('max_replies_per_day')) {
        if (item.event_id) chatService.setDelivery(item.event_id, 'local');
        skipped += 1;
        continue;
      }
      const jid = toJid(item.phone);
      if (!jid) {
        if (item.event_id) chatService.setDelivery(item.event_id, 'local');
        skipped += 1;
        continue;
      }
      if (typeof this.sock.onWhatsApp === 'function') {
        try {
          const [probe] = await this.sock.onWhatsApp(jid);
          if (!probe?.exists) {
            if (item.event_id) chatService.setDelivery(item.event_id, 'failed');
            skipped += 1;
            continue;
          }
        } catch (error) {
          console.warn('[wa] onWhatsApp probe failed:', error.message);
        }
      }

      const ok = await this.reply(fromJid(jid), jid, item.body);
      if (ok) {
        this.globalDay.count += 1;
        this.stats.replied += 1;
        this.logMessage(fromJid(jid), 'out', item.body);
        if (item.event_id) chatService.setDelivery(item.event_id, 'sent');
        sent += 1;
        this.onEvent({ type: 'chat', payload: { id: item.event_id, kind: item.kind, delivery: 'sent' } });
      } else {
        if (item.event_id) chatService.setDelivery(item.event_id, 'failed');
        skipped += 1;
      }

      if (i < notifications.length - 1) {
        await sleep(randomBetween(this.queuePauseMs[0], this.queuePauseMs[1]));
      }
    }

    this.onStatus(this.publicStatus());
    this.onEvent({ type: 'queue', payload: { sent, skipped } });
    return { sent, skipped };
  }
}

module.exports = { WhatsAppService, toJid, fromJid, extractText };
