'use strict';
/**
 * Feature 5 — Minimize/Close to System Tray, context menu, once-per-session
 * background notification, single-instance hidden restore, Windows shutdown
 * non-blocking bypass, clean final quit, and rotating background file logger.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  TRAY_TOOLTIP,
  TRAY_MENU_OPEN,
  TRAY_MENU_LICENSE,
  TRAY_MENU_AUTOSTART_ON,
  TRAY_MENU_AUTOSTART_OFF,
  TRAY_MENU_QUIT,
  TRAY_QUIT_CONFIRM_MESSAGE,
  TRAY_BACKGROUND_NOTIFICATION,
} = require('../src/main/config');
const { TrayController, resolveIconPath } = require('../src/main/tray');
const log = require('../src/main/log');

function createFakeElectron({ dialogResponse = 0 } = {}) {
  const balloons = [];
  const dialogs = [];
  let currentDialogResponse = dialogResponse;

  class FakeTray {
    constructor(image) {
      this.image = image;
      this.tooltip = '';
      this.menu = null;
      this.destroyed = false;
      this.listeners = new Map();
    }
    setToolTip(text) {
      this.tooltip = text;
    }
    setContextMenu(menu) {
      this.menu = menu;
    }
    on(event, fn) {
      this.listeners.set(event, fn);
    }
    emit(event) {
      const fn = this.listeners.get(event);
      if (fn) fn();
    }
    displayBalloon(opts) {
      balloons.push(opts);
    }
    isDestroyed() {
      return this.destroyed;
    }
    destroy() {
      this.destroyed = true;
    }
  }

  const electron = {
    Tray: FakeTray,
    Menu: {
      buildFromTemplate: (tpl) => tpl,
    },
    dialog: {
      showMessageBox: async (_winOrOpts, maybeOpts) => {
        const opts = maybeOpts || _winOrOpts;
        dialogs.push(opts);
        return { response: currentDialogResponse };
      },
    },
    nativeImage: {
      createFromPath: (p) => ({ path: p, isEmpty: () => false, resize: () => ({ path: p, resized: true }) }),
      createFromDataURL: (u) => ({ dataUrl: u, isEmpty: () => false }),
    },
    app: {
      quitCalled: 0,
      quit() {
        this.quitCalled += 1;
      },
    },
  };

  return {
    electron,
    balloons,
    dialogs,
    setDialogResponse(val) {
      currentDialogResponse = val;
    },
  };
}

function createFakeWindow() {
  return {
    visible: true,
    minimized: false,
    focused: 0,
    destroyed: false,
    isVisible() {
      return this.visible;
    },
    isMinimized() {
      return this.minimized;
    },
    isDestroyed() {
      return this.destroyed;
    },
    hide() {
      this.visible = false;
    },
    show() {
      this.visible = true;
    },
    restore() {
      this.minimized = false;
    },
    focus() {
      this.focused += 1;
    },
  };
}

test('Feature 5 — Tray icon, tooltip, context menu, close-to-tray & once-per-session notification', () => {
  assert.ok(resolveIconPath(), 'bundled assets/icon.png must exist for Tray & installer');

  const env = createFakeElectron();
  const win = createFakeWindow();
  let autostartEnabled = true;
  let botRunning = true;

  const ctrl = new TrayController({
    electron: env.electron,
    getMainWindow: () => win,
    createMainWindow: () => win,
    getAutostartEnabled: () => autostartEnabled,
    setAutostartEnabled: (val) => {
      autostartEnabled = val;
      return { enabled: autostartEnabled };
    },
    stopBot: async () => {
      botRunning = false;
    },
  });

  const tray = ctrl.init();
  assert.ok(tray);
  assert.equal(tray.tooltip, TRAY_TOOLTIP);
  assert.equal(tray.tooltip, 'بوت العيادة - يعمل');

  // Verify context menu items
  const labels = tray.menu.filter((i) => i.label).map((i) => i.label);
  assert.deepEqual(labels, [TRAY_MENU_OPEN, TRAY_MENU_LICENSE, TRAY_MENU_AUTOSTART_ON, TRAY_MENU_QUIT]);

  // Toggle autostart from Tray menu -> label updates cleanly
  const autostartItem = tray.menu.find((i) => i.id === 'autostart');
  autostartItem.click({ checked: false });
  assert.equal(autostartEnabled, false);
  assert.equal(tray.menu.find((i) => i.id === 'autostart').label, TRAY_MENU_AUTOSTART_OFF);

  // First click on window X -> hides to Tray, keeps bot running, shows notification ONCE
  let prevented1 = false;
  const close1 = ctrl.handleWindowClose({ preventDefault: () => { prevented1 = true; } }, win);
  assert.equal(prevented1, true);
  assert.equal(close1.prevented, true);
  assert.equal(close1.notified, true);
  assert.equal(win.visible, false);
  assert.equal(botRunning, true, 'WhatsApp bot must keep running when window is hidden to Tray');
  assert.equal(env.balloons.length, 1);
  assert.equal(env.balloons[0].content, TRAY_BACKGROUND_NOTIFICATION);

  // Clicking Tray icon restores & focuses hidden window
  win.minimized = true;
  tray.emit('click');
  assert.equal(win.visible, true);
  assert.equal(win.minimized, false);
  assert.ok(win.focused >= 1);

  // Second & third clicks on window X -> hides silently WITHOUT repeating notification
  ctrl.handleWindowClose({ preventDefault: () => {} }, win);
  ctrl.handleWindowClose({ preventDefault: () => {} }, win);
  assert.equal(win.visible, false);
  assert.equal(env.balloons.length, 1, 'background notification must appear at most once per session');

  // Single-instance (`second-instance`) unhides and focuses existing window instead of creating another
  let createdWindows = 0;
  ctrl.createMainWindow = () => {
    createdWindows += 1;
    return createFakeWindow();
  };
  ctrl.openWindow();
  assert.equal(createdWindows, 0);
  assert.equal(win.visible, true);
});

test('Feature 5 — Final quit confirmation, cancel safety, clean shutdown & Windows session-end bypass', async () => {
  const env = createFakeElectron({ dialogResponse: 1 }); // 1 = Cancel first
  const win = createFakeWindow();
  const order = [];

  const ctrl = new TrayController({
    electron: env.electron,
    getMainWindow: () => win,
    createMainWindow: () => win,
    stopSchedulers: () => order.push('schedulers'),
    stopBot: async () => order.push('bot'),
    closeDb: () => order.push('db'),
    closeLog: () => order.push('log'),
    quitApp: () => {
      order.push('quit');
      env.electron.app.quit();
    },
  });
  const tray = ctrl.init();

  // 1) User clicks « إغلاق نهائي » then clicks « إلغاء » -> app stays alive!
  const cancelRes = await ctrl.requestFinalQuit();
  assert.equal(cancelRes.quit, false);
  assert.equal(env.dialogs[0].message, TRAY_QUIT_CONFIRM_MESSAGE);
  assert.equal(tray.isDestroyed(), false);
  assert.deepEqual(order, []);
  assert.equal(env.electron.app.quitCalled, 0);

  // 2) User clicks « إغلاق نهائي » and confirms -> clean shutdown of schedulers, bot, DB, Tray icon & process
  env.setDialogResponse(0);
  const quitRes = await ctrl.requestFinalQuit();
  assert.equal(quitRes.quit, true);
  assert.equal(tray.isDestroyed(), true, 'Tray icon must be destroyed so no ghost icon lingers');
  assert.deepEqual(order, ['schedulers', 'bot', 'db', 'log', 'quit']);
  assert.equal(env.electron.app.quitCalled, 1);

  // 3) Windows Shutdown (`session-end`) bypasses preventDefault & confirmation dialog immediately
  const envShutdown = createFakeElectron();
  const winShutdown = createFakeWindow();
  const ctrlShutdown = new TrayController({
    electron: envShutdown.electron,
    getMainWindow: () => winShutdown,
  });
  ctrlShutdown.init();
  ctrlShutdown.markSystemShutdown();

  let preventedOnOsShutdown = false;
  const resShutdown = ctrlShutdown.handleWindowClose(
    { preventDefault: () => { preventedOnOsShutdown = true; } },
    winShutdown,
  );
  assert.equal(preventedOnOsShutdown, false, 'must NEVER block Windows shutdown/logoff');
  assert.equal(resShutdown.prevented, false);
  assert.equal(envShutdown.dialogs.length, 0);
});

test('Feature 5 — Background file logger rotates on size limit and scrubs PII on background errors', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'medirdv-tray-log-'));
  const file = path.join(dir, 'medirdv.log');
  try {
    // Pre-fill just below MAX_BYTES so next write triggers live rotation while running in Tray
    fs.writeFileSync(file, 'A'.repeat(log.MAX_BYTES - 20));
    log.init(file);
    log.write('error', ['Background error for patient +213551234567', new Error('socket reset')]);

    let latest = '';
    for (let i = 0; i < 40; i += 1) {
      if (fs.existsSync(`${file}.1`) && fs.existsSync(file)) {
        latest = fs.readFileSync(file, 'utf8');
        if (latest.includes('socket reset')) break;
      }
      await new Promise((r) => setTimeout(r, 15));
    }
    log.close();

    assert.ok(fs.existsSync(`${file}.1`), 'log must rotate to medirdv.log.1 when exceeding MAX_BYTES');
    assert.match(latest, /socket reset/);
    assert.match(latest, /\[PHONE-REDACTED\]/);
    assert.ok(!latest.includes('551234567'));
  } finally {
    log.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
