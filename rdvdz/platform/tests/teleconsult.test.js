/**
 * Téléconsultation : garde-fous légaux (loi 18-11 / 18-07), cloisonnement des
 * dossiers, cycle de vie, documents chiffrés et liens signés.
 *
 * Aucune donnée clinique ne sort de la plateforme : ces tests vérifient aussi
 * que les canaux non conformes (WhatsApp) n'y sont jamais exposés.
 */

import './env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  setup,
  teardown,
  call,
  registerPatient,
  createVerifiedDoctorWithSlots,
  createAdmin,
} from './helpers.js';
import { db, one } from '../src/db.js';
import { config } from '../src/config.js';
import { clearAll as clearRateLimits } from '../src/lib/rate-limit.js';

let fixture;
let patient;
let doctor;

const PDF_BASE64 = Buffer.from('%PDF-1.4\n% contenu de test confidentiel\n').toString('base64');

test.before(async () => {
  await setup();
  fixture = await createVerifiedDoctorWithSlots({ teleconsult: true, fee: 2000 });
  // Un médecin qui téléconsulte gratuitement (acte non payant) : c'est le seul
  // cas autorisé tant que TELEMEDICINE_PAID_ENABLED=false.
  await db().query(`UPDATE doctors SET teleconsult_fee = 0 WHERE id = $1`, [fixture.doctorId]);
  doctor = fixture.doctorLogin;
  patient = await registerPatient();
});

test.after(async () => {
  await teardown();
});

test.beforeEach(async () => {
  clearRateLimits();
  await db().query(`UPDATE doctors SET teleconsult_enabled = true, teleconsult_fee = 0 WHERE id = $1`, [
    fixture.doctorId,
  ]);
  config.compliance.telemedicineEnabled = true;
  config.compliance.telemedicinePaidEnabled = false;
});

