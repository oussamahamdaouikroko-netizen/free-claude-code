'use strict';
/**
 * System Tray & Background Lifecycle Controller (Feature 5).
 *
 * Ensures closing the window (`X`) hides MediRDV to the Windows System Tray
 * while the WhatsApp bot, reminders, and local SQLite database keep running
 * safely in the background. Only choosing « إغلاق نهائي » from the Tray menu
 * (after confirmation) or a real Windows shutdown/logoff exits the process.
 */

const fs = require('node:fs');
const path = require('node:path');
const {
  APP_NAME,
  TRAY_TOOLTIP,
  TRAY_MENU_OPEN,
  TRAY_MENU_LICENSE,
  TRAY_MENU_AUTOSTART_ON,
  TRAY_MENU_AUTOSTART_OFF,
  TRAY_MENU_QUIT,
  TRAY_QUIT_CONFIRM_MESSAGE,
  TRAY_BACKGROUND_NOTIFICATION,
} = require('./config');

// 16x16 solid teal PNG fallback so Tray never crashes even if icon file is absent
const FALLBACK_ICON_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAACXBIWXMAAAsTAAALEwEAmpwYAAAAB3RJTUUH6AoZAAABg69i5AAAAB1pVFh0Q29tbWVudAAAAAAAQ3JlYXRlZCB3aXRoIEdJTVBkLmUHAAAAFklEQVQoz2NgYGD4z8DAwMgwquBoAwBpMAERA81hWQAAAABJRU5ErkJggg==';

function resolveIconPath(customPath) {
  const candidates = [
    customPath,
    path.join(__dirname, '..', '..', 'assets', 'icon.png'),
  ].filter(Boolean);
  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) return file;
    } catch (_err) {
      /* ignore */
    }
  }
  return null;
}

class TrayController {
  /**
   * @param {object} deps
   * @param {object} [deps.electron] - Electron module (`{ Tray, Menu, dialog, nativeImage, Notification, app }`)
   * @param {() => object|null} deps.getMainWindow
   * @param {() => object} deps.createMainWindow
   * @param {() => boolean} deps.getAutostartEnabled
   * @param {(enabled: boolean) => {enabled: boolean}} deps.setAutostartEnabled
   * @param {() => Promise<void>|void} [deps.stopBot]
   * @param {() => void} [deps.stopSchedulers]
   * @param {() => void} [deps.closeDb]
   * @param {() => void} [deps.closeLog]
   * @param {() => void} [deps.quitApp]
   * @param {string} [deps.iconPath]
   */
  constructor(deps = {}) {
    this.electron = deps.electron || null;
    this.getMainWindow = deps.getMainWindow || (() => null);
    this.createMainWindow = deps.createMainWindow || (() => null);
    this.getAutostartEnabled = deps.getAutostartEnabled || (() => false);
    this.setAutostartEnabled = deps.setAutostartEnabled || ((enabled) => ({ enabled }));
    this.stopBot = deps.stopBot || (async () => {});
    this.stopSchedulers = deps.stopSchedulers || (() => {});
    this.closeDb = deps.closeDb || (() => {});
    this.closeLog = deps.closeLog || (() => {});
    this.quitApp = deps.quitApp || (() => this.electron?.app?.quit?.());
    this.onOpenLicense = deps.onOpenLicense || (() => {});
    this.iconPath = deps.iconPath || null;

    this.tray = null;
    this.isQuitting = false;
    this.hideNotifiedOnce = false;
    this.shutdownPromise = null;
  }

  loadTrayImage() {
    const nativeImage = this.electron?.nativeImage;
    const foundPath = resolveIconPath(this.iconPath);
    if (nativeImage) {
      if (foundPath) {
        const img = nativeImage.createFromPath(foundPath);
        if (img && (typeof img.isEmpty !== 'function' || !img.isEmpty())) {
          return typeof img.resize === 'function' ? img.resize({ width: 16, height: 16 }) : img;
        }
      }
      if (typeof nativeImage.createFromDataURL === 'function') {
        return nativeImage.createFromDataURL(FALLBACK_ICON_DATA_URL);
      }
    }
    return foundPath || FALLBACK_ICON_DATA_URL;
  }

