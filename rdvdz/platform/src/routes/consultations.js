/**
 * Routes de téléconsultation et de documents médicaux.
 *
 * Le contrôle d'accès est délégué au module, qui compare l'identité réelle
 * (patient rattaché / médecin rattaché) : un opérateur n'a jamais de
 * rattachement, il est donc systématiquement refusé.
 */

import * as teleconsult from '../modules/teleconsult/service.js';
import * as documents from '../modules/teleconsult/documents.js';
import { requireAuth } from '../lib/security.js';
import { auth as authModule } from '../lib/session-helpers.js';
import { validate, json, toInt } from '../lib/http.js';
import { Errors } from '../lib/errors.js';
import { one } from '../db.js';
import * as notifications from '../modules/notifications/service.js';

/** Identité de rattachement de l'appelant. */
async function identity(request) {
  return authModule.identityFor(request.user);
}

export default async function consultationRoutes(app) {
  app.get('/teleconsult/config', async (request, reply) => json(reply, 200, await teleconsult.telemedConfig()));

  app.post('/consultations', { preHandler: requireAuth }, async (request, reply) => {
    if (request.user.role !== 'PATIENT') throw Errors.forbidden('Seul un patient peut demander une consultation');
    const body = validate(request.body, {
      doctor_id: { type: 'string', required: true, max: 64 },
      kind: { type: 'string', required: true, enum: teleconsult.KINDS },
      subject: { type: 'string', required: true, min: 3, max: 200 },
      symptom_summary: { type: 'string', required: true, min: 10, max: 4000 },
      consent: { type: 'boolean', required: true },
      emergency_ack: { type: 'boolean', required: true },
    });
    const patient = await one('SELECT id, phone FROM patients WHERE user_id = $1', [request.user.id]);
    if (!patient) throw Errors.forbidden('Profil patient manquant');

    const result = await teleconsult.createConsultation({
      patientId: patient.id,
      doctorId: body.doctor_id,
      kind: body.kind,
      subject: body.subject,
      symptomSummary: body.symptom_summary,
      consent: body.consent,
      emergencyAck: body.emergency_ack,
      actor: request.user,
    });

    const doctorUser = await one(
      `SELECT u.id FROM doctors d JOIN users u ON u.id = d.user_id WHERE d.id = $1`,
      [body.doctor_id],
    );
    if (doctorUser) {
      await notifications.notify({
        userId: doctorUser.id,
        patientId: patient.id,
        templateCode: 'consultation.created',
        locale: 'fr',
        payload: { reference: result.consultation.reference },
        channels: ['IN_APP'],
        dedupeKey: `consultation-created:${result.consultation.id}`,
      });
    }

    return json(reply, 201, {
      consultation: {
        id: result.consultation.id,
        reference: result.consultation.reference,
        status: result.consultation.status,
        price: result.consultation.price,
      },
      payment_required: result.payment_required,
    });
  });

  app.get('/consultations', { preHandler: requireAuth }, async (request, reply) => {
    const id = await identity(request);
    const query = request.query || {};
    const options = { status: query.status, limit: toInt(query.limit, 50) };
    if (request.user.role === 'PATIENT') options.patientId = id.patientId ?? '00000000-0000-0000-0000-000000000000';
    else if (request.user.role === 'DOCTOR') options.doctorId = id.doctorId ?? '00000000-0000-0000-0000-000000000000';
    else if (!['SUPER_ADMIN', 'ADMIN'].includes(request.user.role)) throw Errors.forbidden();
    return json(reply, 200, { items: await teleconsult.listConsultations(options) });
  });

  app.get('/consultations/:id', { preHandler: requireAuth }, async (request, reply) => {
    const id = await identity(request);
    const consultation = await teleconsult.loadAuthorized(request.params.id, request.user, id);
    // Le résumé symptomatique n'est visible que du patient et du médecin.
    const messages = await teleconsult.listMessages(request.params.id, { actor: request.user, identity: id });
    const docs = await documents.listDocuments(request.params.id, { actor: request.user, identity: id });
    return json(reply, 200, { consultation, messages, documents: docs });
  });

  app.post('/consultations/:id/messages', { preHandler: requireAuth }, async (request, reply) => {
    const id = await identity(request);
    const body = validate(request.body, { body: { type: 'string', required: true, min: 1, max: 4000 } });
    const message = await teleconsult.addMessage(request.params.id, body.body, {
      actor: request.user,
      identity: id,
    });
    return json(reply, 201, { message });
  });

  app.post('/consultations/:id/accept', { preHandler: requireAuth }, async (request, reply) => {
    const id = await identity(request);
    if (request.user.role !== 'DOCTOR') throw Errors.forbidden();
    const updated = await teleconsult.transition(request.params.id, 'ACCEPTED', {
      actor: request.user,
      identity: id,
    });
    return json(reply, 200, { consultation: updated });
  });

  app.post('/consultations/:id/reject', { preHandler: requireAuth }, async (request, reply) => {
    const id = await identity(request);
    if (request.user.role !== 'DOCTOR') throw Errors.forbidden();
    // Un refus médical doit toujours être motivé : le patient a droit à une
    // explication compréhensible (et traçable).
    const body = validate(request.body ?? {}, { reason: { type: 'string', required: true, min: 3, max: 500 } });
    const updated = await teleconsult.transition(request.params.id, 'REJECTED', {
      actor: request.user,
      identity: id,
      details: { refusalReason: body.reason },
    });
    return json(reply, 200, { consultation: updated });
  });

  app.post('/consultations/:id/request-info', { preHandler: requireAuth }, async (request, reply) => {
    const id = await identity(request);
    if (request.user.role !== 'DOCTOR') throw Errors.forbidden();
    const body = validate(request.body, { message: { type: 'string', required: true, min: 3, max: 2000 } });
    await teleconsult.addMessage(request.params.id, body.message, { actor: request.user, identity: id });
    const updated = await teleconsult.transition(request.params.id, 'AWAITING_PATIENT', {
      actor: request.user,
      identity: id,
      details: { request: 'info' },
    });
    return json(reply, 200, { consultation: updated });
  });

  app.post('/consultations/:id/answer', { preHandler: requireAuth }, async (request, reply) => {
    const id = await identity(request);
    if (request.user.role !== 'DOCTOR') throw Errors.forbidden();
    // La réponse est un texte rédigé par le médecin : la plateforme ne produit
    // ni diagnostic ni ordonnance automatique.
    const body = validate(request.body, {
      answer: { type: 'string', required: true, min: 10, max: 8000 },
      recommend_physical_exam: { type: 'boolean' },
    });
    const updated = await teleconsult.transition(request.params.id, 'ANSWERED', {
      actor: request.user,
      identity: id,
      details: {
        doctorAnswer: body.answer,
        physicalExamRecommended: Boolean(body.recommend_physical_exam),
      },
    });
    await notifications.notify({
      userId: null,
      patientId: updated.patient_id,
      phone: null,
      templateCode: 'consultation.answered',
      locale: 'fr',
      payload: { reference: updated.reference, doctor: request.user.full_name },
      channels: ['IN_APP'],
      dedupeKey: `consultation-answered:${updated.id}`,
    });
    return json(reply, 200, { consultation: updated });
  });

  app.post('/consultations/:id/close', { preHandler: requireAuth }, async (request, reply) => {
    const id = await identity(request);
    const updated = await teleconsult.transition(request.params.id, 'CLOSED', {
      actor: request.user,
      identity: id,
    });
    return json(reply, 200, { consultation: updated });
  });

  app.post('/consultations/:id/video-room', { preHandler: requireAuth }, async (request, reply) => {
    const id = await identity(request);
    return json(reply, 200, await teleconsult.videoRoom(request.params.id, { actor: request.user, identity: id }));
  });

  /* ------------------------------ documents ------------------------------- */

  app.post('/consultations/:id/documents', { preHandler: requireAuth }, async (request) => {
    const id = await identity(request);
    // `multipart/form-data` : Fastify expose les parties via `request.parts()`
    // quand le plugin multipart est enregistré. Pour rester sans dépendance
    // supplémentaire, le client peut aussi envoyer un JSON
    // `{ filename, mime, content_base64 }` (petits fichiers).
    const body = request.body || {};
    const filename = body.filename;
    const mime = body.mime;
    const base64 = body.content_base64;
    if (!filename || !mime || !base64) {
      throw Errors.validation({ file: 'envoyer { filename, mime, content_base64 }' });
    }
    const buffer = Buffer.from(String(base64), 'base64');
    const result = await documents.uploadDocument({
      consultationId: request.params.id,
      filename,
      mime,
      buffer,
      actor: request.user,
      identity: id,
    });
    return { ok: true, document: result };
  });

  app.get('/consultations/:id/documents', { preHandler: requireAuth }, async (request, reply) => {
    const id = await identity(request);
    return json(reply, 200, {
      items: await documents.listDocuments(request.params.id, { actor: request.user, identity: id }),
    });
  });

  app.get('/documents/:id/link', { preHandler: requireAuth }, async (request, reply) => {
    const id = await identity(request);
    return json(reply, 200, await documents.createLink(request.params.id, { actor: request.user, identity: id }));
  });

  app.delete('/documents/:id', { preHandler: requireAuth }, async (request, reply) => {
    const id = await identity(request);
    return json(reply, 200, await documents.deleteDocument(request.params.id, { actor: request.user, identity: id }));
  });

  /**
   * Flux binaire via lien signé. Pas de session : le lien EST l'autorisation
   * (signature + échéance + utilisateur lié).
   */
  app.get('/documents/:id', async (request, reply) => {
    const { user: userId, exp, sig } = request.query || {};
    const result = await documents.readSignedDocument({
      documentId: request.params.id,
      userId,
      expiresAt: Number(exp),
      signature: String(sig ?? ''),
    });
    reply.header('Content-Type', result.doc.mime);
    reply.header('Content-Disposition', `attachment; filename="${encodeURIComponent(result.doc.filename)}"`);
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    return reply.send(result.buffer);
  });
}
