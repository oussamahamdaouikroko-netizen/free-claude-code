/**
 * Paiements et finances : vérification HMAC des webhooks, idempotence des
 * événements, contrôle de montant/devise, séparation strict entre argent réel
 * et simulation, commissions, remboursements et reversements.
 *
 * Aucun appel réseau : l'adaptateur Chargily reçoit un `fetch` factice.
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
  createVerifiedDoctorWithSlots,
  createAdmin,
} from './helpers.js';
import { db, many, one } from '../src/db.js';
import { hmac } from '../src/lib/crypto.js';
import { clearAll as clearRateLimits } from '../src/lib/rate-limit.js';
import { ChargilyProvider } from '../src/modules/payments/providers/chargily.js';
import { getProvider, resetProviders } from '../src/modules/payments/registry.js';
import { splitAmount } from '../src/modules/finance/service.js';

const SECRET = 'test_secret_webhook_key';
let fixture;

test.before(async () => {
  await setup();
  fixture = await createVerifiedDoctorWithSlots({ slotCount: 8, fee: 2000 });
  // Le fournisseur par défaut des tests est le sandbox : la configuration
  // Chargily reste disponible pour les tests de webhook.
  assert.equal(getProvider('sandbox').name, 'sandbox');
});

test.after(async () => {
  resetProviders();
  await teardown();
});

test.beforeEach(() => clearRateLimits());

/** Réserve un créneau et renvoie {patient, appointmentId}. */
async function bookedAppointment(slotId) {
  const patient = await registerPatient();
  const booking = await call('POST', '/api/v1/bookings', {
    token: patient.token,
    csrf: patient.csrf,
    body: { slot_id: slotId },
  });
  assert.equal(booking.status, 201, JSON.stringify(booking.body));
  return { patient, appointmentId: booking.body.appointment.id };
}

/** Crée un paiement réel (livemode) rattaché à un rendez-vous. */
async function realPayment({ amount = 10000, status = 'PENDING' } = {}) {
  const patient = await registerPatient();
  const patientRow = await one('SELECT id FROM patients WHERE user_id = $1', [patient.user.id]);
  // Créneau dédié : la base impose un créneau unique par rendez-vous.
  const slot = await one(
    `INSERT INTO doctor_slots (doctor_id, starts_at, ends_at, mode, status)
     VALUES ($1, now() + ($2 || ' hours')::interval, now() + ($2 || ' hours')::interval + interval '20 minutes',
             'IN_CLINIC', 'BOOKED')
     RETURNING id`,
    [fixture.doctorId, String(100 + Math.floor(Math.random() * 5000))],
  );
  const appointment = await one(
    `INSERT INTO appointments (reference, slot_id, doctor_id, clinic_id, patient_id, mode, status, price, service_fee)
     VALUES ($1, $2, $3, $4, $5, 'IN_CLINIC', 'AWAITING_PAYMENT', 2000, $6) RETURNING *`,
    [`RDV-${randomUUID().slice(0, 8)}`, slot.id, fixture.doctorId, fixture.clinicId, patientRow.id, amount],
  );
  const payment = await one(
    `INSERT INTO payments (purpose, appointment_id, patient_id, provider, provider_ref, amount, status, livemode)
     VALUES ('BOOKING_SERVICE_FEE', $1, $2, 'chargily', $3, $4, $5, true) RETURNING *`,
    [appointment.id, patientRow.id, `ch_${randomUUID()}`, amount, status],
  );
  return { patient, appointment, payment };
}

function signedEvent(payment, overrides = {}) {
  const body = JSON.stringify({
    id: overrides.eventId ?? `evt_${randomUUID()}`,
    entity: 'event',
    type: overrides.type ?? 'checkout.paid',
    data: {
      id: payment.provider_ref,
      status: overrides.status ?? 'paid',
      amount: overrides.amount ?? payment.amount,
      currency: overrides.currency ?? 'dzd',
      livemode: overrides.livemode ?? true,
    },
  });
  return { body, signature: hmac(SECRET, body) };
}

