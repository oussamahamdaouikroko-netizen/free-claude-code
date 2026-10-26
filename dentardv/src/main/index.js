'use strict';
/**
 * DentaRDV v2.0.0 - Electron main process.
 *
 * Boot order:
 *  1. open SQLite (creates + seeds on first run, migrates existing DB);
 *  2. initialize offline Ed25519 licensing (7-day trial + activation code);
 *  3. start backup scheduler + Windows autostart + system tray;
 *  4. register IPC handlers;
 *  5. show dashboard window (or start minimized to tray on `--hidden`);
 *  6. reconnect WhatsApp if it was enabled last time.
 */

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, Menu, shell, dialog } = require('electron');
const db = require('./db');
const log = require('./log');
const auth = require('./services/auth');
const license = require('./services/license');
const settings = require('./services/settings');
const backup = require('./services/backup');
const autostart = require('./autostart');
const { createTrayController } = require('./tray');
const { registerIpc, reloadWindows } = require('./ipc');
const { printDocument, prescriptionHtml, certificateHtml } = require('./print');
const { WhatsAppService } = require('./whatsapp/service');

function isDemoMode() {
  if (process.env.DENTARDV_DEMO === '1') return true;
  const markers = [path.dirname(app.getPath('exe'))];
  if (process.resourcesPath) markers.push(process.resourcesPath);
  return markers.some((dir) => {
    try {
      return Boolean(dir) && fs.existsSync(path.join(dir, 'demo.mode'));
    } catch (_error) {
      return false;
    }
  });
}

const DEMO = isDemoMode();
const START_HIDDEN = process.argv.includes('--hidden') || process.argv.includes('--autostart');

if (typeof app.setName === 'function') app.setName(DEMO ? 'DentaRDV-Demo' : 'DentaRDV');

const isDev = !app.isPackaged;
let mainWindow = null;
let waService = null;
let trayCtrl = null;
let reminderTimer = null;
let isQuitting = false;

function resolveDataDir() {
  if (process.env.DENTARDV_DATA_DIR) return path.resolve(process.env.DENTARDV_DATA_DIR);
  return path.join(app.getPath('userData'), DEMO ? 'demo-data' : 'data');
}

function broadcastStatus(status) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('dentardv:wa-status', status);
  }
  if (trayCtrl) trayCtrl.update(status);
}

function broadcastEvent(event) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('dentardv:event', event);
  }
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow({ showImmediately: true });
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createWindow({ showImmediately = !START_HIDDEN } = {}) {
  const win = new BrowserWindow({
    width: 1380,
    height: 880,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    backgroundColor: '#f4f8f7',
    title: DEMO ? 'DentaRDV — Démonstration' : 'DentaRDV',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  win.once('ready-to-show', () => {
    if (showImmediately) win.show();
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault();
  });

  // Minimize to Windows system tray on window close when tray is active
  win.on('close', (event) => {
    if (!isQuitting && !DEMO && trayCtrl && trayCtrl.isActive()) {
      event.preventDefault();
      win.hide();
      trayCtrl.notifyMinimizedOnce();
    }
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

  log.init(path.join(dataDir, 'dentardv.log'));
  log.attachConsole();
  console.log('[boot] DentaRDV', app.getVersion(), '| electron', process.versions.electron);
  console.log('[boot] data dir', dataDir);

  db.open(databaseFile);
  console.log('[db]', databaseFile);

  license.init({
    dataDir,
    demo: DEMO,
    onStatusChange: (status) => {
      broadcastEvent({ type: 'license', payload: status });
    },
  });
  license.startPeriodicCheck();

  if (DEMO) {
    const { seedDemoData } = require('./db/demo-seed');
    seedDemoData();
    if (!auth.hasPassword()) auth.setup({ password: '1234', confirm: '1234' });
    auth.login('1234');
    console.log('[demo] demo mode active — data in', dataDir);
  } else {
    autostart.ensureDefaultInitialized({ isPackaged: app.isPackaged, execPath: process.execPath });
  }

  backup.init(dataDir, { restored: reloadWindows });
  backup.startScheduler();

  waService = new WhatsAppService({
    authDir: path.join(dataDir, 'wa-auth'),
    onStatus: broadcastStatus,
    onEvent: broadcastEvent,
  });

  if (!DEMO) {
    trayCtrl = createTrayController({
      getLang: () => settings.get('language'),
      onShowWindow: showMainWindow,
      onStartBot: () => {
        settings.set('bot_enabled', '1');
        waService.start().catch((err) => console.error('[tray] start failed:', err.message));
      },
      onStopBot: () => {
        settings.set('bot_enabled', '0');
        waService.stop({ logout: false }).catch((err) => console.error('[tray] stop failed:', err.message));
      },
      onQuit: () => {
        isQuitting = true;
        app.quit();
      },
      getAutostartEnabled: () =>
        autostart.getStatus({ isPackaged: app.isPackaged, execPath: process.execPath }).enabled,
      setAutostartEnabled: (enabled) =>
        autostart.setEnabled(enabled, { isPackaged: app.isPackaged, execPath: process.execPath }),
    });
    trayCtrl.init();
  }

  registerIpc({
    version: app.getVersion(),
    dataDir,
    logFile: log.currentFile(),
    demo: DEMO,
    userData: app.getPath('userData'),
    autostart: DEMO ? null : autostart,
    printReceipt: printDocument,
    prescriptionHtml,
    certificateHtml,
    onEvent: broadcastEvent,
    wa: DEMO ? null : waService,
  });

  createWindow({ showImmediately: !START_HIDDEN });
  Menu.setApplicationMenu(null);
  startReminderScheduler();

  if (!DEMO && settings.getBool('bot_enabled')) {
    setTimeout(() => {
      waService.start().catch((error) => console.error('[wa] autostart failed:', error.message));
    }, 2500);
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showMainWindow();
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
      showMainWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (!trayCtrl || !trayCtrl.isActive()) {
      app.quit();
    }
  });

  app.on('before-quit', () => {
    isQuitting = true;
    if (reminderTimer) clearInterval(reminderTimer);
    license.stopPeriodicCheck();
    backup.stopScheduler();
    if (trayCtrl) trayCtrl.destroy();
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
