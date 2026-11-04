/**
 * Limitation de débit en mémoire.
 *
 * Suffisant pour une instance unique (le déploiement recommandé en pilote).
 * En cas de montée en charge multi-instances, remplacer `buckets` par une
 * table PostgreSQL ou Redis : l'interface publique reste identique.
 */

import { Errors } from './errors.js';

const buckets = new Map();
let lastSweep = Date.now();

function sweep(now) {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

/**
 * Incrémente un compteur et lève `RATE_LIMITED` au-delà de la limite.
 * @param {string} key identifiant du quota (ex. `login:1.2.3.4`)
 * @param {{ limit: number, windowMs: number }} options
 */
export function hit(key, { limit, windowMs }) {
  const now = Date.now();
  sweep(now);
  const current = buckets.get(key);
  if (!current || current.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { remaining: limit - 1, resetAt: now + windowMs };
  }
  current.count += 1;
  if (current.count > limit) {
    const retryAfter = Math.max(1, Math.ceil((current.resetAt - now) / 1000));
    throw Errors.rateLimited(retryAfter);
  }
  return { remaining: limit - current.count, resetAt: current.resetAt };
}

/** Réinitialise un quota (après une connexion réussie, par exemple). */
export function reset(key) {
  buckets.delete(key);
}

/** Vide tous les compteurs (tests). */
export function clearAll() {
  buckets.clear();
}
