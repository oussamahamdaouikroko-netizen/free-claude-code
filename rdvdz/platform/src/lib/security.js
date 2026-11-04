/**
 * Authentification par session (cookie HttpOnly) + protection CSRF.
 *
 * Pourquoi pas de JWT en `localStorage` ? Parce qu'un XSS y accède
 * immédiatement. Ici le jeton reste dans un cookie `HttpOnly` (illisible par
 * JavaScript) et chaque mutation exige en plus un jeton CSRF renvoyé dans un
 * en-tête : un site tiers ne peut donc pas déclencher d'action à la place de
 * l'utilisateur.
 */

import { config } from '../config.js';
import { db, one } from '../db.js';
import { Errors } from './errors.js';
import { randomToken, sha256, safeEqual } from './crypto.js';

const { sessionCookieName, csrfHeader } = config.security;

/* --------------------------------- rôles ---------------------------------- */

export const ROLES = {
  SUPER_ADMIN: 'SUPER_ADMIN',
  ADMIN: 'ADMIN',
  FINANCE_MANAGER: 'FINANCE_MANAGER',
  BRANCH_MANAGER: 'BRANCH_MANAGER',
  OPERATOR: 'OPERATOR',
  DOCTOR: 'DOCTOR',
  PATIENT: 'PATIENT',
};

export const STAFF_ROLES = [ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.FINANCE_MANAGER];
export const OPS_ROLES = [ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.BRANCH_MANAGER, ROLES.OPERATOR];
export const ADMIN_ROLES = [ROLES.SUPER_ADMIN, ROLES.ADMIN];

/* -------------------------------- sessions -------------------------------- */

/**
 * Crée une session et renvoie le jeton brut (à placer dans le cookie).
 * Seule l'empreinte SHA-256 est stockée : une fuite de la base ne permet pas
 * de rejouer une session.
 */
export async function createSession(userId, { ip, userAgent } = {}) {
  const token = randomToken(32);
  const csrf = randomToken(24);
  const expiresAt = new Date(Date.now() + config.security.sessionTtlHours * 3600_000);
  await db().query(
    `INSERT INTO sessions (user_id, token_hash, csrf_token, ip, user_agent, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [userId, sha256(token), csrf, ip ?? null, (userAgent ?? '').slice(0, 300) || null, expiresAt],
  );
  return { token, csrf, expiresAt };
}

/** Paramètres du cookie de session. */
export function sessionCookie(token, expiresAt) {
  const parts = [
    `${sessionCookieName}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Expires=${expiresAt.toUTCString()}`,
  ];
  if (config.security.cookieSecure) parts.push('Secure');
  return parts.join('; ');
}

/** Cookie d'effacement (déconnexion). */
export function clearSessionCookie() {
  return `${sessionCookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/**
 * Charge l'utilisateur à partir du cookie, prolonge la session glissante.
 * @returns {Promise<object|null>}
 */
export async function resolveSession(request) {
  const raw = request.cookies?.[sessionCookieName];
  if (!raw) return null;
  const row = await one(
    `SELECT s.id AS session_id, s.csrf_token, s.expires_at, s.revoked_at,
            u.id, u.role, u.full_name, u.phone, u.email, u.status, u.locale,
            u.phone_verified_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1`,
    [sha256(raw)],
  );
  if (!row) return null;
  if (row.revoked_at) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  if (row.status !== 'ACTIVE') return null;

  await db().query('UPDATE sessions SET last_seen_at = now() WHERE id = $1', [row.session_id]);
  return {
    id: row.id,
    role: row.role,
    full_name: row.full_name,
    phone: row.phone,
    email: row.email,
    locale: row.locale,
    phone_verified_at: row.phone_verified_at,
    session_id: row.session_id,
    csrf_token: row.csrf_token,
  };
}

/** Révoque une session. */
export async function revokeSession(sessionId) {
  await db().query('UPDATE sessions SET revoked_at = now() WHERE id = $1', [sessionId]);
}

/** Révoque toutes les sessions d'un utilisateur (sauf éventuellement la courante). */
export async function revokeAllSessions(userId, exceptSessionId = null) {
  await db().query(
    'UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL AND ($2::uuid IS NULL OR id <> $2)',
    [userId, exceptSessionId],
  );
}

/** Vérifie le jeton CSRF d'une requête mutante. */
export function assertCsrf(request) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
  // Les webhooks signés par HMAC n'utilisent pas de session : hors CSRF.
  if (request.url.startsWith('/api/v1/webhooks/')) return;
  if (request.url.startsWith('/api/v1/desktop/')) return;

  const sent = request.headers[csrfHeader];
  const expected = request.user?.csrf_token;
  if (!expected || !sent || !safeEqual(String(sent), String(expected))) throw Errors.csrf();
}

/* ---------------------------- garde-fous de rôle -------------------------- */

/**
 * Fabrique une règle `preHandler` : session obligatoire + rôle autorisé.
 * @param {string[]} roles
 */
export function requireRole(roles) {
  return async function guard(request) {
    if (!request.user) throw Errors.authRequired();
    if (!roles.includes(request.user.role)) {
      throw Errors.forbidden(`Rôle ${request.user.role} non autorisé pour cette action`);
    }
    assertCsrf(request);
  };
}

/** Session obligatoire, quel que soit le rôle. */
export async function requireAuth(request) {
  if (!request.user) throw Errors.authRequired();
  assertCsrf(request);
}

/**
 * Périmètre de l'utilisateur : branches dont il est opérateur/manager et
 * wilayas auxquelles il est rattaché. Un staff global n'a pas de restriction.
 */
export async function loadScope(user) {
  if (STAFF_ROLES.includes(user.role)) return { global: true, branchIds: [], wilayas: [] };
  const rows = await db().query(
    `SELECT scope.branch_id, scope.wilaya_code
       FROM (
         SELECT branch_id, wilaya_code FROM user_scopes WHERE user_id = $1
         UNION
         SELECT o.branch_id, b.wilaya_code
           FROM branch_operators o JOIN branches b ON b.id = o.branch_id
          WHERE o.user_id = $1
         UNION
         SELECT b.id, b.wilaya_code FROM branches b WHERE b.manager_user_id = $1
       ) scope`,
    [user.id],
  );
  const branchIds = [...new Set(rows.rows.map((r) => r.branch_id).filter(Boolean))];
  const wilayas = [...new Set(rows.rows.map((r) => r.wilaya_code).filter(Boolean))];
  return { global: false, branchIds, wilayas, restricted: branchIds.length === 0 || undefined };
}

/**
 * Clause SQL de périmètre pour les rendez-vous : renvoie un fragment
 * `AND (...)` et ses paramètres, jamais une valeur interpolée.
 */
export function branchScopeClause(scope, column = 'a.branch_id') {
  if (scope.global) return { sql: '', params: [] };
  if (scope.branchIds.length === 0) return { sql: ' AND false', params: [] };
  return {
    sql: ` AND (${column} = ANY(${scope.branchIds.map((_, i) => `$${i + 1}`).join(', ')}))`,
    params: scope.branchIds,
  };
}