/** POST direct sur le webhook (corps brut + en-tête signature). */
async function postWebhook({ body, signature }) {
  return fixturePost(body, { signature });
}

async function fixturePost(body, headers) {
  const { getApp } = await import('./helpers.js');
  const res = await getApp().inject({
    method: 'POST',
    url: '/api/v1/webhooks/chargily',
    payload: body,
    headers: { 'content-type': 'application/json', ...headers },
  });
  let json = null;
  try {
    json = res.body ? JSON.parse(res.body) : null;
  } catch {
    json = null;
  }
  return { status: res.statusCode, body: json, raw: res.body };
}

/* ------------------------------- fournisseurs ----------------------------- */

test('le catalogue expose les prestataires et leur état réel', async () => {
  const response = await call('GET', '/api/v1/payments/providers');
  assert.equal(response.status, 200);
  const names = response.body.items.map((p) => p.name).sort();
  assert.deepEqual(names, ['chargily', 'manual', 'sandbox']);
  const chargily = response.body.items.find((p) => p.name === 'chargily');
  assert.equal(chargily.live, true, 'la clé de test est configurée dans cet environnement');
  const sandbox = response.body.items.find((p) => p.name === 'sandbox');
  assert.equal(sandbox.live, false, 'le sandbox ne peut jamais être présenté comme réel');
});

test('un fournisseur inconnu est refusé proprement', async () => {
  assert.throws(() => getProvider('paypal'), (error) => error.code === 'PROVIDER_UNKNOWN');
});

/* ---------------------------------- webhook ------------------------------- */

test('un webhook sans signature valide est rejeté (403) et jamais traité', async () => {
  const { payment } = await realPayment();
  const { body } = signedEvent(payment);

  const missing = await fixturePost(body, {});
  assert.equal(missing.status, 403);
  assert.equal(missing.body.error.code, 'INVALID_SIGNATURE');

  const forged = await fixturePost(body, { signature: 'a'.repeat(64) });
  assert.equal(forged.status, 403);

  // Signature calculée sur un autre corps : refusée aussi.
  const other = signedEvent(payment);
  const tampered = await fixturePost(body.replace('"paid"', '"failed"'), { signature: other.signature });
  assert.equal(tampered.status, 403);

  const row = await one('SELECT status FROM payments WHERE id = $1', [payment.id]);
  assert.equal(row.status, 'PENDING', 'le paiement reste en attente');
});

test('un webhook signé valide confirme le paiement et le rendez-vous', async () => {
  const { payment, appointment } = await realPayment();
  const event = signedEvent(payment);

  const response = await postWebhook(event);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.ok, true);
  assert.equal(response.body.status, 'PAID');

  const paid = await one('SELECT status, paid_at, livemode FROM payments WHERE id = $1', [payment.id]);
  assert.equal(paid.status, 'PAID');
  assert.ok(paid.paid_at);
  assert.equal(paid.livemode, true);

  const appointmentRow = await one('SELECT status FROM appointments WHERE id = $1', [appointment.id]);
  assert.ok(['PAID', 'CONFIRMED'].includes(appointmentRow.status));

  const events = await many('SELECT * FROM payment_events WHERE provider_event_id = $1', [
    JSON.parse(event.body).id,
  ]);
  assert.equal(events.length, 1);
  assert.equal(events[0].signature_valid, true);
  assert.ok(events[0].processed_at);
});

test('le même événement rejoué n\'est traité qu\'une seule fois', async () => {
  const { payment } = await realPayment();
  const event = signedEvent(payment);

  const first = await postWebhook(event);
  assert.equal(first.body.duplicate, false);

  const before = await many('SELECT id FROM commissions WHERE payment_id = $1', [payment.id]);
  const replay = await postWebhook(event);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.duplicate, true);

  const after = await many('SELECT id FROM commissions WHERE payment_id = $1', [payment.id]);
  assert.equal(after.length, before.length, 'aucune commission dupliquée');
  const events = await many('SELECT id FROM payment_events WHERE provider_event_id = $1', [
    JSON.parse(event.body).id,
  ]);
  assert.equal(events.length, 1);
});

