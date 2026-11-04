/**
 * Client HTTP de l'application.
 *
 * Règles :
 *  - le cookie de session est envoyé automatiquement (`credentials: same-origin`),
 *    il n'est jamais lu par JavaScript (`HttpOnly`) ;
 *  - le jeton CSRF vit en mémoire et est posé dans l'en-tête `x-csrf-token` ;
 *  - une 401 renvoie une erreur typée `AUTH_REQUIRED` que l'appelant peut
 *    traiter en redirigeant vers l'écran de connexion ;
 *  - `Idempotency-Key` est généré pour les mutations sensibles (réservation,
 *    paiement) : un double clic ne crée pas deux rendez-vous.
 */

const BASE = '/api/v1';

/** Erreur normalisée : conserve le `code` stable renvoyé par l'API. */
export class ApiError extends Error {
  constructor(code, message, status, details) {
    super(message || code);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details ?? {};
  }
}

/** Jeton CSRF courant (mémoire uniquement). */
let csrfToken = null;
export function setCsrf(token) {
  csrfToken = token;
}
export function getCsrf() {
  return csrfToken;
}

/** Identifiant d'idempotence (UUID v4 si disponible). */
export function idempotencyKey() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return `idem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

async function request(method, path, { body, csrf, headers = {}, raw = false } = {}) {
  const finalHeaders = { Accept: 'application/json', ...headers };
  if (body !== undefined) finalHeaders['Content-Type'] = 'application/json';
  const token = csrf ?? csrfToken;
  if (token && method !== 'GET') finalHeaders['x-csrf-token'] = token;

  let response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method,
      credentials: 'same-origin',
      headers: finalHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    throw new ApiError('OFFLINE', error.message, 0);
  }

  if (raw) return response;

  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const error = payload?.error ?? {};
    throw new ApiError(
      error.code ?? `HTTP_${response.status}`,
      error.message ?? response.statusText,
      response.status,
      error.details,
    );
  }
  return payload;
}

export const get = (path) => request('GET', path);
export const post = (path, body, options = {}) => request('POST', path, { ...options, body });
export const put = (path, body, options = {}) => request('PUT', path, { ...options, body });
export const patch = (path, body, options = {}) => request('PATCH', path, { ...options, body });
export const del = (path, options = {}) => request('DELETE', path, options);

/** Récupère un document HTML protégé (reçu, export) et le télécharge. */
export async function download(path, filename) {
  const response = await request('GET', path, { raw: true });
  if (!response.ok) {
    throw new ApiError(`HTTP_${response.status}`, response.statusText, response.status);
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** Ouvre un reçu HTML dans un nouvel onglet (blob isolé, sans script). */
export async function openReceipt(path) {
  const response = await request('GET', path, { raw: true });
  if (!response.ok) {
    throw new ApiError(`HTTP_${response.status}`, response.statusText, response.status);
  }
  const html = await response.text();
  const blob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
