/**
 * Routes d'administration, de finance et de rapports.
 * Toutes les routes de ce fichier exigent un rôle de personnel habilité.
 */

import { requireRole, ADMIN_ROLES, STAFF_ROLES, ROLES } from '../lib/security.js';
import { validate, json, toInt } from '../lib/http.js';
import { Errors } from '../lib/errors.js';
import { db, many, one } from '../db.js';
import { audit } from '../lib/audit.js';
import * as directory from '../modules/directory/service.js';
import * as reports from '../modules/reports/service.js';
import * as finance from '../modules/finance/service.js';
import * as syncService from '../modules/desktop-sync/service.js';
import { revokeAllSessions } from '../lib/security.js';

export default async function adminRoutes(app) {
  app.get('/admin/overview', { preHandler: requireRole(STAFF_ROLES) }, async (request, reply) => {
    const period = reports.resolvePeriod((request.query || {}).from, (request.query || {}).to);
    return json(reply, 200, await reports.platformOverview(period));
  });

  app.get('/admin/users', { preHandler: requireRole(ADMIN_ROLES) }, async (request, reply) => {
    const query = request.query || {};
    const items = await many(
      `SELECT u.id, u.role, u.full_name, u.phone, u.email, u.status, u.locale,
              u.created_at, u.last_login_at, u.phone_verified_at,
              (SELECT count(*)::int FROM sessions s WHERE s.user_id = u.id AND s.revoked_at IS NULL) AS active_sessions
         FROM users u
        WHERE ($1::text IS NULL OR u.role = $1)
          AND ($2::text IS NULL OR u.status = $2)
          AND ($3::text = '' OR u.full_name ILIKE '%' || $3 || '%' OR u.phone LIKE '%' || $3 || '%')
        ORDER BY u.created_at DESC
        LIMIT $4 OFFSET $5`,
      [
        query.role ?? null,
        query.status ?? null,
        String(query.q ?? ''),
        Math.min(toInt(query.limit, 30), 100),
        Math.max(toInt(query.offset, 0), 0),
      ],
    );
    return json(reply, 200, { items });
  });

  app.post('/admin/users/:id/suspend', { preHandler: requireRole(ADMIN_ROLES) }, async (request, reply) => {
    if (request.params.id === request.user.id) throw Errors.conflict('SELF_SUSPEND', 'Impossible de suspendre son propre compte');
    const body = validate(request.body ?? {}, { reason: { type: 'string', max: 300 } });
    const user = await one(
      `UPDATE users SET status = 'SUSPENDED', updated_at = now() WHERE id = $1 RETURNING id, role, status`,
      [request.params.id],
    );
    if (!user) throw Errors.notFound('User');
    await revokeAllSessions(user.id);
    await audit({
      actor: request.user,
      action: 'user.suspended',
      entity: 'user',
      entityId: user.id,
      details: { reason: body.reason ?? '' },
    });
    return json(reply, 200, { user });
  });

  app.post('/admin/users/:id/activate', { preHandler: requireRole(ADMIN_ROLES) }, async (request, reply) => {
    const user = await one(
      `UPDATE users SET status = 'ACTIVE', failed_logins = 0, locked_until = NULL, updated_at = now()
        WHERE id = $1 RETURNING id, role, status`,
      [request.params.id],
    );
    if (!user) throw Errors.notFound('User');
    await audit({ actor: request.user, action: 'user.activated', entity: 'user', entityId: user.id });
    return json(reply, 200, { user });
  });

  /** Création d'un membre du personnel (opérateur, manager, finance). */
  app.post('/admin/staff', { preHandler: requireRole([ROLES.SUPER_ADMIN, ROLES.ADMIN]) }, async (request, reply) => {
    const body = validate(request.body, {
      full_name: { type: 'string', required: true, min: 3, max: 160 },
      phone: { type: 'string', required: true, max: 30 },
      role: { type: 'string', required: true, enum: ['OPERATOR', 'BRANCH_MANAGER', 'FINANCE_MANAGER', 'ADMIN'] },
      password: { type: 'string', required: true, max: 128 },
      locale: { type: 'string', enum: ['ar', 'fr'] },
      branch_id: { type: 'string', max: 64 },
    });
    const { register } = await import('../modules/auth/service.js');
    const result = await register({
      fullName: body.full_name,
      phone: body.phone,
      password: body.password,
      role: 'PATIENT', // créé patient puis promu : évite d'ouvrir un rôle interne à l'inscription publique
      locale: body.locale ?? 'fr',
      consent: true,
      ip: request.ip,
      userAgent: request.headers['user-agent'],
    });
    // Promotion contrôlée + suppression du profil patient inutile.
    await db().query(`DELETE FROM patients WHERE user_id = $1`, [result.user.id]);
    await db().query(`UPDATE users SET role = $2, status = 'ACTIVE' WHERE id = $1`, [result.user.id, body.role]);

    if (body.branch_id) {
      await db().query(
        `INSERT INTO branch_operators (branch_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [body.branch_id, result.user.id],
      );
      await db().query(
        `INSERT INTO user_scopes (user_id, branch_id, wilaya_code)
         SELECT $1, $2, b.wilaya_code FROM branches b WHERE b.id = $2 ON CONFLICT DO NOTHING`,
        [result.user.id, body.branch_id],
      );
    }
    await audit({
      actor: request.user,
      action: 'staff.created',
      entity: 'user',
      entityId: result.user.id,
      details: { role: body.role, branch_id: body.branch_id ?? null },
    });
    return json(reply, 201, { user: { ...result.user, role: body.role } });
  });

  /* -------------------------- vérification médecins ----------------------- */

  app.get('/admin/doctors/pending', { preHandler: requireRole(ADMIN_ROLES) }, async (request, reply) => {
    const items = await many(
      `SELECT d.id, u.full_name, u.phone, u.status AS user_status, u.created_at,
              d.license_no, d.primary_specialty_code, d.verified_at, d.rejected_at,
              d.rejection_reason,
              sp.name_fr AS specialty_fr, sp.name_ar AS specialty_ar,
              c.name_fr AS clinic_name_fr
         FROM doctors d
         JOIN users u ON u.id = d.user_id
         JOIN specialties sp ON sp.code = d.primary_specialty_code
         LEFT JOIN clinics c ON c.id = d.clinic_id
        WHERE d.verified_at IS NULL AND d.rejected_at IS NULL
        ORDER BY u.created_at ASC`,
    );
    return json(reply, 200, { items });
  });

  app.post('/admin/doctors/:id/verify', { preHandler: requireRole(ADMIN_ROLES) }, async (request, reply) => {
    const body = validate(request.body ?? {}, { note: { type: 'string', max: 500 } });
    const result = await directory.verifyDoctor(request.params.id, {
      approved: true,
      note: body.note ?? '',
      actor: request.user,
    });
    return json(reply, 200, result);
  });

  app.post('/admin/doctors/:id/reject', { preHandler: requireRole(ADMIN_ROLES) }, async (request, reply) => {
    const body = validate(request.body ?? {}, { note: { type: 'string', required: true, max: 500 } });
    const result = await directory.verifyDoctor(request.params.id, {
      approved: false,
      note: body.note,
      actor: request.user,
    });
    return json(reply, 200, result);
  });

  /* ------------------------------ modération ------------------------------ */

  app.get('/admin/reviews', { preHandler: requireRole(ADMIN_ROLES) }, async (request, reply) => {
    const status = (request.query || {}).status ?? 'PENDING';
    const items = await many(
      `SELECT r.id, r.rating, r.comment, r.status, r.created_at, r.moderation_note,
              u.full_name AS doctor_name, p.full_name AS patient_name
         FROM reviews r
         JOIN doctors d ON d.id = r.doctor_id
         JOIN users u ON u.id = d.user_id
         JOIN patients p ON p.id = r.patient_id
        WHERE ($1::text IS NULL OR r.status = $1)
        ORDER BY r.created_at DESC LIMIT 100`,
      [status === 'all' ? null : status],
    );
    return json(reply, 200, { items });
  });

  app.post('/admin/reviews/:id/moderate', { preHandler: requireRole(ADMIN_ROLES) }, async (request, reply) => {
    const body = validate(request.body, {
      status: { type: 'string', required: true, enum: ['APPROVED', 'REJECTED'] },
      note: { type: 'string', max: 500 },
    });
    const result = await directory.moderateReview(request.params.id, {
      status: body.status,
      note: body.note ?? '',
      actor: request.user,
    });
    return json(reply, 200, result);
  });

  /* -------------------------------- cliniques ----------------------------- */

  app.post('/admin/clinics', { preHandler: requireRole(ADMIN_ROLES) }, async (request, reply) => {
    const clinic = await directory.upsertClinic(request.body ?? {}, { actor: request.user });
    return json(reply, 201, { clinic });
  });

  app.patch('/admin/clinics/:id', { preHandler: requireRole(ADMIN_ROLES) }, async (request, reply) => {
    const clinic = await directory.upsertClinic({ ...(request.body ?? {}), id: request.params.id }, { actor: request.user });
    return json(reply, 200, { clinic });
  });

  app.post('/admin/clinics/:id/verify', { preHandler: requireRole(ADMIN_ROLES) }, async (request, reply) => {
    const clinic = await one(
      `UPDATE clinics SET verified_at = now(), verified_by = $2 WHERE id = $1 RETURNING id, verified_at`,
      [request.params.id, request.user.id],
    );
    if (!clinic) throw Errors.notFound('Clinic');
    await audit({ actor: request.user, action: 'clinic.verified', entity: 'clinic', entityId: clinic.id });
    return json(reply, 200, { clinic });
  });

  /* ------------------------------- réglages ------------------------------- */

  app.get('/admin/settings', { preHandler: requireRole(ADMIN_ROLES) }, async (request, reply) => {
    const rows = await many('SELECT key, value, updated_at FROM system_settings ORDER BY key');
    return json(reply, 200, { items: rows });
  });

  app.put('/admin/settings/:key', { preHandler: requireRole([ROLES.SUPER_ADMIN, ROLES.ADMIN]) }, async (request, reply) => {
    const key = request.params.key;
    if (!/^public\.[a-z_.]+$/.test(key)) throw Errors.validation({ key: 'clé non autorisée' });
    const value = request.body?.value;
    if (value === undefined) throw Errors.validation({ value: 'required' });
    const row = await one(
      `INSERT INTO system_settings (key, value, updated_by, updated_at)
       VALUES ($1,$2,$3, now())
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = now()
       RETURNING key, value`,
      [key, JSON.stringify(value), request.user.id],
    );
    await audit({
      actor: request.user,
      action: 'settings.updated',
      entity: 'system_setting',
      entityId: key,
      details: { value },
    });
    return json(reply, 200, { setting: row });
  });

  /* ------------------------------ commissions ----------------------------- */

  app.get('/admin/commission-rules', { preHandler: requireRole(STAFF_ROLES) }, async (request, reply) => {
    const items = await many(
      `SELECT * FROM commission_rules ORDER BY scope, effective_from DESC`,
    );
    return json(reply, 200, { items });
  });

  app.post('/admin/commission-rules', { preHandler: requireRole([ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.FINANCE_MANAGER]) }, async (
    request,
    reply,
  ) => {
    const body = validate(request.body, {
      scope: { type: 'string', required: true, enum: ['BOOKING_FEE', 'TELECONSULT'] },
      platform_pct: { type: 'number', required: true, min: 0, max: 100 },
      branch_pct: { type: 'number', min: 0, max: 100 },
      operator_pct: { type: 'number', min: 0, max: 100 },
      psp_fixed: { type: 'number', min: 0, max: 100000, integer: true },
      doctor_pct: { type: 'number', min: 0, max: 100 },
      branch_id: { type: 'string', max: 64 },
    });

    const total = (body.branch_pct ?? 0) + (body.operator_pct ?? 0) + body.platform_pct;
    if (body.scope === 'BOOKING_FEE' && total !== 100) {
      throw Errors.validation({ total: 'platform + branch + operator doit valoir 100 %' });
    }
    if (body.scope === 'TELECONSULT' && body.platform_pct + (body.doctor_pct ?? 100 - body.platform_pct) !== 100) {
      throw Errors.validation({ total: 'platform + doctor doit valoir 100 %' });
    }

    // Historisation : l'ancienne règle est désactivée, jamais supprimée.
    await db().query(
      `UPDATE commission_rules SET active = false WHERE scope = $1 AND active
        AND coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid) = coalesce($2::uuid, '00000000-0000-0000-0000-000000000000'::uuid)`,
      [body.scope, body.branch_id ?? null],
    );
    const rule = await one(
      `INSERT INTO commission_rules (scope, branch_id, platform_pct, branch_pct, operator_pct, psp_fixed, doctor_pct)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [
        body.scope,
        body.branch_id ?? null,
        body.platform_pct,
        body.branch_pct ?? 0,
        body.operator_pct ?? 0,
        body.psp_fixed ?? 0,
        body.doctor_pct ?? (body.scope === 'TELECONSULT' ? 100 - body.platform_pct : 0),
      ],
    );
    await audit({
      actor: request.user,
      action: 'commission_rule.created',
      entity: 'commission_rule',
      entityId: rule.id,
      details: { scope: body.scope, platform_pct: body.platform_pct },
    });
    return json(reply, 201, { rule });
  });

  /* -------------------------------- rapports ------------------------------ */

  app.get('/reports/overview', { preHandler: requireRole(STAFF_ROLES) }, async (request, reply) => {
    const period = reports.resolvePeriod((request.query || {}).from, (request.query || {}).to);
    return json(reply, 200, await reports.platformOverview(period));
  });

  app.get('/reports/revenue', { preHandler: requireRole(STAFF_ROLES) }, async (request, reply) => {
    const period = reports.resolvePeriod((request.query || {}).from, (request.query || {}).to);
    const summary = await finance.revenueSummary(period);
    return json(reply, 200, summary);
  });

  app.get('/reports/doctors', { preHandler: requireRole(STAFF_ROLES) }, async (request, reply) => {
    const period = reports.resolvePeriod((request.query || {}).from, (request.query || {}).to);
    return json(reply, 200, { items: await reports.doctorReport(period) });
  });

  app.get('/reports/branches', {
    preHandler: requireRole([...STAFF_ROLES, ROLES.BRANCH_MANAGER]),
  }, async (request, reply) => {
    const period = reports.resolvePeriod((request.query || {}).from, (request.query || {}).to);
    return json(reply, 200, await reports.branchReport(period));
  });

  app.get('/reports/refunds', { preHandler: requireRole([...STAFF_ROLES]) }, async (request, reply) => {
    const period = reports.resolvePeriod((request.query || {}).from, (request.query || {}).to);
    return json(reply, 200, { items: await reports.refundReport(period) });
  });

  /** Export CSV (compatible Excel) — `?format=csv`. */
  app.get('/reports/:kind/export', { preHandler: requireRole(STAFF_ROLES) }, async (request, reply) => {
    const period = reports.resolvePeriod((request.query || {}).from, (request.query || {}).to);
    const rows = await reports.exportBundle({ ...period, kind: request.params.kind });
    const csv = reports.toCsv(rows);
    await audit({
      actor: request.user,
      action: 'report.exported',
      entity: 'report',
      entityId: request.params.kind,
      details: { rows: rows.length },
    });
    return reply
      .type('text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="rdvdz-${request.params.kind}-${period.from.slice(0, 10)}.csv"`)
      .send(csv);
  });

  /* ------------------------------ reversements ---------------------------- */

  app.post('/admin/settlements', { preHandler: requireRole([ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.FINANCE_MANAGER]) }, async (
    request,
    reply,
  ) => {
    const body = validate(request.body, {
      beneficiary_type: { type: 'string', required: true, enum: ['BRANCH', 'OPERATOR', 'DOCTOR'] },
      beneficiary_id: { type: 'string', required: true, max: 64 },
      period_start: { type: 'string', required: true, max: 10 },
      period_end: { type: 'string', required: true, max: 10 },
    });
    const settlement = await finance.buildSettlement({
      beneficiaryType: body.beneficiary_type,
      beneficiaryId: body.beneficiary_id,
      periodStart: body.period_start,
      periodEnd: body.period_end,
      createdBy: request.user.id,
    });
    await audit({
      actor: request.user,
      action: 'settlement.created',
      entity: 'settlement',
      entityId: settlement.id,
      details: { net: settlement.net },
    });
    return json(reply, 201, { settlement });
  });

  app.post('/admin/settlements/:id/pay', { preHandler: requireRole([ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.FINANCE_MANAGER]) }, async (
    request,
    reply,
  ) => {
    const body = validate(request.body ?? {}, { reference: { type: 'string', max: 120 } });
    const settlement = await finance.markSettlementPaid(request.params.id, {
      reference: body.reference ?? null,
      actor: request.user,
    });
    return json(reply, 200, { settlement });
  });

  /* --------------------------------- audit -------------------------------- */

  app.get('/admin/audit-logs', { preHandler: requireRole(ADMIN_ROLES) }, async (request, reply) => {
    const query = request.query || {};
    const items = await many(
      `SELECT id, actor_user_id, actor_role, action, entity, entity_id, ip, created_at, details
         FROM audit_logs
        WHERE ($1::text IS NULL OR action = $1)
          AND ($2::text IS NULL OR entity = $2)
          AND ($3::text = '' OR entity_id = $3)
        ORDER BY id DESC LIMIT $4`,
      [query.action ?? null, query.entity ?? null, String(query.entity_id ?? ''), Math.min(toInt(query.limit, 100), 500)],
    );
    return json(reply, 200, { items });
  });

  /* --------------------------- appareils desktop -------------------------- */

  app.get('/admin/desktop-devices', { preHandler: requireRole(ADMIN_ROLES) }, async (request, reply) => {
    return json(reply, 200, { items: await syncService.listDevices() });
  });

  app.post('/admin/desktop-devices/pair', { preHandler: requireRole(ADMIN_ROLES) }, async (request, reply) => {
    const body = validate(request.body, {
      product: { type: 'string', required: true, enum: ['DENTARDV', 'MEDIRDV'] },
      name: { type: 'string', max: 120 },
      doctor_id: { type: 'string', max: 64 },
      clinic_id: { type: 'string', max: 64 },
    });
    const device = await syncService.pairDevice({
      product: body.product,
      name: body.name ?? '',
      clinicId: body.clinic_id ?? null,
      doctorId: body.doctor_id ?? null,
      actor: request.user,
    });
    // Le secret n'est renvoyé qu'ici, une seule fois.
    return json(reply, 201, device);
  });

  app.post('/admin/desktop-devices/:id/revoke', { preHandler: requireRole(ADMIN_ROLES) }, async (request, reply) => {
    return json(reply, 200, await syncService.revokeDevice(request.params.id, request.user));
  });

  app.get('/admin/desktop-devices/:id/log', { preHandler: requireRole(ADMIN_ROLES) }, async (request, reply) => {
    const items = await many(
      `SELECT direction, entity, local_id, remote_id, operation, status, detail, created_at
         FROM desktop_sync_log WHERE device_id = $1 ORDER BY id DESC LIMIT 200`,
      [request.params.id],
    );
    return json(reply, 200, { items });
  });

  app.get('/admin/desktop-conflicts', { preHandler: requireRole(ADMIN_ROLES) }, async (request, reply) => {
    const items = await many(
      `SELECT c.id, c.remote_id, c.local_id, c.reason, c.created_at, d.product, d.name AS device_name
         FROM desktop_conflicts c JOIN desktop_devices d ON d.id = c.device_id
        WHERE c.resolved_at IS NULL
        ORDER BY c.created_at DESC LIMIT 100`,
    );
    return json(reply, 200, { items });
  });

  app.post('/admin/desktop-conflicts/:id/resolve', { preHandler: requireRole(ADMIN_ROLES) }, async (request, reply) => {
    const body = validate(request.body, { resolution: { type: 'string', required: true, min: 3, max: 500 } });
    return json(reply, 200, await syncService.resolveConflict(request.params.id, body.resolution, request.user));
  });
}
