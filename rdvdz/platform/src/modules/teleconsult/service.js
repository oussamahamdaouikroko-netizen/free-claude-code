/**
 * Téléconsultation.
 *
 * Garde-fous médicaux codés (pas seulement affichés) :
 *  - `TELEMEDICINE_ENABLED=false` ⇒ toute création échoue (`LEGAL_BLOCKED`) ;
 *  - l'acte clinique **payant** reste fermé tant que
 *    `TELEMEDICINE_PAID_ENABLED=false` (revue juridique requise) ;
 *  - `consent_at` et `emergency_ack_at` sont obligatoires et horodatés ;
 *  - aucun diagnostic ni ordonnance n'est généré automatiquement : seul un
 *    document téléversé et signé par le médecin peut exister ;
 *  - le médecin peut refuser ou demander un examen présentiel à tout moment.
 *
 * Cloisonnement : une consultation n'est lisible que par le patient concerné,
 * le médecin concerné, ou un administrateur habilité. Les opérateurs de
 * branches n'y ont **aucun** accès.
 */

import { db, many, one, nextReference } from '../../db.js';
import { Errors } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { config } from '../../config.js';
import { randomToken } from '../../lib/crypto.js';

export const KINDS = ['ASYNC_TEXT', 'DOCUMENT_REVIEW', 'VIDEO_SCHEDULED', 'FOLLOW_UP'];

/**
 * Transitions autorisées. `REQUESTED → AWAITING_PATIENT` couvre le cas réel où
 * le médecin réclame une pièce (radio, analyse) avant même d'accepter le
 * dossier : refuser cette demande forcerait un faux « accepté ».
 */
export const CONSULT_TRANSITIONS = {
  REQUESTED: ['ACCEPTED', 'AWAITING_PATIENT', 'REJECTED', 'CANCELLED'],
  ACCEPTED: ['IN_PROGRESS', 'AWAITING_PATIENT', 'ANSWERED', 'CLOSED', 'REJECTED'],
  IN_PROGRESS: ['AWAITING_PATIENT', 'ANSWERED', 'CLOSED'],
  AWAITING_PATIENT: ['IN_PROGRESS', 'ANSWERED', 'CLOSED'],
  ANSWERED: ['CLOSED'],
  CLOSED: [],
  REJECTED: [],
  CANCELLED: [],
};

/** Paramètres publics de la téléconsultation (textes légaux inclus). */
export async function telemedConfig() {
  const row = await one(`SELECT value FROM system_settings WHERE key = 'public.telemedicine'`);
  return {
    enabled: config.compliance.telemedicineEnabled && (row?.value?.enabled ?? true),
    paidEnabled: config.compliance.telemedicinePaidEnabled,
    noticeFr: row?.value?.notice_fr ?? '',
    noticeAr: row?.value?.notice_ar ?? '',
  };
}

/**
 * Crée une demande de consultation.
 * @param {object} input
 * @param {string} input.patientId
 * @param {string} input.doctorId
 * @param {string} input.kind
 * @param {string} input.subject
 * @param {string} input.symptomSummary
 * @param {boolean} input.consent
 * @param {boolean} input.emergencyAck
 * @param {object} [input.actor]
 */
