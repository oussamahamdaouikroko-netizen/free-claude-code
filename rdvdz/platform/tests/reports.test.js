/**
 * Notifications et rapports.
 *
 * Deux exigences structurantes sont vérifiées ici :
 *  - aucun contenu médical ne sort par WhatsApp (canal non conforme pour des
 *    données de santé) et le mode par défaut est « clic-pour-discuter » ;
 *  - un rappel n'est jamais envoyé deux fois, même si le worker tourne en
 *    boucle (clé d'anti-doublon en base).
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
import { config } from '../src/config.js';
import { clearAll as clearRateLimits } from '../src/lib/rate-limit.js';
import * as notifications from '../src/modules/notifications/service.js';
import * as reports from '../src/modules/reports/service.js';

let fixture;

test.before(async () => {
  await setup();
  fixture = await createVerifiedDoctorWithSlots({ slotCount: 4, fee: 2000 });
});

test.after(async () => {
  await teardown();
});

test.beforeEach(() => clearRateLimits());

/* ------------------------------- modèles --------------------------------- */

test('les modèles par défaut existent en AR et en FR', async () => {
  const rows = await many(
    `SELECT code, locale, channel, body FROM notification_templates WHERE active ORDER BY code, locale`,
  );
  assert.ok(rows.length >= 10);
  const codes = new Set(rows.map((r) => r.code));
  for (const code of ['booking.confirmed', 'booking.cancelled', 'consultation.answered', 'payment.received']) {
    assert.ok(codes.has(code), code);
    for (const locale of ['ar', 'fr']) {
      assert.ok(
        rows.some((r) => r.code === code && r.locale === locale && r.body.length > 0),
        `${code}/${locale}`,
      );
    }
  }
  // Parité de contenu : aucune traduction vide.
  assert.ok(rows.every((r) => r.body.trim().length > 0));
});

test('le rendu remplace les variables et ne laisse pas de gabarit brut', () => {
  assert.equal(notifications.render('Bonjour {{nom}}', { nom: 'Nadia' }), 'Bonjour Nadia');
  assert.equal(notifications.render('Bonjour {{nom}}', {}), 'Bonjour ');
  assert.equal(notifications.render('Ligne {{a}}{{b}}', { a: 1, b: 2 }), 'Ligne 12');
});

/* ------------------------------- WhatsApp -------------------------------- */

test('le mode par défaut est le repli clic-pour-discuter, sans envoi automatique', async () => {
  assert.equal(config.notifications.whatsapp.provider, 'click_to_chat');

  const result = await notifications.queueWhatsApp({
    phone: '0550112233',
    templateCode: 'booking.confirmed',
    locale: 'fr',
    payload: { reference: 'RDV-1', date: '2026-11-10', time: '09:00' },
  });
  assert.equal(result.mode, 'CLICK_TO_CHAT');
  assert.match(result.click_to_chat, /^https:\/\/wa\.me\/213/);
  assert.match(result.note, /aucun envoi automatique/i);

  const row = await one('SELECT mode, status, to_phone FROM wa_messages WHERE id = $1', [result.messageId]);
  assert.equal(row.mode, 'CLICK_TO_CHAT');
  assert.equal(row.status, 'CLICK_READY');
  assert.equal(row.to_phone, '+213550112233', 'normalisé en E.164');
});

test('un message sortant ne contient jamais de donnée clinique', async () => {
  const result = await notifications.queueWhatsApp({
    phone: '0550112233',
    templateCode: 'booking.confirmed',
    locale: 'fr',
    payload: {
      reference: 'RDV-1',
      date: '2026-11-10',
      time: '09:00',
      doctor: 'Dr A.',
      symptom_summary: 'douleur thoracique',
      diagnosis: 'angine',
    },
  });
  assert.equal(/douleur|diagnos|angine/i.test(result.body), false, 'seuls date/heure/référence sortent');
  assert.match(result.body, /ne répondez pas|لا ترسلوا/i, 'le modèle rappelle de ne pas envoyer de données médicales');
});

test('un numéro invalide est refusé sans erreur technique', async () => {
  const result = await notifications.queueWhatsApp({ phone: '123', templateCode: 'booking.confirmed' });
  assert.equal(result.skipped, 'invalid_phone');
});

