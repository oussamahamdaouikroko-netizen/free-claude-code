/**
 * Documents médicaux : téléversement chiffré, stockage privé, liens signés.
 *
 * Un document n'est JAMAIS servi par une URL devinable. Le téléchargement
 * exige un lien signé lié au document, à l'utilisateur et à une échéance
 * (5 minutes par défaut, configurable).
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../../config.js';
import { db, many, one } from '../../db.js';
import { AppError, Errors } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { encryptBuffer, decryptBuffer, signLink, verifyLink, randomToken } from '../../lib/crypto.js';
import { loadAuthorized } from './service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORAGE_ROOT = path.resolve(config.storage.dir);

export const ALLOWED_MIME = new Map([
  ['application/pdf', 'pdf'],
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
  ['image/heic', 'heic'],
]);

export const MAX_SIZE_BYTES = 10 * 1024 * 1024;

/**
 * Enregistre un document téléversé.
 * @param {object} input
 * @param {string} input.consultationId
 * @param {string} input.filename
 * @param {string} input.mime
 * @param {Buffer} input.buffer
 * @param {{ id: string, role: string }} input.actor
 * @param {{ doctorId?: string|null, patientId?: string|null }} input.identity
 */
export async function uploadDocument(input) {
  const { consultationId, filename, mime, buffer, actor, identity } = input;
  const consultation = await loadAuthorized(consultationId, actor, identity);

  if (!ALLOWED_MIME.has(mime)) {
    throw Errors.validation({ file: `type non autorisé (${mime || 'inconnu'})` });
  }
  if (!buffer || buffer.length === 0) throw Errors.validation({ file: 'fichier vide' });
  if (buffer.length > MAX_SIZE_BYTES) throw Errors.validation({ file: 'fichier trop volumineux (max 10 Mo)' });
  if (['CLOSED', 'REJECTED', 'CANCELLED'].includes(consultation.status)) {
    throw Errors.conflict('CONSULTATION_CLOSED', 'Consultation clôturée');
  }

  // Le nom de stockage est aléatoire : il ne révèle ni le patient ni le nom
  // d'origine du fichier.
  const storageKey = `${consultationId}/${randomToken(18)}.bin`;
  const absolute = path.join(STORAGE_ROOT, storageKey);
  if (!absolute.startsWith(STORAGE_ROOT)) throw Errors.validation({ path: 'invalid' });

  const encrypted = encryptBuffer(buffer, config.storage.encryptionKey || 'dev-key-'.padEnd(32, 'x'));
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, encrypted);

  const digest = createHash('sha256').update(buffer).digest('hex');
  const safeName = String(filename || 'document')
    .replace(/[/\\]/g, '_')
    .replace(/[^\w.\-\u0600-\u06FF ]+/g, '_')
    .slice(0, 180);

  const row = await one(
    `INSERT INTO medical_documents
       (consultation_id, patient_id, doctor_id, storage_key, filename, mime, size_bytes, sha256, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [
      consultationId,
      consultation.patient_id,
      consultation.doctor_id,
      storageKey,
      safeName,
      mime,
      buffer.length,
      digest,
      actor.id,
    ],
  );

  await audit({
    actor,
    action: 'medical_document.uploaded',
    entity: 'medical_document',
    entityId: row.id,
    details: { consultation_id: consultationId, size: buffer.length, mime },
  });

  return {
    id: row.id,
    filename: row.filename,
    mime: row.mime,
    size_bytes: row.size_bytes,
    sha256: row.sha256,
    created_at: row.created_at,
  };
}

/** Métadonnées des documents d'une consultation (jamais le contenu). */
export async function listDocuments(consultationId, { actor, identity }) {
  await loadAuthorized(consultationId, actor, identity);
  const rows = await many(
    `SELECT id, filename, mime, size_bytes, sha256, created_at
       FROM medical_documents
      WHERE consultation_id = $1 AND deleted_at IS NULL
      ORDER BY created_at ASC`,
    [consultationId],
  );
  await audit({
    actor,
    action: 'medical_document.listed',
    entity: 'consultation',
    entityId: consultationId,
    details: { count: rows.length },
  });
  return rows;
}

/** Crée un lien de téléchargement signé, court et lié à l'utilisateur. */
export async function createLink(documentId, { actor, identity }) {
  const doc = await one('SELECT * FROM medical_documents WHERE id = $1 AND deleted_at IS NULL', [documentId]);
  if (!doc) throw Errors.notFound('Document');
  await loadAuthorized(doc.consultation_id, actor, identity);

  const expiresAt = Date.now() + config.security.documentLinkTtlSeconds * 1000;
  const signature = signLink({
    secret: config.security.appSecret,
    documentId,
    userId: actor.id,
    expiresAt,
  });
  await audit({
    actor,
    action: 'medical_document.link_issued',
    entity: 'medical_document',
    entityId: documentId,
    details: { expires_at: new Date(expiresAt).toISOString() },
  });
  return {
    url: `/api/v1/documents/${documentId}?user=${actor.id}&exp=${expiresAt}&sig=${signature}`,
    expires_at: new Date(expiresAt).toISOString(),
  };
}

/**
 * Lit un document à partir d'un lien signé (pas de session requise : le lien
 * EST l'autorisation, avec une échéance courte et une signature infalsifiable).
 */
export async function readSignedDocument({ documentId, userId, expiresAt, signature, now = Date.now() }) {
  const valid = verifyLink({
    secret: config.security.appSecret,
    documentId,
    userId,
    expiresAt,
    signature,
    now,
  });
  if (!valid) throw new AppError('LINK_EXPIRED', 'Lien expiré ou invalide', 410);
  const doc = await one('SELECT * FROM medical_documents WHERE id = $1 AND deleted_at IS NULL', [documentId]);
  if (!doc) throw Errors.notFound('Document');

  const absolute = path.join(STORAGE_ROOT, doc.storage_key);
  if (!absolute.startsWith(STORAGE_ROOT)) throw Errors.forbidden('Chemin invalide');
  const encrypted = await readFile(absolute);
  const buffer = decryptBuffer(encrypted, config.storage.encryptionKey || 'dev-key-'.padEnd(32, 'x'));

  await db().query(
    `INSERT INTO audit_logs (actor_user_id, action, entity, entity_id, details)
     VALUES ($1, 'medical_document.read', 'medical_document', $2, $3)`,
    [userId, doc.id, JSON.stringify({ via: 'signed_link' })],
  );

  return { buffer, doc };
}

/** Suppression logique (le fichier reste pour l'audit, l'accès est fermé). */
export async function deleteDocument(documentId, { actor, identity }) {
  const doc = await one('SELECT * FROM medical_documents WHERE id = $1 AND deleted_at IS NULL', [documentId]);
  if (!doc) throw Errors.notFound('Document');
  await loadAuthorized(doc.consultation_id, actor, identity);
  await db().query('UPDATE medical_documents SET deleted_at = now() WHERE id = $1', [documentId]);
  await audit({
    actor,
    action: 'medical_document.deleted',
    entity: 'medical_document',
    entityId: documentId,
  });
  return { ok: true };
}
