/**
 * Helpers HTTP : réponse JSON normalisée, validation de champs, sérialisation
 * en liste blanche (allowlist).
 *
 * La sérialisation par liste blanche est une mesure de sécurité, pas un
 * détail : un opérateur qui reçoit un objet patient ne doit voir *que* les
 * colonnes explicitement listées. Une colonne ajoutée plus tard en base ne
 * fuite donc jamais automatiquement vers une interface.
 */

import { AppError, Errors } from './errors.js';

/** Envoie une réponse JSON. */
export function json(reply, status, payload) {
  return reply.code(status).type('application/json; charset=utf-8').send(payload);
}

/** Renvoie la liste blanche des clés demandées. */
export function pick(source, keys) {
  const out = {};
  if (!source) return out;
  for (const key of keys) if (source[key] !== undefined) out[key] = source[key];
  return out;
}

/** `pick` sur un tableau. */
export function pickAll(rows, keys) {
  return (rows || []).map((row) => pick(row, keys));
}

/**
 * Vérifie la présence et le type des champs d'un corps de requête.
 * @param {Record<string, unknown>} body
 * @param {Record<string, {type?: 'string'|'number'|'boolean'|'array'|'object', required?: boolean, min?: number, max?: number, enum?: string[], pattern?: RegExp}>} schema
 * @returns {Record<string, unknown>} corps filtré aux clés connues
 */
export function validate(body, schema) {
  const input = body && typeof body === 'object' ? body : {};
  const errors = {};
  const output = {};

  for (const [key, rule] of Object.entries(schema)) {
    const value = input[key];
    const present = value !== undefined && value !== null && value !== '';

    if (!present) {
      if (rule.required) errors[key] = 'required';
      continue;
    }

    let normalized = value;
    if (rule.type === 'number') {
      normalized = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(normalized)) {
        errors[key] = 'must be a number';
        continue;
      }
      if (rule.min !== undefined && normalized < rule.min) errors[key] = `min ${rule.min}`;
      if (rule.max !== undefined && normalized > rule.max) errors[key] = `max ${rule.max}`;
      if (rule.integer && !Number.isInteger(normalized)) errors[key] = 'must be an integer';
    } else if (rule.type === 'boolean') {
      normalized = value === true || value === 'true' || value === 1 || value === '1';
    } else if (rule.type === 'array') {
      if (!Array.isArray(value)) {
        errors[key] = 'must be an array';
        continue;
      }
      if (rule.maxItems && value.length > rule.maxItems) errors[key] = `max ${rule.maxItems} items`;
    } else if (rule.type === 'object') {
      if (typeof value !== 'object' || Array.isArray(value)) {
        errors[key] = 'must be an object';
        continue;
      }
    } else {
      normalized = String(value).trim();
      if (rule.min !== undefined && normalized.length < rule.min) errors[key] = `min length ${rule.min}`;
      if (rule.max !== undefined && normalized.length > rule.max) errors[key] = `max length ${rule.max}`;
      if (rule.pattern && !rule.pattern.test(normalized)) errors[key] = 'invalid format';
    }

    if (rule.enum && !rule.enum.includes(normalized)) errors[key] = `must be one of ${rule.enum.join(', ')}`;
    if (!errors[key]) output[key] = normalized;
  }

  if (Object.keys(errors).length) throw Errors.validation(errors);
  return output;
}

/** Lit `?limit=&cursor=` avec des bornes sûres. */
export function pagination(request, { defaultLimit = 20, maxLimit = 100 } = {}) {
  const query = request.query || {};
  const limit = Math.min(maxLimit, Math.max(1, Number.parseInt(query.limit, 10) || defaultLimit));
  const cursor = typeof query.cursor === 'string' && query.cursor.length ? query.cursor : null;
  return { limit, cursor };
}

/**
 * Pagination par curseur numérique simple (id croissant).
 * `next_cursor` vaut null quand la page est la dernière.
 */
export function cursorPage(rows, limit) {
  const items = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  return { items, next_cursor: hasMore ? String(items[items.length - 1].cursor ?? '') : null };
}

/** Petite aide : int ou null. */
export function toInt(value, fallback = null) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

export { AppError };