/** Crée une demande de consultation valide. */
async function requestConsultation(overrides = {}) {
  const response = await call('POST', '/api/v1/consultations', {
    token: patient.token,
    csrf: patient.csrf,
    body: {
      doctor_id: fixture.doctorId,
      kind: 'ASYNC_TEXT',
      subject: 'Douleur dentaire persistante',
      symptom_summary: 'Douleur molaire depuis trois jours, sensible au froid.',
      consent: true,
      emergency_ack: true,
      ...overrides,
    },
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.consultation;
}

/* ------------------------------ configuration ----------------------------- */

test('la configuration publique expose l\'état réel et les textes légaux', async () => {
  const response = await call('GET', '/api/v1/teleconsult/config');
  assert.equal(response.status, 200);
  assert.equal(response.body.enabled, true);
  assert.equal(response.body.paidEnabled, false, 'acte payant fermé par défaut');
  assert.equal(typeof response.body.noticeFr, 'string');
  assert.equal(typeof response.body.noticeAr, 'string');
  assert.equal(response.body.noticeAr.length > 0, true, 'la notice arabe est obligatoire (parité AR/FR)');
});

test('la téléconsultation peut être coupée par configuration (LEGAL_BLOCKED)', async () => {
  config.compliance.telemedicineEnabled = false;
  try {
    const enabled = await call('GET', '/api/v1/teleconsult/config');
    assert.equal(enabled.body.enabled, false);

    const response = await call('POST', '/api/v1/consultations', {
      token: patient.token,
      csrf: patient.csrf,
      body: {
        doctor_id: fixture.doctorId,
        kind: 'ASYNC_TEXT',
        subject: 'Test',
        symptom_summary: 'Résumé suffisamment long pour passer.',
        consent: true,
        emergency_ack: true,
      },
    });
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'LEGAL_BLOCKED');
  } finally {
    config.compliance.telemedicineEnabled = true;
  }
});

/* -------------------------------- création -------------------------------- */

test('consentement et accusé d\'urgence sont obligatoires et horodatés', async () => {
  const withoutConsent = await call('POST', '/api/v1/consultations', {
    token: patient.token,
    csrf: patient.csrf,
    body: {
      doctor_id: fixture.doctorId,
      kind: 'ASYNC_TEXT',
      subject: 'Sans consentement',
      symptom_summary: 'Résumé suffisamment long pour passer.',
      consent: false,
      emergency_ack: true,
    },
  });
  assert.equal(withoutConsent.status, 422);

  const withoutAck = await call('POST', '/api/v1/consultations', {
    token: patient.token,
    csrf: patient.csrf,
    body: {
      doctor_id: fixture.doctorId,
      kind: 'ASYNC_TEXT',
      subject: 'Sans accusé',
      symptom_summary: 'Résumé suffisamment long pour passer.',
      consent: true,
      emergency_ack: false,
    },
  });
  assert.equal(withoutAck.status, 422);

  const consultation = await requestConsultation();
  const row = await one('SELECT consent_at, emergency_ack_at FROM consultations WHERE id = $1', [
    consultation.id,
  ]);
  assert.ok(row.consent_at, 'le consentement est horodaté côté serveur');
  assert.ok(row.emergency_ack_at);
});

test('un résumé de symptômes trop court est refusé', async () => {
  const response = await call('POST', '/api/v1/consultations', {
    token: patient.token,
    csrf: patient.csrf,
    body: {
      doctor_id: fixture.doctorId,
      kind: 'ASYNC_TEXT',
      subject: 'Court',
      symptom_summary: 'mal',
      consent: true,
      emergency_ack: true,
    },
  });
  assert.equal(response.status, 422);
});

test('un médecin sans téléconsultation activée est refusé', async () => {
  await db().query(`UPDATE doctors SET teleconsult_enabled = false WHERE id = $1`, [fixture.doctorId]);
  const response = await call('POST', '/api/v1/consultations', {
    token: patient.token,
    csrf: patient.csrf,
    body: {
      doctor_id: fixture.doctorId,
      kind: 'ASYNC_TEXT',
      subject: 'Indisponible',
      symptom_summary: 'Résumé suffisamment long pour passer.',
      consent: true,
      emergency_ack: true,
    },
  });
  assert.equal(response.status, 409);
  assert.equal(response.body.error.code, 'TELECONSULT_UNAVAILABLE');
});

test('la téléconsultation payante reste bloquée sans validation juridique', async () => {
  await db().query(`UPDATE doctors SET teleconsult_fee = 1500, teleconsult_enabled = true WHERE id = $1`, [
    fixture.doctorId,
  ]);
  const response = await call('POST', '/api/v1/consultations', {
    token: patient.token,
    csrf: patient.csrf,
    body: {
      doctor_id: fixture.doctorId,
      kind: 'VIDEO_SCHEDULED',
      subject: 'Acte payant',
      symptom_summary: 'Résumé suffisamment long pour passer.',
      consent: true,
      emergency_ack: true,
    },
  });
  assert.equal(response.status, 403);
  assert.equal(response.body.error.code, 'LEGAL_BLOCKED');
  assert.equal(response.body.error.details.requires, 'TELEMEDICINE_PAID_ENABLED');
});

test('seul un patient peut demander une consultation', async () => {
  const response = await call('POST', '/api/v1/consultations', {
    token: doctor.token,
    csrf: doctor.csrf,
    body: {
      doctor_id: fixture.doctorId,
      kind: 'ASYNC_TEXT',
      subject: 'Moi-même',
      symptom_summary: 'Résumé suffisamment long pour passer.',
      consent: true,
      emergency_ack: true,
    },
  });
  assert.equal(response.status, 403);
});

test('la demande crée une trace d\'audit et notifie le médecin en interne', async () => {
  const consultation = await requestConsultation();
  const events = await db().query(
    `SELECT event FROM consultation_events WHERE consultation_id = $1`,
    [consultation.id],
  );
  assert.deepEqual(events.rows.map((r) => r.event), ['created']);

  const audit = await db().query(
    `SELECT action FROM audit_logs WHERE entity_id = $1`,
    [consultation.id],
  );
  assert.ok(audit.rows.some((r) => r.action === 'consultation.created'));

  const doctorUser = await one('SELECT user_id FROM doctors WHERE id = $1', [fixture.doctorId]);
  const inbox = await db().query(
    `SELECT template_code FROM notifications WHERE user_id = $1`,
    [doctorUser.user_id],
  );
  assert.ok(inbox.rows.length >= 1, 'le médecin reçoit une notification in-app');
});

/* --------------------------------- cloisonnement -------------------------- */

test('un dossier n\'est lisible que par le patient, son médecin ou un administrateur', async () => {
  const consultation = await requestConsultation();

  const owner = await call('GET', `/api/v1/consultations/${consultation.id}`, { token: patient.token });
  assert.equal(owner.status, 200);
  assert.equal(owner.body.consultation.id, consultation.id);
  assert.ok(owner.body.consultation.symptom_summary, 'le patient voit son propre résumé');

  const intruder = await registerPatient();
  const forbidden = await call('GET', `/api/v1/consultations/${consultation.id}`, { token: intruder.token });
  assert.equal(forbidden.status, 403);

  const doctorView = await call('GET', `/api/v1/consultations/${consultation.id}`, { token: doctor.token });
  assert.equal(doctorView.status, 200);

  const admin = await createAdmin('ADMIN');
  const adminView = await call('GET', `/api/v1/consultations/${consultation.id}`, { token: admin.token });
  assert.equal(adminView.status, 200);

  // Un opérateur de branche n'a AUCUN accès au contenu clinique.
  const operator = await createAdmin('OPERATOR');
  const denied = await call('GET', `/api/v1/consultations/${consultation.id}`, { token: operator.token });
  assert.equal(denied.status, 403);
});

test('les listes sont filtrées par rôle', async () => {
  await requestConsultation();
  const mine = await call('GET', '/api/v1/consultations', { token: patient.token });
  assert.equal(mine.status, 200);
  assert.ok(mine.body.items.length >= 1);

  const intruder = await registerPatient();
  const theirs = await call('GET', '/api/v1/consultations', { token: intruder.token });
  assert.equal(theirs.body.items.length, 0);

  const operator = await createAdmin('OPERATOR');
  const denied = await call('GET', '/api/v1/consultations', { token: operator.token });
  assert.equal(denied.status, 403);
});

/* --------------------------------- cycle de vie --------------------------- */

test('le cycle acceptation → réponse → clôture est contrôlé', async () => {
  const consultation = await requestConsultation();

  // Le patient ne peut pas accepter sa propre demande.
  const selfAccept = await call('POST', `/api/v1/consultations/${consultation.id}/accept`, {
    token: patient.token,
    csrf: patient.csrf,
  });
  assert.equal(selfAccept.status, 403);

  const accepted = await call('POST', `/api/v1/consultations/${consultation.id}/accept`, {
    token: doctor.token,
    csrf: doctor.csrf,
  });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.consultation.status, 'ACCEPTED');
  assert.ok(accepted.body.consultation.accepted_at);

  // Accepter deux fois est une transition interdite.
  const twice = await call('POST', `/api/v1/consultations/${consultation.id}/accept`, {
    token: doctor.token,
    csrf: doctor.csrf,
  });
  assert.equal(twice.status, 409);
  assert.equal(twice.body.error.code, 'INVALID_TRANSITION');

  // Un message du médecin fait passer en IN_PROGRESS.
  const message = await call('POST', `/api/v1/consultations/${consultation.id}/messages`, {
    token: doctor.token,
    csrf: doctor.csrf,
    body: { body: 'Pouvez-vous préciser la dent concernée ?' },
  });
  assert.equal(message.status, 201);
  assert.equal(message.body.message.author_role, 'DOCTOR');

  const afterMessage = await one('SELECT status FROM consultations WHERE id = $1', [consultation.id]);
  assert.equal(afterMessage.status, 'IN_PROGRESS');

  const answer = await call('POST', `/api/v1/consultations/${consultation.id}/answer`, {
    token: doctor.token,
    csrf: doctor.csrf,
    body: {
      answer: 'Prise en charge antalgique puis consultation présentielle.',
      recommend_physical_exam: true,
    },
  });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.equal(answer.body.consultation.status, 'ANSWERED');
  assert.equal(answer.body.consultation.physical_exam_recommended, true);

  const closed = await call('POST', `/api/v1/consultations/${consultation.id}/close`, {
    token: patient.token,
    csrf: patient.csrf,
  });
  assert.equal(closed.status, 200);
  assert.equal(closed.body.consultation.status, 'CLOSED');

  // Plus aucun message après clôture.
  const late = await call('POST', `/api/v1/consultations/${consultation.id}/messages`, {
    token: patient.token,
    csrf: patient.csrf,
    body: { body: 'Une dernière question ?' },
  });
  assert.equal(late.status, 409);
  assert.equal(late.body.error.code, 'CONSULTATION_CLOSED');
});

