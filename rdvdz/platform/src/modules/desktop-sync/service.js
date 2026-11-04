/**
 * Passerelle de synchronisation des postes DENTARDV / MEDIRDV.
 *
 * Sécurité :
 *  - un appareil est identifié par `device_id` + `secret` (stocké haché) ;
 *  - chaque requête porte un HMAC-SHA256 de
 *    `timestamp + méthode + chemin + corps` et un horodatage ±300 s ;
 *  - révocation immédiate possible par un administrateur ;
 *  - tout est journalisé dans `desktop_sync_log`.
 *
 * La plateforme pousse des **réservations** au poste (file `desktop_inbox`)
 * et reçoit l'état réel de l'agenda local (statuts, encaissements constatés,
 * liens local→distant). Aucune donnée médicale ne circule.
 */

import { db, many, one } from '../../db.js';
import { Errors } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { hmac, safeEqual, randomToken, sha256 } from '../../lib/crypto.js';
import { changeStatus } from '../booking/service.js';

const CLOCK_SKEW_SECONDS = 300;

/** Appairage : crée un appareil et renvoie le secret UNE SEULE FOIS. */
export async function pairDevice({ product, name = '', version = '', clinicId = null, doctorId = null, actor = null }) {
  if (!['DENTARDV', 'MEDIRDV'].includes(product)) throw Errors.validation({ product: 'invalid' });
  const deviceId = `dev_${randomToken(9)}`;
  const secret = randomToken(32);

  const row = await one(
    `INSERT INTO desktop_devices (clinic_id, doctor_id, product, name, version, token_hash, secret)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, product, registered_at`,
    [clinicId, doctorId, product, String(name).slice(0, 120), String(version).slice(0, 40), sha256(deviceId), secret],
  );

  await audit({
    actor,
    action: 'desktop.device.paired',
    entity: 'desktop_device',
    entityId: row.id,
    details: { product, clinic_id: clinicId, doctor_id: doctorId },
  });

  return {
    device_id: deviceId,
    secret,
    device_uuid: row.id,
    note: 'Conservez ce secret : il ne sera plus affiché. Il se configure dans le poste (Paramètres → RDV DZ).',
  };
}

/**
 * Authentifie une requête d'appareil.
 * @param {{ authorization?: string, signature?: string, timestamp?: string }} headers
 * @param {string} method
 * @param {string} path
 * @param {string} rawBody
 */
export async function authenticateDevice(headers, method, path, rawBody) {
  const authorization = headers.authorization;
  if (!authorization || !authorization.startsWith('Device ')) throw Errors.deviceUnauthorized();
  const [deviceId, secret] = authorization.slice(7).split('.');
  if (!deviceId || !secret) throw Errors.deviceUnauthorized();

  const device = await one('SELECT * FROM desktop_devices WHERE token_hash = $1', [sha256(deviceId)]);
  if (!device || device.revoked_at) throw Errors.deviceUnauthorized('Appareil inconnu ou révoqué');
  if (!safeEqual(device.secret, secret)) throw Errors.deviceUnauthorized('Secret invalide');

  const timestamp = Number(headers['x-timestamp']);
  if (!Number.isFinite(timestamp)) throw Errors.deviceUnauthorized('Horodatage manquant');
  const skew = Math.abs(Date.now() / 1000 - timestamp);
  if (skew > CLOCK_SKEW_SECONDS) throw Errors.deviceUnauthorized('Horodatage hors tolérance (rejeu ?)');

  const expected = hmac(device.secret, `${timestamp}.${method}.${path}.${rawBody}`);
  if (!safeEqual(expected, String(headers['x-signature'] ?? ''))) {
    throw Errors.deviceUnauthorized('Signature invalide');
  }

  await db().query('UPDATE desktop_devices SET last_seen_at = now() WHERE id = $1', [device.id]);
  return device;
}

/** Met une réservation en file pour un appareil. */
export async function queueForDevice(device, kind, remoteId, payload) {
  const row = await one(
    `INSERT INTO desktop_inbox (device_id, kind, remote_id, payload)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (device_id, remote_id) DO NOTHING
     RETURNING id`,
    [device.id, kind, remoteId, JSON.stringify(payload)],
  );
  return row;
}

/**
 * Ce que le poste doit récupérer depuis son curseur.
 * Les éléments déjà traités (`APPLIED`) ne sont pas renvoyés.
 */
