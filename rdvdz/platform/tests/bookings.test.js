/**
 * Réservation : disponibilité, verrou de paiement, anti-double réservation,
 * transitions de statut, annulation, reprogrammation, expiration des verrous.
 */

import './env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  setup,
  teardown,
  call,
  registerPatient,
  createVerifiedDoctorWithSlots,
} from './helpers.js';
import { db } from '../src/db.js';
import { releaseExpiredHolds } from '../src/modules/booking/service.js';
import { clearAll as clearRateLimits } from '../src/lib/rate-limit.js';

let fixture;

test.before(async () => {
  await setup();
  fixture = await createVerifiedDoctorWithSlots({ slotCount: 8, fee: 2000 });
});

test.after(async () => {
  await teardown();
});

test.beforeEach(() => clearRateLimits());

test('le profil public expose les tarifs, les frais de service et les créneaux', async () => {
  const profile = await call('GET', `/api/v1/doctors/${fixture.doctorId}`);
  assert.equal(profile.status, 200);
  assert.equal(profile.body.doctor.verified, true);
  assert.equal(profile.body.doctor.consultation_fee, 2000);
  assert.equal(profile.body.fees.service_fee, 10000, '100,00 DZD exprimés en centimes');
  assert.ok(profile.body.slots.length >= 8);
  assert.ok(profile.body.slots[0].starts_at);
  assert.equal(profile.body.doctor.rating_count, 0);
});

test('la recherche filtre par spécialité, wilaya et texte', async () => {
  const bySpecialty = await call('GET', '/api/v1/doctors?specialty=GENERAL&wilaya=16');
  assert.ok(bySpecialty.body.items.length >= 1);

  const wrongWilaya = await call('GET', '/api/v1/doctors?wilaya=9');
  assert.equal(wrongWilaya.body.items.length, 0);

  const byName = await call('GET', '/api/v1/doctors?q=Dr%20Test');
  assert.ok(byName.body.items.length >= 1);

  const byClinic = await call('GET', '/api/v1/doctors?q=Clinique%20Test');
  assert.ok(byClinic.body.items.length >= 1);
});

test('une réservation avec frais place un verrou et exige un paiement', async () => {
  const patient = await registerPatient();
  const slot = fixture.slots[0];

  const booking = await call('POST', '/api/v1/bookings', {
    token: patient.token,
    csrf: patient.csrf,
    headers: { 'idempotency-key': 'test-hold-1' },
    body: { slot_id: slot.id },
  });
  assert.equal(booking.status, 201);
  assert.equal(booking.body.appointment.status, 'AWAITING_PAYMENT');
  assert.equal(booking.body.payment_required, true);
  assert.ok(booking.body.hold_expires_at);
  assert.equal(booking.body.appointment.service_fee, 10000);

  const slotRow = await db().query('SELECT status, hold_expires_at FROM doctor_slots WHERE id = $1', [slot.id]);
  assert.equal(slotRow.rows[0].status, 'HELD');

  const hold = await db().query('SELECT * FROM booking_holds WHERE slot_id = $1 AND released_at IS NULL', [slot.id]);
  assert.equal(hold.rows.length, 1);
});

test('le même créneau ne peut pas être réservé deux fois (409 SLOT_TAKEN)', async () => {
  const first = await registerPatient();
  const second = await registerPatient();

  const a = await call('POST', '/api/v1/bookings', {
    token: first.token,
    csrf: first.csrf,
    body: { slot_id: fixture.slots[1].id },
  });
  assert.equal(a.status, 201);

  const b = await call('POST', '/api/v1/bookings', {
    token: second.token,
    csrf: second.csrf,
    body: { slot_id: fixture.slots[1].id },
  });
  assert.equal(b.status, 409);
  assert.equal(b.body.error.code, 'SLOT_TAKEN');
});

