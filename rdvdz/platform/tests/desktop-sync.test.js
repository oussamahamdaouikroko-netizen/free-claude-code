/**
 * Synchronisation des postes DENTARDV / MEDIRDV.
 *
 * Vérifie le contrat de sécurité (appairage, HMAC, horodatage, révocation),
 * l'exactitude du transport (curseur, rejeu, conflits) et la règle absolue :
 * aucune donnée médicale ne transite par la plateforme.
 */

import './env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  setup,
  teardown,
  call,
  registerPatient,
  createAdmin,
  createVerifiedDoctorWithSlots,
} from './helpers.js';
import { db, many, one } from '../src/db.js';
import { getApp } from './helpers.js';
import { hmac } from '../src/lib/crypto.js';
import { clearAll as clearRateLimits } from '../src/lib/rate-limit.js';

let fixture;
let device;

test.before(async () => {
  await setup();
  fixture = await createVerifiedDoctorWithSlots({ slotCount: 4, fee: 2000 });
});

test.after(async () => {
  await teardown();
});

test.beforeEach(() => clearRateLimits());

/** Appaire un appareil via l'API d'administration. */
async function pairDevice(admin, overrides = {}) {
  const response = await call('POST', '/api/v1/admin/desktop-devices/pair', {
    token: admin.token,
    csrf: admin.csrf,
    body: { product: 'DENTARDV', name: 'Poste accueil', doctor_id: fixture.doctorId, ...overrides },
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body;
}

/**
 * Requête signée comme le ferait le poste de travail.
 * @param {{ device: {device_id: string, secret: string}, method: string, url: string,
 *           body?: object, timestamp?: number, signature?: string, auth?: string }} options
 */
async function desktopRequest({
  target = device,
  method,
  url,
  body = undefined,
  timestamp = Math.floor(Date.now() / 1000),
  signature = null,
  auth = null,
}) {
  const rawBody = body === undefined ? '' : JSON.stringify(body);
  const path = url.split('?')[0];
  const expected =
    signature ??
    hmac(target.secret, `${timestamp}.${method}.${path}.${rawBody}`);

  const response = await getApp().inject({
    method,
    url,
    payload: body === undefined ? undefined : rawBody,
    headers: {
      authorization: auth ?? `Device ${target.device_id}.${target.secret}`,
      'x-timestamp': String(timestamp),
      'x-signature': expected,
      'content-type': 'application/json',
    },
  });
  let json = null;
  try {
    json = response.body ? JSON.parse(response.body) : null;
  } catch {
    json = null;
  }
  return { status: response.statusCode, body: json, raw: response.body };
}

/* --------------------------------- appairage ------------------------------ */

test('l\'appairage renvoie un secret une seule fois et le stocke hors du renderer', async () => {
  const admin = await createAdmin('ADMIN');
  const paired = await pairDevice(admin);
  assert.match(paired.device_id, /^dev_/);
  assert.ok(paired.secret.length >= 32);
  assert.ok(paired.device_uuid);

  const row = await one(
    'SELECT token_hash, secret, product, doctor_id FROM desktop_devices WHERE id = $1',
    [paired.device_uuid],
  );
  assert.equal(row.product, 'DENTARDV');
  assert.equal(row.doctor_id, fixture.doctorId);
  assert.notEqual(row.token_hash, paired.device_id, 'l\'identifiant n\'est pas stocké en clair');

  // Le listing ne réexpose jamais le secret.
  const list = await call('GET', '/api/v1/admin/desktop-devices', { token: admin.token });
  assert.equal(list.status, 200);
  const raw = JSON.stringify(list.body);
  assert.equal(raw.includes(paired.secret), false);
  assert.equal(raw.includes('secret'), false);

  // Un produit inconnu est refusé.
  const bad = await call('POST', '/api/v1/admin/desktop-devices/pair', {
    token: admin.token,
    csrf: admin.csrf,
    body: { product: 'AUTRE', name: 'x' },
  });
  assert.equal(bad.status, 422);

  device = { ...paired, timestamp: Math.floor(Date.now() / 1000) };
});

/* -------------------------------- transport -------------------------------- */

test('le handshake décrit le serveur sans divulguer de données personnelles', async () => {
  const admin = await createAdmin('ADMIN');
  const paired = await pairDevice(admin);

  const response = await desktopRequest({ target: paired, method: 'POST', url: '/api/v1/desktop/handshake', body: {} });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.product, 'DENTARDV');
  assert.ok(response.body.server_time);
  assert.equal(response.body.config.slot_minutes, 20);
  assert.match(response.body.note, /restent locales/);
});

test('une requête non signée, mal signée ou trop ancienne est refusée (401)', async () => {
  const admin = await createAdmin('ADMIN');
  const paired = await pairDevice(admin);

  const anonymous = await desktopRequest({
    target: paired,
    method: 'POST',
    url: '/api/v1/desktop/handshake',
    body: {},
    auth: 'Bearer quelquechose',
  });
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.body.error.code, 'DEVICE_UNAUTHORIZED');

  const wrongSecret = await desktopRequest({
    target: paired,
    method: 'POST',
    url: '/api/v1/desktop/handshake',
    body: {},
    auth: `Device ${paired.device_id}.mauvais-secret`,
  });
  assert.equal(wrongSecret.status, 401);

  const badSignature = await desktopRequest({
    target: paired,
    method: 'POST',
    url: '/api/v1/desktop/handshake',
    body: {},
    signature: 'f'.repeat(64),
  });
  assert.equal(badSignature.status, 401);

  const stale = await desktopRequest({
    target: paired,
    method: 'POST',
    url: '/api/v1/desktop/handshake',
    body: {},
    timestamp: Math.floor(Date.now() / 1000) - 3600,
  });
  assert.equal(stale.status, 401);
  assert.match(stale.body.error.message, /Horodatage/);

  // La signature lie le corps : modifier le contenu l'invalide.
  const signed = hmac(paired.secret, `${Math.floor(Date.now() / 1000)}.POST./api/v1/desktop/push.{"outbox":[]}`);
  const tampered = await getApp().inject({
    method: 'POST',
    url: '/api/v1/desktop/push',
    payload: JSON.stringify({ outbox: [{ entity: 'appointment' }] }),
    headers: {
      authorization: `Device ${paired.device_id}.${paired.secret}`,
      'x-timestamp': String(Math.floor(Date.now() / 1000)),
      'x-signature': signed,
      'content-type': 'application/json',
    },
  });
  assert.equal(tampered.statusCode, 401);
});

