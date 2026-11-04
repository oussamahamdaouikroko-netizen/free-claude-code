/**
 * Routes de synchronisation des postes DENTARDV / MEDIRDV.
 *
 * Authentification par appareil (pas de session utilisateur) :
 *   Authorization: Device <device_id>.<secret>
 *   x-signature: HMAC-SHA256("<timestamp>.<METHOD>.<path>.<rawBody>", secret)
 *   x-timestamp: secondes epoch (±300 s)
 *
 * Ces routes sont exclues du CSRF (l'authenticité vient de la signature) et
 * n'exposent jamais de données médicales.
 */

import * as syncService from '../modules/desktop-sync/service.js';
import { json, validate } from '../lib/http.js';
import { Errors } from '../lib/errors.js';
import { many, one } from '../db.js';

async function deviceFrom(request) {
  return syncService.authenticateDevice(
    request.headers,
    request.method,
    request.url.split('?')[0],
    request.rawBody ?? '',
  );
}

export default async function desktopRoutes(app) {
  /** Appairage déjà réalisé (route admin) : ici on vérifie seulement l'état. */
  app.post('/desktop/handshake', async (request, reply) => {
    const device = await deviceFrom(request);
    const bookingCfg = await one(`SELECT value FROM system_settings WHERE key = 'public.booking'`);
    return json(reply, 200, {
      ok: true,
      device_uuid: device.id,
      product: device.product,
      server_time: new Date().toISOString(),
      cursor: Number(device.last_cursor) || 0,
      config: {
        hold_ttl_minutes: bookingCfg?.value?.hold_ttl_minutes ?? 10,
        slot_minutes: 20,
      },
      note: 'Synchronisation active. Les données médicales du poste restent locales.',
    });
  });

  app.get('/desktop/pull', async (request, reply) => {
    const device = await deviceFrom(request);
    const cursor = Number(request.query?.cursor ?? 0) || 0;
    const payload = await syncService.pull(device, cursor);
    return json(reply, 200, payload);
  });

  app.post('/desktop/push', async (request, reply) => {
    const device = await deviceFrom(request);
    const body = request.body || {};
    if (!Array.isArray(body.outbox)) throw Errors.validation({ outbox: 'array requis' });
    const result = await syncService.push(device, {
      outbox: body.outbox,
      cursor: Number(body.cursor) || 0,
    });
    return json(reply, 200, result);
  });

  app.post('/desktop/heartbeat', async (request, reply) => {
    const device = await deviceFrom(request);
    const body = request.body || {};
    await one('SELECT 1');
    return json(reply, 200, {
      ok: true,
      device_uuid: device.id,
      server_time: new Date().toISOString(),
      outbox_pending: body.outbox_pending ?? 0,
    });
  });

  /**
   * Ce que la plateforme a réellement confirmé pour ce médecin.
   * Utile au poste pour reconcilier son agenda après une longue coupure.
   */
  app.get('/desktop/appointments', async (request, reply) => {
    const device = await deviceFrom(request);
    if (!device.doctor_id) {
      return json(reply, 200, { items: [], note: 'appareil non rattaché à un médecin' });
    }
    const items = await syncService.confirmedAppointmentsForDoctor(device.doctor_id, {
      since: request.query?.since ?? null,
      limit: Number(request.query?.limit ?? 100),
    });
    return json(reply, 200, { items });
  });

  /** Diagnostic local : versions et compteurs (aucune donnée personnelle). */
  app.get('/desktop/status', async (request, reply) => {
    const device = await deviceFrom(request);
    const counts = await many(
      `SELECT status, count(*)::int AS n FROM desktop_inbox WHERE device_id = $1 GROUP BY status`,
      [device.id],
    );
    return json(reply, 200, {
      device_uuid: device.id,
      product: device.product,
      last_seen_at: device.last_seen_at,
      inbox: counts,
    });
  });
}
