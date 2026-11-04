'use strict';
/**
 * Tests du module de synchronisation DENTARDV / MEDIRDV.
 *
 * Ces tests s'exécutent DEPUIS le dossier de chaque produit (le module utilise
 * les chemins relatifs de l'application hôte) :
 *
 *   node ../rdvdz/desktop/sync.test.js DENTARDV
 *   node ../rdvdz/desktop/sync.test.js MEDIRDV
 *
 * Ils vérifient le contrat de sûreté : aucune écriture directe en base, aucune
 * donnée médicale transmise, rejeu idempotent, conflits journalisés.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const product = (process.argv[2] || 'DENTARDV').toUpperCase();
const isMedi = product === 'MEDIRDV';

// Les modules sont chargés depuis le dossier du produit hôte, quel que soit
// l'emplacement de ce fichier de test.
const host = process.cwd();
const load = (relative) => require(path.join(host, relative));

const db = load('src/main/db');
const settings = load('src/main/services/settings');
const patients = load('src/main/services/patients');
const appointments = load('src/main/services/appointments');
const sync = load('src/main/sync');

let tempFile = null;
let server = null;
let baseUrl = null;
/** Ce que le faux serveur a reçu (inspection des payloads). */
const received = { push: [], pull: 0, heartbeat: 0 };
const SECRET = 'test-device-secret';
const DEVICE_ID = 'dev-123';

function startDb() {
  db.closeAndReset();
  tempFile = path.join(os.tmpdir(), `sync-${product}-${process.pid}-${Date.now()}.sqlite`);
  db.open(tempFile);
}

function cleanup() {
  try {
    db.close();
  } catch (error) {
    /* déjà fermé */
  }
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.rmSync(`${tempFile}${suffix}`, { force: true });
    } catch (error) {
      /* Windows : fichier encore verrouillé, sans conséquence */
    }
  }
}

/** Faux serveur plateforme : 2 réservations en attente, un push accepté. */
function startServer() {
  server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
      const send = (status, payload) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };

      // Vérifie la signature HMAC de l'appareil, comme le fera l'API réelle.
      const timestamp = req.headers['x-timestamp'];
      const expected = crypto
        .createHmac('sha256', SECRET)
        .update(`${timestamp}.${req.method}.${new URL(req.url, 'http://x').pathname}.${chunks.length ? Buffer.concat(chunks).toString('utf8') : ''}`)
        .digest('hex');
      if (req.headers['x-signature'] !== expected) return send(401, { error: { code: 'BAD_SIGNATURE' } });
      if (req.headers.authorization !== `Device ${DEVICE_ID}.${SECRET}`) {
        return send(401, { error: { code: 'BAD_DEVICE' } });
      }

      if (req.url.startsWith('/api/v1/desktop/pull')) {
        received.pull += 1;
        return send(200, {
          cursor: 7,
          items: [
            {
              remote_id: 'remote-booking-1',
              kind: 'BOOKING',
              payload: {
                remote_id: 'remote-booking-1',
                reference: 'RDV-2026-000001',
                patient_name: 'Amina Test',
                patient_phone: '0550112233',
                day: nextWorkingDay(),
                kind: isMedi ? 'MEDICAL' : 'DENTAL',
                price: 1500,
              },
            },
          ],
        });
      }
      if (req.url.startsWith('/api/v1/desktop/push')) {
        received.push.push(body);
        return send(200, {
          accepted: (body.outbox || []).map((item) => ({ outbox_id: item.outbox_id })),
          conflicts: [],
          cursor: 8,
        });
      }
      if (req.url.startsWith('/api/v1/desktop/heartbeat')) {
        received.heartbeat += 1;
        return send(200, { ok: true });
      }
      return send(404, { error: { code: 'NOT_FOUND' } });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
}

function nextWorkingDay() {
  const working = settings.getWorkingDays();
  const date = new Date();
  for (let i = 1; i <= 20; i += 1) {
    const candidate = new Date(date.getTime() + i * 86400000);
    if (working.includes(candidate.getDay())) return candidate.toISOString().slice(0, 10);
  }
  return date.toISOString().slice(0, 10);
}

test.before(() => {
  startDb();
  assert.equal(sync.status().enabled, false, 'la synchronisation est désactivée par défaut');
  return startServer();
});

test.after(async () => {
  sync.stop();
  if (server) await new Promise((resolve) => server.close(resolve));
  cleanup();
});

test('le module ne fait aucune connexion tant qu\'il est désactivé', async () => {
  const result = await sync.syncOnce({ patients, appointments });
  assert.deepEqual(result, { skipped: 'disabled' });
  assert.equal(received.pull, 0, 'aucun appel réseau');
});

test('le message d\'erreur explique l\'appairage manquant', async () => {
  settings.set('sync_enabled', '1');
  const result = await sync.syncOnce({ patients, appointments });
  assert.deepEqual(result, { skipped: 'not_configured' });
  assert.match(sync.status().last_error, /Appareil non appairé/);
  settings.set('sync_enabled', '0');
});

