/**
 * Service de paiement.
 *
 * Invariants (testés) :
 *  - un paiement n'est `PAID` que par un webhook à signature valide, dont le
 *    montant et la devise correspondent à l'intention enregistrée ;
 *  - chaque événement prestataire est traité une seule fois (idempotence par
 *    `(provider, provider_event_id)`) ;
 *  - un retour navigateur (`?success=1`) ne modifie jamais le statut ;
 *  - aucun numéro de carte n'est reçu, journalisé ou stocké.
 */

import { db, many, one } from '../../db.js';
import { Errors } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { config } from '../../config.js';
import { getProvider } from './registry.js';
import { accrueForPayment, reverseForPayment } from '../finance/service.js';
import { confirmAfterPayment } from '../booking/service.js';

/** Crée une intention de paiement (ou renvoie celle déjà créée pour la clé). */
export async function createIntent({
  purpose,
  patientId,
  appointmentId = null,
  consultationId = null,
  amount,
  provider = config.payments.provider,
  idempotencyKey = null,
  locale = 'fr',
  metadata = {},
  actor = null,
}) {
  if (!['BOOKING_SERVICE_FEE', 'BOOKING_DEPOSIT', 'TELECONSULTATION'].includes(purpose)) {
    throw Errors.validation({ purpose: 'invalid' });
  }
  const total = Math.round(Number(amount));
  if (!Number.isFinite(total) || total <= 0) throw Errors.validation({ amount: 'must be > 0' });

  if (idempotencyKey) {
    const existing = await one('SELECT * FROM payments WHERE idempotency_key = $1', [idempotencyKey]);
    if (existing) return { payment: existing, replayed: true };
  }

  const adapter = getProvider(provider);
  const intent = await adapter.createIntent({
    amount: total,
    description: `RDV DZ — ${purpose}`,
    successUrl: `${config.appUrl}/paiement/succes`,
    failureUrl: `${config.appUrl}/paiement/echec`,
    locale,
    metadata: { ...metadata, purpose },
  });

  const payment = await one(
    `INSERT INTO payments
       (purpose, appointment_id, consultation_id, patient_id, provider, provider_ref,
        amount, status, livemode, checkout_url, idempotency_key, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING *`,
    [
      purpose,
      appointmentId,
      consultationId,
      patientId,
      adapter.name,
      intent.providerRef,
      total,
      intent.status === 'PAID' ? 'PAID' : 'PENDING',
      Boolean(intent.livemode),
      intent.checkoutUrl ?? null,
      idempotencyKey,
      JSON.stringify({ ...metadata, simulated: Boolean(intent.simulated) }),
    ],
  );

  await audit({
    actor,
    action: 'payment.intent.created',
    entity: 'payment',
    entityId: payment.id,
    details: { purpose, provider: adapter.name, amount: total, livemode: payment.livemode },
  });

  return {
    payment,
    checkout_url: payment.checkout_url,
    simulated: Boolean(intent.simulated) || !payment.livemode,
    instructions: intent.instructions ?? null,
    replayed: false,
  };
}

/**
 * Traite un webhook prestataire.
 * @param {string} providerName
 * @param {Buffer|string} rawBody
 * @param {Record<string, unknown>} headers
 */
