'use strict';
/**
 * PharmaGestion DZ — Electron main process.
 *
 * Boot order:
 *  1. resolve the data folder (%APPDATA%\PharmaGestion DZ\data, never the
 *     installation folder) and start the file log;
 *  2. open SQLite, applying migrations (a copy is taken before an upgrade);
 *  3. start the daily backup scheduler;
 *  4. register the allowlisted IPC actions;
 *  5. show the window.
 *
 * Security posture (checked by tests/security.test.js):
 *  - contextIsolation: true, nodeIntegration: false, sandbox: true;
 *  - no remote content: only local file:// assets are loaded;
 *  - navigation and new windows are blocked, permissions denied;
 *  - the window can only reach the allowlisted actions in handlers.js.
 */

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, Menu, dialog, session, shell, clipboard } = require('electron');
const db = require('./db');
const log = require('./log');
const settings = require('./services/settings');
const backup = require('./services/backup');
const audit = require('./services/audit');
const { registerIpc, reloadWindows, methods } = require('./ipc');

const APP_NAME = 'PharmaGestion DZ';
if (typeof app.setName === 'function') app.setName(APP_NAME);

const isDev = !app.isPackaged;

/**
 * Smoke mode (used by the Windows/macOS/Linux CI job): boot everything that
 * matters — data folder, database creation, migrations, backup scheduler, IPC
 * registration — then quit. A real window cannot be shown on a headless CI
 * machine, but "does the packaged application start?" can still be verified.
 */
const SMOKE = process.env.PHARMAGESTION_SMOKE === '1';
let mainWindow = null;
let bootError = null;

/**
 * All pharmacy data lives in one folder, easy to copy or back up:
 *   Windows: %APPDATA%\PharmaGestion DZ\data
 * Tests and support scripts can point elsewhere with PHARMAGESTION_DATA_DIR.
 */
function resolveDataDir() {
  if (process.env.PHARMAGESTION_DATA_DIR) {
    return path.resolve(process.env.PHARMAGESTION_DATA_DIR);
  }
  return path.join(app.getPath('userData'), 'data');
}

function broadcastEvent(event) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('pharmagestion:event', event);
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    backgroundColor: '#f5f7f4',
    title: APP_NAME,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: false,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
    },
  });

  win.once('ready-to-show', () => win.show());

  const indexFile = path.join(__dirname, '..', 'renderer', 'index.html');
  if (bootError) {
    // A failed boot must still show something explainable rather than a
    // silent, invisible application.
    win.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(
        `<html dir="rtl"><body style="font-family:Segoe UI,Arial;padding:40px">
         <h2>تعذر بدء التطبيق / Démarrage impossible</h2>
         <p>${String(bootError.message || bootError).replace(/[<>&]/g, '')}</p>
         <p style="color:#666">Consultez / راجع: ${resolveDataDir()}</p></body></html>`,
      )}`,
    );
  } else {
    win.loadFile(indexFile);
  }

  // External links open in the real browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault();
  });
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());

  if (isDev && process.env.PHARMAGESTION_DEVTOOLS) {
    win.webContents.openDevTools({ mode: 'detach' });
  }

  win.on('closed', () => {
    mainWindow = null;
  });
  mainWindow = win;
  return win;
}

function boot() {
  const dataDir = resolveDataDir();
  const databaseFile = path.join(dataDir, 'pharmagestion.sqlite');

  log.init(path.join(dataDir, 'pharmagestion.log'));
  log.attachConsole();
  console.log('[boot]', APP_NAME, app.getVersion(), '| electron', process.versions.electron);
  console.log('[boot] data dir:', dataDir);

  db.open(databaseFile, {
    backupDir: path.join(dataDir, 'backups'),
    onUpgrade: ({ from, to, file }) => {
      console.log(`[db] schema upgraded ${from} -> ${to}`, file || '(no pre-update copy)');
      broadcastEvent({ type: 'database-upgraded', from, to });
    },
  });
  console.log('[db] ready:', databaseFile, '| schema v' + db.stats().schemaVersion);

  try {
    audit.prune(settings.getInt('audit_keep_days'));
  } catch (error) {
    console.warn('[audit] prune skipped:', error.message);
  }

  backup.init(dataDir, { restored: () => reloadWindows() });
  backup.startScheduler();

  registerIpc({
    version: app.getVersion(),
    dataDir,
    logFile: log.currentFile(),
    isPackaged: app.isPackaged,
    dialogs: {
      openPath: (target) => shell.openPath(target),
      copyText: (text) => clipboard.writeText(String(text ?? '')),
      chooseBackup: async () => {
        const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
          title: 'اختر نسخة احتياطية / Choisir une sauvegarde',
          defaultPath: backup.backupsDir(),
          filters: [{ name: 'SQLite', extensions: ['sqlite', 'sqlite3', 'db'] }],
          properties: ['openFile'],
        });
        return { canceled, file: filePaths && filePaths[0] };
      },
      saveBackup: async (filename) => {
        const exportsDir = path.join(dataDir, 'exports');
        fs.mkdirSync(exportsDir, { recursive: true });
        const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
          title: 'تصدير النسخة الاحتياطية / Exporter la sauvegarde',
          defaultPath: path.join(exportsDir, filename),
          filters: [{ name: 'SQLite', extensions: ['sqlite'] }],
        });
        return { canceled, file: filePath };
      },
    },
  });

  if (SMOKE) {
    const stats = db.stats();
    console.log(`[smoke] data-dir=${dataDir}`);
    console.log(`[smoke] database=${databaseFile}`);
    console.log(`[smoke] schema-version=${stats.schemaVersion}`);
    console.log(`[smoke] tables=${stats.tables.join(',')}`);
    console.log(`[smoke] ipc-methods=${[...methods()].join(',')}`);
    console.log('[smoke] ok');
    setTimeout(() => app.quit(), 250);
    return;
  }

  createWindow();
  Menu.setApplicationMenu(null);
}

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

  app.whenReady().then(() => {
    // Deny every browser capability the app does not need: this is an offline
    // business tool, not a web browser.
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => {
      callback(false);
    });
    session.defaultSession.setPermissionCheckHandler(() => false);

    app.on('web-contents-created', (_event, contents) => {
      contents.on('will-attach-webview', (event) => event.preventDefault());
      contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    });

    try {
      boot();
    } catch (error) {
      bootError = error;
      console.error('[boot] fatal error', error);
      createWindow();
      dialog.showErrorBox(
        APP_NAME,
        `تعذر بدء التطبيق / Impossible de démarrer l'application.\n\n${error.message}\n\n${resolveDataDir()}`,
      );
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('before-quit', () => {
    backup.stopScheduler();
    try {
      db.close();
    } catch (error) {
      console.warn('[db] close failed', error.message);
    }
    log.detachConsole();
    log.close();
  });
}

process.on('uncaughtException', (error) => {
  console.error('[main] uncaught exception', error);
});
process.on('unhandledRejection', (reason) => {
  console.error('[main] unhandled rejection', reason);
});
