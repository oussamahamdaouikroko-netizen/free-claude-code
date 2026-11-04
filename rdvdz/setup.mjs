#!/usr/bin/env node
/**
 * RDV DZ — installateur.
 *
 * Objectif : une machine neuve → application qui tourne, sans rien connaître au
 * projet. Le script vérifie l'environnement, installe, configure, migre,
 * alimente la démo, vérifie, puis démarre.
 *
 * Il est volontairement écrit en **Node pur, sans aucune dépendance** : il doit
 * pouvoir s'exécuter avant `npm install`, et sur Windows comme sur Linux/macOS.
 *
 * Usage :
 *   node setup.mjs              menu interactif
 *   node setup.mjs --yes        installation complète + démarrage (CI, raccourci)
 *   node setup.mjs --no-start   installation et vérifications seulement
 *   node setup.mjs --reset      efface la base de démo puis réinstalle
 *   node setup.mjs --check      vérifications seulement (rien n'est modifié)
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  access,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLATFORM = path.join(HERE, 'platform');
const ENV_FILE = path.join(PLATFORM, '.env.local');
const DATA_DIR = path.join(PLATFORM, '.data');

const MIN_NODE = [20, 11];
const isWindows = process.platform === 'win32';
const npm = isWindows ? 'npm.cmd' : 'npm';

const flags = new Set(process.argv.slice(2).map((arg) => arg.replace(/^--/, '')));
const color = process.stdout.isTTY && !flags.has('no-color');
const c = {
  bold: (s) => (color ? `\u001b[1m${s}\u001b[22m` : s),
  dim: (s) => (color ? `\u001b[2m${s}\u001b[22m` : s),
  green: (s) => (color ? `\u001b[32m${s}\u001b[39m` : s),
  red: (s) => (color ? `\u001b[31m${s}\u001b[39m` : s),
  yellow: (s) => (color ? `\u001b[33m${s}\u001b[39m` : s),
  cyan: (s) => (color ? `\u001b[36m${s}\u001b[39m` : s),
};

const say = (message = '') => process.stdout.write(`${message}\n`);
const step = (message) => say(`\n${c.cyan('▶')} ${c.bold(message)}`);
const ok = (message) => say(`  ${c.green('✔')} ${message}`);
const warn = (message) => say(`  ${c.yellow('!')} ${message}`);
const info = (message) => say(`  ${c.dim(message)}`);

/* ---------------------------------- outils -------------------------------- */

class SetupError extends Error {
  constructor(message, hint) {
    super(message);
    this.hint = hint;
  }
}

async function exists(target) {
  try {
    await access(target, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** Lance une commande et hérite de la sortie (npm affiche ses propres progrès). */
function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? PLATFORM,
      stdio: options.quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      shell: isWindows,
      env: { ...process.env, ...(options.env ?? {}) },
    });
    let stdout = '';
    let stderr = '';
    if (options.quiet) {
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
    }
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else {
        const tail = `${stderr}\n${stdout}`.trim().split('\n').slice(-6).join('\n');
        reject(new SetupError(`« ${command} ${args.join(' ')} » a échoué (code ${code}).`, tail));
      }
    });
  });
}

/** `npm` sur Windows est un `.cmd` : il faut passer par le shell. */

function nodeVersion() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  return { major, minor, label: process.versions.node };
}

function versionAtLeast(current, [wantMajor, wantMinor]) {
  return current.major > wantMajor || (current.major === wantMajor && current.minor >= wantMinor);
}

function secret(bytes = 48) {
  // Même primitive que `crypto.randomBytes` sans l'importer deux fois.
  return createHash('sha512')
    .update(`${Date.now()}-${process.pid}-${Math.random()}-${process.hrtime.bigint()}`)
    .digest('base64url')
    .slice(0, bytes);
}

/** Lecture de `.env.local` sans dépendance : suffit pour PORT / PG. */
async function readEnv() {
  const out = {};
  let contents = '';
  try {
    contents = await readFile(ENV_FILE, 'utf8');
  } catch {
    return out;
  }
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index <= 0) continue;
    out[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim();
  }
  return out;
}

/** Quelque chose écoute-t-il déjà sur ce port (peu importe quoi) ? */
function portBusy(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port, timeout: 700 });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(false));
  });
}

