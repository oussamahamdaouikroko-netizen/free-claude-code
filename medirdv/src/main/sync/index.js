'use strict';
/**
 * RDV DZ — client de synchronisation pour DENTARDV / MEDIRDV.
 *
 * RÈGLES DE SÛRETÉ (à ne jamais contourner) :
 *  1. Ce module ne modifie JAMAIS la base directement : toute réservation
 *     entrante passe par les services existants (`patients`, `appointments`,
 *     `payments`), donc par leurs validations, leurs transactions et leurs
 *     index uniques.
 *  2. Il est INACTIF par défaut. Tant que `sync_enabled` n'est pas `1`, aucune
 *     connexion réseau n'est ouverte.
 *  3. Il ne supprime aucune donnée et n'écrase aucun rendez-vous existant : un
 *     conflit est journalisé et renvoyé à la plateforme.
 *  4. Il n'envoie jamais de donnée médicale (allergies, antécédents,
 *     ordonnances, certificats, notes cliniques) : uniquement l'identité du
 *     patient (nom, téléphone), le créneau et le statut.
 *  5. Hors-ligne, tout continue de fonctionner : les actions sont mises en
 *     file et rejouées au retour du réseau.
 */

const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const { getDb } = require('../db');
const settings = require('../services/settings');

const DEFAULT_INTERVAL_MS = 60 * 1000;
const MAX_OUTBOX_ATTEMPTS = 25;

/* ------------------------------- utilitaires ------------------------------ */

function nowIso() {
  return new Date().toISOString();
}

