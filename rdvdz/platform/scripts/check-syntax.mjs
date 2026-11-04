/**
 * Vérification syntaxique de tous les fichiers JavaScript du projet.
 *
 * `tsconfig.json` utilise `checkJs: false` : le code est du JavaScript exécuté
 * tel quel (aucune compilation), et les annotations JSDoc documentent sans
 * contraindre les types. Ce script garantit au minimum que **chaque fichier
 * livré se charge** — y compris le front, qui n'est jamais compilé.
 *
 * `tsc` ne voit pas les erreurs de syntaxe ESM ; `node --check` si (traitement
 * d'un vrai module, imports compris).
 */

import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

const ROOTS = ['src', 'scripts', 'tests', 'packages/db'];
const files = [];

async function walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // dossier absent (packages/db peut ne contenir que du SQL)
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full);
    else if (entry.name.endsWith('.js')) files.push(full);
  }
}

for (const root of ROOTS) await walk(root);

const failures = [];
// Parallélisme borné : spawner un processus par fichier reste rapide, mais on
// évite d'en lancer une centaine d'un coup.
const queue = [...files.sort()];
async function worker() {
  for (let file = queue.shift(); file; file = queue.shift()) {
    try {
      await run(process.execPath, ['--check', file]);
    } catch (error) {
      failures.push(`${file}\n${String(error.stderr ?? error.message).trim()}`);
    }
  }
}
await Promise.all(Array.from({ length: 8 }, worker));

if (failures.length) {
  for (const failure of failures) console.error(`✗ ${failure}`);
  console.error(`[check-syntax] ${failures.length} fichier(s) invalide(s) sur ${files.length}`);
  process.exit(1);
}
console.log(`[check-syntax] ${files.length} fichiers JavaScript valides`);