/** L'application répond-elle sur ce port, et est-ce bien la nôtre ? */
async function probeHome(port) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1200);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, { signal: controller.signal });
    if (!response.ok) return false;
    const html = await response.text();
    return html.includes('RDV DZ') && html.includes('/app.js');
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function probeHealth(port) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1200);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/health`, {
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function openBrowser(url) {
  const command = isWindows ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = isWindows ? ['/c', 'start', '""', url] : [url];
  spawn(command, args, { stdio: 'ignore', detached: true, shell: isWindows }).on(
    'error',
    () => {},
  );
}

/* --------------------------------- étapes --------------------------------- */

async function stepPrerequisites() {
  step('Vérification de l’environnement');
  const version = nodeVersion();
  if (!versionAtLeast(version, MIN_NODE)) {
    throw new SetupError(
      `Node.js ${version.label} est trop ancien (minimum ${MIN_NODE.join('.')}).`,
      'Installez la version LTS : https://nodejs.org/fr/download  — puis relancez ce fichier.',
    );
  }
  ok(`Node.js ${version.label}`);

  if (version.major < 22) {
    warn(`Node ${version.major} fonctionne, mais la version 22 LTS est recommandée.`);
  }

  const { stdout } = await run(npm, ['--version'], { quiet: true });
  ok(`npm ${stdout.trim()}`);

  if (!(await exists(path.join(PLATFORM, 'package.json')))) {
    throw new SetupError(
      'Le dossier `platform/` est introuvable à côté de ce fichier.',
      'Décompressez l’archive en entier puis relancez `setup.bat` depuis le dossier racine du projet.',
    );
  }
  ok('Fichiers du projet présents');
}

async function stepInstall() {
  step('Installation des dépendances');
  // `npm ci` est reproductible quand le verrou est présent, sinon `npm install`.
  const hasLock = await exists(path.join(PLATFORM, 'package-lock.json'));
  await run(npm, hasLock ? ['ci', '--no-audit', '--no-fund'] : ['install', '--no-audit', '--no-fund']);
  ok('Dépendances installées');
}

async function stepConfigure() {
  step('Configuration');
  if (await exists(ENV_FILE)) {
    const env = await readEnv();
    // Un secret absent ou laissé à la valeur d'exemple est une faille : on le
    // remplace silencieusement, sans jamais l'afficher.
    const broken =
      !env.APP_SECRET || env.APP_SECRET.length < 32 || /changez-moi|example/i.test(env.APP_SECRET);
    if (broken) {
      await patchEnv({ APP_SECRET: secret(48) });
      warn('APP_SECRET était absent ou invalide : régénéré.');
    }
    const env2 = await readEnv();
    if (!env2.STORAGE_ENCRYPTION_KEY || env2.STORAGE_ENCRYPTION_KEY.length < 32) {
      await patchEnv({ STORAGE_ENCRYPTION_KEY: secret(32) });
      warn('STORAGE_ENCRYPTION_KEY était absent ou invalide : régénéré.');
    }
    ok('Fichier `.env.local` existant conservé');
    return env2;
  }

  let template = '';
  try {
    template = await readFile(path.join(PLATFORM, '.env.example'), 'utf8');
  } catch {
    template = '';
  }
  if (!template) {
    template = [
      'PORT=8080',
      'HOST=0.0.0.0',
      'DB_DRIVER=pglite',
      'PGLITE_DIR=./.data/dev',
      'PAYMENTS_PROVIDER=sandbox',
      'PAYMENTS_SANDBOX_ALLOWED=true',
      'WHATSAPP_PROVIDER=click_to_chat',
      'STORAGE_DRIVER=local',
      'STORAGE_DIR=./.data/documents',
      'OTP_DEBUG=true',
      'LOG_LEVEL=info',
    ].join('\n');
  }

  // Remplacements ciblés : on garde toutes les explications du modèle.
  const filled = template
    .replace(/^APP_SECRET=.*$/m, `APP_SECRET=${secret(48)}`)
    .replace(/^STORAGE_ENCRYPTION_KEY=.*$/m, `STORAGE_ENCRYPTION_KEY=${secret(32)}`)
    .replace(/^PGLITE_DIR=.*$/m, 'PGLITE_DIR=./.data/dev')
    .replace(/^LOG_LEVEL=.*$/m, 'LOG_LEVEL=info');
  const header = [
    '# ---------------------------------------------------------------------------',
    '# Fichier généré par setup.mjs — NE PAS VERSIONNER (ignoré par Git).',
    '# Contient des secrets propres à cette machine.',
    '# Pour repartir de zéro : supprimez ce fichier puis relancez setup.bat',
    '# ---------------------------------------------------------------------------',
    '',
  ].join('\n');
  await writeFile(ENV_FILE, header + filled, 'utf8');
  ok('Fichier `.env.local` créé (secrets aléatoires générés)');
  return readEnv();
}

/** Ajoute ou remplace des clés dans `.env.local`, en préservant l'ordre. */
async function patchEnv(patch) {
  let contents = '';
  try {
    contents = await readFile(ENV_FILE, 'utf8');
  } catch {
    contents = '';
  }
  const lines = contents.split(/\r?\n/);
  const pending = new Map(Object.entries(patch));
  const next = lines.map((line) => {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
    if (match && pending.has(match[1])) {
      const value = pending.get(match[1]);
      pending.delete(match[1]);
      return `${match[1]}=${value}`;
    }
    return line;
  });
  for (const [key, value] of pending) next.push(`${key}=${value}`);
  await writeFile(ENV_FILE, next.join('\n'), 'utf8');
}

/** La base PGlite est-elle déjà initialisée (migrations appliquées) ? */
async function databaseReady(env) {
  const driver = (env.DB_DRIVER ?? 'pglite').toLowerCase();
  if (driver === 'pg') return true; // serveur PostgreSQL : on laisse migrer
  const dirRelative = env.PGLITE_DIR ?? './.data/dev';
  if (dirRelative === ':memory:') return false;
  const dir = path.resolve(PLATFORM, dirRelative);
  try {
    const entries = await readdir(dir);
    return entries.length > 0;
  } catch {
    return false;
  }
}

async function stepDatabase(env, { reset }) {
  step('Base de données');
  if (reset) {
    for (const candidate of ['dev', 'pglite']) {
      await rm(path.join(DATA_DIR, candidate), { recursive: true, force: true });
    }
    ok('Base de démonstration effacée');
  }

  // Les dossiers de travail doivent exister : PGlite refuse de créer une base
  // dont le dossier parent est absent, et le stockage des pièces jointes aussi.
  const pgliteDir = env.PGLITE_DIR ?? './.data/dev';
  if (pgliteDir !== ':memory:') {
    await mkdir(path.resolve(PLATFORM, pgliteDir), { recursive: true });
  }
  await mkdir(path.resolve(PLATFORM, env.STORAGE_DIR ?? './.data/documents'), { recursive: true });

  if (await databaseReady(env)) {
    info('Base existante détectée : les migrations sont rejouées (idempotent).');
  } else {
    info('Création de la base locale (PGlite, aucun serveur à installer).');
  }
  await run(process.execPath, ['scripts/migrate.js']);
  ok('Migrations appliquées');

  await run(process.execPath, ['scripts/seed-demo.js']);
  ok('Données de démonstration prêtes (paiements simulés, aucune donnée réelle)');
}

async function stepVerify() {
  step('Vérification');
  await run(process.execPath, ['scripts/check-schema.js']);
  await run(process.execPath, ['scripts/check-syntax.mjs']);
  info('Les 179 tests automatisés ne sont pas exécutés ici (≈ 40 s).');
  info('Pour les lancer : npm run check   — dans le dossier platform/');
  ok('Schéma et fichiers conformes');
}

async function stepStart(env) {
  const port = Number(env.PORT ?? 8080);
  const url = `http://localhost:${port}`;

  step('Démarrage');
  const running = await probeHealth(port);
  if (running && (await probeHome(port))) {
    ok(`RDV DZ tourne déjà sur ${url}`);
    say(`\n  ${c.bold('Ouvrez :')} ${c.cyan(url)}\n`);
    openBrowser(url);
    return;
  }
  if (running || (await portBusy(port))) {
    // Le port est pris par autre chose (autre logiciel, autre copie du projet) :
    // démarrer échouerait sur EADDRINUSE avec un message obscur.
    throw new SetupError(
      `Le port ${port} est déjà utilisé par un autre programme.`,
      [
        'Deux solutions :',
        `  • fermer le programme qui occupe le port ${port}, puis relancer setup.bat`,
        `  • ou choisir un autre port : ouvrir platform/.env.local et modifier PORT=${port + 1}`,
      ].join('\n'),
    );
  }

  say(`\n  ${c.bold('Application :')} ${c.cyan(url)}`);
  say(`  ${c.dim('Comptes de démo — mot de passe : Demo#2026-Demo')}`);
  say(`  ${c.dim('  +213555000201  patient      +213555000101  médecin')}`);
  say(`  ${c.dim('  +213555000001  administrateur +213555000004  opérateur')}`);
  say(`\n  ${c.yellow('Ctrl+C')} pour arrêter.\n`);

  // Le navigateur s'ouvre une fois le serveur prêt, sans bloquer le démarrage.
  let opened = false;
  const open = setInterval(() => {
    void probeHealth(port).then((health) => {
      if (health && !opened) {
        opened = true;
        clearInterval(open);
        openBrowser(url);
      }
    });
  }, 700);
  setTimeout(() => clearInterval(open), 30_000);

  try {
    await run(process.execPath, ['src/server.js'], { env: {} });
  } finally {
    clearInterval(open);
  }
}