export async function createConsultation(input) {
  const cfg = await telemedConfig();
  if (!cfg.enabled) {
    throw Errors.legalBlocked('La téléconsultation est désactivée sur cette plateforme');
  }
  if (!KINDS.includes(input.kind)) throw Errors.validation({ kind: 'invalid' });
  if (!input.consent) throw Errors.validation({ consent: 'obligatoire' });
  if (!input.emergencyAck) throw Errors.validation({ emergency_ack: 'obligatoire' });
  if (!input.symptomSummary || input.symptomSummary.trim().length < 10) {
    throw Errors.validation({ symptom_summary: 'min length 10' });
  }

  const doctor = await one(
    `SELECT d.*, u.status AS user_status FROM doctors d JOIN users u ON u.id = d.user_id WHERE d.id = $1`,
    [input.doctorId],
  );
  if (!doctor || doctor.user_status !== 'ACTIVE') throw Errors.notFound('Doctor');
  if (!doctor.teleconsult_enabled) {
    throw Errors.conflict('TELECONSULT_UNAVAILABLE', 'Ce médecin ne propose pas la téléconsultation');
  }

  // Acte clinique payant : bloqué par défaut jusqu'à revue juridique.
  const payable = doctor.teleconsult_fee > 0;
  if (payable && !cfg.paidEnabled) {
    throw Errors.legalBlocked(
      'La téléconsultation payante n\'est pas encore activée (validation juridique en cours)',
      { requires: 'TELEMEDICINE_PAID_ENABLED' },
    );
  }

  const reference = await nextReference('TLC', 'consultations');
  const created = await one(
    `INSERT INTO consultations
       (reference, patient_id, doctor_id, kind, status, price, currency, subject,
        symptom_summary, consent_at, emergency_ack_at)
     VALUES ($1,$2,$3,$4,'REQUESTED',$5,'DZD',$6,$7,now(),now())
     RETURNING *`,
    [
      reference,
      input.patientId,
      input.doctorId,
      input.kind,
      payable ? doctor.teleconsult_fee : 0,
      input.subject.slice(0, 200),
      input.symptomSummary.slice(0, 4000),
    ],
  );

  await db().query(
    `INSERT INTO consultation_events (consultation_id, event, actor_user_id, details)
     VALUES ($1, 'created', $2, $3)`,
    [created.id, input.actor?.id ?? null, JSON.stringify({ kind: input.kind, price: created.price })],
  );

  await audit({
    actor: input.actor,
    action: 'consultation.created',
    entity: 'consultation',
    entityId: created.id,
    details: { kind: input.kind, price: created.price },
  });

  return { consultation: created, payment_required: payable };
}

/**
 * Charge une consultation en vérifiant l'autorisation de l'appelant.
 * @param {string} id
 * @param {{ id: string, role: string }} actor
 * @param {{ doctorId?: string|null, patientId?: string|null }} identity rattachement
 */
export async function loadAuthorized(id, actor, identity = {}) {
  const row = await one(
    `SELECT c.*, d.user_id AS doctor_user_id
       FROM consultations c
       JOIN doctors d ON d.id = c.doctor_id
      WHERE c.id = $1`,
    [id],
  );
  if (!row) throw Errors.notFound('Consultation');

  const isAdmin = ['SUPER_ADMIN', 'ADMIN'].includes(actor.role);
  const isDoctor = identity.doctorId && row.doctor_id === identity.doctorId;
  const isPatient = identity.patientId && row.patient_id === identity.patientId;
  if (!isAdmin && !isDoctor && !isPatient) {
    throw Errors.forbidden('Consultation non accessible');
  }
  return row;
}

/** Transition contrôlée + journal. */
export async function transition(consultationId, to, { actor, identity, details = {} }) {
  const consultation = await loadAuthorized(consultationId, actor, identity);
  const allowed = CONSULT_TRANSITIONS[consultation.status] ?? [];
  if (!allowed.includes(to)) {
    throw Errors.conflict('INVALID_TRANSITION', `${consultation.status} → ${to} interdite`, { allowed });
  }
  const sets = { status: to };
  if (to === 'ACCEPTED') sets.accepted_at = new Date();
  if (to === 'ANSWERED') sets.answered_at = new Date();
  if (to === 'CLOSED') sets.closed_at = new Date();
  if (details.refusalReason) sets.refusal_reason = String(details.refusalReason).slice(0, 500);
  if (details.doctorAnswer !== undefined) sets.doctor_answer = String(details.doctorAnswer).slice(0, 8000);
  if (details.physicalExamRecommended !== undefined) {
    sets.physical_exam_recommended = Boolean(details.physicalExamRecommended);
  }

  const keys = Object.keys(sets);
  const params = keys.map((k) => sets[k]);
  params.push(consultationId);
  const updated = await one(
    `UPDATE consultations SET ${keys.map((k, i) => `"${k}" = $${i + 1}`).join(', ')}
      WHERE id = $${keys.length + 1} RETURNING *`,
    params,
  );

  await db().query(
    `INSERT INTO consultation_events (consultation_id, event, actor_user_id, details)
     VALUES ($1, $2, $3, $4)`,
    [consultationId, `status.${to.toLowerCase()}`, actor?.id ?? null, JSON.stringify(details)],
  );
  await audit({
    actor,
    action: `consultation.${to.toLowerCase()}`,
    entity: 'consultation',
    entityId: consultationId,
    details: { from: consultation.status, ...details },
  });
  return updated;
}