  init() {
    if (this.tray) return this.tray;
    const TrayCtor = this.electron?.Tray;
    if (!TrayCtor) return null;

    this.tray = new TrayCtor(this.loadTrayImage());
    if (typeof this.tray.setToolTip === 'function') {
      this.tray.setToolTip(TRAY_TOOLTIP);
    }

    if (typeof this.tray.on === 'function') {
      this.tray.on('click', () => this.openWindow());
      this.tray.on('double-click', () => this.openWindow());
    }

    this.refreshMenu();
    return this.tray;
  }

  buildMenuTemplate() {
    const enabled = Boolean(this.getAutostartEnabled());
    return [
      {
        id: 'open',
        label: TRAY_MENU_OPEN,
        click: () => this.openWindow(),
      },
      {
        id: 'license',
        label: TRAY_MENU_LICENSE,
        click: () => this.openLicense(),
      },
      {
        id: 'autostart',
        label: enabled ? TRAY_MENU_AUTOSTART_ON : TRAY_MENU_AUTOSTART_OFF,
        type: 'checkbox',
        checked: enabled,
        click: (menuItem) => {
          const next = menuItem && typeof menuItem.checked === 'boolean' ? menuItem.checked : !enabled;
          this.toggleAutostart(next);
        },
      },
      { type: 'separator' },
      {
        id: 'quit',
        label: TRAY_MENU_QUIT,
        click: () => {
          this.requestFinalQuit().catch((err) => {
            console.error('[tray] final quit error:', err);
          });
        },
      },
    ];
  }

  refreshMenu() {
    if (!this.tray) return null;
    if (typeof this.tray.isDestroyed === 'function' && this.tray.isDestroyed()) return null;
    const template = this.buildMenuTemplate();
    const MenuApi = this.electron?.Menu;
    if (MenuApi && typeof MenuApi.buildFromTemplate === 'function' && typeof this.tray.setContextMenu === 'function') {
      const menu = MenuApi.buildFromTemplate(template);
      this.tray.setContextMenu(menu);
      return menu;
    }
    return template;
  }

  toggleAutostart(nextEnabled) {
    try {
      const res = this.setAutostartEnabled(Boolean(nextEnabled));
      this.refreshMenu();
      return res;
    } catch (err) {
      console.error('[tray] failed to toggle autostart:', err.message);
      this.refreshMenu();
      return { enabled: Boolean(this.getAutostartEnabled()), error: err.message };
    }
  }