test('20 réservations concurrentes sur un créneau : une seule réussit', async () => {
  const slot = fixture.slots[2];
  const patients = [];
  for (let i = 0; i < 20; i += 1) {
    // Séquentiel : on ne teste pas ici la limitation de débit (test dédié).
    patients.push(await registerPatient());
  }

  const results = await Promise.all(
    patients.map((patient) =>
      call('POST', '/api/v1/bookings', {
        token: patient.token,
        csrf: patient.csrf,
        body: { slot_id: slot.id },
      }),
    ),
  );

  const success = results.filter((r) => r.status === 201);
  const conflicts = results.filter((r) => r.status === 409);
  assert.equal(success.length, 1, 'exactement une réservation acceptée');
  assert.equal(conflicts.length, 19);
  assert.ok(conflicts.every((r) => r.body.error.code === 'SLOT_TAKEN'));

  const rows = await db().query('SELECT count(*)::int AS n FROM appointments WHERE slot_id = $1', [slot.id]);
  assert.equal(rows.rows[0].n, 1, 'une seule ligne en base');
});

test('la clé d\'idempotence renvoie la même réservation sans doublon', async () => {
  const patient = await registerPatient();
  const key = 'idem-booking-42';
  const body = { slot_id: fixture.slots[3].id };

  const first = await call('POST', '/api/v1/bookings', {
    token: patient.token,
    csrf: patient.csrf,
    headers: { 'idempotency-key': key },
    body,
  });
  const second = await call('POST', '/api/v1/bookings', {
    token: patient.token,
    csrf: patient.csrf,
    headers: { 'idempotency-key': key },
    body,
  });

  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.equal(second.body.replayed, true);
  assert.equal(second.body.appointment.id, first.body.appointment.id);
});

test('le paiement sandbox confirme la réservation et réserve le créneau', async () => {
  const patient = await registerPatient();
  const booking = await call('POST', '/api/v1/bookings', {
    token: patient.token,
    csrf: patient.csrf,
    body: { slot_id: fixture.slots[4].id },
  });
  const appointmentId = booking.body.appointment.id;

  const intent = await call('POST', '/api/v1/payments/intents', {
    token: patient.token,
    csrf: patient.csrf,
    body: { purpose: 'BOOKING_SERVICE_FEE', appointment_id: appointmentId },
  });
  assert.equal(intent.status, 201);
  assert.equal(intent.body.simulated, true, 'le mode sandbox est signalé explicitement');
  assert.equal(intent.body.livemode, false);

  const pay = await call('POST', `/api/v1/payments/${intent.body.payment_id}/sandbox-pay`, {
    token: patient.token,
    csrf: patient.csrf,
  });
  assert.equal(pay.status, 200);
  assert.equal(pay.body.simulated, true);

  const detail = await call('GET', `/api/v1/bookings/${appointmentId}`, { token: patient.token });
  assert.equal(detail.body.appointment.status, 'CONFIRMED');
  assert.ok(detail.body.appointment.confirmed_at);

  const slot = await db().query('SELECT status, hold_expires_at FROM doctor_slots WHERE id = $1', [
    fixture.slots[4].id,
  ]);
  assert.equal(slot.rows[0].status, 'BOOKED');
  assert.equal(slot.rows[0].hold_expires_at, null);

  // L'historique complet est présent.
  const statuses = detail.body.history.map((h) => h.to_status);
  assert.deepEqual(statuses, ['AWAITING_PAYMENT', 'PAID', 'CONFIRMED']);

  // Le paiement simulé ne génère AUCUN revenu comptable.
  const revenue = await db().query(
    `SELECT count(*)::int AS n FROM commissions WHERE source_id = $1`,
    [appointmentId],
  );
  assert.equal(revenue.rows[0].n, 0, 'un paiement simulé ne produit pas de commission');
});