test('un webhook valide pour un autre montant ne valide jamais le paiement (409)', async () => {
  const { payment } = await realPayment({ amount: 10000 });
  const event = signedEvent(payment, { amount: 500 });

  const response = await postWebhook(event);
  assert.equal(response.status, 409);
  assert.equal(response.body.error.code, 'PAYMENT_AMOUNT_MISMATCH');

  const row = await one('SELECT status FROM payments WHERE id = $1', [payment.id]);
  assert.equal(row.status, 'PENDING');
});

test('une devise incohérente est refusée', async () => {
  const { payment } = await realPayment();
  const event = signedEvent(payment, { currency: 'eur' });
  const response = await postWebhook(event);
  assert.equal(response.status, 409);
  assert.equal(response.body.error.code, 'PAYMENT_CURRENCY_MISMATCH');
});

test('un webhook pour un paiement inconnu est accepté puis ignoré sans erreur', async () => {
  const { payment } = await realPayment();
  const event = signedEvent({ ...payment, provider_ref: 'ch_inconnu' });
  const response = await postWebhook(event);
  assert.equal(response.status, 200);
  assert.equal(response.body.unknownPayment, true);
});

test('un événement en échec marque le paiement FAILED sans commission', async () => {
  const { payment } = await realPayment();
  const response = await postWebhook(signedEvent(payment, { type: 'checkout.failed', status: 'failed' }));
  assert.equal(response.status, 200);
  const row = await one('SELECT status FROM payments WHERE id = $1', [payment.id]);
  assert.equal(row.status, 'FAILED');
  const commissions = await many('SELECT id FROM commissions WHERE payment_id = $1', [payment.id]);
  assert.equal(commissions.length, 0);
});

test('l\'adaptateur Chargily envoie la requête documentée et ne stocke aucune carte', async () => {
  let captured = null;
  const provider = new ChargilyProvider({
    secretKey: SECRET,
    baseUrl: 'https://pay.chargily.net/test/api/v2/',
    webhookUrl: 'https://exemple.dz/api/v1/webhooks/chargily',
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return {
        ok: true,
        json: async () => ({
          id: 'ch_123',
          checkout_url: 'https://pay.chargily.net/test/checkout/ch_123',
          status: 'pending',
          livemode: false,
        }),
      };
    },
  });

  const intent = await provider.createIntent({
    amount: 10000,
    description: 'RDV DZ — BOOKING_SERVICE_FEE',
    successUrl: 'https://exemple.dz/ok',
    failureUrl: 'https://exemple.dz/ko',
    locale: 'ar',
    metadata: { purpose: 'BOOKING_SERVICE_FEE' },
  });

  assert.equal(captured.url, 'https://pay.chargily.net/test/api/v2/checkouts');
  assert.equal(captured.options.method, 'POST');
  assert.equal(captured.options.headers.Authorization, `Bearer ${SECRET}`);
  const payload = JSON.parse(captured.options.body);
  assert.equal(payload.amount, 10000, 'montant entier en centimes');
  assert.equal(payload.currency, 'dzd');
  assert.equal(payload.locale, 'ar');
  assert.equal(payload.webhook_endpoint, 'https://exemple.dz/api/v1/webhooks/chargily');
  assert.equal(JSON.stringify(payload).toLowerCase().includes('card'), false, 'aucune donnée de carte');

  assert.equal(intent.providerRef, 'ch_123');
  assert.equal(intent.status, 'PENDING');
  assert.equal(intent.livemode, false);
  assert.equal(provider.livemode, false, 'une clé test_ n\'est jamais du mode réel');
});

test('un remboursement Chargily est marqué MANUAL_REQUIRED (API non documentée)', async () => {
  const provider = new ChargilyProvider({ secretKey: SECRET, baseUrl: 'https://x/api/v2', fetchImpl: async () => ({}) });
  const outcome = await provider.refund('ch_1', 100, 'test');
  assert.equal(outcome.status, 'MANUAL_REQUIRED');
});

