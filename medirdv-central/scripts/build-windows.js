'use strict';
/**
 * Windows build helper (Part 18.2).
 *
 * Produces an Electron + NSIS Windows application for the central
 * administrator, mirroring the electron-builder pattern already used by
 * `medirdv/` and `dentardv/` (Part 16: those projects are NOT touched).
 *
 * TWO MODES, no configuration required on first launch:
 *
 *  1. STANDALONE (default) — the app bundles the Medirdv Central server and
 *     starts it on a free local port, then opens the dashboard. Installing
 *     and double-clicking is enough: no server address, no separate install.
 *     Data lives in %APPDATA%\Medirdv Central\data (per-user, upgrade-safe).
 *
 *  2. CONNECTED — for a network deployment, the administrator can point the
 *     app at a shared central server (File → Change server). Every client
 *     then shares one authoritative database, per Part 18.4.
 *
 * A Windows installer can only be produced by electron-builder on Windows or
 * in CI (`.github/workflows/medirdv-central-windows.yml`); this script
 * prepares the project and never claims a binary exists.
 *
 * Usage: node scripts/build-windows.js [--mode standalone|connected] [--api-base URL]
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'release', 'windows-app');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

function argValue(flag, fallback = '') {
  const index = process.argv.indexOf(flag);
  return index > -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const mode = argValue('--mode', process.env.MEDIRDV_APP_MODE || 'standalone');
const serverUrl = argValue('--api-base', process.env.MEDIRDV_CENTRAL_URL || 'https://central.medirdv.dz');

function write(relative, content) {
  const target = path.join(OUT, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'src'), { recursive: true });

// Bundle the server so the app is self-contained (standalone mode).
// Layout: server/<all files from src/> + server/package.json, i.e. the
// desktop main process requires `server/server.js`.
const bundle = path.join(OUT, 'server');
fs.cpSync(path.join(ROOT, 'src'), bundle, { recursive: true });
fs.writeFileSync(
  path.join(bundle, 'package.json'),
  JSON.stringify({ name: 'medirdv-central-server', version: pkg.version, private: true, main: 'server.js' }, null, 2)
);

/* ------------------------------- package.json ------------------------------ */
write(
  'package.json',
  JSON.stringify(
    {
      name: 'medirdv-central-app',
      productName: 'Medirdv Central',
      version: pkg.version,
      description: 'Medirdv Central — Windows administration application',
      main: 'src/main.js',
      author: 'Medirdv',
      license: 'MIT',
      private: true,
      scripts: { start: 'electron .', dist: 'electron-builder --win nsis --x64 --publish never' },
      devDependencies: { electron: '^38.8.6', 'electron-builder': '^26.15.3' },
      build: {
        appId: 'dz.medirdv.central',
        productName: 'Medirdv Central',
        directories: { output: '../windows', buildResources: '../build' },
        // Server source is bundled as an unpacked resource so node:sqlite can
        // be required normally and data files never land inside the asar.
        files: ['src/**/*', 'package.json'],
        extraResources: [{ from: 'server', to: 'server' }],
        asarUnpack: [],
        win: {
          target: [{ target: 'nsis', arch: ['x64'] }],
          icon: '../build/icon.ico',
          artifactName: `Medirdv-Central-Setup-${pkg.version}.\${ext}`,
        },
        nsis: {
          oneClick: false,
          perMachine: false,
          // Installs per-user by default so no administrator prompt is needed,
          // but the user may still choose a machine-wide location.
          allowToChangeInstallationDirectory: true,
          createDesktopShortcut: true,
          createStartMenuShortcut: true,
          shortcutName: 'Medirdv Central',
          uninstallDisplayName: 'Medirdv Central ${version}',
          // Data lives in %APPDATA%, so upgrades and reinstalls keep records.
          deleteAppDataOnUninstall: false,
          runAfterFinish: true,
        },
      },
    },
    null,
    2
  )
);

/* ---------------------------------- main.js -------------------------------- */
// main.js is a real source file (desktop/main.js). It used to be emitted from a
// template literal here, which broke on every nested quote/newline — the file is
// now copied and only two safe constants are substituted.
const mainTemplate = fs.readFileSync(path.join(ROOT, 'desktop', 'main.js'), 'utf8');
const mainSource = mainTemplate
  .replace('__DEFAULT_REMOTE__', JSON.stringify(serverUrl))
  .replace('__BUILD_MODE__', JSON.stringify(mode));
if (mainSource.includes('__DEFAULT_REMOTE__') || mainSource.includes('__BUILD_MODE__')) {
  throw new Error('desktop/main.js is missing its build placeholders');
}
write('src/main.js', mainSource);

console.log('[build-windows] Electron desktop project prepared at release/windows-app/');
console.log(`[build-windows] Mode: ${mode}${mode === 'connected' ? ` (shared server ${serverUrl})` : ' (bundled local database)'}`);
console.log('[build-windows] Server bundled at release/windows-app/server/');
console.log('[build-windows] To produce the installer:');
console.log('  node scripts/convert-icon.js');
console.log('  cd release/windows-app && npm install && npm run dist');
console.log(`[build-windows] Output: release/windows/Medirdv-Central-Setup-${pkg.version}.exe`);
console.log('[build-windows] NOTE: no .exe is claimed until electron-builder succeeds.');
