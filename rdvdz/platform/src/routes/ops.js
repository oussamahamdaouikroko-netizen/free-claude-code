/**
 * Routes de la console opérateur / branches.
 *
 * Cloisonnement : toutes les requêtes sont filtrées par le périmètre de
 * l'utilisateur (branches / wilayas). Les données médicales ne sont **jamais**
 * sérialisées vers ces routes (listes blanches explicites).
 */

import { requireRole, loadScope, OPS_ROLES, ROLES } from '../lib/security.js';
import { validate, json, toInt } from '../lib/http.js';
import { Errors } from '../lib/errors.js';
import { db, many, one } from '../db.js';
import * as booking from '../modules/booking/service.js';
import * as directory from '../modules/directory/service.js';
import { normalizePhone } from '../lib/crypto.js';
import { audit } from '../lib/audit.js';

/** Branches visibles par l'utilisateur (null = toutes). */
async function visibleBranches(user) {
  const scope = await loadScope(user);
  if (scope.global) return null;
  if (scope.branchIds.length === 0) return [];
  return scope.branchIds;
}

export default async function opsRoutes(app) {
  const preHandler = requireRole(OPS_ROLES);

  app.get('/ops/dashboard', { preHandler }, async (request, reply) => {
    const branches = await visibleBranches(request.user);
    if (branches && branches.length === 0) {
      return json(reply, 200, {
        bookings: { total: 0, today: 0, pending: 0, confirmed: 0, cancelled: 0 },
        revenue: { confirmed_revenue: 0, pending_amount: 0, simulated_revenue: 0 },
        shares: { BRANCH: 0, OPERATOR: 0, PLATFORM: 0 },
        doctors_available: 0,
        warning: 'Aucune branche ne vous est assignée.',
      });
    }

    const scopeFilter = branches ? 'AND a.branch_id = ANY($1::uuid[])' : '';
    const params = branches ? [branches] : [];

    const bookings = await one(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE s.starts_at::date = CURRENT_DATE)::int AS today,
              count(*) FILTER (WHERE a.status IN ('PENDING','AWAITING_PAYMENT'))::int AS pending,
              count(*) FILTER (WHERE a.status = 'CONFIRMED')::int AS confirmed,
              count(*) FILTER (WHERE a.status = 'CANCELLED')::int AS cancelled
         FROM appointments a JOIN doctor_slots s ON s.id = a.slot_id
        WHERE a.created_at > now() - interval '30 days' ${scopeFilter}`,
      params,
    );

    const money = await one(
      `SELECT coalesce(sum(p.amount) FILTER (WHERE p.status = 'PAID' AND p.livemode),0)::int AS confirmed,
              coalesce(sum(p.amount) FILTER (WHERE p.status IN ('CREATED','PENDING')),0)::int AS pending,
              coalesce(sum(p.amount) FILTER (WHERE p.status = 'PAID' AND NOT p.livemode),0)::int AS simulated
         FROM payments p
         JOIN appointments a ON a.id = p.appointment_id
        WHERE p.created_at > now() - interval '30 days' ${scopeFilter}`,
      params,
    );

    const shares = await one(
      `SELECT coalesce(sum(c.amount) FILTER (WHERE c.beneficiary_type = 'BRANCH'),0)::int AS branch,
              coalesce(sum(c.amount) FILTER (WHERE c.beneficiary_type = 'OPERATOR'),0)::int AS operator,
              coalesce(sum(c.amount) FILTER (WHERE c.beneficiary_type = 'PLATFORM'),0)::int AS platform
         FROM commissions c
         JOIN appointments a ON a.id = c.source_id AND c.source_type = 'APPOINTMENT'
        WHERE c.status = 'ACCRUED' ${scopeFilter}`,
      params,
    );

    const doctors = await one(
      `SELECT count(DISTINCT d.id)::int AS n
         FROM doctors d
         JOIN doctor_slots s ON s.doctor_id = d.id AND s.starts_at > now() AND s.status = 'OPEN'
        WHERE d.verified_at IS NOT NULL`,
    );

    return json(reply, 200, {
      bookings,
      revenue: {
        confirmed_revenue: money.confirmed,
        pending_amount: money.pending,
        simulated_revenue: money.simulated,
      },
      shares: { BRANCH: shares.branch, OPERATOR: shares.operator, PLATFORM: shares.platform },
      doctors_available: doctors.n,
    });
  });

  app.get('/ops/doctors', { preHandler }, async (request, reply) => {
    const query = request.query || {};
    const items = await directory.searchDoctors({
      q: query.q,
      specialty: query.specialty,
      wilaya: toInt(query.wilaya),
      teleconsult: query.teleconsult === '1',
      limit: toInt(query.limit, 20),
    });
    // Disponibilité en direct (prochains créneaux uniquement).
    const withSlots = await Promise.all(
      items.map(async (doctor) => {
        const slots = await many(
          `SELECT starts_at FROM doctor_slots
            WHERE doctor_id = $1 AND status = 'OPEN' AND starts_at > now()
            ORDER BY starts_at ASC LIMIT 3`,
          [doctor.id],
        );
        return { ...doctor, next_slots: slots.map((s) => s.starts_at) };
      }),
    );
    return json(reply, 200, { items: withSlots });
  });

  /** Recherche patient : identité seulement, aucune donnée médicale. */
  app.get('/ops/patients', { preHandler }, async (request, reply) => {
    const query = request.query || {};
    const search = String(query.q ?? '').trim();
    const phone = normalizePhone(search);
    const items = await many(
      `SELECT id, full_name, phone, wilaya_code, commune, created_at
         FROM patients
        WHERE ($1::text = '' OR full_name ILIKE '%' || $1 || '%' OR phone = $2)
        ORDER BY created_at DESC LIMIT 25`,
      [search, phone],
    );
    return json(reply, 200, { items });
  });

  /** Création d'un patient sans compte (réservation au guichet). */
  app.post('/ops/patients', { preHandler }, async (request, reply) => {
    const body = validate(request.body, {
      full_name: { type: 'string', required: true, min: 3, max: 160 },
      phone: { type: 'string', required: true, max: 30 },
      wilaya_code: { type: 'number', min: 1, max: 58, integer: true },
      commune: { type: 'string', max: 120 },
    });
    const phone = normalizePhone(body.phone);
    if (!phone) throw Errors.validation({ phone: 'invalid' });

    const existing = await one('SELECT id, full_name, phone FROM patients WHERE phone = $1', [phone]);
    if (existing) return json(reply, 200, { patient: existing, created: false });

    const patient = await one(
      `INSERT INTO patients (full_name, phone, wilaya_code, commune, created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, full_name, phone, wilaya_code, commune`,
      [body.full_name, phone, body.wilaya_code ?? null, body.commune ?? '', request.user.id],
    );
    await audit({
      actor: request.user,
      action: 'patient.created_by_operator',
      entity: 'patient',
      entityId: patient.id,
      details: { source: 'OPERATOR' },
    });
    return json(reply, 201, { patient, created: true });
  });

  /** Réservation par un opérateur pour un patient (avec ou sans compte). */
  app.post('/ops/bookings', { preHandler }, async (request, reply) => {
    const body = validate(request.body, {
      slot_id: { type: 'string', required: true, max: 64 },
      patient_id: { type: 'string', required: true, max: 64 },
      branch_id: { type: 'string', max: 64 },
      notes: { type: 'string', max: 500 },
    });

    const branches = await visibleBranches(request.user);
    const branchId = body.branch_id ?? (branches && branches.length === 1 ? branches[0] : null);
    if (branches && branchId && !branches.includes(branchId)) {
      throw Errors.forbidden('Branche hors de votre périmètre');
    }

    const result = await booking.createBooking({
      slotId: body.slot_id,
      patientId: body.patient_id,
      source: body.branch_id ? 'BRANCH' : 'OPERATOR',
      branchId,
      notes: body.notes ?? '',
      actor: request.user,
      idempotencyKey: request.headers['idempotency-key'] || null,
    });

    return json(reply, 201, {
      appointment: {
        id: result.appointment.id,
        reference: result.appointment.reference,
        status: result.appointment.status,
        service_fee: result.appointment.service_fee,
      },
      payment_required: result.paymentRequired,
      hold_expires_at: result.holdExpiresAt,
    });
  });

  /** Encaissement constaté pour une réservation prise au guichet. */
  app.post('/ops/bookings/:id/payment-record', { preHandler }, async (request, reply) => {
    const body = validate(request.body ?? {}, { receipt_ref: { type: 'string', max: 80 } });
    const appointment = await booking.getAppointment(request.params.id);
    if (!appointment) throw Errors.notFound('Appointment');

    const branches = await visibleBranches(request.user);
    if (branches && !branches.includes(appointment.branch_id)) {
      throw Errors.forbidden('Rendez-vous hors de votre périmètre');
    }

    const { createIntent, markPaid } = await import('../modules/payments/service.js');
    const intent = await createIntent({
      purpose: 'BOOKING_SERVICE_FEE',
      patientId: appointment.patient_id,
      appointmentId: appointment.id,
      amount: appointment.service_fee || 0,
      provider: 'manual',
      actor: request.user,
    });
    if (appointment.service_fee === 0) {
      await db().query(`UPDATE appointments SET status = 'CONFIRMED', confirmed_at = now() WHERE id = $1 AND status <> 'CONFIRMED'`, [
        appointment.id,
      ]);
      return json(reply, 200, { ok: true, status: 'CONFIRMED', note: 'Aucun frais à encaisser.' });
    }
    const paid = await markPaid(intent.payment, { actor: request.user });
    return json(reply, 200, {
      ok: true,
      payment_id: paid.id,
      status: 'PAID',
      verification: 'MANUAL',
      receipt_ref: body.receipt_ref ?? null,
    });
  });

  /* -------------------------------- branches ------------------------------ */

  app.get('/branches', { preHandler }, async (request, reply) => {
    const branches = await visibleBranches(request.user);
    const rows = await many(
      `SELECT b.id, b.code, b.name, b.wilaya_code, b.commission_pct, b.status, b.phone,
              u.full_name AS manager_name,
              (SELECT count(*)::int FROM branch_operators o WHERE o.branch_id = b.id) AS operators,
              (SELECT count(*)::int FROM doctor_branches db WHERE db.branch_id = b.id) AS doctors
         FROM branches b LEFT JOIN users u ON u.id = b.manager_user_id
        ${branches ? 'WHERE b.id = ANY($1::uuid[])' : ''}
        ORDER BY b.code`,
      branches ? [branches] : [],
    );
    return json(reply, 200, { items: rows });
  });

  app.post('/branches', { preHandler: requireRole([ROLES.SUPER_ADMIN, ROLES.ADMIN]) }, async (request, reply) => {
    const body = validate(request.body, {
      code: { type: 'string', required: true, min: 2, max: 20 },
      name: { type: 'string', required: true, min: 2, max: 120 },
      wilaya_code: { type: 'number', required: true, min: 1, max: 58, integer: true },
      manager_user_id: { type: 'string', max: 64 },
      commission_pct: { type: 'number', min: 0, max: 100 },
      phone: { type: 'string', max: 40 },
    });
    const branch = await one(
      `INSERT INTO branches (code, name, wilaya_code, manager_user_id, commission_pct, phone)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [
        body.code.toUpperCase(),
        body.name,
        body.wilaya_code,
        body.manager_user_id ?? null,
        body.commission_pct ?? 15,
        body.phone ?? null,
      ],
    ).catch((error) => {
      if (String(error.message).includes('duplicate key')) throw Errors.conflict('BRANCH_CODE_EXISTS', 'Code déjà utilisé');
      throw error;
    });
    await audit({ actor: request.user, action: 'branch.created', entity: 'branch', entityId: branch.id });
    return json(reply, 201, { branch });
  });

  app.patch('/branches/:id', { preHandler: requireRole([ROLES.SUPER_ADMIN, ROLES.ADMIN]) }, async (request, reply) => {
    const body = validate(request.body ?? {}, {
      name: { type: 'string', min: 2, max: 120 },
      manager_user_id: { type: 'string', max: 64 },
      commission_pct: { type: 'number', min: 0, max: 100 },
      status: { type: 'string', enum: ['ACTIVE', 'SUSPENDED'] },
    });
    const fields = [];
    const params = [];
    for (const [key, value] of Object.entries(body)) {
      params.push(value);
      fields.push(`"${key}" = $${params.length}`);
    }
    if (!fields.length) return json(reply, 200, { ok: true, updated: 0 });
    params.push(request.params.id);
    const branch = await one(
      `UPDATE branches SET ${fields.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params,
    );
    if (!branch) throw Errors.notFound('Branch');
    await audit({ actor: request.user, action: 'branch.updated', entity: 'branch', entityId: branch.id });
    return json(reply, 200, { branch });
  });

  app.post('/branches/:id/operators', {
    preHandler: requireRole([ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.BRANCH_MANAGER]),
  }, async (request, reply) => {
    const body = validate(request.body, { user_id: { type: 'string', required: true, max: 64 } });
    if (request.user.role === 'BRANCH_MANAGER') {
      const branches = await visibleBranches(request.user);
      if (!branches || !branches.includes(request.params.id)) {
        throw Errors.forbidden('Branche hors de votre périmètre');
      }
    }
    const target = await one('SELECT id, role FROM users WHERE id = $1', [body.user_id]);
    if (!target) throw Errors.notFound('User');
    if (!['OPERATOR', 'BRANCH_MANAGER'].includes(target.role)) {
      throw Errors.validation({ user_id: 'l\'utilisateur doit avoir le rôle OPERATOR ou BRANCH_MANAGER' });
    }
    await db().query(
      `INSERT INTO branch_operators (branch_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [request.params.id, body.user_id],
    );
    await db().query(
      `INSERT INTO user_scopes (user_id, branch_id, wilaya_code)
       SELECT $1, $2, b.wilaya_code FROM branches b WHERE b.id = $2
       ON CONFLICT DO NOTHING`,
      [body.user_id, request.params.id],
    );
    await audit({
      actor: request.user,
      action: 'branch.operator.assigned',
      entity: 'branch',
      entityId: request.params.id,
      details: { user_id: body.user_id },
    });
    return json(reply, 201, { ok: true });
  });

  app.delete('/branches/:id/operators/:userId', {
    preHandler: requireRole([ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.BRANCH_MANAGER]),
  }, async (request, reply) => {
    // Le périmètre de données (`user_scopes`) doit suivre l'affectation :
    // sinon un opérateur retiré garderait l'accès aux données de la branche.
    await db().tx(async (client) => {
      await client.query('DELETE FROM branch_operators WHERE branch_id = $1 AND user_id = $2', [
        request.params.id,
        request.params.userId,
      ]);
      await client.query('DELETE FROM user_scopes WHERE branch_id = $1 AND user_id = $2', [
        request.params.id,
        request.params.userId,
      ]);
    });
    await audit({
      actor: request.user,
      action: 'branch.operator.removed',
      entity: 'branch',
      entityId: request.params.id,
      details: { user_id: request.params.userId },
    });
    return json(reply, 200, { ok: true });
  });

  app.post('/branches/:id/doctors', { preHandler: requireRole([ROLES.SUPER_ADMIN, ROLES.ADMIN]) }, async (request, reply) => {
    const body = validate(request.body, {
      doctor_id: { type: 'string', required: true, max: 64 },
      commission_pct: { type: 'number', min: 0, max: 100 },
    });
    await db().query(
      `INSERT INTO doctor_branches (doctor_id, branch_id, commission_pct)
       VALUES ($1,$2,$3) ON CONFLICT (doctor_id, branch_id)
       DO UPDATE SET commission_pct = excluded.commission_pct`,
      [body.doctor_id, request.params.id, body.commission_pct ?? 15],
    );
    await audit({
      actor: request.user,
      action: 'branch.doctor.assigned',
      entity: 'branch',
      entityId: request.params.id,
      details: { doctor_id: body.doctor_id },
    });
    return json(reply, 201, { ok: true });
  });

  app.get('/branches/:id/performance', { preHandler }, async (request, reply) => {
    const branches = await visibleBranches(request.user);
    if (branches && !branches.includes(request.params.id)) {
      throw Errors.forbidden('Branche hors de votre périmètre');
    }
    const { branchReport } = await import('../modules/reports/service.js');
    const from = (request.query || {}).from ?? new Date(Date.now() - 30 * 86400000).toISOString();
    const to = (request.query || {}).to ?? new Date().toISOString();
    const report = await branchReport({ from, to });
    return json(reply, 200, {
      branch: report.branches.find((b) => b.id === request.params.id) ?? null,
      operators: report.operators.filter((o) => o.branch_id === request.params.id),
    });
  });
}
