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
write(
  'src/main.js',
  `'use strict';
/**
 * Medirdv Central — Windows desktop application.
 *
 * Default: STANDALONE. The bundled server starts on a free local port and
 * the dashboard opens automatically, so the application works immediately
 * after installation with no server address to configure.
 *
 * Optional: CONNECTED. Point the app at a shared central server (File →
 * "Use a shared server…"). The central database then stays authoritative.
 */
const { app, BrowserWindow, shell, Menu, dialog } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_REMOTE = ${JSON.stringify(serverUrl)};
const BUILD_MODE = ${JSON.stringify(mode)};

let mainWindow = null;
let embedded = null; // { server, baseUrl }
let embeddedError = '';

/* -------------------------------- settings -------------------------------- */
function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
  } catch {
    return {};
  }
}

function writeSettings(next) {
  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2));
  } catch {
    /* non-fatal */
  }
}

/** 'standalone' (bundled server) or 'remote' (shared server). */
function appMode() {
  const settings = readSettings();
  if (settings.mode) return settings.mode;
  return BUILD_MODE === 'connected' ? 'remote' : 'standalone';
}

function remoteUrl() {
  const settings = readSettings();
  return (settings.centralUrl || DEFAULT_REMOTE).replace(/\\/+$/, '');
}

/* ----------------------------- embedded server ---------------------------- */
function dataRoot() {
  // Per-user, survives upgrades and uninstall (deleteAppDataOnUninstall=false).
  return path.join(app.getPath('userData'), 'data');
}

function startEmbeddedServer() {
  return new Promise((resolve) => {
    try {
      const serverDir = app.isPackaged
        ? path.join(process.resourcesPath, 'server')
        : path.join(__dirname, '..', 'server');

      const data = dataRoot();
      process.env.MEDIRDV_DB_PATH = path.join(data, 'medirdv-central.sqlite');
      process.env.MEDIRDV_RECEIPTS_DIR = path.join(data, 'receipts');
      process.env.MEDIRDV_TIMEZONE = 'Africa/Algiers';
      process.env.HOST = '127.0.0.1';
      process.env.PORT = '0';

      // First run only: generate and persist an encryption key for
      // WhatsApp tokens. Never shipped inside the installer.
      const keyFile = path.join(data, '.encryption-key');
      if (!fs.existsSync(keyFile)) {
        fs.mkdirSync(data, { recursive: true });
        fs.writeFileSync(keyFile, require('node:crypto').randomBytes(32).toString('hex'), { mode: 0o600 });
      }
      if (!process.env.MEDIRDV_ENCRYPTION_KEY) {
        process.env.MEDIRDV_ENCRYPTION_KEY = fs.readFileSync(keyFile, 'utf8').trim();
      }

      // Local administrator account for the standalone app. Generated on
      // first run and shown once, so the app is usable without a configured
      // account (a real deployment should create named accounts instead).
      const adminFile = path.join(data, 'administrator.json');
      if (!fs.existsSync(adminFile)) {
        const password = require('node:crypto').randomBytes(9).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 12);
        fs.mkdirSync(data, { recursive: true });
        fs.writeFileSync(
          adminFile,
          JSON.stringify({ email: 'admin@medirdv.local', password }, null, 2),
          { mode: 0o600 }
        );
      }
      const admin = JSON.parse(fs.readFileSync(adminFile, 'utf8'));
      process.env.MEDIRDV_BOOTSTRAP_ADMIN_EMAIL = process.env.MEDIRDV_BOOTSTRAP_ADMIN_EMAIL || admin.email;
      process.env.MEDIRDV_BOOTSTRAP_ADMIN_PASSWORD = process.env.MEDIRDV_BOOTSTRAP_ADMIN_PASSWORD || admin.password;

      const { start } = require(path.join(serverDir, 'server.js'));
      const server = start({
        port: 0,
        host: '127.0.0.1',
        onListen: (instance) => {
          embedded = { server: instance, baseUrl: instance.baseUrl };
          resolve(embedded);
        },
      });
      server.on('error', (error) => {
        embeddedError = String(error && error.message ? error.message : error);
        resolve(null);
      });
    } catch (error) {
      embeddedError = String(error && error.stack ? error.stack : error);
      console.error('[medirdv-central] embedded server failed:', embeddedError);
      resolve(null);
    }
  });
}

/* --------------------------------- window --------------------------------- */
function targetUrl() {
  if (appMode() === 'remote') return remoteUrl() + '/admin/';
  return embedded ? embedded.baseUrl + '/admin/' : null;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#f4f6f6',
    autoHideMenuBar: true,
    title: 'Medirdv Central',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
  });

  const url = targetUrl();
  if (url) {
    mainWindow.loadURL(url);
  } else {
    showEmbeddedFailure();
  }

  mainWindow.webContents.on('did-fail-load', (_event, code, description, failedUrl, isMainFrame) => {
    if (!isMainFrame) return;
    if (appMode() === 'standalone') {
      // The bundled server should always be reachable; surface the cause.
      dialog.showMessageBox(mainWindow, {
        type: 'error',
        title: 'Medirdv Central could not start',
        message: 'The local database service did not respond.',
        detail: (embeddedError || description) + '\\n\\nTry: File → Restart local service.',
        buttons: ['Retry', 'Quit'],
      }).then(({ response }) => { if (response === 0) mainWindow.loadURL(targetUrl() || 'about:blank'); else app.quit(); });
      return;
    }
    dialog
      .showMessageBox(mainWindow, {
        type: 'error',
        title: 'Server unreachable',
        message: 'The Medirdv Central server could not be reached.',
        detail: 'Server: ' + failedUrl + '\\nReason: ' + description + ' (' + code + ')\\n\\nYou can switch back to the local database from the File menu.',
        buttons: ['Retry', 'Use local database', 'Quit'],
        defaultId: 0,
        cancelId: 2,
      })
      .then(({ response }) => {
        if (response === 0) mainWindow.loadURL(targetUrl());
        else if (response === 1) switchToStandalone();
        else app.quit();
      });
  });

  mainWindow.webContents.setWindowOpenHandler(({ url: openUrl }) => {
    shell.openExternal(openUrl);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function showEmbeddedFailure() {
  dialog.showMessageBox({
    type: 'error',
    title: 'Medirdv Central could not start',
    message: 'The local database service failed to start.',
    detail: (embeddedError || 'Unknown error') + '\\n\\nData folder: ' + dataRoot(),
    buttons: ['Quit'],
  }).then(() => app.quit());
}

async function switchToStandalone() {
  writeSettings({ ...readSettings(), mode: 'standalone' });
  if (!embedded) await startEmbeddedServer();
  if (mainWindow) mainWindow.loadURL(targetUrl() || 'about:blank');
}

async function switchToRemote() {
  const promptWindow = new BrowserWindow({
    parent: mainWindow || undefined,
    modal: true,
    width: 520,
    height: 260,
    resizable: false,
    title: 'Use a shared server',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  promptWindow.setMenuBarVisibility(false);
  promptWindow.loadURL(
    'data:text/html;charset=utf-8,' +
      encodeURIComponent(
        '<body style="font-family:Segoe UI,sans-serif;padding:18px;background:#f4f6f6">' +
          '<h3 style="margin:0 0 6px">Shared Medirdv Central server</h3>' +
          '<p style="color:#555;font-size:13px;margin:0 0 10px">All administrators will share one database. HTTPS is required.</p>' +
          '<input id="u" style="width:100%;padding:9px;box-sizing:border-box;border:1px solid #ccc;border-radius:6px" value="' + remoteUrl() + '">' +
          '<p style="color:#777;font-size:12px">Example: https://central.example.dz</p>' +
          '<div style="display:flex;gap:8px">' +
          '<button id="s" style="padding:9px 18px;background:#0e7c7b;color:#fff;border:0;border-radius:6px;cursor:pointer">Connect</button>' +
          '<button id="c" style="padding:9px 18px;border:1px solid #ccc;background:#fff;border-radius:6px;cursor:pointer">Cancel</button>' +
          '</div>' +
          '<script>' +
          'document.getElementById("s").onclick=function(){location.href="medirdv://remote?url="+encodeURIComponent(document.getElementById("u").value)};' +
          'document.getElementById("c").onclick=function(){location.href="medirdv://cancel"};' +
          '</script></body>'
      )
  );
  promptWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('medirdv://')) return;
    event.preventDefault();
    if (url.startsWith('medirdv://cancel')) {
      promptWindow.destroy();
      return;
    }
    const value = (new URL(url).searchParams.get('url') || '').trim().replace(/\\/+$/, '');
    if (!/^https?:\\/\\//i.test(value)) {
      dialog.showMessageBox({ type: 'warning', message: 'Enter a full address starting with https://' });
      return;
    }
    writeSettings({ ...readSettings(), mode: 'remote', centralUrl: value });
    promptWindow.destroy();
    if (mainWindow) mainWindow.loadURL(targetUrl());
  });
}

function dataFolderInfo() {
  const admin = (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(dataRoot(), 'administrator.json'), 'utf8'));
    } catch {
      return null;
    }
  })();
  return [
    'Mode: ' + (appMode() === 'standalone' ? 'this computer (local database)' : 'shared server — ' + remoteUrl()),
    'Data folder: ' + dataRoot(),
    'Database: ' + path.join(dataRoot(), 'medirdv-central.sqlite'),
    admin ? 'Local administrator: ' + admin.email : '',
    embedded ? 'Local service: ' + embedded.baseUrl : '',
  ].filter(Boolean).join('\\n');
}

function editLocalAdministrator() {
  const file = path.join(dataRoot(), 'administrator.json');
  let current = { email: 'admin@medirdv.local', password: '' };
  try {
    current = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    /* defaults */
  }
  const promptWindow = new BrowserWindow({
    parent: mainWindow || undefined,
    modal: true,
    width: 520,
    height: 300,
    resizable: false,
    title: 'Local administrator account',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  promptWindow.setMenuBarVisibility(false);
  promptWindow.loadURL(
    'data:text/html;charset=utf-8,' +
      encodeURIComponent(
        '<body style="font-family:Segoe UI,sans-serif;padding:18px;background:#f4f6f6">' +
          '<h3 style="margin:0 0 10px">Local administrator account</h3>' +
          '<label style="font-size:13px">Email<br><input id="e" style="width:100%;padding:8px;margin:4px 0 10px;box-sizing:border-box" value="' + current.email + '"></label>' +
          '<label style="font-size:13px">New password (leave empty to keep)<br><input id="p" type="password" style="width:100%;padding:8px;margin:4px 0 14px;box-sizing:border-box"></label>' +
          '<p style="color:#777;font-size:12px;margin:0 0 12px">Used only for the built-in database on this computer. Applies on the next restart.</p>' +
          '<button id="s" style="padding:9px 18px;background:#0e7c7b;color:#fff;border:0;border-radius:6px;cursor:pointer">Save</button>' +
          '<script>document.getElementById("s").onclick=function(){' +
          'location.href="medirdv://saveadmin?email="+encodeURIComponent(document.getElementById("e").value)+"&password="+encodeURIComponent(document.getElementById("p").value)};</script>' +
          '</body>'
      )
  );
  promptWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('medirdv://saveadmin')) return;
    event.preventDefault();
    const params = new URL(url).searchParams;
    const email = (params.get('email') || '').trim();
    const password = params.get('password') || '';
    if (!/^[^@\\s]+@[^@\\s]+$/.test(email)) {
      dialog.showMessageBox({ type: 'warning', message: 'Enter a valid email address.' });
      return;
    }
    try {
      fs.mkdirSync(dataRoot(), { recursive: true });
      fs.writeFileSync(
        file,
        JSON.stringify({ email, password: password || current.password }, null, 2),
        { mode: 0o600 }
      );
    } catch (error) {
      dialog.showMessageBox({ type: 'error', message: 'Could not save: ' + error.message });
      return;
    }
    promptWindow.destroy();
    dialog.showMessageBox({
      type: 'info',
      message: 'Saved. Restart Medirdv Central to apply.',
      detail: password ? 'A new password will be set on restart.' : 'Password unchanged.',
    });
  });
}

function buildMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'File',
        submenu: [
          { label: 'Restart local service', click: async () => { embedded = null; await startEmbeddedServer(); if (mainWindow) mainWindow.loadURL(targetUrl() || 'about:blank'); } },
          { type: 'separator' },
          { label: 'Use local database', click: switchToStandalone },
          { label: 'Use a shared server…', click: switchToRemote },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      {
        label: 'Account',
        submenu: [{ label: 'Local administrator…', click: editLocalAdministrator }],
      },
      {
        label: 'View',
        submenu: [
          { role: 'reload' },
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { type: 'separator' },
          { role: 'togglefullscreen' },
        ],
      },
      {
        label: 'Help',
        submenu: [
          { label: 'Data folder…', click: () => dialog.showMessageBox(mainWindow, { type: 'info', title: 'Where is my data?', message: 'Medirdv Central data', detail: dataFolderInfo() }) },
          { label: 'Open data folder', click: () => shell.openPath(dataRoot()) },
          { type: 'separator' },
          {
            label: 'About Medirdv Central',
            click: () =>
              dialog.showMessageBox(mainWindow, {
                type: 'info',
                title: 'About',
                message: 'Medirdv Central ' + app.getVersion(),
                detail: 'Centralized healthcare booking, WhatsApp Hub and payment verification.\\n\\n' + dataFolderInfo(),
              }),
          },
        ],
      },
    ])
  );
}

/* -------------------------------- lifecycle ------------------------------- */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    buildMenu();
    if (appMode() === 'standalone') await startEmbeddedServer();
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    if (embedded && embedded.server) {
      try {
        embedded.server.close();
      } catch {
        /* shutting down anyway */
      }
    }
  });
}
`
);

console.log('[build-windows] Electron desktop project prepared at release/windows-app/');
console.log(`[build-windows] Mode: ${mode}${mode === 'connected' ? ` (shared server ${serverUrl})` : ' (bundled local database)'}`);
console.log('[build-windows] Server bundled at release/windows-app/server/');
console.log('[build-windows] To produce the installer:');
console.log('  node scripts/convert-icon.js');
console.log('  cd release/windows-app && npm install && npm run dist');
console.log(`[build-windows] Output: release/windows/Medirdv-Central-Setup-${pkg.version}.exe`);
console.log('[build-windows] NOTE: no .exe is claimed until electron-builder succeeds.');