test('un rendez-vous gratuit est confirmé immédiatement, sans paiement', async () => {
  await db().query(`UPDATE system_settings SET value = '{"amount": 0}'::jsonb WHERE key = 'public.service_fee'`);
  try {
    const patient = await registerPatient();
    const booking = await call('POST', '/api/v1/bookings', {
      token: patient.token,
      csrf: patient.csrf,
      body: { slot_id: fixture.slots[5].id },
    });
    assert.equal(booking.status, 201);
    assert.equal(booking.body.payment_required, false);
    assert.equal(booking.body.appointment.status, 'CONFIRMED');
  } finally {
    await db().query(`UPDATE system_settings SET value = '{"amount": 10000}'::jsonb WHERE key = 'public.service_fee'`);
  }
});

test('annulation : créneau libéré, remboursement calculé, historique tracé', async () => {
  const patient = await registerPatient();
  const booking = await call('POST', '/api/v1/bookings', {
    token: patient.token,
    csrf: patient.csrf,
    body: { slot_id: fixture.slots[6].id },
  });
  const appointmentId = booking.body.appointment.id;

  const cancel = await call('POST', `/api/v1/bookings/${appointmentId}/cancel`, {
    token: patient.token,
    csrf: patient.csrf,
    body: { reason: 'empêchement' },
  });
  assert.equal(cancel.status, 200);
  assert.equal(cancel.body.appointment.status, 'CANCELLED');
  assert.equal(cancel.body.refund.eligible, false, 'aucun paiement : pas de remboursement');
  assert.equal(cancel.body.refund.percent, 0);

  const slot = await db().query('SELECT status FROM doctor_slots WHERE id = $1', [fixture.slots[6].id]);
  assert.equal(slot.rows[0].status, 'OPEN', 'le créneau redevient disponible');

  const again = await call('POST', `/api/v1/bookings/${appointmentId}/cancel`, {
    token: patient.token,
    csrf: patient.csrf,
  });
  assert.equal(again.status, 409, 'une deuxième annulation est refusée');
});

test('reprogrammation : ancien créneau libéré, nouveau réservé, dans une seule transaction', async () => {
  const patient = await registerPatient();
  const booking = await call('POST', '/api/v1/bookings', {
    token: patient.token,
    csrf: patient.csrf,
    body: { slot_id: fixture.slots[7].id },
  });
  const appointmentId = booking.body.appointment.id;

  // Créer un créneau cible libre.
  const target = await db().query(
    `INSERT INTO doctor_slots (doctor_id, starts_at, ends_at, mode, status)
     VALUES ($1, now() + interval '10 days', now() + interval '10 days 20 minutes', 'IN_CLINIC', 'OPEN')
     RETURNING id`,
    [fixture.doctorId],
  );
  const targetId = target.rows[0].id;

  const rescheduled = await call('POST', `/api/v1/bookings/${appointmentId}/reschedule`, {
    token: patient.token,
    csrf: patient.csrf,
    body: { slot_id: targetId },
  });
  assert.equal(rescheduled.status, 200);
  assert.equal(rescheduled.body.appointment.slot_id, targetId);

  const old = await db().query('SELECT status FROM doctor_slots WHERE id = $1', [fixture.slots[7].id]);
  assert.equal(old.rows[0].status, 'OPEN');
  const fresh = await db().query('SELECT status FROM doctor_slots WHERE id = $1', [targetId]);
  assert.ok(['HELD', 'BOOKED'].includes(fresh.rows[0].status));
});

test('les verrous expirés sont libérés et la réservation annulée', async () => {
  const patient = await registerPatient();
  const slot = await db().query(
    `INSERT INTO doctor_slots (doctor_id, starts_at, ends_at, mode, status)
     VALUES ($1, now() + interval '11 days', now() + interval '11 days 20 minutes', 'IN_CLINIC', 'OPEN')
     RETURNING id`,
    [fixture.doctorId],
  );
  const booking = await call('POST', '/api/v1/bookings', {
    token: patient.token,
    csrf: patient.csrf,
    body: { slot_id: slot.rows[0].id },
  });
  assert.equal(booking.status, 201);

  // On force l'expiration du verrou.
  await db().query(
    `UPDATE doctor_slots SET hold_expires_at = now() - interval '1 minute' WHERE id = $1`,
    [slot.rows[0].id],
  );
  const released = await releaseExpiredHolds();
  assert.equal(released.released, 1);

  const slotAfter = await db().query('SELECT status FROM doctor_slots WHERE id = $1', [slot.rows[0].id]);
  assert.equal(slotAfter.rows[0].status, 'OPEN');
  const appointmentAfter = await db().query('SELECT status FROM appointments WHERE id = $1', [
    booking.body.appointment.id,
  ]);
  assert.equal(appointmentAfter.rows[0].status, 'CANCELLED');
});