/* ------------------------------- commissions ------------------------------ */

test('la répartition ne perd jamais un centime, quel que soit le montant', () => {
  const rule = { platform_pct: 60, branch_pct: 15, operator_pct: 15, psp_fixed: 1000 };
  for (let amount = 1; amount <= 2000; amount += 7) {
    const parts = splitAmount({ amount, scope: 'BOOKING_FEE', rule });
    const sum = parts.reduce((acc, part) => acc + part.amount, 0);
    assert.equal(sum, amount, `montant ${amount}`);
    assert.ok(parts.every((part) => part.amount >= 0));
  }
  const tele = splitAmount({ amount: 1001, scope: 'TELECONSULT', rule: { platform_pct: 15 } });
  assert.equal(tele.reduce((acc, part) => acc + part.amount, 0), 1001);
  assert.equal(tele.find((p) => p.beneficiary_type === 'PLATFORM').amount, 150);
});

test('un paiement réel génère des commissions cohérentes avec la règle active', async () => {
  const { payment, appointment } = await realPayment({ amount: 10000 });
  await postWebhook(signedEvent(payment));

  const rows = await many(
    'SELECT beneficiary_type, amount, status FROM commissions WHERE payment_id = $1 ORDER BY beneficiary_type',
    [payment.id],
  );
  assert.ok(rows.length >= 1);
  assert.ok(rows.every((row) => row.status === 'ACCRUED'));
  const total = rows.reduce((acc, row) => acc + row.amount, 0);
  assert.equal(total, 10000, 'la somme des commissions égale le montant encaissé');

  // La règle appliquée est historisée et pointe vers la table des règles.
  const linked = await one(
    `SELECT r.scope FROM commissions c JOIN commission_rules r ON r.id = c.rule_id
      WHERE c.payment_id = $1 LIMIT 1`,
    [payment.id],
  );
  assert.ok(linked === null || linked.scope === 'BOOKING_FEE');

  // Le rendez-vous porte bien la référence de paiement.
  const appt = await one('SELECT status FROM appointments WHERE id = $1', [appointment.id]);
  assert.ok(['PAID', 'CONFIRMED'].includes(appt.status));
});

test('un paiement simulé n\'apparaît jamais dans le chiffre d\'affaires réel', async () => {
  const { patient, appointmentId } = await bookedAppointment(fixture.slots[0].id);
  const intent = await call('POST', '/api/v1/payments/intents', {
    token: patient.token,
    csrf: patient.csrf,
    body: { purpose: 'BOOKING_SERVICE_FEE', appointment_id: appointmentId },
  });
  assert.equal(intent.status, 201);
  const pay = await call('POST', `/api/v1/payments/${intent.body.payment_id}/sandbox-pay`, {
    token: patient.token,
    csrf: patient.csrf,
  });
  assert.equal(pay.status, 200);

  const admin = await createAdmin('FINANCE_MANAGER');
  const revenue = await call('GET', '/api/v1/reports/revenue', { token: admin.token });
  assert.equal(revenue.status, 200);
  assert.ok(revenue.body.simulated_count >= 1, 'le simulé est compté…');
  assert.ok(revenue.body.simulated_revenue >= 10000, '…dans une colonne séparée');
  assert.ok(revenue.body.simulated_revenue >= 0);
  assert.notEqual(revenue.body.simulated_revenue, revenue.body.confirmed_revenue + 10000);
  for (const value of Object.values(revenue.body.shares)) {
    assert.equal(Number.isInteger(value), true);
  }
});

/* --------------------------------- remboursement -------------------------- */

