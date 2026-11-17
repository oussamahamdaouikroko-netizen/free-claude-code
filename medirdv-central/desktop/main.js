'use strict';
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

const DEFAULT_REMOTE = "";
const BUILD_MODE = "standalone";

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
  return (settings.centralUrl || DEFAULT_REMOTE).replace(/\/+$/, '');
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

      // No administrator is created automatically. On first launch the
      // dashboard shows a setup screen where the operator chooses their own
      // email and password (see /api/setup/status). Never invent credentials
      // the user cannot know.

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
    autoHideMenuBar: false,
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
        title: 'Medirdv Central n’a pas pu démarrer',
        message: 'Le service de base de données local ne répond pas.',
        detail: (embeddedError || description) + '\n\nEssayez : Fichier → Redémarrer le service local.',
        buttons: ['Réessayer', 'Quitter'],
      }).then(({ response }) => { if (response === 0) mainWindow.loadURL(targetUrl() || 'about:blank'); else app.quit(); });
      return;
    }
    dialog
      .showMessageBox(mainWindow, {
        type: 'error',
        title: 'Serveur injoignable',
        message: 'Le serveur Medirdv Central est injoignable.',
        detail: 'Serveur : ' + failedUrl + '\nRaison : ' + description + ' (' + code + ')\n\nVous pouvez revenir à la base locale depuis le menu Fichier.',
        buttons: ['Réessayer', 'Utiliser la base locale', 'Quitter'],
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
    detail: (embeddedError || 'Unknown error') + '\n\nData folder: ' + dataRoot(),
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
    const value = (new URL(url).searchParams.get('url') || '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(value)) {
      dialog.showMessageBox({ type: 'warning', message: 'Enter a full address starting with https://' });
      return;
    }
    writeSettings({ ...readSettings(), mode: 'remote', centralUrl: value });
    promptWindow.destroy();
    if (mainWindow) mainWindow.loadURL(targetUrl());
  });
}

function dataFolderInfo() {
  return [
    'Mode: ' + (appMode() === 'standalone' ? 'this computer (local database)' : 'shared server — ' + remoteUrl()),
    'Data folder: ' + dataRoot(),
    'Database: ' + path.join(dataRoot(), 'medirdv-central.sqlite'),
    embedded ? 'Local service: ' + embedded.baseUrl : '',
  ].filter(Boolean).join('\n');
}

/**
 * Administrator recovery for the built-in database.
 *
 * Users who installed an earlier build never learned the generated password.
 * Instead of asking them to use a command line, this dialog resets the
 * administrator credentials through the same local server, preserving all
 * records. It is local-only: it talks to the embedded server on 127.0.0.1.
 */
/**
 * Administrator recovery for the built-in database.
 *
 * Opens the recovery screen served by the local Medirdv Central server, so the
 * logic lives in one place (the web UI) instead of being duplicated inside the
 * desktop shell. Local-only: it refuses to act on a shared server.
 */
function recoverAdminAccess() {
  if (appMode() !== 'standalone' || !embedded) {
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Récupération indisponible',
      message: 'Cette installation utilise un serveur partagé.',
      detail: 'Demandez à l’administrateur du serveur de réinitialiser votre compte. La récupération ici ne concerne que la base locale.',
    });
    return;
  }
  const win = new BrowserWindow({
    parent: mainWindow || undefined,
    modal: true,
    width: 560,
    height: 520,
    resizable: false,
    title: 'Récupérer l’accès administrateur',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.setMenuBarVisibility(false);
  win.loadURL(embedded.baseUrl + '/admin/recover.html');
  win.webContents.on('did-navigate', (_event, url) => {
    // The page tells us it is done by navigating to #done.
    if (url.includes('#done') && mainWindow) {
      win.destroy();
      mainWindow.loadURL(targetUrl());
    }
  });
}

function buildMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'Fichier',
        submenu: [
          {
            label: 'Récupérer l’accès administrateur…',
            click: recoverAdminAccess,
          },
          { type: 'separator' },
          {
            label: 'Redémarrer le service local',
            click: async () => {
              embedded = null;
              embeddedError = null;
              await startEmbeddedServer();
              if (mainWindow) mainWindow.loadURL(targetUrl() || 'about:blank');
            },
          },
          { label: 'Utiliser la base locale', click: switchToStandalone },
          { label: 'Utiliser un serveur partagé…', click: switchToRemote },
          { type: 'separator' },
          { role: 'quit', label: 'Quitter' },
        ],
      },
      {
        label: 'Affichage',
        submenu: [
          { role: 'reload', label: 'Recharger' },
          { role: 'resetZoom', label: 'Taille normale' },
          { role: 'zoomIn', label: 'Agrandir' },
          { role: 'zoomOut', label: 'Réduire' },
          { type: 'separator' },
          { role: 'togglefullscreen', label: 'Plein écran' },
        ],
      },
      {
        label: 'Aide',
        submenu: [
          {
            label: 'Où sont mes données ?',
            click: () =>
              dialog.showMessageBox(mainWindow, {
                type: 'info',
                title: 'Où sont mes données ?',
                message: 'Dossier de données Medirdv Central',
                detail: dataFolderInfo(),
              }),
          },
          { label: 'Ouvrir le dossier de données', click: () => shell.openPath(dataRoot()) },
          { type: 'separator' },
          {
            label: 'À propos de Medirdv Central',
            click: () =>
              dialog.showMessageBox(mainWindow, {
                type: 'info',
                title: 'À propos',
                message: 'Medirdv Central ' + app.getVersion(),
                detail:
                  'Gestion centralisée des rendez-vous, du hub WhatsApp et de la vérification des paiements.' +
                  '\n\n' +
                  '\n\n' +
                  dataFolderInfo(),
              }),
          },
        ],
      },
    ])
  );
}

// Escape-free newline: this file is itself emitted from a template literal,
// so a literal backslash-n here would be turned into a real line break.
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