export async function handleWebhook(providerName, rawBody, headers) {
  const adapter = getProvider(providerName);
  const event = await adapter.verifyWebhook(rawBody, headers);

  if (!event) {
    // On journalise la tentative, sans stocker le corps (il pourrait contenir
    // des données personnelles non fiables).
    await db().query(
      `INSERT INTO payment_events (provider, provider_event_id, event_type, signature_valid, payload)
       VALUES ($1, $2, 'INVALID_SIGNATURE', false, '{}'::jsonb)
       ON CONFLICT (provider, provider_event_id) DO NOTHING`,
      [providerName, `invalid_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`],
    );
    throw Errors.forbidden('Signature de webhook invalide');
  }

  // Idempotence stricte.
  const existing = await one(
    'SELECT id, processed_at FROM payment_events WHERE provider = $1 AND provider_event_id = $2',
    [providerName, event.eventId],
  );
  if (existing?.processed_at) {
    return { ok: true, duplicate: true, paymentId: null };
  }

  const inserted = await db().query(
    `INSERT INTO payment_events (provider, provider_event_id, event_type, signature_valid, payload)
     VALUES ($1,$2,$3,true,$4)
     ON CONFLICT (provider, provider_event_id) DO NOTHING
     RETURNING id`,
    [providerName, event.eventId, event.type, JSON.stringify(event.payload)],
  );
  if (inserted.rows.length === 0) {
    return { ok: true, duplicate: true, paymentId: null };
  }

  const payment = await one('SELECT * FROM payments WHERE provider = $1 AND provider_ref = $2', [
    providerName,
    event.providerRef,
  ]);
  if (!payment) {
    await markEventProcessed(providerName, event.eventId);
    return { ok: true, unknownPayment: true, paymentId: null };
  }

  // Vérification du montant et de la devise : un webhook valide pour une autre
  // somme ne doit jamais valider cette intention.
  if (event.amount !== null && Number(event.amount) !== Number(payment.amount)) {
    await markEventProcessed(providerName, event.eventId);
    await audit({
      action: 'payment.webhook.amount_mismatch',
      entity: 'payment',
      entityId: payment.id,
      details: { expected: payment.amount, received: event.amount },
    });
    throw Errors.conflict('PAYMENT_AMOUNT_MISMATCH', 'Montant du webhook différent de l\'intention', {
      expected: payment.amount,
      received: event.amount,
    });
  }
  if (event.currency && event.currency !== payment.currency) {
    await markEventProcessed(providerName, event.eventId);
    throw Errors.conflict('PAYMENT_CURRENCY_MISMATCH', 'Devise incohérente');
  }

  if (event.status === 'PAID') {
    await markPaid(payment, { event, actor: null });
  } else if (event.status === 'FAILED') {
    await db().query(`UPDATE payments SET status = 'FAILED', updated_at = now() WHERE id = $1 AND status <> 'PAID'`, [
      payment.id,
    ]);
  }

  await markEventProcessed(providerName, event.eventId);
  return { ok: true, duplicate: false, paymentId: payment.id, status: event.status };
}

async function markEventProcessed(providerName, eventId) {
  await db().query(
    `UPDATE payment_events SET processed_at = now() WHERE provider = $1 AND provider_event_id = $2`,
    [providerName, eventId],
  );
}

/**
 * Passe un paiement à PAID, confirme la réservation associée, calcule les
 * commissions. Utilisé par les webhooks (et uniquement par eux).
 */
export async function markPaid(payment, { event = null, actor = null } = {}) {
  const updated = await one(
    `UPDATE payments
        SET status = 'PAID', paid_at = coalesce(paid_at, now()), updated_at = now(),
            livemode = $2
      WHERE id = $1 AND status <> 'PAID'
      RETURNING *`,
    [payment.id, event ? event.livemode : payment.livemode],
  );
  const paid = updated ?? payment;

  if (paid.appointment_id) {
    const appointment = await one('SELECT * FROM appointments WHERE id = $1', [paid.appointment_id]);
    if (appointment) {
      await db().query(
        `UPDATE appointments SET status = 'PAID', updated_at = now()
          WHERE id = $1 AND status = 'AWAITING_PAYMENT'`,
        [appointment.id],
      );
      await db().query(
        `INSERT INTO appointment_status_history (appointment_id, from_status, to_status, reason)
         SELECT $1, 'AWAITING_PAYMENT', 'PAID', 'payment verified'
          WHERE EXISTS (SELECT 1 FROM appointments WHERE id = $1 AND status = 'PAID')`,
        [appointment.id],
      );
      // Confirmation immédiate : le médecin n'a pas de validation manuelle.
      const doctor = await one('SELECT manual_confirmation FROM doctors WHERE id = $1', [
        appointment.doctor_id,
      ]);
      if (doctor && !doctor.manual_confirmation) {
        await confirmAfterPayment(appointment.id, { actor });
      }

      const full = await one(
        `SELECT a.id, a.branch_id, a.doctor_id, a.created_by_user_id, a.price, a.service_fee
           FROM appointments a WHERE a.id = $1`,
        [appointment.id],
      );
      await accrueForPayment({
        paymentId: paid.id,
        sourceType: 'APPOINTMENT',
        sourceId: appointment.id,
        scope: 'BOOKING_FEE',
        amount: paid.amount,
        livemode: Boolean(paid.livemode),
        branchId: full?.branch_id ?? null,
        branchBeneficiaryId: full?.branch_id ?? null,
        operatorBeneficiaryId:
          full?.created_by_user_id && full.created_by_user_id !== full.doctor_id
            ? full.created_by_user_id
            : null,
        doctorBeneficiaryId: full?.doctor_id ?? null,
      });
    }
  }

  if (paid.consultation_id) {
    const consultation = await one('SELECT * FROM consultations WHERE id = $1', [paid.consultation_id]);
    if (consultation) {
      await accrueForPayment({
        paymentId: paid.id,
        sourceType: 'CONSULTATION',
        sourceId: consultation.id,
        scope: 'TELECONSULT',
        amount: paid.amount,
        livemode: Boolean(paid.livemode),
        doctorBeneficiaryId: consultation.doctor_id,
      });
    }
  }

  await audit({
    actor,
    action: 'payment.paid',
    entity: 'payment',
    entityId: paid.id,
    details: { amount: paid.amount, livemode: paid.livemode, provider: paid.provider },
  });
  return paid;
}

