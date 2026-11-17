'use strict';
/**
 * Windows build helper (Part 18.2).
 *
 * Produces an Electron + NSIS Windows application for the central
 * administrator, mirroring the electron-builder pattern already used by
 * `medirdv/` and `dentardv/` (Part 16: those projects are NOT touched).
 *
 * The shell loads the central dashboard from MEDIRDV_CENTRAL_URL. It is a
 * real desktop app (desktop shortcut, Start Menu, uninstaller, preserved
 * settings across upgrades) — not a browser bookmark.
 *
 * A Windows installer can only be produced by electron-builder on Windows
 * or inside CI (`.github/workflows/medirdv-central-windows.yml`); this script
 * prepares the project and never claims a binary exists.
 *
 * Usage: node scripts/build-windows.js [--api-base https://central.example.dz]
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

const apiBase = argValue('--api-base', process.env.MEDIRDV_CENTRAL_URL || 'https://central.medirdv.dz');

function write(relative, content) {
  const target = path.join(OUT, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

fs.mkdirSync(path.join(OUT, 'src'), { recursive: true });

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
        files: ['src/**/*', 'package.json'],
        win: {
          target: [{ target: 'nsis', arch: ['x64'] }],
          icon: '../build/icon.ico',
          artifactName: `Medirdv-Central-Setup-${pkg.version}.\${ext}`,
        },
        nsis: {
          oneClick: false,
          perMachine: false,
          allowToChangeInstallationDirectory: true,
          createDesktopShortcut: true,
          createStartMenuShortcut: true,
          shortcutName: 'Medirdv Central',
          uninstallDisplayName: 'Medirdv Central ${version}',
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
 * Medirdv Central — Windows desktop shell.
 *
 * The central database is authoritative; this app stores nothing locally
 * except the session cookie and window state (Part 18.4). All requests go to
 * the configured central server over HTTPS.
 */
const { app, BrowserWindow, shell, Menu, dialog } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_URL = ${JSON.stringify(apiBase)};

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
    /* non-fatal: keep the default */
  }
}

function centralUrl() {
  const settings = readSettings();
  return (settings.centralUrl || process.env.MEDIRDV_CENTRAL_URL || DEFAULT_URL).replace(/\\/+$/, '');
}

function appUrl() {
  return centralUrl() + '/admin/';
}

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#f4f6f6',
    autoHideMenuBar: true,
    title: 'Medirdv Central',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  win.loadURL(appUrl());

  // Show a real error state instead of a blank white window when the
  // central server is unreachable (offline-safe, Part 18.4).
  win.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (!isMainFrame) return;
    const message = [
      'The Medirdv Central server could not be reached.',
      '',
      'Server: ' + url,
      'Reason: ' + description + ' (' + code + ')',
      '',
      'Check your connection, or set the server address from the File menu.',
    ].join('\\n');
    dialog
      .showMessageBox(win, {
        type: 'error',
        title: 'Server unreachable',
        message: 'Medirdv Central is offline',
        detail: message,
        buttons: ['Retry', 'Change server…', 'Quit'],
        defaultId: 0,
        cancelId: 2,
      })
      .then(({ response }) => {
        if (response === 0) win.loadURL(appUrl());
        else if (response === 1) promptForServer();
        else app.quit();
      });
  });

  // External links (wa.me, docs) open in the user's browser, never in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(centralUrl())) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });
  win.on('closed', () => {
    win = null;
  });
}

async function promptForServer() {
  const parent = win || undefined;
  const { response, checkboxChecked } = await dialog.showMessageBox(parent, {
    type: 'question',
    title: 'Medirdv Central server',
    message: 'Address of the Medirdv Central server',
    detail: 'The administrator dashboard is served by this address. HTTPS is required.',
    buttons: ['Save', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response !== 0) return;
  void checkboxChecked;

  const input = await dialog.showMessageBox(parent, {
    type: 'info',
    title: 'Server address',
    message: 'Current: ' + centralUrl(),
    detail: 'Type the new address in the next dialog (example: https://central.example.dz).',
    buttons: ['Continue', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
  });
  if (input.response !== 0) return;

  // A tiny focused window is more reliable than a dialog with a text field.
  const promptWindow = new BrowserWindow({
    parent,
    modal: true,
    width: 460,
    height: 190,
    resizable: false,
    title: 'Server address',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  promptWindow.loadURL(
    'data:text/html;charset=utf-8,' +
      encodeURIComponent(
        '<body style="font-family:Segoe UI,sans-serif;padding:16px">' +
          '<p style="margin:0 0 8px">Medirdv Central server address</p>' +
          '<input id="u" style="width:100%;padding:8px;box-sizing:border-box" value="' +
          centralUrl() +
          '">' +
          '<p style="color:#666;font-size:12px;margin:8px 0">Example: https://central.example.dz</p>' +
          '<button id="s" style="padding:8px 16px">Save</button>' +
          '<script>document.getElementById("s").onclick=function(){' +
          'location.href="medirdv://save?url="+encodeURIComponent(document.getElementById("u").value)}' +
          '</script></body>'
      )
  );
  promptWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('medirdv://save')) return;
    event.preventDefault();
    const value = new URL(url).searchParams.get('url') || '';
    const clean = value.trim().replace(/\\/+$/, '');
    if (!/^https?:\\/\\//i.test(clean)) {
      dialog.showMessageBox(parent, { type: 'warning', message: 'Please enter a full URL starting with https://' });
      return;
    }
    writeSettings({ ...readSettings(), centralUrl: clean });
    promptWindow.destroy();
    if (win) win.loadURL(appUrl());
  });
}

function buildMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => win && win.reload() },
        { label: 'Change server…', click: promptForServer },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { label: 'Toggle developer tools', accelerator: 'F12', click: () => win && win.webContents.toggleDevTools() },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'About Medirdv Central',
          click: () =>
            dialog.showMessageBox(win, {
              type: 'info',
              title: 'About',
              message: 'Medirdv Central ' + app.getVersion(),
              detail:
                'Centralized healthcare booking, WhatsApp Hub and payment verification.\\n' +
                'Server: ' + centralUrl(),
            }),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(() => {
    buildMenu();
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
`
);

console.log('[build-windows] Electron wrapper prepared at release/windows-app/');
console.log(`[build-windows] Default server: ${apiBase}`);
console.log('[build-windows] To produce the installer:');
console.log('  node scripts/convert-icon.js            # PNG → icon.ico for NSIS');
console.log('  cd release/windows-app && npm install && npm run dist');
console.log(`[build-windows] Output: release/windows/Medirdv-Central-Setup-${pkg.version}.exe`);
console.log('[build-windows] NOTE: no .exe is claimed until electron-builder succeeds.');