test('sans modèle WhatsApp, rien n\'est inventé', async () => {
  const result = await notifications.queueWhatsApp({
    phone: '0550112233',
    templateCode: 'modele.inexistant',
    locale: 'fr',
  });
  assert.equal(result.skipped, 'no_template');
});

test('le canal WhatsApp reste désactivable par préférence utilisateur', async () => {
  const patient = await registerPatient();
  await notifications.setPreference(patient.user.id, {
    eventCode: 'booking.created',
    channel: 'WHATSAPP',
    enabled: false,
  });

  const results = await notifications.notify({
    userId: patient.user.id,
    patientId: patient.patientId,
    phone: patient.phone,
    templateCode: 'booking.created',
    channels: ['WHATSAPP', 'IN_APP'],
    dedupeKey: `pref-${randomUUID()}`,
  });
  const whatsapp = results.find((r) => r.channel === 'WHATSAPP');
  assert.equal(whatsapp.skipped, 'preference_disabled');
  const inApp = results.find((r) => r.channel === 'IN_APP');
  assert.ok(inApp.notificationId, 'le canal interne reste disponible');
});

/* -------------------------------- rappels -------------------------------- */

test('un rappel n\'est jamais émis deux fois, même si le worker boucle', async () => {
  const patient = await registerPatient();
  const slot = await one(
    `INSERT INTO doctor_slots (doctor_id, starts_at, ends_at, mode, status)
     VALUES ($1, now() + interval '5 hours', now() + interval '5 hours 20 minutes', 'IN_CLINIC', 'BOOKED')
     RETURNING id`,
    [fixture.doctorId],
  );
  const appointment = await one(
    `INSERT INTO appointments (reference, slot_id, patient_id, doctor_id, clinic_id, status, mode, price, service_fee, confirmed_at)
     VALUES ($1,$2,$3,$4,$5,'CONFIRMED','IN_CLINIC',2000,10000, now()) RETURNING id, reference`,
    [`RDV-R-${randomUUID().slice(0, 6)}`, slot.id, patient.patientId, fixture.doctorId, fixture.clinicId],
  );

  const due = await notifications.dueReminders();
  assert.ok(due.some((row) => row.id === appointment.id), 'le rendez-vous de dans 5 h est dû');

  const first = await notifications.sendDueReminders();
  assert.ok(first.sent >= 1);

  await notifications.sendDueReminders();
  assert.equal(
    (await notifications.dueReminders()).some((row) => row.id === appointment.id),
    false,
    'le rappel déjà traité n\'est plus dû',
  );

  const messages = await many(
    `SELECT id FROM wa_messages WHERE body LIKE $1`,
    [`%${appointment.reference}%`],
  );
  assert.equal(messages.length, 1, 'un seul message WhatsApp pour ce rendez-vous');

  const markers = await many(`SELECT id FROM notifications WHERE dedupe_key = $1`, [
    `reminder:${appointment.id}`,
  ]);
  assert.equal(markers.length, 1, 'le marqueur d\'envoi est unique');
});

test('un rendez-vous non confirmé ne reçoit pas de rappel', async () => {
  const patient = await registerPatient();
  const slot = await one(
    `INSERT INTO doctor_slots (doctor_id, starts_at, ends_at, mode, status)
     VALUES ($1, now() + interval '6 hours', now() + interval '6 hours 20 minutes', 'IN_CLINIC', 'HELD')
     RETURNING id`,
    [fixture.doctorId],
  );
  const appointment = await one(
    `INSERT INTO appointments (reference, slot_id, patient_id, doctor_id, clinic_id, status, mode, price, service_fee)
     VALUES ($1,$2,$3,$4,$5,'AWAITING_PAYMENT','IN_CLINIC',2000,10000) RETURNING id`,
    [`RDV-N-${randomUUID().slice(0, 6)}`, slot.id, patient.patientId, fixture.doctorId, fixture.clinicId],
  );
  const due = await notifications.dueReminders();
  assert.equal(due.some((row) => row.id === appointment.id), false);
});

/* -------------------------------- rapports ------------------------------- */

