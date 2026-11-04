/**
 * Construction de l'application HTTP.
 *
 * Ordre des protections :
 *  1. en-têtes de sécurité sur TOUTE réponse ;
 *  2. corps JSON limité en taille (+ conservation du corps brut pour les
 *     webhooks, indispensable à la vérification HMAC) ;
 *  3. résolution de la session (cookie HttpOnly) ;
 *  4. routes (chaque route déclare ses rôles autorisés) ;
 *  5. gestion d'erreurs normalisée (aucune fuite de trace technique).
 */

import Fastify from 'fastify';
import { config } from './config.js';
import { AppError, Errors } from './lib/errors.js';
import { resolveSession, assertCsrf } from './lib/security.js';
import { audit } from './lib/audit.js';

import authRoutes from './routes/auth.js';
import directoryRoutes from './routes/directory.js';
import bookingRoutes from './routes/bookings.js';
import consultationRoutes from './routes/consultations.js';
import paymentRoutes from './routes/payments.js';
import opsRoutes from './routes/ops.js';
import adminRoutes from './routes/admin.js';
import desktopRoutes from './routes/desktop.js';
import meRoutes from './routes/me.js';
import webRoutes from './routes/web.js';

/** Cookie minimal (aucune dépendance externe). */
export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

export async function buildApp(options = {}) {
  const app = Fastify({
    logger: options.logger ?? (config.logLevel === 'silent' ? false : { level: config.logLevel }),
    bodyLimit: 2 * 1024 * 1024,
    trustProxy: true,
    disableRequestLogging: config.isTest,
  });

  // Corps brut conservé pour les webhooks signés.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    request.rawBody = body;
    if (!body || body.length === 0) return done(null, {});
    try {
      done(null, JSON.parse(body));
    } catch {
      done(new AppError('BAD_JSON', 'JSON invalide', 400));
    }
  });

  app.addHook('onSend', async (request, reply, payload) => {
    // Les fichiers du front portent leur propre CSP (plus permissive pour les
    // styles calculés) : on ne la remplace pas ici.
    if (reply.getHeader('x-rdvdz-static')) return payload;
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'same-origin');
    reply.header('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    if (config.isProduction) {
      reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    if (!request.url.startsWith('/api/v1/webhooks/')) {
      reply.header(
        'Content-Security-Policy',
        "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      );
    }
    return payload;
  });

  app.decorateRequest('user', null);
  app.decorateRequest('identity', null);
  app.decorateRequest('rawBody', null);

  app.addHook('onRequest', async (request) => {
    request.cookies = parseCookies(request.headers.cookie);
    if (request.url.startsWith('/api/v1/webhooks/') || request.url.startsWith('/api/v1/health')) return;
    const user = await resolveSession(request);
    if (user) {
      request.user = user;
      request.identity = { csrf_token: user.csrf_token, session_id: user.session_id };
    }
  });

  // CSRF après résolution de session, avant les handlers mutatifs.
  app.addHook('preHandler', async (request) => {
    if (!request.user) return; // les routes publiques gèrent elles-mêmes
    assertCsrf(request);
  });

  app.setErrorHandler(async (error, request, reply) => {
    const isAppError = error instanceof AppError;
    const rawStatus = error.statusCode ?? error.status;
    const status = isAppError
      ? error.status
      : Number.isInteger(rawStatus) && rawStatus >= 400 && rawStatus < 600
        ? rawStatus
        : 500;

    if (status >= 500) {
      request.log?.error({ err: error }, 'unhandled error');
      await audit({
        actor: request.user ? { id: request.user.id, role: request.user.role } : undefined,
        action: 'error.unhandled',
        entity: 'http',
        entityId: request.url,
        ip: request.ip,
        details: { message: error.message },
      });
    }

    const payload = {
      error: {
        code: isAppError ? error.code : status === 500 ? 'INTERNAL_ERROR' : error.code || 'ERROR',
        message:
          status >= 500
            ? 'Une erreur interne est survenue.'
            : isAppError
              ? error.message
              : String(error.message || 'Requête invalide'),
        details: isAppError ? error.details : {},
      },
    };
    return reply.code(status).type('application/json; charset=utf-8').send(payload);
  });

  app.setNotFoundHandler((request, reply) =>
    reply.code(404).type('application/json; charset=utf-8').send({
      error: { code: 'NOT_FOUND', message: 'Route inconnue', details: {} },
    }),
  );

  // Santé (aucune donnée sensible).
  const { schemaVersion } = await import('./db.js');
  app.get('/api/v1/health', async () => ({ ok: true, service: 'rdvdz-api', time: new Date().toISOString() }));
  app.get('/api/v1/ready', async () => {
    try {
      const version = await schemaVersion();
      return { ok: true, schema_version: version, payments: config.payments.provider, otp_debug: config.notifications.otpDebug };
    } catch (error) {
      return { ok: false, error: 'database_unavailable' };
    }
  });

  await app.register(authRoutes, { prefix: '/api/v1' });
  await app.register(directoryRoutes, { prefix: '/api/v1' });
  await app.register(bookingRoutes, { prefix: '/api/v1' });
  await app.register(consultationRoutes, { prefix: '/api/v1' });
  await app.register(paymentRoutes, { prefix: '/api/v1' });
  await app.register(opsRoutes, { prefix: '/api/v1' });
  await app.register(adminRoutes, { prefix: '/api/v1' });
  await app.register(desktopRoutes, { prefix: '/api/v1' });
  await app.register(meRoutes, { prefix: '/api/v1' });
  // Front statique (PWA) : déclaré en DERNIER pour ne jamais masquer une API.
  if (!config.isTest || options.withWeb) await app.register(webRoutes);

  return app;
}

export { Errors };