test('transitions interdites : impossible de terminer un rendez-vous non confirmé', async () => {
  const patient = await registerPatient();
  const slot = await db().query(
    `INSERT INTO doctor_slots (doctor_id, starts_at, ends_at, mode, status)
     VALUES ($1, now() + interval '12 days', now() + interval '12 days 20 minutes', 'IN_CLINIC', 'OPEN')
     RETURNING id`,
    [fixture.doctorId],
  );
  const booking = await call('POST', '/api/v1/bookings', {
    token: patient.token,
    csrf: patient.csrf,
    body: { slot_id: slot.rows[0].id },
  });

  const complete = await call('POST', `/api/v1/bookings/${booking.body.appointment.id}/complete`, {
    token: fixture.doctorLogin.token,
    csrf: fixture.doctorLogin.csrf,
  });
  assert.equal(complete.status, 409);
  assert.equal(complete.body.error.code, 'INVALID_TRANSITION');
});

test('un patient ne peut ni voir ni annuler le rendez-vous d\'un autre', async () => {
  const owner = await registerPatient();
  const intruder = await registerPatient();
  const slot = await db().query(
    `INSERT INTO doctor_slots (doctor_id, starts_at, ends_at, mode, status)
     VALUES ($1, now() + interval '13 days', now() + interval '13 days 20 minutes', 'IN_CLINIC', 'OPEN')
     RETURNING id`,
    [fixture.doctorId],
  );
  const booking = await call('POST', '/api/v1/bookings', {
    token: owner.token,
    csrf: owner.csrf,
    body: { slot_id: slot.rows[0].id },
  });

  const read = await call('GET', `/api/v1/bookings/${booking.body.appointment.id}`, { token: intruder.token });
  assert.equal(read.status, 403);

  const cancel = await call('POST', `/api/v1/bookings/${booking.body.appointment.id}/cancel`, {
    token: intruder.token,
    csrf: intruder.csrf,
  });
  assert.equal(cancel.status, 403);
});

test('le reçu est du HTML autonome, bilingue et sans ressource externe', async () => {
  const patient = await registerPatient();
  const slot = await db().query(
    `INSERT INTO doctor_slots (doctor_id, starts_at, ends_at, mode, status)
     VALUES ($1, now() + interval '14 days', now() + interval '14 days 20 minutes', 'IN_CLINIC', 'OPEN')
     RETURNING id`,
    [fixture.doctorId],
  );
  const booking = await call('POST', '/api/v1/bookings', {
    token: patient.token,
    csrf: patient.csrf,
    body: { slot_id: slot.rows[0].id },
  });
  const receipt = await call('GET', `/api/v1/bookings/${booking.body.appointment.id}/receipt`, {
    token: patient.token,
  });
  assert.equal(receipt.status, 200);
  assert.match(receipt.raw, /RDV DZ/);
  assert.match(receipt.raw, /رسوم الخدمة/);
  assert.doesNotMatch(receipt.raw, /https?:\/\//, 'aucune ressource distante');
});

test('un créneau inexistant renvoie 404 sans exposer la base', async () => {
  const patient = await registerPatient();
  const response = await call('POST', '/api/v1/bookings', {
    token: patient.token,
    csrf: patient.csrf,
    body: { slot_id: '00000000-0000-0000-0000-000000000000' },
  });
  assert.equal(response.status, 404);
  assert.equal(response.body.error.code, 'NOT_FOUND');
});