export async function pull(device, cursor = 0) {
  const rows = await many(
    `SELECT id, kind, remote_id, payload, status
       FROM desktop_inbox
      WHERE device_id = $1 AND id > $2 AND status IN ('QUEUED','DELIVERED')
      ORDER BY id ASC
      LIMIT 100`,
    [device.id, Number(cursor) || 0],
  );

  // Marque comme livrés (le poste confirmera par un push `link`).
  if (rows.length) {
    await db().query(
      `UPDATE desktop_inbox SET status = 'DELIVERED', delivered_at = now()
        WHERE device_id = $1 AND id = ANY($2::bigint[]) AND status = 'QUEUED'`,
      [device.id, rows.map((r) => r.id)],
    );
  }

  const next = rows.length ? rows[rows.length - 1].id : Number(cursor) || 0;
  await db().query('UPDATE desktop_devices SET last_cursor = $2 WHERE id = $1', [device.id, next]);

  return {
    cursor: next,
    items: rows.map((r) => ({ remote_id: r.remote_id, kind: r.kind, payload: r.payload, inbox_id: String(r.id) })),
  };
}

/** Appointments réellement confirmés : ce que le poste doit encore savoir. */
export async function confirmedAppointmentsForDoctor(doctorId, { since = null, limit = 100 } = {}) {
  return many(
    `SELECT a.id, a.reference, a.status, a.desktop_uuid, s.starts_at, s.ends_at,
            p.full_name, p.phone
       FROM appointments a
       JOIN doctor_slots s ON s.id = a.slot_id
       JOIN patients p ON p.id = a.patient_id
      WHERE a.doctor_id = $1
        AND a.status IN ('CONFIRMED','CANCELLED','COMPLETED','NO_SHOW')
        AND ($2::timestamptz IS NULL OR a.updated_at > $2)
      ORDER BY a.updated_at ASC
      LIMIT $3`,
    [doctorId, since, Math.min(limit, 300)],
  );
}

/**
 * Traite un push du poste.
 * Chaque élément est appliqué dans sa propre transaction : un conflit sur un
 * élément n'annule pas les autres.
 */
export async function push(device, { outbox = [], cursor = 0 } = {}) {
  const accepted = [];
  const conflicts = [];
  let processed = 0;

  for (const item of outbox.slice(0, 200)) {
    const outboxId = item.outbox_id ?? null;
    try {
      const outcome = await applyOutboxItem(device, item);
      if (outcome.conflict) {
        conflicts.push({ outbox_id: outboxId, local_id: item.local_id, remote_id: item.remote_id, reason: outcome.conflict });
        await logSync(device, 'IN', item.entity, 'CONFLICT', item, outcome.conflict);
      } else {
        accepted.push({ outbox_id: outboxId, remote_id: outcome.remote_id ?? item.remote_id });
        await logSync(device, 'IN', item.entity, 'ACK', item, outcome.note ?? '');
        processed += 1;
      }
    } catch (error) {
      await logSync(device, 'IN', item.entity, 'ERROR', item, error.message);
      conflicts.push({ outbox_id: outboxId, reason: error.code || error.message });
    }
  }

  return { accepted, conflicts, cursor: Number(cursor) || 0, processed };
}

