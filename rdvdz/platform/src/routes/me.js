/**
 * Espace « mon compte » : profil patient/médecin, notifications, préférences,
 * droits des personnes (export, rectification, suppression).
 */

import { requireAuth, requireRole, ROLES } from '../lib/security.js';
import { validate, json } from '../lib/http.js';
import { Errors } from '../lib/errors.js';
import { one, many } from '../db.js';
import * as authService from '../modules/auth/service.js';
import * as notifications from '../modules/notifications/service.js';
import * as directory from '../modules/directory/service.js';
import { videoRoom } from '../modules/teleconsult/service.js';

export default async function meRoutes(app) {
  app.get('/me/profile', { preHandler: requireAuth }, async (request, reply) => {
    const identity = await authService.identityFor(request.user);
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
      patient: identity.patient
        ? {
            id: identity.patient.id,
            wilaya_code: identity.patient.wilaya_code,
            commune: identity.patient.commune,
            consent_at: identity.patient.consent_at,
          }
        : null,
      doctor: identity.doctor
        ? {
            id: identity.doctor.id,
            primary_specialty_code: identity.doctor.primary_specialty_code,
            consultation_fee: identity.doctor.consultation_fee,
            teleconsult_fee: identity.doctor.teleconsult_fee,
            teleconsult_enabled: identity.doctor.teleconsult_enabled,
            manual_confirmation: identity.doctor.manual_confirmation,
            slot_minutes: identity.doctor.slot_minutes,
            accepting_new: identity.doctor.accepting_new,
            verified: Boolean(identity.doctor.verified_at),
            bio_fr: identity.doctor.bio_fr,
            bio_ar: identity.doctor.bio_ar,
          }
        : null,
    });
  });

  app.put('/me/profile', { preHandler: requireAuth }, async (request, reply) => {
    const body = validate(request.body ?? {}, {
      locale: { type: 'string', enum: ['ar', 'fr'] },
      full_name: { type: 'string', min: 3, max: 160 },
      wilaya_code: { type: 'number', min: 1, max: 58, integer: true },
      commune: { type: 'string', max: 120 },
    });
    await authService.rectifyPersonalData(request.user.id, {
      fullName: body.full_name,
      wilayaCode: body.wilaya_code,
      commune: body.commune,
    });
    if (body.locale) {
      const { db } = await import('../db.js');
      await db().query('UPDATE users SET locale = $2 WHERE id = $1', [request.user.id, body.locale]);
    }
    return json(reply, 200, { ok: true });
  });

  /** Profil médecin (tarifs, téléconsultation, durée de créneau). */
  app.put('/me/doctor-profile', { preHandler: requireRole([ROLES.DOCTOR]) }, async (request, reply) => {
    const identity = await authService.identityFor(request.user);
    if (!identity.doctorId) throw Errors.forbidden('Profil médecin manquant');
    const body = request.body ?? {};
    const updated = await directory.updateDoctorProfile(identity.doctorId, body, { actor: request.user });
    return json(reply, 200, {
      doctor: {
        id: updated.id,
        consultation_fee: updated.consultation_fee,
        teleconsult_fee: updated.teleconsult_fee,
        teleconsult_enabled: updated.teleconsult_enabled,
        manual_confirmation: updated.manual_confirmation,
        slot_minutes: updated.slot_minutes,
        accepting_new: updated.accepting_new,
        bio_fr: updated.bio_fr,
        bio_ar: updated.bio_ar,
      },
    });
  });

  /* ---------------------------- disponibilités ---------------------------- */

  app.get('/me/availability', { preHandler: requireRole([ROLES.DOCTOR]) }, async (request, reply) => {
    const identity = await authService.identityFor(request.user);
    if (!identity.doctorId) throw Errors.forbidden();
    const hours = await many(
      `SELECT id, weekday, opens, closes, break_start, break_end
         FROM clinic_hours WHERE doctor_id = $1 ORDER BY weekday`,
      [identity.doctorId],
    );
    const timeOff = await many(
      `SELECT id, starts_at, ends_at, reason FROM doctor_time_off
        WHERE doctor_id = $1 AND ends_at > now() ORDER BY starts_at`,
      [identity.doctorId],
    );
    return json(reply, 200, { clinic_id: identity.doctor.clinic_id, hours, time_off: timeOff, slot_minutes: identity.doctor.slot_minutes });
  });

  /** Remplace les horaires du médecin (opération atomique). */
  app.put('/me/availability', { preHandler: requireRole([ROLES.DOCTOR]) }, async (request, reply) => {
    const identity = await authService.identityFor(request.user);
    if (!identity.doctorId) throw Errors.forbidden();
    const body = request.body ?? {};
    if (!Array.isArray(body.hours)) throw Errors.validation({ hours: 'array requis' });

    const { db } = await import('../db.js');
    await db().tx(async (client) => {
      await client.query('DELETE FROM clinic_hours WHERE doctor_id = $1', [identity.doctorId]);
      for (const entry of body.hours.slice(0, 7 * 3)) {
        const weekday = Number(entry.weekday);
        if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) continue;
        if (!entry.opens || !entry.closes) continue;
        await client.query(
          `INSERT INTO clinic_hours (clinic_id, doctor_id, weekday, opens, closes, break_start, break_end)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [
            identity.doctor.clinic_id,
            identity.doctorId,
            weekday,
            entry.opens,
            entry.closes,
            entry.break_start ?? null,
            entry.break_end ?? null,
          ],
        );
      }
    });
    return json(reply, 200, { ok: true });
  });

  app.post('/me/time-off', { preHandler: requireRole([ROLES.DOCTOR]) }, async (request, reply) => {
    const identity = await authService.identityFor(request.user);
    if (!identity.doctorId) throw Errors.forbidden();
    const body = validate(request.body, {
      starts_at: { type: 'string', required: true, max: 40 },
      ends_at: { type: 'string', required: true, max: 40 },
      reason: { type: 'string', max: 200 },
    });
    if (new Date(body.ends_at) <= new Date(body.starts_at)) throw Errors.validation({ ends_at: 'doit être après starts_at' });
    const { db } = await import('../db.js');
    const row = await one(
      `INSERT INTO doctor_time_off (doctor_id, starts_at, ends_at, reason, created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [identity.doctorId, new Date(body.starts_at), new Date(body.ends_at), body.reason ?? '', request.user.id],
    );
    // Les créneaux déjà générés sur cette période sont bloqués.
    await db().query(
      `UPDATE doctor_slots SET status = 'BLOCKED'
        WHERE doctor_id = $1 AND status = 'OPEN' AND starts_at < $3 AND ends_at > $2`,
      [identity.doctorId, new Date(body.starts_at), new Date(body.ends_at)],
    );
    return json(reply, 201, { time_off: row });
  });

  app.delete('/me/time-off/:id', { preHandler: requireRole([ROLES.DOCTOR]) }, async (request, reply) => {
    const identity = await authService.identityFor(request.user);
    const { db } = await import('../db.js');
    await db().query('DELETE FROM doctor_time_off WHERE id = $1 AND doctor_id = $2', [
      request.params.id,
      identity.doctorId,
    ]);
    await db().query(
      `UPDATE doctor_slots SET status = 'OPEN'
        WHERE doctor_id = $1 AND status = 'BLOCKED' AND starts_at > now()`,
      [identity.doctorId],
    );
    return json(reply, 200, { ok: true });
  });

  /* ----------------------------- notifications ---------------------------- */

  app.get('/notifications', { preHandler: requireAuth }, async (request, reply) => {
    return json(reply, 200, { items: await notifications.listForUser(request.user.id) });
  });

  app.post('/notifications/:id/read', { preHandler: requireAuth }, async (request, reply) => {
    return json(reply, 200, await notifications.markRead(request.user.id, request.params.id));
  });

  app.post('/notifications/read-all', { preHandler: requireAuth }, async (request, reply) => {
    return json(reply, 200, await notifications.markRead(request.user.id, null));
  });

  app.get('/notifications/preferences', { preHandler: requireAuth }, async (request, reply) => {
    return json(reply, 200, { items: await notifications.preferences(request.user.id) });
  });

  app.put('/notifications/preferences', { preHandler: requireAuth }, async (request, reply) => {
    const body = validate(request.body, {
      event_code: { type: 'string', required: true, max: 60 },
      channel: { type: 'string', required: true, enum: ['IN_APP', 'EMAIL', 'WHATSAPP', 'SMS'] },
      enabled: { type: 'boolean', required: true },
    });
    return json(reply, 200, await notifications.setPreference(request.user.id, {
      eventCode: body.event_code,
      channel: body.channel,
      enabled: body.enabled,
    }));
  });

  /* ------------------------- droits des personnes ------------------------- */

  app.get('/me/export', { preHandler: requireAuth }, async (request, reply) => {
    const data = await authService.exportPersonalData(request.user.id);
    reply.header('Content-Disposition', `attachment; filename="rdvdz-mes-donnees-${new Date().toISOString().slice(0, 10)}.json"`);
    return json(reply, 200, data);
  });

  app.post('/me/delete', { preHandler: requireAuth }, async (request, reply) => {
    return json(reply, 200, await authService.requestDeletion(request.user.id, { actor: request.user }));
  });

  /** Salle vidéo d'une consultation (le cloisonnement est vérifié par le module). */
  app.post('/me/video-room/:consultationId', { preHandler: requireAuth }, async (request, reply) => {
    const identity = await authService.identityFor(request.user);
    return json(reply, 200, await videoRoom(request.params.consultationId, { actor: request.user, identity }));
  });
}
