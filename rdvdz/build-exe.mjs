#!/usr/bin/env node
/**
 * Fabrique `setup.exe` (Windows) à partir de `setup.mjs`.
 *
 * Pré-requis (à faire une seule fois, sur une machine Windows) :
 *   winget installOpenJS.NodeJS.LTS        (ou l'installeur .msi)
 *   npm ci                                  (dans platform/)
 *   npm i -g @yao-pkg/pkg
 *
 * Puis, depuis `rdvdz/` :
 *   node build-exe.mjs
 *
 * Résultat : `dist/rdvdz-setup.exe` — un exécutable autonome qui embarque Node
 * et l'installateur. Il ne contient **pas** l'application : celle-ci reste dans
 * le dossier du projet, que l'exe doit pouvoir trouver à côté de lui.
 *
 * Pourquoi un exécutable « mince » : embarquer `node_modules` (~40 Mo) et les
 * migrations dans un binaire figé rendrait toute mise à jour du code impossible
 * sans régénérer l'exe. L'installateur, lui, reste sur le disque du projet.
 *
 * Ce script échoue volontairement s'il n'est pas exécuté sous Windows : il ne
 * faut pas produire un binaire Windows non testé depuis une autre plateforme.
 */

import { spawn } from 'node:child_process';
import { mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const isWindows = process.platform === 'win32';

if (!isWindows) {
  console.error('[build-exe] Ce script doit être exécuté sur Windows.');
  console.error('            Un .exe produit ailleurs ne serait pas testable ici.');
  process.exit(1);
}

async function has(command) {
  return new Promise((resolve) => {
    const child = spawn(command, ['--version'], { stdio: 'ignore', shell: true });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

if (!(await has('pkg'))) {
  console.error('[build-exe] `pkg` est absent. Installer avec :');
  console.error('            npm i -g @yao-pkg/pkg');
  process.exit(1);
}

try {
  await access(path.join(HERE, 'platform', 'node_modules'));
} catch {
  console.error('[build-exe] `platform/node_modules` est absent : lancez d’abord setup.bat.');
  process.exit(1);
}

await mkdir(path.join(HERE, 'dist'), { recursive: true });

const args = [
  path.join(HERE, 'setup.mjs'),
  '--targets',
  'node22-win-x64',
  '--output',
  path.join(HERE, 'dist', 'rdvdz-setup.exe'),
  '--compress',
  'GZip',
];

console.log(`[build-exe] pkg ${args.join(' ')}`);
const child = spawn('pkg', args, { stdio: 'inherit', shell: true });
child.on('close', (code) => {
  if (code === 0) {
    console.log('\n[build-exe] dist/rdvdz-setup.exe créé.');
    console.log('[build-exe] Placez-le à la racine du projet, à côté de platform/, puis testez-le');
    console.log('[build-exe] sur une machine SANS Node.js avant toute diffusion.');
  }
  process.exit(code ?? 1);
});