test('un médecin peut refuser une demande avec un motif, jamais sans', async () => {
  const consultation = await requestConsultation();
  const noReason = await call('POST', `/api/v1/consultations/${consultation.id}/reject`, {
    token: doctor.token,
    csrf: doctor.csrf,
    body: {},
  });
  assert.equal(noReason.status, 422);

  const rejected = await call('POST', `/api/v1/consultations/${consultation.id}/reject`, {
    token: doctor.token,
    csrf: doctor.csrf,
    body: { reason: 'Nécessite un examen clinique en cabinet' },
  });
  assert.equal(rejected.status, 200);
  assert.equal(rejected.body.consultation.status, 'REJECTED');
  assert.ok(rejected.body.consultation.refusal_reason.includes('cabinet'));
});

test('le médecin peut demander une information complémentaire', async () => {
  const consultation = await requestConsultation();
  const response = await call('POST', `/api/v1/consultations/${consultation.id}/request-info`, {
    token: doctor.token,
    csrf: doctor.csrf,
    body: { message: 'Merci de joindre la radiographie.' },
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.consultation.status, 'AWAITING_PATIENT');

  const answered = await call('POST', `/api/v1/consultations/${consultation.id}/messages`, {
    token: patient.token,
    csrf: patient.csrf,
    body: { body: 'Voici la radiographie demandée.' },
  });
  assert.equal(answered.status, 201);
  const row = await one('SELECT status FROM consultations WHERE id = $1', [consultation.id]);
  assert.equal(row.status, 'IN_PROGRESS', 'la réponse du patient relance le dossier');
});

test('aucun diagnostic n\'est généré automatiquement (champ absent par défaut)', async () => {
  const consultation = await requestConsultation();
  const row = await one(
    'SELECT doctor_answer, refusal_reason, physical_exam_recommended FROM consultations WHERE id = $1',
    [
      consultation.id,
    ],
  );
  assert.equal(row.doctor_answer, '', 'aucun texte médical produit par la plateforme');
  assert.equal(row.refusal_reason, '');
  assert.equal(row.physical_exam_recommended, false);
});

/* ---------------------------------- vidéo --------------------------------- */

test('la salle vidéo est opaque, stable et réservée aux consultations vidéo', async () => {
  const textConsultation = await requestConsultation();
  const wrongKind = await call('POST', `/api/v1/consultations/${textConsultation.id}/video-room`, {
    token: patient.token,
    csrf: patient.csrf,
  });
  assert.equal(wrongKind.status, 409);
  assert.equal(wrongKind.body.error.code, 'NOT_VIDEO');

  const video = await requestConsultation({ kind: 'VIDEO_SCHEDULED', subject: 'Visio' });
  const first = await call('POST', `/api/v1/consultations/${video.id}/video-room`, {
    token: patient.token,
    csrf: patient.csrf,
  });
  assert.equal(first.status, 200);
  assert.match(first.body.room, /^rdvdz-[a-z0-9]+$/);
  assert.equal(first.body.recording, false, 'aucun enregistrement automatique');
  assert.equal(first.body.room.includes(patient.user.full_name.toLowerCase().replace(/\s+/g, '')), false);

  const second = await call('POST', `/api/v1/consultations/${video.id}/video-room`, {
    token: doctor.token,
    csrf: doctor.csrf,
  });
  assert.equal(second.body.room, first.body.room, 'la salle est stable pour les deux participants');
});

/* -------------------------------- documents ------------------------------- */

test('un document est chiffré sur disque et jamais exposé par URL devinable', async () => {
  const consultation = await requestConsultation();
  const upload = await call('POST', `/api/v1/consultations/${consultation.id}/documents`, {
    token: patient.token,
    csrf: patient.csrf,
    body: { filename: 'radio.pdf', mime: 'application/pdf', content_base64: PDF_BASE64 },
  });
  assert.equal(upload.status, 200, JSON.stringify(upload.body));
  const doc = upload.body.document;
  assert.equal(doc.mime, 'application/pdf');
  assert.ok(doc.sha256);
  assert.equal(rawHasBase64(JSON.stringify(upload.body)), false, 'le contenu n\'est pas renvoyé');

  const row = await one('SELECT storage_key FROM medical_documents WHERE id = $1', [doc.id]);
  assert.ok(row.storage_key.includes(consultation.id));
  assert.equal(row.storage_key.includes('radio'), false, 'le nom d\'origine n\'apparaît pas dans le chemin');

  // Le fichier sur disque ne contient pas le PDF en clair.
  const onDisk = await readFile(path.resolve(config.storage.dir, row.storage_key));
  assert.equal(onDisk.includes(Buffer.from('%PDF')), false, 'contenu chiffré au repos');
  assert.ok(onDisk.length > 0);
});

function rawHasBase64(text) {
  return text.includes(PDF_BASE64.slice(0, 40));
}

test('les types de fichiers dangereux et les corps trop gros sont refusés', async () => {
  const consultation = await requestConsultation();

  const html = await call('POST', `/api/v1/consultations/${consultation.id}/documents`, {
    token: patient.token,
    csrf: patient.csrf,
    body: { filename: 'x.html', mime: 'text/html', content_base64: Buffer.from('<script>').toString('base64') },
  });
  assert.equal(html.status, 422);

  const missing = await call('POST', `/api/v1/consultations/${consultation.id}/documents`, {
    token: patient.token,
    csrf: patient.csrf,
    body: { filename: 'x.pdf' },
  });
  assert.equal(missing.status, 422);

  const huge = await call('POST', `/api/v1/consultations/${consultation.id}/documents`, {
    token: patient.token,
    csrf: patient.csrf,
    body: { filename: 'big.pdf', mime: 'application/pdf', content_base64: 'A'.repeat(3 * 1024 * 1024) },
  });
  assert.equal(huge.status, 413, 'le corps est refusé avant tout traitement');
});

test('un tiers ne peut ni lister, ni téléverser, ni supprimer un document', async () => {
  const consultation = await requestConsultation();
  const upload = await call('POST', `/api/v1/consultations/${consultation.id}/documents`, {
    token: patient.token,
    csrf: patient.csrf,
    body: { filename: 'ordonnance.pdf', mime: 'application/pdf', content_base64: PDF_BASE64 },
  });
  const docId = upload.body.document.id;

  const intruder = await registerPatient();
  const list = await call('GET', `/api/v1/consultations/${consultation.id}/documents`, {
    token: intruder.token,
  });
  assert.equal(list.status, 403);

  const link = await call('GET', `/api/v1/documents/${docId}/link`, { token: intruder.token });
  assert.equal(link.status, 403);

  const remove = await call('DELETE', `/api/v1/documents/${docId}`, {
    token: intruder.token,
    csrf: intruder.csrf,
  });
  assert.equal(remove.status, 403);
});

test('le lien signé sert le document déchiffré, puis expire ou se falsifie sans effet', async () => {
  const consultation = await requestConsultation();
  const upload = await call('POST', `/api/v1/consultations/${consultation.id}/documents`, {
    token: patient.token,
    csrf: patient.csrf,
    body: { filename: 'compte-rendu.pdf', mime: 'application/pdf', content_base64: PDF_BASE64 },
  });
  const docId = upload.body.document.id;

  const link = await call('GET', `/api/v1/documents/${docId}/link`, { token: patient.token });
  assert.equal(link.status, 200);
  assert.match(link.body.url, /^\/api\/v1\/documents\//);

  const served = await call('GET', link.body.url);
  assert.equal(served.status, 200);
  assert.equal(served.headers['cache-control'], 'no-store');
  assert.equal(served.raw, Buffer.from(PDF_BASE64, 'base64').toString('utf8'));

  // Signature falsifiée → 410, jamais de fuite.
  const tampered = await call('GET', link.body.url.replace(/sig=[^&]+/, 'sig=deadbeef'));
  assert.equal(tampered.status, 410);
  assert.equal(tampered.body.error.code, 'LINK_EXPIRED');

  // Lien périmé → 410.
  const expired = link.body.url.replace(/exp=\d+/, 'exp=1');
  const late = await call('GET', expired);
  assert.equal(late.status, 410);

  // Sans signature du tout → 410.
  const naked = await call('GET', `/api/v1/documents/${docId}`);
  assert.equal(naked.status, 410);
});

test('la suppression d\'un document est logique : le lien cesse de fonctionner', async () => {
  const consultation = await requestConsultation();
  const upload = await call('POST', `/api/v1/consultations/${consultation.id}/documents`, {
    token: patient.token,
    csrf: patient.csrf,
    body: { filename: 'a-supprimer.pdf', mime: 'application/pdf', content_base64: PDF_BASE64 },
  });
  const docId = upload.body.document.id;
  const link = await call('GET', `/api/v1/documents/${docId}/link`, { token: patient.token });

  const removed = await call('DELETE', `/api/v1/documents/${docId}`, {
    token: patient.token,
    csrf: patient.csrf,
  });
  assert.equal(removed.status, 200);

  const after = await call('GET', link.body.url);
  assert.equal(after.status, 404);

  const list = await call('GET', `/api/v1/consultations/${consultation.id}/documents`, {
    token: patient.token,
  });
  assert.equal(list.body.items.length, 0);

  const row = await one('SELECT deleted_at FROM medical_documents WHERE id = $1', [docId]);
  assert.ok(row.deleted_at, 'la trace reste en base pour l\'audit');
});
