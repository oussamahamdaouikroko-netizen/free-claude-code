'use strict';
/**
 * MediRDV - Electron main process.
 *
 * Boot order:
 *  1. open SQLite (creates + seeds on first run);
 *  2. start backup scheduler (one snapshot per day);
 *  3. register IPC handlers;
 *  4. show the dashboard window;
 *  5. reconnect WhatsApp if it was enabled last time.
 */

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, Menu, Tray, nativeImage, Notification, shell, dialog } = require('electron');
const { STARTUP_DELAY_SECONDS, APP_NAME } = require('./config');
const autostart = require('./autostart');
const { TrayController, resolveIconPath } = require('./tray');
const db = require('./db');
const log = require('./log');
const auth = require('./services/auth');
const license = require('./services/license');
const settings = require('./services/settings');
const backup = require('./services/backup');
const { registerIpc, reloadWindows } = require('./ipc');
const { printDocument } = require('./print');
const { WhatsAppService } = require('./whatsapp/service');

/**
 * Demo mode: the portable "MediRDV-Demo.exe" handed to a clinic or doctor
 * during a visit. It seeds sample multi-department clinic data, auto-unlocks,
 * never touches a real clinic database and cannot link WhatsApp.
 */
function isDemoMode() {
  if (process.env.MEDIRDV_DEMO === '1') return true;
  const markers = [path.dirname(app.getPath('exe'))];
  if (process.resourcesPath) markers.push(process.resourcesPath);
  return markers.some((dir) => {
    try {
      return Boolean(dir) && fs.existsSync(path.join(dir, 'demo.mode'));
    } catch (error) {
      return false;
    }
  });
}

const DEMO = isDemoMode();

if (typeof app.setName === 'function') app.setName(DEMO ? `${APP_NAME}-Demo` : APP_NAME);

const isDev = !app.isPackaged;
let mainWindow = null;
let waService = null;
let reminderTimer = null;
let trayController = null;

/** All clinic data lives in one folder, easy to copy / backup. */
function resolveDataDir() {
  if (process.env.MEDIRDV_DATA_DIR) return path.resolve(process.env.MEDIRDV_DATA_DIR);
  return path.join(app.getPath('userData'), DEMO ? 'demo-data' : 'data');
}

function broadcastStatus(status) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('medirdv:wa-status', status);
  }
}

function broadcastEvent(event) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('medirdv:event', event);
  }
}

function createWindow({ startHidden = false } = {}) {
  const iconFile = resolveIconPath();
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    icon: iconFile || undefined,
    backgroundColor: '#f3f7fc',
    title: DEMO ? `${APP_NAME} — Démonstration` : APP_NAME,
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
    if (!startHidden && !win.isDestroyed()) win.show();
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // External links open in the real browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault();
  });

  if (isDev && process.env.MEDIRDV_DEVTOOLS) win.webContents.openDevTools({ mode: 'detach' });

  win.on('close', (event) => {
    if (!DEMO && trayController) {
      trayController.handleWindowClose(event, win);
    }
  });

  win.on('closed', () => {
    mainWindow = null;
  });
  mainWindow = win;
  return win;
}

function stopReminderScheduler() {
  if (reminderTimer) {
    clearInterval(reminderTimer);
    reminderTimer = null;
  }
}