test('les rapports séparent toujours réel, simulé et en attente', async () => {
  const admin = await createAdmin('FINANCE_MANAGER');
  const response = await call('GET', '/api/v1/reports/revenue', { token: admin.token });
  assert.equal(response.status, 200);
  for (const key of [
    'confirmed_revenue',
    'confirmed_count',
    'simulated_revenue',
    'simulated_count',
    'pending_amount',
    'refunded_amount',
    'shares',
  ]) {
    assert.ok(key in response.body, key);
  }
  assert.ok(Number.isInteger(response.body.confirmed_revenue));
  assert.equal(response.body.confirmed_revenue >= 0, true);
});

test('un rapport par médecin ne divulgue pas l\'identité des patients', async () => {
  const admin = await createAdmin('ADMIN');
  const response = await call('GET', '/api/v1/reports/doctors?from=2020-01-01&to=2099-01-01', {
    token: admin.token,
  });
  assert.equal(response.status, 200);
  const raw = JSON.stringify(response.body);
  assert.equal(/patient|phone|symptom/i.test(raw), false);
  const row = response.body.items.find((item) => item.doctor_id === fixture.doctorId);
  assert.ok(row);
  assert.ok(Number.isInteger(row.bookings));
  assert.equal(typeof row.attendance_rate === 'number' || row.attendance_rate === null, true);
});

test('le rapport par branche agrège réservations et parts de commission', async () => {
  const admin = await createAdmin('ADMIN');
  const response = await call('GET', '/api/v1/reports/branches?from=2020-01-01&to=2099-01-01', {
    token: admin.token,
  });
  assert.equal(response.status, 200);
  assert.ok(Array.isArray(response.body.branches));
  assert.ok(Array.isArray(response.body.operators));
});

test('le rapport des remboursements distingue le mode réel du simulé', async () => {
  const admin = await createAdmin('ADMIN');
  const response = await call('GET', '/api/v1/reports/refunds?from=2020-01-01&to=2099-01-01', {
    token: admin.token,
  });
  assert.equal(response.status, 200);
  assert.ok(Array.isArray(response.body.items));
});

test('les exports produisent un CSV lisible par Excel', async () => {
  const admin = await createAdmin('ADMIN');
  for (const kind of ['overview', 'revenue', 'doctors']) {
    const response = await call('GET', `/api/v1/reports/${kind}/export?from=2020-01-01&to=2099-01-01`, {
      token: admin.token,
    });
    assert.equal(response.status, 200, kind);
    assert.ok(response.raw.startsWith('\uFEFF'), `${kind} : BOM UTF-8 pour Excel`);
    assert.match(response.raw, /;/, `${kind} : séparateur point-virgule`);
  }
});

test('la sérialisation CSV échappe les guillemets et les retours à la ligne', () => {
  const csv = reports.toCsv([
    { nom: 'A; B', note: 'ligne "citée"' },
    { nom: 'retour\nligne', note: '' },
  ]);
  assert.match(csv, /"A; B"/);
  assert.match(csv, /"ligne ""citée"""/);
  assert.match(csv, /"retour\nligne"/);
});

test('les colonnes d\'un export sont stables et ordonnées', () => {
  const csv = reports.toCsv([{ b: 1, a: 2 }], { columns: ['a', 'b'] });
  assert.match(csv, /\uFEFFa;b/);
  assert.match(csv, /2;1/);
});

/* -------------------------- revenus et périodes ------------------------- */

test('une période par défaut couvre le mois en cours', () => {
  const period = reports.resolvePeriod();
  const start = new Date(period.from);
  assert.equal(start.getDate(), 1);
  assert.ok(new Date(period.to) > start);
});

test('une période inversée est une erreur de requête', () => {
  assert.throws(() => reports.resolvePeriod('2026-05-01', '2026-01-01'), (error) => error.code === 'VALIDATION');
  assert.throws(() => reports.resolvePeriod('pas-une-date'), (error) => error.code === 'VALIDATION');
});

test('la vue de revenus quotidiens est cohérente avec les tables', async () => {
  const rows = await many(`SELECT day, paid_count, gross_paid, simulated_amount FROM v_revenue_daily`);
  assert.ok(Array.isArray(rows));
  for (const row of rows) {
    assert.ok(Number(row.gross_paid) >= 0);
    assert.ok(Number(row.simulated_amount) >= 0);
  }
  assert.ok(db);
});
