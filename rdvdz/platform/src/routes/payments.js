/**
 * Routes de paiement : intentions, webhooks signés, sandbox, remboursements.
 *
 * Points de vigilance traduits en code :
 *  - le webhook lit le **corps brut** (`request.rawBody`) ;
 *  - la route sandbox est refusée hors environnement de test ;
 *  - un patient ne peut payer que pour lui-même (anti-IDOR) ;
 *  - un retour navigateur ne change jamais un statut.
 */

import * as payments from '../modules/payments/service.js';
import { providerCatalog, getProvider } from '../modules/payments/registry.js';
import { requireAuth, requireRole, ROLES, STAFF_ROLES, ADMIN_ROLES } from '../lib/security.js';
import { validate, json, toInt } from '../lib/http.js';
import { Errors } from '../lib/errors.js';
import { config } from '../config.js';
import { db, one } from '../db.js';
import { audit } from '../lib/audit.js';

export default async function paymentRoutes(app) {
  app.get('/payments/providers', async (request, reply) => json(reply, 200, { items: providerCatalog() }));

  /** Diagnostic : le fournisseur est-il correctement configuré ? */
  app.get('/payments/providers/health', { preHandler: requireRole(ADMIN_ROLES) }, async (request, reply) => {
    const provider = getProvider(config.payments.provider);
    return json(reply, 200, {
      provider: provider.name,
      livemode: provider.livemode,
      configured: provider.name !== 'chargily' || Boolean(config.payments.chargily.secretKey),
      sandbox_allowed: config.payments.sandboxAllowed,
      webhook_url: config.payments.chargily.webhookUrl || null,
    });
  });

  app.post('/payments/intents', { preHandler: requireAuth }, async (request, reply) => {
    const body = validate(request.body, {
      purpose: { type: 'string', required: true, enum: ['BOOKING_SERVICE_FEE', 'BOOKING_DEPOSIT', 'TELECONSULTATION'] },
      appointment_id: { type: 'string', max: 64 },
      consultation_id: { type: 'string', max: 64 },
      provider: { type: 'string', enum: ['chargily', 'manual', 'sandbox'] },
    });

    let patientId = null;
    if (request.user.role === 'PATIENT') {
      const patient = await one('SELECT id FROM patients WHERE user_id = $1', [request.user.id]);
      if (!patient) throw Errors.forbidden('Profil patient manquant');
      patientId = patient.id;
    } else if (request.user.role === 'OPERATOR' || request.user.role === 'BRANCH_MANAGER') {
      const target = await one(
        `SELECT p.id FROM appointments a JOIN patients p ON p.id = a.patient_id WHERE a.id = $1`,
        [body.appointment_id ?? ''],
      );
      if (!target) throw Errors.notFound('Appointment');
      patientId = target.id;
    } else {
      throw Errors.forbidden();
    }

    let amount = 0;
    if (body.purpose === 'TELECONSULTATION') {
      if (!body.consultation_id) throw Errors.validation({ consultation_id: 'required' });
      const consultation = await one('SELECT * FROM consultations WHERE id = $1', [body.consultation_id]);
      if (!consultation) throw Errors.notFound('Consultation');
      if (consultation.patient_id !== patientId) throw Errors.forbidden('Consultation d\'un autre patient');
      amount = consultation.price;
      if (amount <= 0) throw Errors.conflict('NOTHING_TO_PAY', 'Consultation sans frais');
    } else {
      if (!body.appointment_id) throw Errors.validation({ appointment_id: 'required' });
      const appointment = await one('SELECT * FROM appointments WHERE id = $1', [body.appointment_id]);
      if (!appointment) throw Errors.notFound('Appointment');
      if (appointment.patient_id !== patientId) throw Errors.forbidden('Rendez-vous d\'un autre patient');
      amount = appointment.service_fee;
      if (amount <= 0) throw Errors.conflict('NOTHING_TO_PAY', 'Aucun frais de service à régler');
      if (appointment.status !== 'AWAITING_PAYMENT') {
        throw Errors.conflict('NOT_PAYABLE', `Statut ${appointment.status}`);
      }
    }

    const idempotencyKey = request.headers['idempotency-key'] || null;
    const result = await payments.createIntent({
      purpose: body.purpose,
      patientId,
      appointmentId: body.appointment_id ?? null,
      consultationId: body.consultation_id ?? null,
      amount,
      provider: body.provider,
      idempotencyKey,
      locale: request.user.locale ?? 'fr',
      actor: request.user,
    });

    return json(reply, 201, {
      payment_id: result.payment.id,
      status: result.payment.status,
      amount: result.payment.amount,
      currency: result.payment.currency,
      checkout_url: result.checkout_url,
      livemode: result.payment.livemode,
      simulated: result.simulated,
      instructions: result.instructions,
      replayed: Boolean(result.replayed),
      warning: result.simulated
        ? 'SIMULATION — aucun paiement réel. Ce mode est réservé au développement.'
        : null,
    });
  });

  app.get('/payments', { preHandler: requireAuth }, async (request, reply) => {
    const query = request.query || {};
    let patientId = null;
    if (request.user.role === 'PATIENT') {
      const patient = await one('SELECT id FROM patients WHERE user_id = $1', [request.user.id]);
      patientId = patient?.id ?? '00000000-0000-0000-0000-000000000000';
    } else if (!STAFF_ROLES.includes(request.user.role) && !['OPERATOR', 'BRANCH_MANAGER'].includes(request.user.role)) {
      throw Errors.forbidden();
    }
    const items = await payments.listPayments({
      patientId,
      status: query.status,
      limit: toInt(query.limit, 50),
    });
    return json(reply, 200, { items });
  });

  app.get('/payments/:id', { preHandler: requireAuth }, async (request, reply) => {
    const payment = await one('SELECT * FROM payments WHERE id = $1', [request.params.id]);
    if (!payment) throw Errors.notFound('Payment');
    if (request.user.role === 'PATIENT') {
      const patient = await one('SELECT id FROM patients WHERE user_id = $1', [request.user.id]);
      if (!patient || patient.id !== payment.patient_id) throw Errors.forbidden('Paiement d\'un autre patient');
    } else if (!STAFF_ROLES.includes(request.user.role) && !['OPERATOR', 'BRANCH_MANAGER'].includes(request.user.role)) {
      throw Errors.forbidden();
    }
    return json(reply, 200, {
      id: payment.id,
      purpose: payment.purpose,
      amount: payment.amount,
      currency: payment.currency,
      status: payment.status,
      provider: payment.provider,
      livemode: payment.livemode,
      simulated: payment.livemode === false,
      paid_at: payment.paid_at,
      created_at: payment.created_at,
    });
  });

  /**
   * Webhook prestataire : corps brut, signature vérifiée côté serveur.
   * Aucune session, aucun CSRF : l'authenticité vient de la signature HMAC.
   */
  app.post('/webhooks/chargily', async (request, reply) => {
    const raw = request.rawBody ?? '';
    try {
      const result = await payments.handleWebhook('chargily', raw, request.headers);
      return json(reply, 200, result);
    } catch (error) {
      if (error.code === 'FORBIDDEN') {
        await audit({ action: 'payment.webhook.invalid_signature', entity: 'payment', ip: request.ip });
        return json(reply, 403, { error: { code: 'INVALID_SIGNATURE' } });
      }
      if (error.code === 'PAYMENT_AMOUNT_MISMATCH' || error.code === 'PAYMENT_CURRENCY_MISMATCH') {
        return json(reply, 409, { error: { code: error.code, details: error.details } });
      }
      throw error;
    }
  });

  /**
   * Simulation explicite d'un paiement réussi (développement uniquement).
   * Refusée dès que l'environnement est de production.
   */
  app.post('/payments/:id/sandbox-pay', { preHandler: requireAuth }, async (request, reply) => {
    if (config.isProduction || !config.payments.sandboxAllowed) {
      throw Errors.forbidden('SANDBOX_DISABLED');
    }
    const payment = await one('SELECT * FROM payments WHERE id = $1', [request.params.id]);
    if (!payment) throw Errors.notFound('Payment');
    if (payment.provider !== 'sandbox') {
      throw Errors.conflict('NOT_SANDBOX', 'Ce paiement n\'est pas simulé : utilisez le webhook du prestataire');
    }
    if (request.user.role === 'PATIENT') {
      const patient = await one('SELECT id FROM patients WHERE user_id = $1', [request.user.id]);
      if (!patient || patient.id !== payment.patient_id) throw Errors.forbidden();
    }

    const paid = await payments.markPaid(payment, {
      event: { livemode: false, provider: 'sandbox' },
      actor: request.user,
    });
    await audit({
      actor: request.user,
      action: 'payment.sandbox.simulated',
      entity: 'payment',
      entityId: payment.id,
      details: { amount: payment.amount },
    });
    return json(reply, 200, {
      ok: true,
      simulated: true,
      status: paid.status,
      warning: 'SIMULATION : ce paiement n\'a encaissé aucun argent réel.',
    });
  });

  app.post('/payments/:id/refund', {
    preHandler: requireRole([ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.FINANCE_MANAGER]),
  }, async (request, reply) => {
    const body = validate(request.body ?? {}, {
      amount: { type: 'number', min: 1, integer: true },
      reason: { type: 'string', required: true, min: 3, max: 500 },
    });
    const result = await payments.refundPayment(request.params.id, {
      amount: body.amount ?? null,
      reason: body.reason,
      actor: request.user,
    });
    return json(reply, 200, {
      refund: result.refund,
      manual_required: result.manual_required,
      note: result.manual_required
        ? 'Le prestataire ne propose pas de remboursement par API : à effectuer puis à constater.'
        : 'Remboursement enregistré.',
    });
  });

  /** Confirmation d'un encaissement manuel (espèces constatées en branche). */
  app.post('/payments/:id/manual-confirm', { preHandler: requireAuth }, async (request, reply) => {
    if (!['OPERATOR', 'BRANCH_MANAGER', 'ADMIN', 'SUPER_ADMIN', 'FINANCE_MANAGER'].includes(request.user.role)) {
      throw Errors.forbidden();
    }
    const payment = await one('SELECT * FROM payments WHERE id = $1', [request.params.id]);
    if (!payment) throw Errors.notFound('Payment');
    if (payment.provider !== 'manual') {
      throw Errors.conflict('NOT_MANUAL', 'Ce paiement doit être confirmé par le prestataire');
    }
    const body = validate(request.body ?? {}, { receipt_ref: { type: 'string', max: 80 } });
    await db().query(
      `UPDATE payments SET status = 'PAID', paid_at = now(),
              metadata = metadata || $2::jsonb, updated_at = now()
        WHERE id = $1 AND status <> 'PAID'`,
      [payment.id, JSON.stringify({ verification: 'MANUAL', receipt_ref: body.receipt_ref ?? '', confirmed_by: request.user.id })],
    );
    await payments.markPaid({ ...payment, livemode: true }, { actor: request.user });
    await audit({
      actor: request.user,
      action: 'payment.manual.confirmed',
      entity: 'payment',
      entityId: payment.id,
      details: { receipt_ref: body.receipt_ref ?? '' },
    });
    return json(reply, 200, { ok: true, verification: 'MANUAL', status: 'PAID' });
  });

}
