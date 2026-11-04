/**
 * Routes d'authentification et de compte.
 * Aucune route ici n'expose de secret ni de hash.
 */

import * as rateLimit from '../lib/rate-limit.js';
import * as auth from '../modules/auth/service.js';
import {
  createSession,
  sessionCookie,
  clearSessionCookie,
  revokeSession,
  requireAuth,
  loadScope,
} from '../lib/security.js';
import { validate, json } from '../lib/http.js';

/** Quota par IP : inscription et OTP sont les cibles classiques d'abus. */
function limitByIp(request, bucket, options) {
  rateLimit.hit(`${bucket}:${request.ip}`, options);
}

export default async function authRoutes(app) {
  app.post('/auth/register', async (request, reply) => {
    limitByIp(request, 'register', { limit: 10, windowMs: 3600_000 });
    const body = validate(request.body, {
      fullName: { type: 'string', required: true, min: 3, max: 160 },
      phone: { type: 'string', required: true, max: 30 },
      email: { type: 'string', max: 190 },
      password: { type: 'string', required: true, max: 128 },
      role: { type: 'string', enum: ['PATIENT', 'DOCTOR'] },
      doctor: { type: 'object' },
      locale: { type: 'string', enum: ['ar', 'fr'] },
      consent: { type: 'boolean', required: true },
      wilayaCode: { type: 'number', min: 1, max: 58, integer: true },
    });
    const result = await auth.register({
      ...body,
      doctor: body.doctor ?? undefined,
      ip: request.ip,
      userAgent: request.headers['user-agent'],
    });
    return json(reply, 201, result);
  });

  app.post('/auth/login', async (request, reply) => {
    limitByIp(request, 'login', { limit: 20, windowMs: 600_000 });
    const body = validate(request.body, {
      identifier: { type: 'string', required: true, max: 190 },
      password: { type: 'string', required: true, max: 128 },
    });
    const user = await auth.login({
      ...body,
      ip: request.ip,
      userAgent: request.headers['user-agent'],
    });
    rateLimit.reset(`login:${request.ip}`);

    const session = await createSession(user.id, {
      ip: request.ip,
      userAgent: request.headers['user-agent'],
    });
    reply.header('Set-Cookie', sessionCookie(session.token, session.expiresAt));
    const identity = await auth.identityFor(user);
    const scope = await loadScope(user);
    return json(reply, 200, {
      user,
      csrf_token: session.csrf,
      expires_at: session.expiresAt.toISOString(),
      identity: { patient_id: identity.patientId ?? null, doctor_id: identity.doctorId ?? null },
      scope: { global: scope.global, branches: scope.branchIds, wilayas: scope.wilayas },
    });
  });

  app.post('/auth/logout', { preHandler: requireAuth }, async (request, reply) => {
    await revokeSession(request.user.session_id);
    reply.header('Set-Cookie', clearSessionCookie());
    return json(reply, 200, { ok: true });
  });

  app.get('/auth/me', { preHandler: requireAuth }, async (request, reply) => {
    const identity = await auth.identityFor(request.user);
    const scope = await loadScope(request.user);
    return json(reply, 200, {
      user: {
        id: request.user.id,
        role: request.user.role,
        full_name: request.user.full_name,
        phone: request.user.phone,
        email: request.user.email,
        locale: request.user.locale,
        phone_verified_at: request.user.phone_verified_at,
      },
      csrf_token: request.user.csrf_token,
      identity: {
        patient_id: identity.patientId ?? null,
        doctor_id: identity.doctorId ?? null,
        doctor_verified: Boolean(identity.doctor?.verified_at),
      },
      scope: { global: scope.global, branches: scope.branchIds, wilayas: scope.wilayas },
    });
  });

  app.post('/auth/otp/request', async (request, reply) => {
    limitByIp(request, 'otp', { limit: 6, windowMs: 600_000 });
    const body = validate(request.body, {
      phone: { type: 'string', required: true, max: 30 },
      purpose: { type: 'string', enum: ['LOGIN', 'VERIFY', 'RESET'] },
    });
    return json(reply, 200, await auth.requestOtp({ ...body, ip: request.ip }));
  });

  app.post('/auth/otp/verify', async (request, reply) => {
    limitByIp(request, 'otp-verify', { limit: 20, windowMs: 600_000 });
    const body = validate(request.body, {
      phone: { type: 'string', required: true, max: 30 },
      code: { type: 'string', required: true, min: 4, max: 8 },
      purpose: { type: 'string', enum: ['LOGIN', 'VERIFY', 'RESET'] },
    });
    return json(reply, 200, await auth.verifyOtp(body));
  });

  app.post('/auth/password', { preHandler: requireAuth }, async (request, reply) => {
    const body = validate(request.body, {
      current: { type: 'string', required: true, max: 128 },
      next: { type: 'string', required: true, max: 128 },
    });
    return json(
      reply,
      200,
      await auth.changePassword(request.user.id, { ...body, sessionId: request.user.session_id }),
    );
  });

  app.get('/auth/sessions', { preHandler: requireAuth }, async (request, reply) => {
    const { many } = await import('../db.js');
    const rows = await many(
      `SELECT id, ip, user_agent, created_at, last_seen_at, expires_at
         FROM sessions WHERE user_id = $1 AND revoked_at IS NULL
        ORDER BY last_seen_at DESC`,
      [request.user.id],
    );
    return json(reply, 200, { items: rows, current: request.user.session_id });
  });

  app.delete('/auth/sessions/:id', { preHandler: requireAuth }, async (request, reply) => {
    const { db } = await import('../db.js');
    await db().query('UPDATE sessions SET revoked_at = now() WHERE id = $1 AND user_id = $2', [
      request.params.id,
      request.user.id,
    ]);
    return json(reply, 200, { ok: true });
  });
}
