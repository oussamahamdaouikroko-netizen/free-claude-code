/**
 * Routes publiques de l'annuaire : référentiels, recherche, profil, avis.
 * Toutes les lectures sont publiques, les écritures sont authentifiées.
 */

import * as directory from '../modules/directory/service.js';
import { listOpenSlots, isIsoDay } from '../modules/booking/slots.js';
import { requireAuth } from '../lib/security.js';
import { validate, json, toInt } from '../lib/http.js';
import { Errors } from '../lib/errors.js';
import { one } from '../db.js';

export default async function directoryRoutes(app) {
  app.get('/reference/wilayas', async (request, reply) => json(reply, 200, { items: await directory.wilayas() }));

  app.get('/reference/specialties', async (request, reply) =>
    json(reply, 200, { items: await directory.specialties() }),
  );

  app.get('/reference/config', async (request, reply) => json(reply, 200, await directory.publicConfig()));

  app.get('/doctors', async (request, reply) => {
    const query = request.query || {};
    const items = await directory.searchDoctors({
      q: query.q,
      specialty: query.specialty,
      wilaya: toInt(query.wilaya),
      commune: query.commune,
      teleconsult: query.teleconsult === '1' || query.teleconsult === 'true',
      limit: toInt(query.limit, 20),
      offset: toInt(query.offset, 0),
    });
    return json(reply, 200, { items });
  });

  app.get('/doctors/:id', async (request, reply) => {
    const profile = await directory.doctorProfile(request.params.id);
    return json(reply, 200, profile);
  });

  app.get('/doctors/:id/slots', async (request, reply) => {
    const { from, to, mode } = request.query || {};
    const start = from ?? new Date().toISOString().slice(0, 10);
    const end = to ?? new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
    if (!isIsoDay(start) || !isIsoDay(end)) throw Errors.validation({ from: 'YYYY-MM-DD' });
    const items = await listOpenSlots(request.params.id, { from: start, to: end, mode, limit: 200 });
    return json(reply, 200, { items });
  });

  app.get('/clinics/:id', async (request, reply) => json(reply, 200, await directory.clinicProfile(request.params.id)));

  app.post('/reviews', { preHandler: requireAuth }, async (request, reply) => {
    if (request.user.role !== 'PATIENT') throw Errors.forbidden('Seul un patient peut déposer un avis');
    const body = validate(request.body, {
      appointmentId: { type: 'string', required: true, max: 64 },
      rating: { type: 'number', required: true, min: 1, max: 5, integer: true },
      comment: { type: 'string', max: 1000 },
    });
    const patient = await one('SELECT id FROM patients WHERE user_id = $1', [request.user.id]);
    if (!patient) throw Errors.forbidden('Profil patient manquant');

    const review = await directory.createReview({
      patientId: patient.id,
      appointmentId: body.appointmentId,
      rating: body.rating,
      comment: body.comment ?? '',
      actor: request.user,
    });
    return json(reply, 201, { review, message: 'Merci. Votre avis sera publié après modération.' });
  });

  app.get('/reviews/mine', { preHandler: requireAuth }, async (request, reply) => {
    const { many } = await import('../db.js');
    const patient = await one('SELECT id FROM patients WHERE user_id = $1', [request.user.id]);
    if (!patient) return json(reply, 200, { items: [] });
    const items = await many(
      `SELECT id, doctor_id, appointment_id, rating, comment, status, created_at
         FROM reviews WHERE patient_id = $1 ORDER BY created_at DESC`,
      [patient.id],
    );
    return json(reply, 200, { items });
  });
}