  /**
   * Open, unhide, unminimize, and focus the existing window (used by Tray click,
   * Tray « فتح », and Single-Instance `second-instance` handler).
   */
  openWindow() {
    let win = this.getMainWindow();
    if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) {
      win = this.createMainWindow();
    }
    if (!win) return null;
    if (typeof win.isVisible === 'function' && !win.isVisible() && typeof win.show === 'function') {
      win.show();
    } else if (typeof win.show === 'function') {
      win.show();
    }
    if (typeof win.isMinimized === 'function' && win.isMinimized() && typeof win.restore === 'function') {
      win.restore();
    }
    if (typeof win.focus === 'function') {
      win.focus();
    }
    return win;
  }

  openLicense() {
    const win = this.openWindow();
    try {
      this.onOpenLicense(win);
    } catch (_err) {
      /* ignore */
    }
    return win;
  }

  notifyAlert(content, iconType = 'warning') {
    if (!content) return false;
    try {
      if (this.tray && typeof this.tray.displayBalloon === 'function') {
        this.tray.displayBalloon({
          iconType,
          title: APP_NAME,
          content: String(content),
        });
        return true;
      }
      const NotificationCtor = this.electron?.Notification;
      if (NotificationCtor && (!NotificationCtor.isSupported || NotificationCtor.isSupported())) {
        const note = new NotificationCtor({
          title: APP_NAME,
          body: String(content),
          silent: false,
        });
        if (typeof note.show === 'function') note.show();
        return true;
      }
    } catch (_err) {
      /* ignore */
    }
    return false;
  }

  /**
   * Show the subtle background-running hint AT MOST ONCE per session.
   */
  notifyHiddenOnce() {
    if (this.hideNotifiedOnce) return false;
    this.hideNotifiedOnce = true;

    try {
      if (this.tray && typeof this.tray.displayBalloon === 'function') {
        this.tray.displayBalloon({
          iconType: 'info',
          title: APP_NAME,
          content: TRAY_BACKGROUND_NOTIFICATION,
        });
        return true;
      }
      const NotificationCtor = this.electron?.Notification;
      if (NotificationCtor && (!NotificationCtor.isSupported || NotificationCtor.isSupported())) {
        const note = new NotificationCtor({
          title: APP_NAME,
          body: TRAY_BACKGROUND_NOTIFICATION,
          silent: true,
        });
        if (typeof note.show === 'function') note.show();
        return true;
      }
    } catch (_err) {
      /* never fail window hide if OS notifications are disabled */
    }
    return true;
  }

  /**
   * Intercept clicking `X` on the main window: hide to Tray instead of quitting,
   * unless a confirmed final quit or OS shutdown (`isQuitting`) is in progress.
   */
  handleWindowClose(event, win) {
    if (this.isQuitting) {
      return { prevented: false };
    }
    if (event && typeof event.preventDefault === 'function') {
      event.preventDefault();
    }
    if (win && (typeof win.isDestroyed !== 'function' || !win.isDestroyed()) && typeof win.hide === 'function') {
      win.hide();
    }
    const notified = this.notifyHiddenOnce();
    return { prevented: true, notified };
  }

  /**
   * Called on Windows `session-end` (`WM_QUERYENDSESSION` / `WM_ENDSESSION`) or OS signals:
   * bypasses Tray hide and confirmation dialogs so Windows shutdown/restart is NEVER blocked.
   */
  markSystemShutdown() {
    this.isQuitting = true;
  }

  destroyTray() {
    if (!this.tray) return;
    try {
      if (typeof this.tray.isDestroyed !== 'function' || !this.tray.isDestroyed()) {
        if (typeof this.tray.destroy === 'function') this.tray.destroy();
      }
    } catch (_err) {
      /* ignore */
    }
    this.tray = null;
  }

  /**
   * Idempotent clean shutdown: stops schedulers, disconnects WhatsApp bot,
   * closes SQLite database, removes Tray icon, and flushes log stream.
   */
  performCleanShutdown() {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.isQuitting = true;
    this.shutdownPromise = (async () => {
      try {
        this.stopSchedulers();
      } catch (err) {
        console.error('[shutdown] scheduler stop warning:', err.message);
      }
      try {
        await this.stopBot();
      } catch (err) {
        console.error('[shutdown] bot stop warning:', err.message);
      }
      try {
        this.closeDb();
      } catch (err) {
        console.error('[shutdown] db close warning:', err.message);
      }
      this.destroyTray();
      try {
        this.closeLog();
      } catch (_err) {
        /* ignore */
      }
    })();
    return this.shutdownPromise;
  }

  /**
   * Confirm final quit from the Tray menu (« إغلاق نهائي »).
   */
  async requestFinalQuit() {
    const dialogApi = this.electron?.dialog;
    let confirmed = true;

    if (dialogApi && typeof dialogApi.showMessageBox === 'function') {
      const parentWin = this.getMainWindow();
      const opts = {
        type: 'warning',
        title: APP_NAME,
        message: TRAY_QUIT_CONFIRM_MESSAGE,
        buttons: [TRAY_MENU_QUIT, 'إلغاء'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      };
      const result =
        parentWin && (typeof parentWin.isDestroyed !== 'function' || !parentWin.isDestroyed()) && parentWin.isVisible?.()
          ? await dialogApi.showMessageBox(parentWin, opts)
          : await dialogApi.showMessageBox(opts);
      confirmed = result && result.response === 0;
    }

    if (!confirmed) {
      return { quit: false };
    }

    this.isQuitting = true;
    await this.performCleanShutdown();
    this.quitApp();
    return { quit: true };
  }
}

module.exports = {
  TrayController,
  resolveIconPath,
  FALLBACK_ICON_DATA_URL,
};