function startReminderScheduler() {
  stopReminderScheduler();
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
  const autostartLaunch = autostart.isAutostartLaunch(process.argv);
  const autostartOptions = {
    isPackaged: app.isPackaged,
    execPath: process.execPath,
    appName: APP_NAME,
  };
  const cwdResult = autostart.ensureAppWorkingDirectory(autostartOptions);

  const dataDir = resolveDataDir();
  const databaseFile = path.join(dataDir, 'medirdv.sqlite');

  log.init(path.join(dataDir, 'medirdv.log'));
  log.attachConsole();
  log.attachProcessErrorHandlers();
  console.log('[boot] MediRDV', app.getVersion(), '| electron', process.versions.electron);
  console.log('[boot] data dir', dataDir, '| cwd', cwdResult.cwd, '| autostart', autostartLaunch);

  if (fs.existsSync(databaseFile)) {
    const integrity = db.checkIntegrity(databaseFile);
    if (!integrity.ok) {
      console.error('[db] startup integrity check warning:', integrity.error);
    }
  }
  db.open(databaseFile);
  console.log('[db]', databaseFile);

  license.configure({
    storageDir: dataDir,
    demoMode: DEMO,
    onChange: (status) => {
      broadcastEvent({ type: 'license_changed', payload: status });
    },
    onWarning: (status) => {
      if (trayController) {
        trayController.notifyAlert(
          `تنبيه الترخيص: متبقي ${status.days_remaining} يوم على انتهاء الصلاحية (${status.expires_date_dz}).`,
          'warning',
        );
      }
      broadcastEvent({ type: 'license_warning', payload: status });
    },
    onExpired: (status) => {
      if (trayController) {
        trayController.notifyAlert(
          'انتهت صلاحية ترخيص البرنامج — توقف استقبال الحجوزات الجديدة مؤقتاً.',
          'warning',
        );
      }
      broadcastEvent({ type: 'license_changed', payload: status });
    },
  });

  if (DEMO) {
    const { seedDemoData } = require('./db/demo-seed');
    seedDemoData();
    if (!auth.hasPassword()) auth.setup({ password: '1234', confirm: '1234' });
    auth.login('1234');
    console.log('[demo] demo mode active — data in', dataDir);
  } else {
    autostart.ensureDefaultAutostartOnFirstRun(autostartOptions);
  }

  backup.init(dataDir, { restored: reloadWindows });
  backup.startScheduler();

  waService = new WhatsAppService({
    authDir: path.join(dataDir, 'wa-auth'),
    onStatus: broadcastStatus,
    onEvent: broadcastEvent,
  });

  if (!DEMO) {
    trayController = new TrayController({
      electron: { app, Tray, Menu, dialog, nativeImage, Notification },
      getMainWindow: () => mainWindow,
      createMainWindow: () => createWindow({ startHidden: false }),
      getAutostartEnabled: () => autostart.getAutostartStatus(autostartOptions).enabled,
      setAutostartEnabled: (enabled) => autostart.setAutostartEnabled(enabled, autostartOptions),
      onOpenLicense: () => {
        broadcastEvent({ type: 'open_license_modal', payload: license.getStatus() });
      },
      stopSchedulers: () => {
        stopReminderScheduler();
        backup.stopScheduler();
        license.stopPeriodicCheck();
      },
      stopBot: async () => {
        if (waService) await waService.stop();
      },
      closeDb: () => {
        try {
          db.close();
        } catch (error) {
          console.warn('[db] close failed', error.message);
        }
      },
      closeLog: () => {
        console.log('[boot] shutdown');
        log.detachProcessErrorHandlers();
        log.detachConsole();
        log.close();
      },
      quitApp: () => app.quit(),
    });
    trayController.init();
  }

  registerIpc({
    version: app.getVersion(),
    dataDir,
    logFile: log.currentFile(),
    demo: DEMO,
    userData: app.getPath('userData'),
    printReceipt: printDocument,
    onEvent: broadcastEvent,
    autostartOptions,
    onAutostartChanged: () => {
      if (trayController) trayController.refreshMenu();
    },
    wa: DEMO ? null : waService,
  });

  createWindow({ startHidden: autostartLaunch && !DEMO });
  Menu.setApplicationMenu(null);
  startReminderScheduler();

  if (!DEMO) {
    const initialLic = license.checkPeriodic();
    license.startPeriodicCheck();
    if (autostartLaunch && !initialLic.status.valid && trayController) {
      trayController.notifyAlert(
        'الترخيص غير مفعّل أو منتهي — انقر على أيقونة الساعة لفتح نافذة الترخيص.',
        'warning',
      );
    }
  }

  if (!DEMO && settings.getBool('bot_enabled')) {
    const startupDelayMs = autostartLaunch ? STARTUP_DELAY_SECONDS * 1000 : 2500;
    setTimeout(() => {
      waService.start({ background: true }).catch((error) => {
        console.error('[wa] autostart failed:', error.message);
      });
    }, startupDelayMs);
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (trayController) {
      trayController.openWindow();
      return;
    }
    if (mainWindow) {
      if (!mainWindow.isVisible()) mainWindow.show();
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  // Never block Windows Shutdown / Restart / Logoff (`WM_QUERYENDSESSION` / `WM_ENDSESSION`).
  app.on('session-end', () => {
    if (trayController) trayController.markSystemShutdown();
  });

  app.whenReady().then(() => {
    try {
      boot();
    } catch (error) {
      console.error('[boot] fatal error', error);
      dialog.showErrorBox(
        'MediRDV',
        `Impossible de démarrer l'application.\n${error.message}\n\n${resolveDataDir()}`,
      );
      app.quit();
    }

    app.on('activate', () => {
      if (trayController) {
        trayController.openWindow();
      } else if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });

  app.on('window-all-closed', () => {
    if (!DEMO && trayController && !trayController.isQuitting) {
      // Stay running in the Windows System Tray.
      return;
    }
    app.quit();
  });

  app.on('before-quit', () => {
    if (trayController) {
      trayController.markSystemShutdown();
      trayController.performCleanShutdown().catch(() => {});
      return;
    }
    stopReminderScheduler();
    backup.stopScheduler();
    if (waService) waService.stop().catch(() => {});
    try {
      db.close();
    } catch (error) {
      console.warn('[db] close failed', error.message);
    }
    console.log('[boot] shutdown');
    log.detachProcessErrorHandlers();
    log.detachConsole();
    log.close();
  });
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (trayController) trayController.markSystemShutdown();
  });
}

process.on('uncaughtException', (error) => {
  console.error('[main] uncaught exception', error);
});
process.on('unhandledRejection', (reason) => {
  console.error('[main] unhandled rejection', reason);
});