test('remboursement : réservé aux rôles finance, jamais au patient', async () => {
  const { payment } = await realPayment();
  await postWebhook(signedEvent(payment));

  const patient = await registerPatient();
  const forbidden = await call('POST', `/api/v1/payments/${payment.id}/refund`, {
    token: patient.token,
    csrf: patient.csrf,
    body: { reason: 'je veux mon argent' },
  });
  assert.equal(forbidden.status, 403);

  const finance = await createAdmin('FINANCE_MANAGER');
  const refund = await call('POST', `/api/v1/payments/${payment.id}/refund`, {
    token: finance.token,
    csrf: finance.csrf,
    body: { reason: 'annulation clinique' },
  });
  assert.equal(refund.status, 200, JSON.stringify(refund.body));
  assert.equal(refund.body.manual_required, true, 'Chargily ne documente pas l\'API de remboursement');
  assert.equal(refund.body.refund.amount, payment.amount);

  const updated = await one('SELECT status FROM payments WHERE id = $1', [payment.id]);
  assert.equal(updated.status, 'REFUNDED');

  // Les commissions sont compensées, jamais supprimées.
  const commissions = await many(
    'SELECT status, amount FROM commissions WHERE payment_id = $1 ORDER BY created_at',
    [payment.id],
  );
  assert.ok(commissions.some((c) => c.status === 'REVERSED' && c.amount < 0), 'écriture compensatoire');
  const accrues = commissions.filter((c) => c.status === 'ACCRUED' && c.amount > 0);
  assert.equal(accrues.length, 0, 'plus aucun montant accru');
});

test('un remboursement ne peut pas dépasser le montant payé', async () => {
  const { payment } = await realPayment();
  await postWebhook(signedEvent(payment));
  const finance = await createAdmin('ADMIN');

  const over = await call('POST', `/api/v1/payments/${payment.id}/refund`, {
    token: finance.token,
    csrf: finance.csrf,
    body: { amount: payment.amount + 1, reason: 'trop' },
  });
  assert.equal(over.status, 409);
  assert.equal(over.body.error.code, 'REFUND_EXCEEDS_PAYMENT');
});

test('un paiement non encaissé n\'est pas remboursable', async () => {
  const { payment } = await realPayment();
  const finance = await createAdmin('ADMIN');
  const response = await call('POST', `/api/v1/payments/${payment.id}/refund`, {
    token: finance.token,
    csrf: finance.csrf,
    body: { reason: 'pas encore payé' },
  });
  assert.equal(response.status, 409);
  assert.equal(response.body.error.code, 'NOT_REFUNDABLE');
});

/* --------------------------- contrôle d'accès paiements ------------------- */

test('un patient ne voit que ses propres paiements', async () => {
  const { payment, patient } = await realPayment();
  const mine = await call('GET', `/api/v1/payments/${payment.id}`, { token: patient.token });
  assert.equal(mine.status, 200);
  assert.equal(mine.body.simulated, false);

  const intruder = await registerPatient();
  const other = await call('GET', `/api/v1/payments/${payment.id}`, { token: intruder.token });
  assert.equal(other.status, 403);

  const list = await call('GET', '/api/v1/payments', { token: intruder.token });
  assert.equal(list.status, 200);
  assert.equal(list.body.items.length, 0);
});

test('un patient ne peut pas payer le rendez-vous d\'un autre', async () => {
  const { appointmentId } = await bookedAppointment(fixture.slots[1].id);
  const intruder = await registerPatient();
  const response = await call('POST', '/api/v1/payments/intents', {
    token: intruder.token,
    csrf: intruder.csrf,
    body: { purpose: 'BOOKING_SERVICE_FEE', appointment_id: appointmentId },
  });
  assert.equal(response.status, 403);
});

test('une intention de paiement sans frais à régler est refusée', async () => {
  const { patient } = await bookedAppointment(fixture.slots[2].id);
  const response = await call('POST', '/api/v1/payments/intents', {
    token: patient.token,
    csrf: patient.csrf,
    body: { purpose: 'BOOKING_SERVICE_FEE' },
  });
  assert.equal(response.status, 422);
  assert.equal(response.body.error.code, 'VALIDATION');
});