function getState(key, fallback = '') {
  const row = getDb().prepare('SELECT value FROM sync_state WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setState(key, value) {
  getDb()
    .prepare(
      'INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    )
    .run(key, String(value));
}

function log(direction, entity, status, { localId = null, remoteId = null, detail = '' } = {}) {
  getDb()
    .prepare(
      `INSERT INTO sync_log (direction, entity, local_id, remote_id, status, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(direction, entity, localId, remoteId, status, String(detail).slice(0, 500), nowIso());
}

/** Identifiant stable d'une ligne locale, indépendant de l'auto-incrément. */
function stableId(prefix, localId) {
  const salt = getState('install_salt');
  return `${prefix}-${localId}-${crypto.createHash('sha256').update(`${salt}:${localId}`).digest('hex').slice(0, 12)}`;
}

/* ------------------------------ configuration ---------------------------- */

/**
 * Configuration lue dans la table `settings` (aucune migration nécessaire) :
 *  - sync_enabled      '0' | '1'
 *  - sync_api_url      ex. https://api.rdvdz.dz
 *  - sync_device_id    identifiant attribué à l'appairage
 *  - sync_secret       secret de l'appareil (affiché une seule fois)
 *  - sync_product      'DENTARDV' | 'MEDIRDV'
 *  - sync_last_error   dernier message (diagnostic dans l'écran Paramètres)
 */
function config() {
  return {
    enabled: settings.getBool('sync_enabled'),
    apiUrl: settings.get('sync_api_url').replace(/\/+$/, ''),
    deviceId: settings.get('sync_device_id'),
    secret: settings.get('sync_secret'),
    product: settings.get('sync_product') || 'DENTARDV',
    intervalMs: Number(settings.get('sync_interval_seconds') || 0) * 1000 || DEFAULT_INTERVAL_MS,
  };
}

/** État affiché dans l'écran Paramètres (jamais le secret). */
function status() {
  const cfg = config();
  const pending = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM sync_outbox WHERE status IN ('pending', 'failed')`)
    .get().n;
  const queued = getDb().prepare(`SELECT COUNT(*) AS n FROM sync_inbox WHERE status = 'pending'`).get().n;
  const lastOk = getDb()
    .prepare(`SELECT created_at FROM sync_log WHERE status = 'ok' ORDER BY id DESC LIMIT 1`)
    .get();
  return {
    enabled: cfg.enabled,
    configured: Boolean(cfg.apiUrl && cfg.deviceId && cfg.secret),
    product: cfg.product,
    api_url: cfg.apiUrl,
    device_id: cfg.deviceId,
    outbox_pending: pending,
    inbox_queued: queued,
    last_success_at: lastOk ? lastOk.created_at : null,
    last_error: settings.get('sync_last_error'),
    cursor: Number(getState('cursor', '0')) || 0,
  };
}

/* --------------------------------- réseau -------------------------------- */

/**
 * Requête HTTPS signée (HMAC-SHA256 du corps + horodatage anti-rejeu).
 * Aucune dépendance externe : `node:https` suffit et évite un module natif.
 */
function request(cfg, method, path, body) {
  return new Promise((resolve, reject) => {
    if (!/^https?:\/\//i.test(cfg.apiUrl)) {
      reject(new Error('SYNC_URL_INVALID'));
      return;
    }
    const url = new URL(cfg.apiUrl + path);
    const payload = body === undefined ? '' : JSON.stringify(body);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = crypto
      .createHmac('sha256', cfg.secret)
      .update(`${timestamp}.${method}.${url.pathname}.${payload}`)
      .digest('hex');

    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request(
      {
        method,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          Authorization: `Device ${cfg.deviceId}.${cfg.secret}`,
          'x-signature': signature,
          'x-timestamp': timestamp,
          'user-agent': `${cfg.product}-sync/1.0`,
        },
        timeout: 20000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let data = null;
          try {
            data = text ? JSON.parse(text) : null;
          } catch (error) {
            data = { raw: text.slice(0, 500) };
          }
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(data || {});
          else {
            const err = new Error((data && data.error && data.error.code) || `HTTP_${res.statusCode}`);
            err.status = res.statusCode;
            err.details = data;
            reject(err);
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('SYNC_TIMEOUT')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/* ------------------------------ file sortante ---------------------------- */

/**
 * Met en file une opération à pousser vers la plateforme.
 * @param {'appointment'|'patient_identity'|'payment_note'|'consultation_request'} entity
 * @param {string} operation
 * @param {object} payload
 */
function enqueue(entity, operation, payload, { localId = null, remoteId = null } = {}) {
  getDb()
    .prepare(
      `INSERT INTO sync_outbox (entity, local_id, remote_id, operation, payload, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
    )
    .run(entity, localId, remoteId, operation, JSON.stringify(payload), nowIso(), nowIso());
}

/** Étape de sortie : envoie la file et traite les accusés. */
async function push(cfg) {
  const rows = getDb()
    .prepare(
      `SELECT * FROM sync_outbox
        WHERE status IN ('pending', 'failed') AND attempts < ?
        ORDER BY id ASC LIMIT 50`,
    )
    .all(MAX_OUTBOX_ATTEMPTS);
  if (rows.length === 0) return { pushed: 0, conflicts: 0 };

  const outbox = rows.map((row) => ({
    entity: row.entity,
    local_id: row.local_id === null ? null : String(row.local_id),
    remote_id: row.remote_id,
    operation: row.operation,
    payload: JSON.parse(row.payload),
    outbox_id: row.id,
  }));

  let response;
  try {
    response = await request(cfg, 'POST', '/api/v1/desktop/push', {
      outbox,
      cursor: Number(getState('cursor', '0')) || 0,
    });
  } catch (error) {
    // Réseau indisponible : on ne perd rien, on réessaie plus tard.
    const fail = getDb().prepare(
      `UPDATE sync_outbox SET attempts = attempts + 1, last_error = ?, updated_at = ? WHERE id = ?`,
    );
    for (const row of rows) fail.run(String(error.message).slice(0, 300), nowIso(), row.id);
    throw error;
  }

  const accepted = new Set(
    (response.accepted || []).map((item) => Number(item.outbox_id ?? item.outboxId)).filter(Number.isFinite),
  );
  const remove = getDb().prepare('DELETE FROM sync_outbox WHERE id = ?');
  const markConflict = getDb().prepare(
    `UPDATE sync_outbox SET status = 'conflict', last_error = ?, updated_at = ? WHERE id = ?`,
  );

  for (const row of rows) {
    if (accepted.has(row.id)) {
      remove.run(row.id);
      log('out', row.entity, 'ok', { localId: row.local_id, remoteId: row.remote_id, detail: row.operation });
    }
  }
  for (const conflict of response.conflicts || []) {
    const id = Number(conflict.outbox_id ?? conflict.outboxId);
    if (Number.isFinite(id)) {
      markConflict.run(String(conflict.reason || 'conflict').slice(0, 300), nowIso(), id);
      log('out', 'appointment', 'conflict', { localId: conflict.local_id, remoteId: conflict.remote_id, detail: conflict.reason });
    }
  }
  if (response.cursor) setState('cursor', String(response.cursor));
  return { pushed: accepted.size, conflicts: (response.conflicts || []).length };
}

/* ------------------------------ file entrante ---------------------------- */

/**
 * Applique une réservation reçue de la plateforme.
 * `appointments.create` reste maître : en cas de collision (journée pleine,
 * jour non ouvré), l'erreur est capturée, la réservation est marquée `failed`
 * et la plateforme en est informée au push suivant.
 */
function applyBooking(item, services) {
  const { patients, appointments } = services;
  const payload = item.payload || {};

  // Idempotence : une réservation déjà appliquée n'est jamais rejouée.
  const already = getDb().prepare('SELECT appointment_id, status FROM sync_inbox WHERE remote_id = ?').get(item.remote_id);
  if (already && already.status === 'applied') return { skipped: true, appointmentId: already.appointment_id };

  const person = patients.upsertFromWhatsApp({
    name: payload.patient_name,
    phone: payload.patient_phone,
  });

  const created = appointments.create({
    patient_id: person.patient.id,
    day: payload.day,
    treatment_name: payload.treatment_name || (payload.kind === 'DENTAL' ? 'Consultation' : 'Consultation générale'),
    price: Number(payload.price) || 0,
    notes: `RDV DZ ${payload.reference || ''}`.trim(),
    source: 'whatsapp',
    historical: !settings.isWorkingDay(payload.day),
  });

  getDb()
    .prepare(
      `UPDATE sync_inbox SET status = 'applied', appointment_id = ?, applied_at = ? WHERE remote_id = ?`,
    )
    .run(created.id, nowIso(), item.remote_id);

  // Le poste devient la référence locale : on renvoie l'identifiant accordé.
  enqueue(
    'appointment',
    'link',
    { remote_id: payload.remote_id || item.remote_id, local_id: created.id, day: created.day, queue_number: created.queue_number },
    { localId: created.id, remoteId: payload.remote_id || item.remote_id },
  );

  log('in', 'appointment', 'ok', { localId: created.id, remoteId: item.remote_id, detail: 'booking applied' });
  return { skipped: false, appointmentId: created.id };
}

/** Applique une annulation distante (le créneau est libéré proprement). */
function applyCancellation(item, services) {
  const payload = item.payload || {};
  const row = getDb()
    .prepare('SELECT appointment_id FROM sync_inbox WHERE remote_id = ?')
    .get(item.remote_id);
  const localId = payload.local_id || (row && row.appointment_id);
  if (!localId) {
    getDb()
      .prepare(`UPDATE sync_inbox SET status = 'skipped', last_error = 'appointment not linked' WHERE remote_id = ?`)
      .run(item.remote_id);
    return { skipped: true };
  }
  try {
    services.appointments.cancel(localId);
    getDb()
      .prepare(`UPDATE sync_inbox SET status = 'applied', applied_at = ? WHERE remote_id = ?`)
      .run(nowIso(), item.remote_id);
    log('in', 'appointment', 'ok', { localId, remoteId: item.remote_id, detail: 'cancellation applied' });
    return { skipped: false };
  } catch (error) {
    getDb()
      .prepare(`UPDATE sync_inbox SET status = 'failed', last_error = ?, attempts = attempts + 1 WHERE remote_id = ?`)
      .run(String(error.message).slice(0, 300), item.remote_id);
    log('in', 'appointment', 'error', { localId, remoteId: item.remote_id, detail: error.message });
    return { skipped: true, error };
  }
}

/** Étape d'entrée : récupère et applique ce que la plateforme a produit. */
async function pull(cfg, services) {
  let response;
  try {
    response = await request(cfg, 'GET', `/api/v1/desktop/pull?cursor=${Number(getState('cursor', '0')) || 0}`);
  } catch (error) {
    settings.set('sync_last_error', String(error.message).slice(0, 200));
    throw error;
  }

  const items = response.items || [];
  let applied = 0;
  for (const item of items) {
    const existing = getDb().prepare('SELECT id FROM sync_inbox WHERE remote_id = ?').get(item.remote_id);
    if (!existing) {
      getDb()
        .prepare(
          `INSERT INTO sync_inbox (remote_id, kind, payload, status, received_at)
           VALUES (?, ?, ?, 'pending', ?)`,
        )
        .run(item.remote_id, item.kind, JSON.stringify(item.payload || {}), nowIso());
    }
  }

  const pending = getDb().prepare(`SELECT * FROM sync_inbox WHERE status = 'pending' ORDER BY id ASC LIMIT 50`).all();
  for (const item of pending) {
    const full = { ...item, payload: JSON.parse(item.payload) };
    try {
      if (full.kind === 'BOOKING') {
        applyBooking(full, services);
        applied += 1;
      } else if (full.kind === 'CANCELLATION') {
        applyCancellation(full, services);
        applied += 1;
      } else {
        // Les autres types sont conservés pour un traitement ultérieur : on ne
        // devine pas leur sémantique, on ne corrompt rien.
        getDb().prepare(`UPDATE sync_inbox SET status = 'skipped' WHERE id = ?`).run(item.id);
      }
    } catch (error) {
      getDb()
        .prepare(
          `UPDATE sync_inbox SET status = 'failed', attempts = attempts + 1, last_error = ? WHERE id = ?`,
        )
        .run(String(error.message).slice(0, 300), item.id);
      log('in', item.kind, 'error', { remoteId: item.remote_id, detail: error.message });
      // On informe la plateforme qu'un créneau local n'est pas disponible.
      enqueue('appointment', 'conflict', { remote_id: full.payload.remote_id || item.remote_id, reason: error.message, code: error.code || 'LOCAL_REJECTED' }, { remoteId: item.remote_id });
    }
  }

  if (response.cursor) setState('cursor', String(response.cursor));
  settings.set('sync_last_error', '');
  return { received: items.length, applied };
}

/* ---------------------------------- cycle -------------------------------- */

let timer = null;
let running = false;

/**
 * Exécute un cycle complet (une seule fois). Séquentiel : jamais deux cycles
 * en parallèle, même si le minuteur se déclenche pendant une opération.
 */
async function syncOnce(services) {
  const cfg = config();
  if (!cfg.enabled) return { skipped: 'disabled' };
  if (!cfg.apiUrl || !cfg.deviceId || !cfg.secret) {
    settings.set('sync_last_error', 'Appareil non appairé (voir Paramètres → RDV DZ)');
    return { skipped: 'not_configured' };
  }
  if (running) return { skipped: 'busy' };
  running = true;
  try {
    const pushed = await push(cfg);
    const pulled = await pull(cfg, services);
    await request(cfg, 'POST', '/api/v1/desktop/heartbeat', {
      version: '1.0.0',
      outbox_pending: status().outbox_pending,
    }).catch(() => {});
    settings.set('sync_last_success_at', nowIso());
    return { ...pushed, ...pulled };
  } catch (error) {
    settings.set('sync_last_error', String(error.message).slice(0, 200));
    return { error: error.message };
  } finally {
    running = false;
  }
}

/** Démarre l'automatisme (idempotent). */
function start(services) {
  stop();
  const cfg = config();
  if (!cfg.enabled) return { started: false, reason: 'disabled' };
  timer = setInterval(() => {
    syncOnce(services).catch((error) => console.error('[sync] cycle failed:', error.message));
  }, cfg.intervalMs);
  if (timer.unref) timer.unref();
  // Premier cycle rapide, non bloquant.
  setTimeout(() => {
    syncOnce(services).catch(() => {});
  }, 5000);
  return { started: true };
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  return { stopped: true };
}

module.exports = {
  status,
  config,
  enqueue,
  syncOnce,
  start,
  stop,
  stableId,
  // exportés pour les tests
  _internal: { applyBooking, applyCancellation, request, push, pull, setState, getState },
};