test('un appareil révoqué perd immédiatement l\'accès', async () => {
  const admin = await createAdmin('ADMIN');
  const paired = await pairDevice(admin);

  const before = await desktopRequest({ target: paired, method: 'POST', url: '/api/v1/desktop/heartbeat', body: {} });
  assert.equal(before.status, 200);

  const revoke = await call('POST', `/api/v1/admin/desktop-devices/${paired.device_uuid}/revoke`, {
    token: admin.token,
    csrf: admin.csrf,
  });
  assert.equal(revoke.status, 200);

  const after = await desktopRequest({ target: paired, method: 'POST', url: '/api/v1/desktop/heartbeat', body: {} });
  assert.equal(after.status, 401);
  assert.match(after.body.error.message, /révoqué/);
});

test('un patient authentifié par cookie ne peut pas utiliser les routes poste', async () => {
  const patient = await registerPatient();
  const response = await call('GET', '/api/v1/desktop/status', { token: patient.token });
  assert.equal(response.status, 401, 'l\'authentification par appareil est obligatoire');
});

/* ---------------------------------- pull ---------------------------------- */

test('le pull renvoie les éléments en attente puis respecte le curseur', async () => {
  const admin = await createAdmin('ADMIN');
  const paired = await pairDevice(admin);

  // Une réservation confirmée est poussée dans la file du poste.
  const patient = await registerPatient();
  const booking = await call('POST', '/api/v1/bookings', {
    token: patient.token,
    csrf: patient.csrf,
    body: { slot_id: fixture.slots[0].id },
  });
  const appointmentId = booking.body.appointment.id;
  await db().query(
    `INSERT INTO desktop_inbox (device_id, kind, remote_id, payload)
     VALUES ($1, 'BOOKING', $2, $3)`,
    [paired.device_uuid, appointmentId, JSON.stringify({ reference: booking.body.appointment.reference })],
  );

  const first = await desktopRequest({ target: paired, method: 'GET', url: '/api/v1/desktop/pull' });
  assert.equal(first.status, 200);
  assert.equal(first.body.items.length, 1);
  assert.equal(first.body.items[0].remote_id, appointmentId);
  assert.equal(first.body.items[0].payload.reference, booking.body.appointment.reference);
  assert.ok(first.body.cursor > 0);

  // Le curseur empêche de renvoyer ce qui a déjà été livré.
  const second = await desktopRequest({
    target: paired,
    method: 'GET',
    url: `/api/v1/desktop/pull?cursor=${first.body.cursor}`,
  });
  assert.equal(second.body.items.length, 0);
  assert.equal(second.body.cursor, first.body.cursor);

  const inbox = await many('SELECT status FROM desktop_inbox WHERE device_id = $1', [paired.device_uuid]);
  assert.equal(inbox[0].status, 'DELIVERED');

  const status = await desktopRequest({ target: paired, method: 'GET', url: '/api/v1/desktop/status' });
  assert.equal(status.status, 200);
  assert.deepEqual(status.body.inbox, [{ status: 'DELIVERED', n: 1 }]);
});

