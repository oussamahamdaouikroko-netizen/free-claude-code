/**
 * Chargement d'un fichier `.env` — sans dépendance externe.
 *
 * Les modules ES sont évalués dans l'ordre des imports : ce fichier doit être
 * importé **avant** `config.js`. `config.js` l'importe lui-même en première
 * ligne, ce qui garantit que `process.env` est complet au moment de la lecture.
 *
 * Règles : aucune variable déjà posée dans l'environnement n'est écrasée (le
 * shell et le système d'exploitation priment toujours sur le fichier), et les
 * valeurs ne sont jamais journalisées.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

const candidates = ['.env', `.env.${process.env.NODE_ENV ?? 'development'}`, '.env.local'];

/** Analyse une ligne `CLÉ=valeur` (guillemets optionnels, `#` en commentaire). */
export function parseEnv(contents) {
  const out = {};
  for (const rawLine of String(contents).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) out[key] = value;
  }
  return out;
}

let loaded = false;

/** Charge `.env` (une seule fois) sans écraser l'environnement existant. */
export function loadEnv({ cwd = process.cwd(), files = candidates } = {}) {
  if (loaded) return [];
  loaded = true;
  const applied = [];
  for (const file of files) {
    let contents;
    try {
      contents = readFileSync(path.resolve(cwd, file), 'utf8');
    } catch {
      continue;
    }
    const parsed = parseEnv(contents);
    for (const [key, value] of Object.entries(parsed)) {
      if (process.env[key] === undefined) {
        process.env[key] = value;
        applied.push(key);
      }
    }
  }
  return applied;
}

loadEnv();
