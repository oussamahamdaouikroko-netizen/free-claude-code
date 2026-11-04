/**
 * Journal d'audit.
 *
 * Append-only : l'API n'expose aucune route de modification ni de suppression,
 * et le rôle SQL applicatif ne reçoit que le droit `INSERT` sur cette table
 * (voir docs/06-SECURITY-COMPLIANCE.md §7).
 */

import { db } from '../db.js';
import { maskPhone } from './crypto.js';

/** Clés qui ne doivent jamais apparaître dans un journal. */
const FORBIDDEN_KEYS = new Set([
  'password',
  'password_hash',
  'password_salt',
  'current',
  'next',
  'csrf_token',
  'token',
  'secret',
  'code',
  'code_hash',
  'mfa_secret',
  'symptom_summary',
  'doctor_answer',
  'body',
]);

/** Nettoie les détails : supprime les secrets et masque les téléphones. */
export function sanitizeDetails(details) {
  if (!details || typeof details !== 'object') return {};
  const out = {};
  for (const [key, value] of Object.entries(details)) {
    if (FORBIDDEN_KEYS.has(key)) {
      out[key] = '[masqué]';
      continue;
    }
    if (key === 'phone' || key === 'to_phone') {
      out[key] = maskPhone(value);
      continue;
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = sanitizeDetails(value);
      continue;
    }
    out[key] = value;
  }
  return out;
}

/**
 * Écrit une ligne d'audit. Ne lève jamais : un journal indisponible ne doit pas
 * faire échouer l'action métier, mais l'erreur est remontée en console.
 *
 * @param {{ actor?: {id?: string, role?: string}, action: string, entity?: string,
 *           entityId?: string, ip?: string, userAgent?: string,
 *           details?: Record<string, unknown> }} entry
 */
export async function audit(entry) {
  try {
    await db().query(
      `INSERT INTO audit_logs (actor_user_id, actor_role, action, entity, entity_id, ip, user_agent, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        entry.actor?.id ?? null,
        entry.actor?.role ?? null,
        entry.action,
        entry.entity ?? null,
        entry.entityId ? String(entry.entityId) : null,
        entry.ip ?? null,
        (entry.userAgent ?? '').slice(0, 300) || null,
        JSON.stringify(sanitizeDetails(entry.details)),
      ],
    );
  } catch (error) {
    console.error('[audit] écriture impossible:', error.message);
  }
}

/** Raccourci lié à une requête HTTP (acteur + IP + user-agent). */
export function auditFrom(request, action, entity, entityId, details = {}) {
  return audit({
    actor: request.user ? { id: request.user.id, role: request.user.role } : undefined,
    action,
    entity,
    entityId,
    ip: request.ip,
    userAgent: request.headers['user-agent'],
    details,
  });
}
