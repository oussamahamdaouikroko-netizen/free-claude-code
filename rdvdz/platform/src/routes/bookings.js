/**
 * Routes de réservation (patient, médecin, opérateur, administrateur).
 */

import * as booking from '../modules/booking/service.js';
import { requireAuth, requireRole, loadScope, ROLES, OPS_ROLES } from '../lib/security.js';
import { validate, json, toInt } from '../lib/http.js';
import { Errors } from '../lib/errors.js';
import { db, many, one } from '../db.js';
import * as notifications from '../modules/notifications/service.js';
import { serviceFee } from '../modules/booking/service.js';

/** Charge le rendez-vous et vérifie que l'appelant y a droit. */
async function loadForActor(appointmentId, request) {
  const appointment = await booking.getAppointment(appointmentId);
  if (!appointment) throw Errors.notFound('Appointment');
  const user = request.user;

  if (['SUPER_ADMIN', 'ADMIN', 'FINANCE_MANAGER'].includes(user.role)) return appointment;

  if (user.role === 'PATIENT') {
    const patient = await one('SELECT id FROM patients WHERE user_id = $1', [user.id]);
    if (!patient || patient.id !== appointment.patient_id) throw Errors.forbidden('Rendez-vous d\'un autre patient');
    return appointment;
  }
  if (user.role === 'DOCTOR') {
    const doctor = await one('SELECT id FROM doctors WHERE user_id = $1', [user.id]);
    if (!doctor || doctor.id !== appointment.doctor_id) throw Errors.forbidden('Rendez-vous d\'un autre médecin');
    return appointment;
  }
  if (OPS_ROLES.includes(user.role)) {
    const scope = await loadScope(user);
    if (!scope.global && !scope.branchIds.includes(appointment.branch_id)) {
      throw Errors.forbidden('Rendez-vous hors de votre périmètre');
    }
    return appointment;
  }
  throw Errors.forbidden();
}