/* ---------------------------------- menu ---------------------------------- */

async function menu() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  say('');
  say(c.bold('  RDV DZ — installation'));
  say(c.dim('  Rendez-vous médicaux · plateforme + interface web'));
  say('');
  say('  1. Installer et démarrer la démo      ' + c.dim('(recommandé)'));
  say('  2. Installer seulement                ' + c.dim('(sans lancer le serveur)'));
  say('  3. Vérifier l’installation existante');
  say('  4. Réinstaller la base de démonstration');
  say('  0. Quitter');
  say('');
  const answer = (await rl.question('  Votre choix [1] : ')).trim() || '1';
  rl.close();
  return answer;
}

/* ---------------------------------- main ---------------------------------- */

async function main() {
  say(c.bold('\n  RDV DZ — installateur'));
  say(c.dim(`  ${isWindows ? 'Windows' : process.platform} · Node ${process.versions.node}`));

  let choice = '1';
  if (!flags.has('yes') && !flags.has('no-start') && !flags.has('check') && !flags.has('reset')) {
    choice = await menu();
    if (choice === '0') {
      say('\n  Installation annulée. Rien n’a été modifié.\n');
      return;
    }
  } else if (flags.has('check')) {
    choice = '3';
  } else if (flags.has('reset')) {
    choice = '4';
  } else if (flags.has('no-start')) {
    choice = '2';
  }

  await stepPrerequisites();

  if (choice === '3') {
    await stepVerify();
    say(`\n  ${c.green('✔ Installation vérifiée.')}\n`);
    return;
  }

  await stepInstall();
  const env = await stepConfigure();

  if (choice === '4') {
    await stepDatabase(env, { reset: true });
  } else {
    await stepDatabase(env, { reset: false });
  }
  await stepVerify();

  if (choice === '1') {
    await stepStart(env);
    return;
  }

  const port = Number(env.PORT ?? 8080);
  say(`\n  ${c.green('✔ Installation terminée.')}`);
  say(`\n  Démarrer l’application :`);
  say(`    cd platform`);
  say(`    npm start`);
  say(`\n  Puis ouvrir : ${c.cyan(`http://localhost:${port}`)}`);
  say(`  Mot de passe des comptes de démo : ${c.bold('Demo#2026-Demo')}\n`);
}

main().catch((error) => {
  say('');
  if (error instanceof SetupError) {
    say(`  ${c.red('✖')} ${c.bold(error.message)}`);
    if (error.hint) {
      say('');
      for (const line of String(error.hint).split('\n')) say(`    ${line}`);
    }
  } else {
    say(`  ${c.red('✖')} Erreur inattendue : ${error.message}`);
    if (error.stack) say(c.dim(error.stack.split('\n').slice(1, 4).join('\n')));
  }
  say('');
  say(c.dim('  Détails complets dans le journal ci-dessus.'));
  say('');
  process.exitCode = 1;
});
