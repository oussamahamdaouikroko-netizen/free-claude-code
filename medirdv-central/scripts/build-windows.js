'use strict';
/**
 * Windows build helper (Part 18.2).
 *
 * Medirdv Central ships as:
 *  1. The central web dashboard (this repo, `npm start`) — the authoritative UI.
 *  2. `Medirdv-Central-Setup.exe` — an Electron wrapper around the admin
 *     dashboard (same electron-builder + NSIS pattern as medirdv/).
 *
 * This script prepares the Electron wrapper project under
 * `release/windows-app/` and prints the exact build commands. The actual
 * NSIS build requires a Windows runner (see .github/workflows/
 * medirdv-central-windows.yml) — this script never pretends an .exe exists
 * until electron-builder has produced it.
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'release', 'windows-app');

function main() {
  fs.mkdirSync(path.join(OUT, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(OUT, 'package.json'),
    JSON.stringify(
      {
        name: 'medirdv-central-app',
        version: '1.0.0',
        description: 'Medirdv Central — Windows administration application',
        main: 'src/main.js',
        author: 'Medirdv',
        license: 'MIT',
        private: true,
        scripts: {
          start: 'electron .',
          dist: 'electron-builder --win nsis',
        },
        devDependencies: {
          electron: '^38.8.6',
          'electron-builder': '^26.15.3',
        },
        build: {
          appId: 'dz.medirdv.central',
          productName: 'Medirdv Central',
          directories: { output: '../windows' },
          files: ['src/**/*', 'package.json'],
          win: {
            target: [{ target: 'nsis', arch: ['x64'] }],
            artifactName: 'Medirdv-Central-Setup-${version}.${ext}',
          },
          nsis: {
            oneClick: false,
            perMachine: false,
            createDesktopShortcut: true,
            createStartMenuShortcut: true,
            shortcutName: 'Medirdv Central',
            deleteAppDataOnUninstall: false,
            runAfterFinish: true,
          },
        },
      },
      null,
      2
    )
  );
  fs.writeFileSync(
    path.join(OUT, 'src', 'main.js'),
    `'use strict';
/**
 * Medirdv Central Windows app — thin Electron shell.
 * Loads the central admin dashboard from the configured MEDIRDV_CENTRAL_URL
 * (default http://localhost:8080/admin/). All data stays on the central
 * server; nothing is stored locally except the session cookie.
 */
const { app, BrowserWindow, shell } = require('electron');
const CENTRAL_URL = process.env.MEDIRDV_CENTRAL_URL || 'http://localhost:8080/admin/';

function createWindow() {
  const win = new BrowserWindow({
    width: 1400, height: 900, autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.loadURL(CENTRAL_URL);
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}
app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
`
  );
  console.log('[build-windows] Electron wrapper prepared at release/windows-app/');
  console.log('[build-windows] To produce the installer (Windows machine or CI):');
  console.log('  cd release/windows-app && npm install && npm run dist');
  console.log('  Output: release/windows/Medirdv-Central-Setup-1.0.0.exe');
  console.log('[build-windows] NOTE: no .exe is claimed until electron-builder succeeds.');
}

main();