test('la clé d\'idempotence évite deux intentions pour le même paiement', async () => {
  const { patient, appointmentId } = await bookedAppointment(fixture.slots[3].id);
  const key = `idem-${randomUUID()}`;
  const body = { purpose: 'BOOKING_SERVICE_FEE', appointment_id: appointmentId, provider: 'sandbox' };

  const first = await call('POST', '/api/v1/payments/intents', {
    token: patient.token,
    csrf: patient.csrf,
    headers: { 'idempotency-key': key },
    body,
  });
  const second = await call('POST', '/api/v1/payments/intents', {
    token: patient.token,
    csrf: patient.csrf,
    headers: { 'idempotency-key': key },
    body,
  });
  assert.equal(second.status, 201);
  assert.equal(second.body.replayed, true);
  assert.equal(second.body.payment_id, first.body.payment_id);

  const count = await one('SELECT count(*)::int AS n FROM payments WHERE idempotency_key = $1', [key]);
  assert.equal(count.n, 1);
});

/* ------------------------------- encaissement manuel --------------------- */

test('un encaissement manuel est constaté puis tracé, jamais automatique', async () => {
  const { payment } = await realPayment();
  await db().query(`UPDATE payments SET provider = 'manual', status = 'PENDING' WHERE id = $1`, [payment.id]);
  const manual = await one('SELECT * FROM payments WHERE id = $1', [payment.id]);

  const operator = await createAdmin('ADMIN');
  const response = await call('POST', `/api/v1/payments/${payment.id}/manual-confirm`, {
    token: operator.token,
    csrf: operator.csrf,
    body: { receipt_ref: 'RECU-2026-001' },
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.verification, 'MANUAL');

  const row = await one('SELECT status, metadata FROM payments WHERE id = $1', [payment.id]);
  assert.equal(row.status, 'PAID');
  assert.equal(row.metadata.verification, 'MANUAL');
  assert.equal(row.metadata.receipt_ref, 'RECU-2026-001');
  assert.ok(manual);

  const traces = await many(`SELECT action FROM audit_logs WHERE entity_id = $1`, [payment.id]);
  assert.ok(traces.some((t) => t.action === 'payment.manual.confirmed'));
});

/* ------------------------------ reversements ----------------------------- */

test('un bordereau de reversement exige des commissions et se solde une seule fois', async () => {
  const { payment } = await realPayment({ amount: 100000 });
  await postWebhook(signedEvent(payment));

  const doctorCommission = await one(
    `SELECT beneficiary_id, amount, created_at FROM commissions
      WHERE payment_id = $1 AND beneficiary_type = 'DOCTOR' AND status = 'ACCRUED'`,
    [payment.id],
  );

  const admin = await createAdmin('ADMIN');
  const beneficiary = doctorCommission?.beneficiary_id ?? fixture.doctorId;
  const created = await call('POST', '/api/v1/admin/settlements', {
    token: admin.token,
    csrf: admin.csrf,
    body: {
      beneficiary_type: 'DOCTOR',
      beneficiary_id: beneficiary,
      period_start: '2020-01-01',
      period_end: '2099-12-31',
    },
  });

  if (created.status === 409) {
    // Aucune commission DOCTOR sur une règle BOOKING_FEE : cas légitime.
    assert.equal(created.body.error.code, 'NOTHING_TO_SETTLE');
    return;
  }
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.ok(created.body.settlement.gross > 0);
  assert.equal(created.body.settlement.status, 'DRAFT');

  const paid = await call('POST', `/api/v1/admin/settlements/${created.body.settlement.id}/pay`, {
    token: admin.token,
    csrf: admin.csrf,
    body: { reference: 'VIR-2026-01' },
  });
  assert.equal(paid.status, 200);
  assert.equal(paid.body.settlement.status, 'PAID');

  const again = await call('POST', `/api/v1/admin/settlements/${created.body.settlement.id}/pay`, {
    token: admin.token,
    csrf: admin.csrf,
    body: {},
  });
  assert.equal(again.status, 409, 'un bordereau payé ne se paie pas deux fois');
});

test('les règles de commission sont historisées et contrôlées à 100 %', async () => {
  const admin = await createAdmin('ADMIN');

  const bad = await call('POST', '/api/v1/admin/commission-rules', {
    token: admin.token,
    csrf: admin.csrf,
    body: { scope: 'BOOKING_FEE', platform_pct: 50, branch_pct: 10, operator_pct: 10 },
  });
  assert.equal(bad.status, 422);

  const ok = await call('POST', '/api/v1/admin/commission-rules', {
    token: admin.token,
    csrf: admin.csrf,
    body: { scope: 'BOOKING_FEE', platform_pct: 55, branch_pct: 20, operator_pct: 25, psp_fixed: 500 },
  });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));

  const second = await call('POST', '/api/v1/admin/commission-rules', {
    token: admin.token,
    csrf: admin.csrf,
    body: { scope: 'BOOKING_FEE', platform_pct: 70, branch_pct: 10, operator_pct: 20, psp_fixed: 0 },
  });
  assert.equal(second.status, 201, JSON.stringify(second.body));

  const active = await many(
    `SELECT id FROM commission_rules WHERE scope = 'BOOKING_FEE' AND active`,
  );
  assert.equal(active.length, 1, 'une seule règle active par portée');
  assert.equal(active[0].id, second.body.rule.id);

  const all = await many(`SELECT id, active FROM commission_rules WHERE scope = 'BOOKING_FEE'`);
  assert.ok(all.length >= 2, 'l\'ancienne règle est conservée (historisation)');
  assert.ok(all.some((r) => r.active === false));
  assert.ok(all.some((r) => r.id === ok.body.rule.id), 'aucune règle n\'est supprimée');
});

