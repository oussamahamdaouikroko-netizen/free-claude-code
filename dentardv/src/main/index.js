'use strict';
/**
 * DentaRDV - Electron main process.
 *
 * Boot order:
 *  1. open SQLite (creates + seeds on first run);
 *  2. start backup scheduler (one snapshot per day);
 *  3. register IPC handlers;
 *  4. show the dashboard window;
 *  5. reconnect WhatsApp if it was enabled last time.
 */

const path = require('node:path');
const { app, BrowserWindow, Menu, shell, dialog } = require('electron');
const db = require('./db');
const log = require('./log');
const settings = require('./services/settings');
const backup = require('./services/backup');
const { registerIpc, reloadWindows } = require('./ipc');
const { printDocument } = require('./print');
const { WhatsAppService } = require('./whatsapp/service');

// Pin the data folder to %APPDATA%\DentaRDV (npm package name is lowercase).
if (typeof app.setName === 'function') app.setName('DentaRDV');

const isDev = !app.isPackaged;
let mainWindow = null;
let waService = null;
let reminderTimer = null;

/** All clinic data lives in one folder, easy to copy / backup. */
function resolveDataDir() {
  if (process.env.DENTARDV_DATA_DIR) return path.resolve(process.env.DENTARDV_DATA_DIR);
  return path.join(app.getPath('userData'), 'data');
}

function broadcastStatus(status) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('dentardv:wa-status', status);
  }
}

function broadcastEvent(event) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('dentardv:event', event);
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    backgroundColor: '#f4f8f7',
    title: 'DentaRDV',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // External links open in the real browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault();
  });

  if (isDev && process.env.DENTARDV_DEVTOOLS) win.webContents.openDevTools({ mode: 'detach' });

  win.on('closed', () => {
    mainWindow = null;
  });
  mainWindow = win;
  return win;
}

function startReminderScheduler() {
  if (reminderTimer) clearInterval(reminderTimer);
  reminderTimer = setInterval(() => {
    if (!waService) return;
    if (!settings.getBool('bot_enabled') || !settings.getBool('reminder_enabled')) return;
    waService.sendReminders().catch((error) => {
      console.error('[reminders] failed:', error.message);
    });
  }, 5 * 60 * 1000);
  if (reminderTimer.unref) reminderTimer.unref();
}

function boot() {
  const dataDir = resolveDataDir();
  const databaseFile = path.join(dataDir, 'dentardv.sqlite');

  // Log before anything else: a failure to open the database must leave a
  // trace inside the data folder (a packaged app has no console).
  log.init(path.join(dataDir, 'dentardv.log'));
  log.attachConsole();
  console.log('[boot] DentaRDV', app.getVersion(), '| electron', process.versions.electron);
  console.log('[boot] data dir', dataDir);

  db.open(databaseFile);
  console.log('[db]', databaseFile);

  backup.init(dataDir, { restored: reloadWindows });
  backup.startScheduler();

  waService = new WhatsAppService({
    authDir: path.join(dataDir, 'wa-auth'),
    onStatus: broadcastStatus,
    onEvent: broadcastEvent,
  });

  registerIpc({
    version: app.getVersion(),
    dataDir,
    logFile: log.currentFile(),
    userData: app.getPath('userData'),
    printReceipt: printDocument,
    wa: waService,
  });

  createWindow();
  Menu.setApplicationMenu(null);
  startReminderScheduler();

  // Reconnect the bot automatically if the clinic left it enabled.
  if (settings.getBool('bot_enabled')) {
    setTimeout(() => {
      waService.start().catch((error) => console.error('[wa] autostart failed:', error.message));
    }, 2500);
  }
}

// One clinic, one instance: two windows writing the same SQLite file would
// duplicate queue numbers.
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
    try {
      boot();
    } catch (error) {
      console.error('[boot] fatal error', error);
      dialog.showErrorBox(
        'DentaRDV',
        `Impossible de démarrer l'application.\n${error.message}\n\n${resolveDataDir()}`,
      );
      app.quit();
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('before-quit', () => {
    if (reminderTimer) clearInterval(reminderTimer);
    backup.stopScheduler();
    if (waService) waService.stop().catch(() => {});
    try {
      db.close();
    } catch (error) {
      console.warn('[db] close failed', error.message);
    }
    console.log('[boot] shutdown');
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