test('un cycle complet applique la réservation distante via les services existants', async () => {
  settings.setMany({
    sync_api_url: baseUrl,
    sync_device_id: DEVICE_ID,
    sync_secret: SECRET,
    sync_enabled: '1',
  });

  const result = await sync.syncOnce({ patients, appointments });
  assert.equal(result.received, 1, 'une réservation reçue');
  assert.equal(received.pull, 1);
  assert.equal(received.heartbeat, 1);

  // La réservation existe réellement dans l'agenda local…
  const inbox = db.getDb().prepare('SELECT * FROM sync_inbox').all();
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].status, 'applied');

  const appointment = appointments.get(inbox[0].appointment_id);
  assert.equal(appointment.full_name, 'Amina Test');
  assert.equal(appointment.phone, '0550112233');
  assert.equal(appointment.status, 'booked', 'le moteur local garde la main sur le statut');

  // …et un identifiant local a été renvoyé à la plateforme.
  const pending = db.getDb().prepare(`SELECT * FROM sync_outbox WHERE status = 'pending'`).all();
  assert.ok(pending.length >= 1, 'un lien local→distant est mis en file');
});

test('rejouer le même cycle ne crée pas de doublon (idempotence)', async () => {
  const before = db.getDb().prepare('SELECT COUNT(*) AS n FROM appointments').get().n;
  await sync.syncOnce({ patients, appointments });
  const after = db.getDb().prepare('SELECT COUNT(*) AS n FROM appointments').get().n;
  assert.equal(after, before, 'aucun rendez-vous dupliqué');
});

test('aucune donnée médicale ne quitte le poste', async () => {
  // On ajoute un patient avec des champs sensibles locaux.
  patients.create({
    full_name: 'Patient Sensible',
    phone: '0660445566',
    notes: 'Allergie pénicilline — ne pas transmettre',
  });
  sync.enqueue('patient_identity', 'update', {
    full_name: 'Patient Sensible',
    phone: '0660445566',
    full_name_ar: '',
  });
  await sync.syncOnce({ patients, appointments });

  const payloadText = JSON.stringify(received.push);
  assert.doesNotMatch(payloadText, /Allergie/i, 'aucune allergie transmise');
  assert.doesNotMatch(payloadText, /pénicilline/i);
  assert.doesNotMatch(payloadText, /chronic/i);
  assert.doesNotMatch(payloadText, /birth_date|blood_group/i);
});

test('un rendez-vous annulé localement est annoncé à la plateforme', async () => {
  sync.enqueue('appointment', 'status', { remote_id: 'remote-booking-1', status: 'cancelled' });
  await sync.syncOnce({ patients, appointments });
  const lastPush = received.push[received.push.length - 1];
  assert.ok(lastPush, 'un push a eu lieu');
  const statuses = lastPush.outbox.map((item) => item.operation);
  assert.ok(statuses.includes('status'), 'l\'opération de statut est transmise');
});

test('le secret de l\'appareil n\'est jamais renvoyé par l\'écran réglages', () => {
  const all = settings.all();
  assert.equal(all.sync_secret, undefined, 'le secret est retiré du dump');
  assert.equal(all.sync_secret_set, true, 'seul son état est exposé');
});

test('une URL de synchronisation invalide est refusée par le validateur', () => {
  assert.throws(() => settings.set('sync_api_url', 'javascript:alert(1)'), /SETTING_INVALID/);
  assert.throws(() => settings.set('sync_api_url', 'pas une url'), /SETTING_INVALID/);
  settings.set('sync_api_url', baseUrl); // restauré
});

test('un serveur qui rejette la signature ne corrompt rien', async () => {
  // Une opération à transmettre, pour vérifier qu'elle n'est pas perdue.
  sync.enqueue('appointment', 'status', { remote_id: 'remote-booking-1', status: 'done' });
  settings.set('sync_secret', 'mauvais-secret');
  const result = await sync.syncOnce({ patients, appointments });
  assert.ok(result.error, 'le cycle échoue proprement');
  assert.match(String(result.error), /BAD_SIGNATURE|HTTP_401|UNAUTHORIZED/i);
  const remaining = db.getDb().prepare(`SELECT COUNT(*) AS n FROM sync_outbox WHERE status = 'pending'`).get().n;
  assert.ok(remaining >= 1, 'les opérations restent en file, aucune perte');
  settings.set('sync_secret', SECRET);
});

test('les journaux de synchronisation restent lisibles et sans donnée sensible', () => {
  const rows = db.getDb().prepare('SELECT * FROM sync_log ORDER BY id DESC LIMIT 50').all();
  assert.ok(rows.length > 0);
  for (const row of rows) {
    assert.ok(['ok', 'conflict', 'error'].includes(row.status));
    assert.doesNotMatch(String(row.detail || ''), /secret|password/i);
  }
});