export default async function bookingRoutes(app) {
  app.get('/booking/fees', async (request, reply) =>
    json(reply, 200, { service_fee: await serviceFee(), currency: 'DZD' }),
  );

  app.post('/bookings', { preHandler: requireAuth }, async (request, reply) => {
    const body = validate(request.body, {
      slot_id: { type: 'string', required: true, max: 64 },
      notes: { type: 'string', max: 1000 },
      source: { type: 'string', enum: ['PATIENT_WEBSITE', 'OPERATOR', 'BRANCH', 'WHATSAPP', 'OTHER'] },
    });

    let patientId;
    if (request.user.role === 'PATIENT') {
      const patient = await one('SELECT id FROM patients WHERE user_id = $1', [request.user.id]);
      if (!patient) throw Errors.forbidden('Profil patient manquant');
      patientId = patient.id;
    } else if (OPS_ROLES.includes(request.user.role)) {
      // Un opérateur réserve pour un patient existant (identifié explicitement).
      const extra = validate(request.body, { patient_id: { type: 'string', required: true, max: 64 } });
      patientId = extra.patient_id;
    } else {
      throw Errors.forbidden('Rôle non autorisé à réserver');
    }

    const idempotencyKey = request.headers['idempotency-key'] || null;
    const result = await booking.createBooking({
      slotId: body.slot_id,
      patientId,
      notes: body.notes ?? '',
      source: body.source ?? (request.user.role === 'PATIENT' ? 'PATIENT_WEBSITE' : 'OPERATOR'),
      idempotencyKey,
      actor: request.user,
    });

    if (!result.replayed) {
      const patient = await one('SELECT full_name, phone FROM patients WHERE id = $1', [patientId]);
      const starts = new Date(result.appointment.created_at);
      void starts;
      const detail = await booking.getAppointment(result.appointment.id);
      await notifications.notify({
        userId: request.user.role === 'PATIENT' ? request.user.id : null,
        patientId,
        phone: patient?.phone,
        templateCode: 'booking.confirmed',
        locale: request.user.locale ?? 'fr',
        payload: {
          reference: detail.reference,
          doctor: detail.doctor_name,
          date: new Date(detail.starts_at).toISOString().slice(0, 10),
          time: new Date(detail.starts_at).toISOString().slice(11, 16),
        },
        channels: ['IN_APP', 'WHATSAPP'],
        dedupeKey: `booking-created:${result.appointment.id}`,
      });
    }

    return json(reply, 201, {
      appointment: {
        id: result.appointment.id,
        reference: result.appointment.reference,
        status: result.appointment.status,
        service_fee: result.appointment.service_fee,
        price: result.appointment.price,
      },
      payment_required: result.paymentRequired,
      hold_expires_at: result.holdExpiresAt,
      replayed: Boolean(result.replayed),
    });
  });

  app.get('/bookings', { preHandler: requireAuth }, async (request, reply) => {
    const query = request.query || {};
    const options = {
      status: query.status,
      from: query.from,
      to: query.to,
      limit: toInt(query.limit, 50),
      offset: toInt(query.offset, 0),
    };

    if (request.user.role === 'PATIENT') {
      const patient = await one('SELECT id FROM patients WHERE user_id = $1', [request.user.id]);
      options.patientId = patient?.id ?? '00000000-0000-0000-0000-000000000000';
    } else if (request.user.role === 'DOCTOR') {
      const doctor = await one('SELECT id FROM doctors WHERE user_id = $1', [request.user.id]);
      options.doctorId = doctor?.id ?? '00000000-0000-0000-0000-000000000000';
    } else if (OPS_ROLES.includes(request.user.role)) {
      const scope = await loadScope(request.user);
      if (!scope.global) options.branchIds = scope.branchIds;
    } else if (!['SUPER_ADMIN', 'ADMIN', 'FINANCE_MANAGER'].includes(request.user.role)) {
      throw Errors.forbidden();
    }

    return json(reply, 200, { items: await booking.listAppointments(options) });
  });

  app.get('/bookings/:id', { preHandler: requireAuth }, async (request, reply) => {
    const appointment = await loadForActor(request.params.id, request);
    const history = await booking.statusHistory(appointment.id);
    // Les opérateurs ne voient aucune note médicale : la sérialisation est
    // déjà une liste blanche via getAppointment + retrait explicite.
    if (OPS_ROLES.includes(request.user.role) && request.user.role === 'OPERATOR') {
      delete appointment.notes;
    }
    return json(reply, 200, { appointment, history });
  });

  app.get('/bookings/:id/history', { preHandler: requireAuth }, async (request, reply) => {
    const appointment = await loadForActor(request.params.id, request);
    return json(reply, 200, { items: await booking.statusHistory(appointment.id) });
  });

  app.post('/bookings/:id/cancel', { preHandler: requireAuth }, async (request, reply) => {
    const appointment = await loadForActor(request.params.id, request);
    const body = validate(request.body ?? {}, { reason: { type: 'string', max: 500 } });
    // Un patient ne peut annuler qu'avant la limite configurée par le médecin.
    const outcome = await booking.cancelBooking(appointment.id, {
      actor: request.user,
      reason: body.reason ?? '',
    });

    await notifications.notify({
      userId: null,
      patientId: appointment.patient_id,
      phone: appointment.patient_phone,
      templateCode: 'booking.cancelled',
      locale: 'fr',
      payload: { reference: appointment.reference, date: new Date(appointment.starts_at).toISOString().slice(0, 10) },
      channels: ['IN_APP', 'WHATSAPP'],
      dedupeKey: `booking-cancelled:${appointment.id}`,
    });

    return json(reply, 200, outcome);
  });

  app.post('/bookings/:id/reschedule', { preHandler: requireAuth }, async (request, reply) => {
    const appointment = await loadForActor(request.params.id, request);
    const body = validate(request.body, { slot_id: { type: 'string', required: true, max: 64 } });
    const updated = await booking.rescheduleBooking(appointment.id, body.slot_id, { actor: request.user });
    return json(reply, 200, { appointment: { id: updated.id, slot_id: updated.slot_id, status: updated.status } });
  });

  app.post('/bookings/:id/confirm', { preHandler: requireRole([ROLES.DOCTOR, ROLES.ADMIN, ROLES.SUPER_ADMIN]) }, async (
    request,
    reply,
  ) => {
    const appointment = await loadForActor(request.params.id, request);
    if (request.user.role === 'DOCTOR' && appointment.service_fee > 0) {
      const paid = await one(
        `SELECT id FROM payments WHERE appointment_id = $1 AND status = 'PAID'`,
        [appointment.id],
      );
      if (!paid) throw Errors.paymentUnverified('Aucun paiement vérifié pour ce rendez-vous');
    }
    const updated = await booking.changeStatus(appointment.id, 'CONFIRMED', { actor: request.user });
    await db().query(`UPDATE doctor_slots SET status = 'BOOKED', hold_expires_at = NULL WHERE id = $1`, [
      appointment.slot_id,
    ]);
    return json(reply, 200, { appointment: { id: updated.id, status: updated.status } });
  });

  app.post('/bookings/:id/reject', { preHandler: requireRole([ROLES.DOCTOR, ROLES.ADMIN, ROLES.SUPER_ADMIN]) }, async (
    request,
    reply,
  ) => {
    const appointment = await loadForActor(request.params.id, request);
    const body = validate(request.body ?? {}, { reason: { type: 'string', max: 500 } });
    const updated = await booking.changeStatus(appointment.id, 'REJECTED', {
      actor: request.user,
      reason: body.reason ?? 'rejected by doctor',
    });
    await db().query(`UPDATE doctor_slots SET status = 'OPEN', hold_expires_at = NULL WHERE id = $1`, [
      appointment.slot_id,
    ]);
    // Un rendez-vous payé puis refusé doit être remboursé.
    const paid = await one(`SELECT id FROM payments WHERE appointment_id = $1 AND status = 'PAID'`, [appointment.id]);
    return json(reply, 200, {
      appointment: { id: updated.id, status: updated.status },
      refund_required: Boolean(paid),
    });
  });

  app.post('/bookings/:id/complete', { preHandler: requireAuth }, async (request, reply) => {
    const appointment = await loadForActor(request.params.id, request);
    if (!['DOCTOR', 'OPERATOR', 'ADMIN', 'SUPER_ADMIN'].includes(request.user.role)) throw Errors.forbidden();
    const updated = await booking.changeStatus(appointment.id, 'COMPLETED', { actor: request.user });
    return json(reply, 200, { appointment: { id: updated.id, status: updated.status } });
  });

  app.post('/bookings/:id/no-show', { preHandler: requireAuth }, async (request, reply) => {
    const appointment = await loadForActor(request.params.id, request);
    if (!['DOCTOR', 'OPERATOR', 'ADMIN', 'SUPER_ADMIN'].includes(request.user.role)) throw Errors.forbidden();
    const updated = await booking.changeStatus(appointment.id, 'NO_SHOW', { actor: request.user });
    return json(reply, 200, { appointment: { id: updated.id, status: updated.status } });
  });

  /** Reçu imprimable (HTML autonome, AR/FR). */
  app.get('/bookings/:id/receipt', { preHandler: requireAuth }, async (request, reply) => {
    const appointment = await loadForActor(request.params.id, request);
    const payment = await one(
      `SELECT amount, status, provider, livemode, paid_at FROM payments
        WHERE appointment_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [appointment.id],
    );
    const html = receiptHtml(appointment, payment);
    return reply.type('text/html; charset=utf-8').send(html);
  });

  /** Réservations à venir d'un médecin (agenda du jour). */
  app.get('/doctor/schedule', { preHandler: requireRole([ROLES.DOCTOR]) }, async (request, reply) => {
    const doctor = await one('SELECT id FROM doctors WHERE user_id = $1', [request.user.id]);
    if (!doctor) throw Errors.forbidden('Profil médecin manquant');
    const day = (request.query || {}).day ?? new Date().toISOString().slice(0, 10);
    const items = await many(
      `SELECT a.id, a.reference, a.status, a.mode, s.starts_at, s.ends_at,
              p.full_name AS patient_name, p.phone AS patient_phone
         FROM appointments a
         JOIN doctor_slots s ON s.id = a.slot_id
         JOIN patients p ON p.id = a.patient_id
        WHERE a.doctor_id = $1 AND s.starts_at >= $2::date AND s.starts_at < ($2::date + interval '1 day')
          AND a.status <> 'CANCELLED'
        ORDER BY s.starts_at`,
      [doctor.id, day],
    );
    return json(reply, 200, { day, items });
  });
}

/** Reçu HTML : autonome, imprimable, sans ressource externe. */
export function receiptHtml(appointment, payment) {
  const starts = new Date(appointment.starts_at);
  const money = (value) => `${(Number(value || 0) / 100).toLocaleString('fr-FR', { minimumFractionDigits: 2 })} DZD`;
  const simulated = payment && payment.livemode === false;
  const statusLabel = {
    CONFIRMED: 'Confirmé / مؤكد',
    COMPLETED: 'Terminé / منجز',
    CANCELLED: 'Annulé / ملغى',
    AWAITING_PAYMENT: 'En attente de paiement / في انتظار الدفع',
    PAID: 'Payé / مدفوع',
    REJECTED: 'Refusé / مرفوض',
    NO_SHOW: 'Absent / غير حاضر',
    REFUNDED: 'Remboursé / مسترجع',
    PENDING: 'En attente / في الانتظار',
  }[appointment.status] ?? appointment.status;

  return `<!doctype html>
<html lang="fr" dir="ltr"><head><meta charset="utf-8">
<title>Reçu ${escapeHtml(appointment.reference)}</title>
<style>
  :root { --ink:#0f172a; --muted:#64748b; --line:#e2e8f0; --blue:#0B63C5; --green:#0E9F6E; }
  body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--ink);margin:0;padding:32px;background:#fff}
  .wrap{max-width:640px;margin:0 auto}
  header{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid var(--blue);padding-bottom:12px}
  h1{font-size:20px;margin:0}
  .muted{color:var(--muted);font-size:13px}
  table{width:100%;border-collapse:collapse;margin-top:20px;font-size:14px}
  td{padding:8px 0;border-bottom:1px solid var(--line)}
  td:last-child{text-align:right;font-weight:600}
  .total{font-size:18px;color:var(--blue)}
  .badge{display:inline-block;padding:2px 8px;border-radius:999px;background:#ecfdf5;color:var(--green);font-size:12px;font-weight:600}
  .warn{margin-top:16px;padding:10px 12px;border-left:4px solid #f59e0b;background:#fffbeb;font-size:13px}
  footer{margin-top:28px;font-size:12px;color:var(--muted);border-top:1px solid var(--line);padding-top:12px}
  @media print{body{padding:0}}
</style></head>
<body><div class="wrap">
<header>
  <div><h1>RDV DZ — Reçu</h1><div class="muted">${escapeHtml(appointment.reference)}</div></div>
  <div class="muted">${statusLabel}</div>
</header>
<table>
  <tr><td>Patient / المريض</td><td>${escapeHtml(appointment.patient_name)}</td></tr>
  <tr><td>Médecin / الطبيب</td><td>${escapeHtml(appointment.doctor_name)}</td></tr>
  <tr><td>Clinique / العيادة</td><td>${escapeHtml(appointment.clinic_name_fr || '')}</td></tr>
  <tr><td>Date & heure / التاريخ والساعة</td><td>${starts.toISOString().slice(0, 10)} ${starts.toISOString().slice(11, 16)} (UTC)</td></tr>
  <tr><td>Honoraires / الأتعاب</td><td>${money(appointment.price)}</td></tr>
  <tr><td>Frais de service / رسوم الخدمة</td><td class="total">${money(appointment.service_fee)}</td></tr>
  ${payment ? `<tr><td>Paiement / الدفع</td><td>${escapeHtml(payment.provider)} — ${payment.status === 'PAID' ? 'payé' : escapeHtml(payment.status)}</td></tr>` : ''}
</table>
${simulated ? '<div class="warn">SIMULATION — aucun paiement réel n\'a été encaissé.<br>محاكاة — لم يتم استلام أي مبلغ حقيقي.</div>' : ''}
<footer>
  Document interne RDV DZ — ne constitue pas une facture fiscale.<br>
  وثيقة داخلية — لا تعتبر فاتورة جبائية.
</footer>
</div></body></html>`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char]);
}