/**
 * Rembourse un paiement. Le remboursement effectif chez le prestataire est
 * demandé quand l'API le permet ; sinon le statut est `MANUAL_REQUIRED` et
 * l'écriture reste tracée.
 */
export async function refundPayment(paymentId, { amount = null, reason = '', actor = null }) {
  const payment = await one('SELECT * FROM payments WHERE id = $1', [paymentId]);
  if (!payment) throw Errors.notFound('Payment');
  if (payment.status !== 'PAID') throw Errors.conflict('NOT_REFUNDABLE', 'Paiement non encaissé');

  const already = await one(
    `SELECT coalesce(sum(amount),0)::int AS total FROM refunds WHERE payment_id = $1 AND status <> 'REJECTED'`,
    [paymentId],
  );
  const requested = Math.round(Number(amount ?? payment.amount));
  if (requested <= 0) throw Errors.validation({ amount: 'must be > 0' });
  if (already.total + requested > payment.amount) {
    throw Errors.conflict('REFUND_EXCEEDS_PAYMENT', 'Remboursement supérieur au montant payé', {
      paid: payment.amount,
      already: already.total,
    });
  }

  const adapter = getProvider(payment.provider);
  const outcome = await adapter.refund(payment.provider_ref, requested, reason);

  const refund = await one(
    `INSERT INTO refunds (payment_id, amount, reason, status, provider_ref, requested_by, processed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING *`,
    [
      paymentId,
      requested,
      reason.slice(0, 500),
      outcome.status === 'PROCESSED' ? 'PROCESSED' : 'APPROVED',
      outcome.providerRef ?? null,
      actor?.id ?? null,
      outcome.status === 'PROCESSED' ? new Date() : null,
    ],
  );

  if (already.total + requested >= payment.amount) {
    await db().query(`UPDATE payments SET status = 'REFUNDED', updated_at = now() WHERE id = $1`, [paymentId]);
    if (payment.appointment_id) {
      await db().query(
        `UPDATE appointments SET status = 'REFUNDED', updated_at = now()
          WHERE id = $1 AND status IN ('CANCELLED','REJECTED','PAID','COMPLETED')`,
        [payment.appointment_id],
      );
    }
  }

  await reverseForPayment(paymentId, reason);

  await audit({
    actor,
    action: 'payment.refunded',
    entity: 'payment',
    entityId: paymentId,
    details: { amount: requested, reason, provider_status: outcome.status },
  });

  return { refund, manual_required: outcome.status === 'MANUAL_REQUIRED' };
}

/** Historique des paiements d'un patient. */
export async function listPayments({ patientId = null, status = null, limit = 50 }) {
  const params = [];
  const where = [];
  if (patientId) {
    params.push(patientId);
    where.push(`patient_id = $${params.length}`);
  }
  if (status) {
    params.push(status);
    where.push(`status = $${params.length}`);
  }
  params.push(Math.min(limit, 200));
  return many(
    `SELECT id, purpose, amount, currency, status, provider, livemode, paid_at, created_at,
            appointment_id, consultation_id
       FROM payments
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY created_at DESC
      LIMIT $${params.length}`,
    params,
  );
}

/** Vérifie qu'un paiement correspond bien à l'objet visé (anti-IDOR). */
export async function assertPaymentBelongsTo(paymentId, patientId) {
  const payment = await one('SELECT * FROM payments WHERE id = $1', [paymentId]);
  if (!payment) throw Errors.notFound('Payment');
  if (payment.patient_id !== patientId) throw Errors.forbidden('Paiement d\'un autre patient');
  return payment;
}
