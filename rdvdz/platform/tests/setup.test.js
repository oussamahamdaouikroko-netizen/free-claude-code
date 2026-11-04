/**
 * L'installateur est du code comme les autres : il doit rester exécutable et
 * cohérent avec le projet. Ces tests ne lancent pas d'installation (trop long),
 * ils vérifient les invariants qui cassent silencieusement.
 */

import './env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(process.cwd(), '..');
const read = (file) => readFile(path.join(ROOT, file), 'utf8');

test('setup.mjs n’a aucune dépendance externe (il tourne avant npm install)', async () => {
  const source = await read('setup.mjs');
  const imports = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1]);
  for (const specifier of imports) {
    assert.ok(
      specifier.startsWith('node:'),
      `setup.mjs importe « ${specifier} » : il doit rester sans dépendance`,
    );
  }
});

test('setup.mjs sait refuser une installation et l’expliquer', async () => {
  const source = await read('setup.mjs');
  // Toute erreur doit porter un message ET une action pour l'utilisateur.
  assert.match(source, /class SetupError/);
  assert.match(source, /hint/);
  assert.match(source, /MIN_NODE = \[20, 11\]/, 'version minimale alignée sur engines');
  assert.match(source, /process\.exitCode = 1/);
});

test('la version minimale du script correspond à `engines` de package.json', async () => {
  const script = await read('setup.mjs');
  const pkg = JSON.parse(await readFile(path.join(ROOT, 'platform', 'package.json'), 'utf8'));
  const wanted = /MIN_NODE = \[(\d+), (\d+)\]/.exec(script);
  assert.ok(wanted, 'MIN_NODE introuvable');
  assert.equal(`${wanted[1]}.${wanted[2]}`, pkg.engines.node.replace(/[>=]/g, '').trim());
});

test('l’installateur ne casse jamais une configuration existante', async () => {
  const source = await read('setup.mjs');
  // Un `.env.local` déjà présent est conservé : seul un secret absent ou
  // d'exemple est remplacé, jamais écrasé à l'aveugle.
  assert.match(source, /Fichier `\.env\.local` existant conservé/);
  assert.match(source, /changez-moi\|example/);
});

test('les commandes ne passent par le shell que si Windows l’exige', async () => {
  // Régression réelle : `shell: true` + `C:\Program Files\nodejs\node.exe`
  // fait couper la commande au premier espace → « code 1 » sans explication.
  const source = await read('setup.mjs');
  assert.ok(
    source.includes("const needsShell = isWindows && /\\.cmd$|\\.bat$/i.test(command);"),
    'le shell doit être limité aux scripts .cmd/.bat',
  );
  assert.match(source, /shell: needsShell/);
  assert.doesNotMatch(source, /shell: isWindows/, 'le shell ne doit plus être global');
  // Et le dossier de travail doit être explicite, sinon `scripts/migrate.js`
  // est cherché à la racine du projet.
  assert.match(source, /cwd: options\.cwd \?\? PLATFORM/);
});

test('un échec est traduit en action concrète, pas en trace technique', async () => {
  const { explainFailure } = await import('../../setup.mjs');
  assert.match(explainFailure('Error: EACCES: permission denied', 'node', []), /Documents|droits d’écriture/);
  assert.match(explainFailure('npm ERR! network ETIMEDOUT', 'npm', ['ci']), /connexion à Internet/);
  assert.match(explainFailure('EBUSY: resource busy or locked', 'node', []), /en cours d’utilisation/);
  assert.match(explainFailure('listen EADDRINUSE 0.0.0.0:8080', 'node', []), /PORT=/);
  assert.match(explainFailure('CONFIG_INVALID: APP_SECRET', 'node', []), /\.env\.local/);
  // Une erreur inconnue ne produit pas de conseil inventé.
  assert.equal(explainFailure('TypeError: x is not a function', 'node', []), null);
});

test('chaque échec écrit un journal lisible à côté du script', async () => {
  const source = await read('setup.mjs');
  assert.match(source, /setup-error\.log/);
  assert.match(source, /journal d’installation/);
  assert.match(source, /process\.versions\.node/);
  // Le .bat doit le réafficher : une fenêtre cmd défile trop vite.
  const batch = await read('setup.bat');
  assert.match(batch, /type "%~dp0setup-error\.log"/);
  assert.match(batch, /del "%~dp0setup-error\.log"/);
});

test('setup.bat conduit à Node.js au lieu d’échouer sèchement', async () => {
  const batch = await read('setup.bat');
  assert.match(batch, /nodejs\.org\/fr\/download/);
  assert.match(batch, /setup\.mjs/);
  assert.match(batch, /if errorlevel 1 goto no_node/);
  // Le chemin du projet est repris tel quel (`cd /d "%~dp0"`) : lancer le .bat
  // depuis n'importe où, ou par double-clic, doit fonctionner.
  assert.match(batch, /cd \/d "%~dp0"/);
});

test('le .bat appelle le script sans redémarrer un second menu', async () => {
  const batch = await read('setup.bat');
  assert.doesNotMatch(batch, /choice |set \/p /i, 'toute la logique vit dans setup.mjs');
});

test('le constructeur d’exécutable refuse de produire hors Windows', async () => {
  const source = await read('build-exe.mjs');
  assert.match(source, /if \(!isWindows\)/);
  assert.match(source, /process\.exit\(1\)/);
  // Il doit expliquer pourquoi, pas seulement échouer.
  assert.match(source, /n’est pas testable|pas testable|testable ici/);
});

test('les secrets générés ont la longueur exigée par la configuration', async () => {
  const source = await read('setup.mjs');
  const appSecret = /APP_SECRET=\$\{secret\((\d+)\)\}/.exec(source);
  const storageKey = /STORAGE_ENCRYPTION_KEY=\$\{secret\((\d+)\)\}/.exec(source);
  const patchApp = /APP_SECRET: secret\((\d+)\)/.exec(source);
  const patchStorage = /STORAGE_ENCRYPTION_KEY: secret\((\d+)\)/.exec(source);
  for (const match of [appSecret, patchApp]) {
    assert.ok(match, 'APP_SECRET non généré');
    assert.ok(Number(match[1]) >= 32, 'APP_SECRET doit faire au moins 32 caractères');
  }
  for (const match of [storageKey, patchStorage]) {
    assert.ok(match, 'STORAGE_ENCRYPTION_KEY non généré');
    assert.ok(Number(match[1]) >= 32, 'clé de chiffrement trop courte');
  }
});

test('la documentation d’installation décrit les fichiers modifiés', async () => {
  const doc = await read('docs/INSTALLATION.md');
  for (const marker of ['setup.bat', 'platform/.env.local', 'platform/.data/', 'Demo#2026-Demo']) {
    assert.ok(doc.includes(marker), `docs/INSTALLATION.md ne mentionne pas ${marker}`);
  }
  // Les limites doivent être annoncées, pas découvertes plus tard.
  assert.match(doc, /dépendances externes/);
});