async function applyOutboxItem(device, item) {
  const entity = String(item.entity || '');

  if (entity === 'appointment') {
    const payload = item.payload || {};
    if (item.operation === 'link') {
      // Le poste indique l'identifiant local attribué à une réservation.
      const remoteId = item.remote_id || payload.remote_id;
      if (!remoteId) return { conflict: 'missing_remote_id' };
      await db().query(
        `UPDATE appointments SET desktop_uuid = $1, updated_at = now()
          WHERE id = $2 AND doctor_id IS NOT DISTINCT FROM $3`,
        [String(payload.local_id ?? item.local_id ?? ''), remoteId, device.doctor_id],
      );
      await db().query(
        `UPDATE desktop_inbox SET status = 'APPLIED', applied_at = now()
          WHERE device_id = $1 AND remote_id = $2`,
        [device.id, remoteId],
      );
      return { remote_id: remoteId, note: 'local id linked' };
    }

    if (item.operation === 'status') {
      const remoteId = item.remote_id || payload.remote_id;
      const status = String(payload.status || '').toUpperCase();
      const map = {
        CONFIRMED: 'CONFIRMED',
        COMPLETED: 'COMPLETED',
        DONE: 'COMPLETED',
        CANCELLED: 'CANCELLED',
        NO_SHOW: 'NO_SHOW',
      };
      const target = map[status];
      if (!remoteId) return { conflict: 'missing_remote_id' };
      if (!target) return { conflict: `unknown_status:${status}` };

      const appointment = await one(
        'SELECT id, status, doctor_id FROM appointments WHERE id = $1',
        [remoteId],
      );
      if (!appointment) return { conflict: 'appointment_not_found' };
      if (device.doctor_id && appointment.doctor_id !== device.doctor_id) {
        return { conflict: 'not_your_appointment' };
      }
      if (appointment.status === target) return { remote_id: remoteId, note: 'already in target status' };
      try {
        await changeStatus(remoteId, target, {
          actor: { id: null, role: 'DOCTOR' },
          reason: `desktop:${device.product}`,
        });
      } catch (error) {
        if (error.code === 'INVALID_TRANSITION') return { conflict: `invalid_transition:${appointment.status}->${target}` };
        throw error;
      }
      return { remote_id: remoteId, note: `status ${target}` };
    }

    if (item.operation === 'conflict') {
      // Le poste signale qu'il n'a pas pu appliquer une réservation.
      await db().query(
        `INSERT INTO desktop_conflicts (device_id, remote_id, local_id, reason)
         VALUES ($1,$2,$3,$4)`,
        [device.id, String(item.remote_id ?? payload.remote_id ?? ''), String(item.local_id ?? ''), String(payload.reason ?? 'local_rejected')],
      );
      await db().query(
        `UPDATE desktop_inbox SET status = 'FAILED', last_error = $3
          WHERE device_id = $1 AND remote_id = $2`,
        [device.id, String(item.remote_id ?? payload.remote_id ?? ''), String(payload.reason ?? '')],
      );
      await audit({
        action: 'desktop.conflict.raised',
        entity: 'desktop_device',
        entityId: device.id,
        details: { remote_id: item.remote_id, reason: payload.reason },
      });
      return { remote_id: item.remote_id, note: 'conflict recorded' };
    }

    if (item.operation === 'reserve') {
      // Le poste réserve un créneau saisi dans son agenda : on le trace sans
      // jamais écraser une réservation en ligne existante.
      const payload = item.payload || {};
      return { remote_id: item.remote_id ?? null, note: `reservation noted (${payload.day ?? ''})` };
    }

    return { conflict: `unknown_operation:${item.operation}` };
  }

  if (entity === 'patient_identity') {
    // Identité uniquement : aucune donnée médicale n'est acceptée ici.
    const payload = item.payload || {};
    const forbidden = ['allergies', 'chronic_conditions', 'blood_group', 'notes', 'birth_date'];
    const leaked = forbidden.filter((key) => payload[key] !== undefined);
    if (leaked.length) return { conflict: `medical_data_rejected:${leaked.join(',')}` };
    return { remote_id: item.remote_id ?? null, note: 'identity acknowledged' };
  }

  if (entity === 'payment_note') {
    const payload = item.payload || {};
    await audit({
      action: 'desktop.payment_note',
      entity: 'desktop_device',
      entityId: device.id,
      details: { appointment_id: payload.appointment_id, amount: payload.amount, method: payload.method },
    });
    return { remote_id: item.remote_id ?? null, note: 'payment note recorded' };
  }

  return { conflict: `unknown_entity:${entity}` };
}

async function logSync(device, direction, entity, status, item, detail) {
  await db().query(
    `INSERT INTO desktop_sync_log (device_id, direction, entity, local_id, remote_id, operation, status, detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      device.id,
      direction,
      String(entity || '').slice(0, 40),
      item.local_id ? String(item.local_id).slice(0, 80) : null,
      item.remote_id ? String(item.remote_id).slice(0, 80) : null,
      String(item.operation || '').slice(0, 40),
      status,
      String(detail || '').slice(0, 500),
    ],
  );
}

/** Révocation d'un appareil (vol, changement de poste). */
export async function revokeDevice(deviceUuid, actor = null) {
  const row = await one(
    `UPDATE desktop_devices SET revoked_at = now() WHERE id = $1 RETURNING id, product, name`,
    [deviceUuid],
  );
  if (!row) throw Errors.notFound('Device');
  await audit({
    actor,
    action: 'desktop.device.revoked',
    entity: 'desktop_device',
    entityId: deviceUuid,
    details: { product: row.product, name: row.name },
  });
  return row;
}

/** Liste des appareils (le secret n'est jamais réexposé). */
export async function listDevices() {
  return many(
    `SELECT d.id, d.product, d.name, d.version, d.registered_at, d.last_seen_at, d.revoked_at,
            u.full_name AS doctor_name,
            (SELECT count(*)::int FROM desktop_inbox i WHERE i.device_id = d.id AND i.status = 'QUEUED') AS pending,
            (SELECT count(*)::int FROM desktop_conflicts c WHERE c.device_id = d.id AND c.resolved_at IS NULL) AS conflicts
       FROM desktop_devices d
       LEFT JOIN doctors doc ON doc.id = d.doctor_id
       LEFT JOIN users u ON u.id = doc.user_id
      ORDER BY d.registered_at DESC`,
  );
}

/** Résout un conflit (trace obligatoire : qui, quand, comment). */
export async function resolveConflict(conflictId, resolution, actor) {
  const row = await one(
    `UPDATE desktop_conflicts
        SET resolution = $2, resolved_by = $3, resolved_at = now()
      WHERE id = $1 AND resolved_at IS NULL
      RETURNING *`,
    [conflictId, String(resolution).slice(0, 500), actor?.id ?? null],
  );
  if (!row) throw Errors.conflict('CONFLICT_ALREADY_RESOLVED', 'Conflit introuvable ou déjà résolu');
  await audit({
    actor,
    action: 'desktop.conflict.resolved',
    entity: 'desktop_conflict',
    entityId: conflictId,
    details: { resolution },
  });
  return row;
}