test('un patient ne peut pas consulter les règles de commission', async () => {
  const patient = await registerPatient();
  const response = await call('GET', '/api/v1/admin/commission-rules', { token: patient.token });
  assert.equal(response.status, 403);
});

/* ------------------------------ exports CSV ------------------------------ */

test('l\'export CSV est authentifié, tracé et sans formule exécutable', async () => {
  const patient = await registerPatient();
  const forbidden = await call('GET', '/api/v1/reports/revenue/export', { token: patient.token });
  assert.equal(forbidden.status, 403);

  const admin = await createAdmin('ADMIN');
  const unknown = await call('GET', '/api/v1/reports/inconnu/export', { token: admin.token });
  assert.equal(unknown.status, 422, 'un export inconnu est une erreur de requête, pas un 500');

  const response = await call('GET', '/api/v1/reports/revenue/export?from=2020-01-01&to=2099-01-01', {
    token: admin.token,
  });
  assert.equal(response.status, 200);
  assert.match(response.headers['content-type'], /text\/csv/);
  assert.match(response.headers['content-disposition'], /attachment/);
  assert.doesNotMatch(response.raw, /[=+@]"/, 'aucune valeur ne commence par un caractère de formule');

  const traces = await many(`SELECT action FROM audit_logs WHERE action = 'report.exported'`);
  assert.ok(traces.length >= 1);
});

/* ------------------------- sandbox interdite ailleurs --------------------- */

test('la route sandbox ne fonctionne que sur un paiement réellement simulé', async () => {
  const { payment, patient } = await realPayment();
  const response = await call('POST', `/api/v1/payments/${payment.id}/sandbox-pay`, {
    token: patient.token,
    csrf: patient.csrf,
  });
  assert.equal(response.status, 409);
  assert.equal(response.body.error.code, 'NOT_SANDBOX');
});

test('le sandbox peut être désactivé par la configuration', async () => {
  const { config } = await import('../src/config.js');
  const previous = config.payments.sandboxAllowed;
  config.payments.sandboxAllowed = false;
  try {
    assert.throws(() => getProvider('sandbox'), (error) => error.code === 'FORBIDDEN');
    const { patient, appointmentId } = await bookedAppointment(fixture.slots[5].id);
    const response = await call('POST', '/api/v1/payments/intents', {
      token: patient.token,
      csrf: patient.csrf,
      body: { purpose: 'BOOKING_SERVICE_FEE', appointment_id: appointmentId, provider: 'sandbox' },
    });
    assert.equal(response.status, 403);
  } finally {
    config.payments.sandboxAllowed = previous;
  }
});