/* ---------------------------------- push ---------------------------------- */

test('le push applique un statut dicté par le poste et le journalise', async () => {
  const admin = await createAdmin('ADMIN');
  const paired = await pairDevice(admin);

  const patient = await registerPatient();
  const booking = await call('POST', '/api/v1/bookings', {
    token: patient.token,
    csrf: patient.csrf,
    body: { slot_id: fixture.slots[1].id },
  });
  const appointmentId = booking.body.appointment.id;
  // Le rendez-vous doit être confirmé pour pouvoir être terminé.
  await db().query(`UPDATE appointments SET status = 'CONFIRMED', confirmed_at = now() WHERE id = $1`, [
    appointmentId,
  ]);

  const response = await desktopRequest({
    target: paired,
    method: 'POST',
    url: '/api/v1/desktop/push',
    body: {
      outbox: [
        {
          outbox_id: 'o-1',
          entity: 'appointment',
          operation: 'status',
          remote_id: appointmentId,
          payload: { status: 'DONE' },
        },
      ],
    },
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.accepted.length, 1);
  assert.equal(response.body.conflicts.length, 0);

  const row = await one('SELECT status FROM appointments WHERE id = $1', [appointmentId]);
  assert.equal(row.status, 'COMPLETED', 'DONE du poste devient COMPLETED sur la plateforme');

  const log = await many(
    `SELECT direction, status, operation FROM desktop_sync_log WHERE device_id = $1`,
    [paired.device_uuid],
  );
  assert.ok(log.some((entry) => entry.direction === 'IN' && entry.status === 'ACK'));
});

test('une transition impossible devient un conflit explicite, jamais un écrasement', async () => {
  const admin = await createAdmin('ADMIN');
  const paired = await pairDevice(admin);

  const patient = await registerPatient();
  const booking = await call('POST', '/api/v1/bookings', {
    token: patient.token,
    csrf: patient.csrf,
    body: { slot_id: fixture.slots[2].id },
  });
  const appointmentId = booking.body.appointment.id;
  // Le rendez-vous est encore AWAITING_PAYMENT : impossible de le terminer.

  const response = await desktopRequest({
    target: paired,
    method: 'POST',
    url: '/api/v1/desktop/push',
    body: {
      outbox: [
        { entity: 'appointment', operation: 'status', remote_id: appointmentId, payload: { status: 'COMPLETED' } },
      ],
    },
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.accepted.length, 0);
  assert.equal(response.body.conflicts.length, 1);
  assert.match(response.body.conflicts[0].reason, /invalid_transition/);

  const row = await one('SELECT status FROM appointments WHERE id = $1', [appointmentId]);
  assert.equal(row.status, 'AWAITING_PAYMENT', 'aucune écriture non autorisée');
});

test('le poste ne peut pas agir sur le rendez-vous d\'un autre médecin', async () => {
  const admin = await createAdmin('ADMIN');
  const other = await createVerifiedDoctorWithSlots({ slotCount: 2 });
  const paired = await pairDevice(admin); // rattaché au premier médecin

  const patient = await registerPatient();
  const booking = await call('POST', '/api/v1/bookings', {
    token: patient.token,
    csrf: patient.csrf,
    body: { slot_id: other.slots[0].id },
  });
  const appointmentId = booking.body.appointment.id;
  await db().query(`UPDATE appointments SET status = 'CONFIRMED' WHERE id = $1`, [appointmentId]);

  const response = await desktopRequest({
    target: paired,
    method: 'POST',
    url: '/api/v1/desktop/push',
    body: {
      outbox: [
        { entity: 'appointment', operation: 'status', remote_id: appointmentId, payload: { status: 'COMPLETED' } },
      ],
    },
  });
  assert.equal(response.body.accepted.length, 0);
  assert.equal(response.body.conflicts[0].reason, 'not_your_appointment');
});

test('le poste peut relier son identifiant local et clôt la file', async () => {
  const admin = await createAdmin('ADMIN');
  const paired = await pairDevice(admin);

  const patient = await registerPatient();
  const booking = await call('POST', '/api/v1/bookings', {
    token: patient.token,
    csrf: patient.csrf,
    body: { slot_id: fixture.slots[3].id },
  });
  const appointmentId = booking.body.appointment.id;
  await db().query(
    `INSERT INTO desktop_inbox (device_id, kind, remote_id, payload)
     VALUES ($1, 'BOOKING', $2, '{}'::jsonb)`,
    [paired.device_uuid, appointmentId],
  );

  const response = await desktopRequest({
    target: paired,
    method: 'POST',
    url: '/api/v1/desktop/push',
    body: {
      outbox: [
        {
          entity: 'appointment',
          operation: 'link',
          remote_id: appointmentId,
          payload: { local_id: 'local-42' },
        },
      ],
    },
  });
  assert.equal(response.body.accepted.length, 1);

  const appointment = await one('SELECT desktop_uuid FROM appointments WHERE id = $1', [appointmentId]);
  assert.equal(appointment.desktop_uuid, 'local-42');

  const inbox = await one('SELECT status FROM desktop_inbox WHERE device_id = $1 AND remote_id = $2', [
    paired.device_uuid,
    appointmentId,
  ]);
  assert.equal(inbox.status, 'APPLIED');
});

test('un refus local remonte en conflit consultable et résoluble par un administrateur', async () => {
  const admin = await createAdmin('ADMIN');
  const paired = await pairDevice(admin);
  const remoteId = randomUUID();

  const raised = await desktopRequest({
    target: paired,
    method: 'POST',
    url: '/api/v1/desktop/push',
    body: {
      outbox: [
        {
          entity: 'appointment',
          operation: 'conflict',
          remote_id: remoteId,
          payload: { reason: 'créneau déjà occupé dans l\'agenda local' },
        },
      ],
    },
  });
  assert.equal(raised.status, 200);

  const list = await call('GET', '/api/v1/admin/desktop-conflicts', { token: admin.token });
  assert.equal(list.status, 200);
  assert.ok(list.body.items.some((item) => item.remote_id === remoteId));

  const conflict = list.body.items.find((item) => item.remote_id === remoteId);
  const unresolved = await call('POST', `/api/v1/admin/desktop-conflicts/${conflict.id}/resolve`, {
    token: admin.token,
    csrf: admin.csrf,
    body: {},
  });
  assert.equal(unresolved.status, 422, 'une résolution doit être motivée');

  const resolved = await call('POST', `/api/v1/admin/desktop-conflicts/${conflict.id}/resolve`, {
    token: admin.token,
    csrf: admin.csrf,
    body: { resolution: 'réservé manuellement au guichet' },
  });
  assert.equal(resolved.status, 200);
  assert.ok(resolved.body.resolved_at);

  const twice = await call('POST', `/api/v1/admin/desktop-conflicts/${conflict.id}/resolve`, {
    token: admin.token,
    csrf: admin.csrf,
    body: { resolution: 'encore' },
  });
  assert.equal(twice.status, 409);
  assert.equal(twice.body.error.code, 'CONFLICT_ALREADY_RESOLVED');
});

/* --------------------------- frontière des données ------------------------ */

test('aucune donnée médicale n\'est acceptée depuis un poste', async () => {
  const admin = await createAdmin('ADMIN');
  const paired = await pairDevice(admin);

  for (const field of ['allergies', 'chronic_conditions', 'blood_group', 'notes', 'birth_date']) {
    const response = await desktopRequest({
      target: paired,
      method: 'POST',
      url: '/api/v1/desktop/push',
      body: {
        outbox: [
          { entity: 'patient_identity', operation: 'update', remote_id: 'p-1', payload: { full_name: 'X', [field]: 'secret' } },
        ],
      },
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.accepted.length, 0, field);
    assert.match(response.body.conflicts[0].reason, /medical_data_rejected/, field);
  }

  // L'identité seule est acceptée.
  const identity = await desktopRequest({
    target: paired,
    method: 'POST',
    url: '/api/v1/desktop/push',
    body: {
      outbox: [
        { entity: 'patient_identity', operation: 'update', remote_id: 'p-1', payload: { full_name: 'Nadia B.' } },
      ],
    },
  });
  assert.equal(identity.body.accepted.length, 1);
});

test('la liste poussée au poste ne contient ni symptômes ni documents', async () => {
  const admin = await createAdmin('ADMIN');
  const paired = await pairDevice(admin);

  const patient = await registerPatient();
  const slot = await one(
    `INSERT INTO doctor_slots (doctor_id, starts_at, ends_at, mode, status)
     VALUES ($1, now() + interval '30 days', now() + interval '30 days 20 minutes', 'IN_CLINIC', 'OPEN')
     RETURNING id`,
    [fixture.doctorId],
  );
  const booking = await call('POST', '/api/v1/bookings', {
    token: patient.token,
    csrf: patient.csrf,
    body: { slot_id: slot.id, notes: 'VENEZ A JEUN' },
  });
  assert.equal(booking.status, 201, JSON.stringify(booking.body));
  await db().query(`UPDATE appointments SET status = 'CONFIRMED', confirmed_at = now() WHERE id = $1`, [
    booking.body.appointment.id,
  ]);

  const response = await desktopRequest({ target: paired, method: 'GET', url: '/api/v1/desktop/appointments' });
  assert.equal(response.status, 200);
  assert.ok(response.body.items.length >= 1);
  const keys = Object.keys(response.body.items[0]).sort();
  assert.deepEqual(keys, ['desktop_uuid', 'ends_at', 'full_name', 'id', 'phone', 'reference', 'starts_at', 'status']);
  assert.equal(JSON.stringify(response.body).includes('VENEZ A JEUN'), false, 'les notes internes restent côté plateforme');
});

test('un appareil non rattaché à un médecin ne reçoit aucun rendez-vous', async () => {
  const admin = await createAdmin('ADMIN');
  const paired = await pairDevice(admin, { doctor_id: undefined });

  const response = await desktopRequest({ target: paired, method: 'GET', url: '/api/v1/desktop/appointments' });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.items, []);
  assert.match(response.body.note, /non rattaché/);
});

test('le secret appareil n\'apparaît dans aucun journal ni aucune trace d\'audit', async () => {
  const admin = await createAdmin('ADMIN');
  const paired = await pairDevice(admin);
  await desktopRequest({ target: paired, method: 'POST', url: '/api/v1/desktop/heartbeat', body: {} });

  const logs = await many('SELECT detail FROM desktop_sync_log WHERE device_id = $1', [paired.device_uuid]);
  const audit = await many(`SELECT details FROM audit_logs WHERE action LIKE 'desktop%'`);
  const haystack = JSON.stringify(logs) + JSON.stringify(audit);
  assert.equal(haystack.includes(paired.secret), false, 'le secret appareil n\'apparaît dans aucun journal');
});