/** Message texte (patient ou médecin). */
export async function addMessage(consultationId, body, { actor, identity }) {
  const consultation = await loadAuthorized(consultationId, actor, identity);
  if (['CLOSED', 'REJECTED', 'CANCELLED'].includes(consultation.status)) {
    throw Errors.conflict('CONSULTATION_CLOSED', 'La consultation est clôturée');
  }
  const text = String(body ?? '').trim();
  if (text.length < 1 || text.length > 4000) throw Errors.validation({ body: 'length 1..4000' });

  const role = identity.doctorId && consultation.doctor_id === identity.doctorId ? 'DOCTOR' : 'PATIENT';
  const message = await one(
    `INSERT INTO consultation_messages (consultation_id, author_user_id, author_role, body)
     VALUES ($1,$2,$3,$4) RETURNING id, consultation_id, author_role, body, created_at`,
    [consultationId, actor.id, role, text],
  );

  if (consultation.status === 'ACCEPTED' && role === 'DOCTOR') {
    await transition(consultationId, 'IN_PROGRESS', { actor, identity });
  }
  if (consultation.status === 'AWAITING_PATIENT' && role === 'PATIENT') {
    await transition(consultationId, 'IN_PROGRESS', { actor, identity });
  }
  return message;
}

/** Messages d'une consultation autorisée. */
export async function listMessages(consultationId, { actor, identity }) {
  await loadAuthorized(consultationId, actor, identity);
  return many(
    `SELECT id, author_role, body, created_at, read_at
       FROM consultation_messages WHERE consultation_id = $1 ORDER BY created_at ASC`,
    [consultationId],
  );
}

/** Liste filtrée selon le rôle. */
export async function listConsultations({ patientId = null, doctorId = null, status = null, limit = 50 }) {
  const where = [];
  const params = [];
  if (patientId) {
    params.push(patientId);
    where.push(`c.patient_id = $${params.length}`);
  }
  if (doctorId) {
    params.push(doctorId);
    where.push(`c.doctor_id = $${params.length}`);
  }
  if (status) {
    params.push(status);
    where.push(`c.status = $${params.length}`);
  }
  params.push(Math.min(limit, 100));
  return many(
    `SELECT c.id, c.reference, c.kind, c.status, c.price, c.subject, c.created_at, c.answered_at,
            p.full_name AS patient_name, u.full_name AS doctor_name
       FROM consultations c
       JOIN patients p ON p.id = c.patient_id
       JOIN doctors d ON d.id = c.doctor_id
       JOIN users u ON u.id = d.user_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY c.created_at DESC LIMIT $${params.length}`,
    params,
  );
}

/**
 * Crée (ou renvoie) une salle vidéo. Aucun enregistrement automatique ;
 * l'identifiant de salle est opaque et signé, jamais dérivé du nom du patient.
 */
export async function videoRoom(consultationId, { actor, identity }) {
  const consultation = await loadAuthorized(consultationId, actor, identity);
  if (consultation.kind !== 'VIDEO_SCHEDULED') {
    throw Errors.conflict('NOT_VIDEO', 'Cette consultation n\'est pas vidéo');
  }
  let room = consultation.video_room;
  if (!room) {
    room = `rdvdz-${randomToken(9).toLowerCase().replace(/[^a-z0-9]/g, '')}`;
    await db().query('UPDATE consultations SET video_room = $2 WHERE id = $1', [consultationId, room]);
  }
  await audit({
    actor,
    action: 'consultation.video_room.opened',
    entity: 'consultation',
    entityId: consultationId,
    details: { room },
  });
  return {
    room,
    // Le client WebRTC a besoin d'un serveur STUN public ; le TURN authentifié
    // doit être fourni par l'exploitant (variable d'environnement à ajouter).
    ice_servers: [{ urls: ['stun:stun.l.google.com:19302'] }],
    recording: false,
    note: 'Aucun enregistrement. Le TURN authentifié doit être configuré pour les réseaux restrictifs.',
  };
}
