'use strict';
/**
 * Main-process smoke test without Electron.
 *
 * The sandbox used for development cannot download the Electron binary, so the
 * test loads `src/main/index.js` with a minimal `electron` stub. It proves that:
 *  - the app boots (DB, backups, IPC registration);
 *  - the preload and renderer files exist at the paths used by BrowserWindow;
 *  - the IPC channel answers and enforces the auth guard;
 *  - window security flags are set (contextIsolation, sandbox, no nodeIntegration).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { safeRemove } = require('./helpers');

const ROOT = path.join(__dirname, '..');

function createElectronStub(state) {
  const windows = [];
  class BrowserWindow {
    constructor(options) {
      this.options = options;
      this.destroyed = false;
      this.webContents = {
        on() {},
        once() {},
        send() {},
        openDevTools() {},
        setWindowOpenHandler(handler) {
          state.windowOpenHandler = handler;
        },
      };
      windows.push(this);
    }
    once(event, handler) {
      if (event === 'ready-to-show') this.readyHandler = handler;
    }
    on() {}
    loadFile(file) {
      this.loadedFile = file;
    }
    show() {
      this.shown = true;
    }
    isDestroyed() {
      return this.destroyed;
    }
    isMinimized() {
      return false;
    }
    restore() {}
    focus() {}
  }
  BrowserWindow.getAllWindows = () => windows;

  const handlers = new Map();
  const app = {
    isPackaged: false,
    handlers: {},
    getVersion: () => '1.0.0',
    getPath: (name) => path.join(state.userData, name),
    requestSingleInstanceLock: () => true,
    whenReady: () => {
      state.readyPromise = new Promise((resolve) => {
        state.ready = resolve;
      });
      return state.readyPromise;
    },
    on() {},
    quit() {
      state.quit = true;
    },
  };

  return {
    app,
    BrowserWindow,
    windows,
    handlers,
    ipcMain: {
      handle(channel, handler) {
        handlers.set(channel, handler);
      },
    },
    Menu: { setApplicationMenu() {} },
    dialog: {
      showErrorBox(title, message) {
        state.errorBox = { title, message };
      },
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      showSaveDialog: async () => ({ canceled: true }),
    },
    shell: { openPath() {}, openExternal() {} },
  };
}

test('the Electron main process boots and wires everything', async (t) => {
  const state = {
    userData: fs.mkdtempSync(path.join(os.tmpdir(), 'dentardv-main-')),
  };
  const stub = createElectronStub(state);

  // Intercept `require('electron')` and point the data folder at a temp dir.
  const originalLoad = Module._load;
  Module._load = function patched(request, parent, isMain) {
    if (request === 'electron') return stub;
    return originalLoad.call(this, request, parent, isMain);
  };
  process.env.DENTARDV_DATA_DIR = path.join(state.userData, 'data');

  t.after(() => {
    Module._load = originalLoad;
    delete process.env.DENTARDV_DATA_DIR;
    try {
      require('../src/main/services/license').stopPeriodicCheck();
    } catch (_error) {
      /* ignore */
    }
    try {
      require('../src/main/services/backup').stopScheduler();
    } catch (_error) {
      /* ignore */
    }
    // Windows keeps the SQLite file locked until the connection is closed.
    try {
      require('../src/main/db').close();
    } catch (error) {
      /* already closed */
    }
    try {
      const log = require('../src/main/log');
      log.detachConsole();
      log.close();
    } catch (error) {
      /* logging was never initialised */
    }
    for (const window of stub.windows) window.destroyed = true;
    safeRemove(state.userData);
  });

  require('../src/main/index');
  state.ready();
  await new Promise((resolve) => setTimeout(resolve, 300));

  // 1. Window created with secure webPreferences and an existing preload file.
  assert.equal(stub.windows.length, 1, 'one window created');
  const window = stub.windows[0];
  assert.equal(window.options.webPreferences.contextIsolation, true);
  assert.equal(window.options.webPreferences.nodeIntegration, false);
  assert.equal(window.options.webPreferences.sandbox, true);
  assert.ok(fs.existsSync(window.options.webPreferences.preload), 'preload file exists');
  assert.ok(fs.existsSync(window.loadedFile), 'renderer index.html exists');

  // 2. Database created in the application data folder.
  assert.ok(fs.existsSync(path.join(state.userData, 'data', 'dentardv.sqlite')));

  // 3. The single IPC channel is registered.
  assert.ok(stub.handlers.has('dentardv:invoke'));
  const invoke = (method, payload) =>
    stub.handlers.get('dentardv:invoke')(null, method, payload);

  // 4. Public action works before login, protected action is refused.
  const bootstrap = await invoke('app:bootstrap', {});
  assert.equal(bootstrap.ok, true);
  assert.equal(bootstrap.data.auth.has_password, false);

  const guarded = await invoke('patients:list', {});
  assert.equal(guarded.ok, false);
  assert.equal(guarded.error.code, 'LOCKED');

  // 5. After creating the password everything is reachable.
  const setup = await invoke('auth:setup', { password: '1234', confirm: '1234' });
  assert.equal(setup.ok, true);
  const patients = await invoke('patients:list', {});
  assert.equal(patients.ok, true);

  const created = await invoke('patients:create', { full_name: 'Test Patient', phone: '0555111999' });
  assert.equal(created.ok, true);
  const agenda = await invoke('appointments:create', { patient_id: created.data.id });
  assert.equal(agenda.ok, true);
  assert.equal(agenda.data.queue_number, 1);

  // 6. Unknown actions are rejected, not crashed on.
  const unknown = await invoke('does:not:exist', {});
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error.code, 'UNKNOWN_METHOD');

  // 7. External navigation is denied / sent to the system browser.
  assert.equal(state.windowOpenHandler({ url: 'https://example.com' }).action, 'deny');
});

test('every renderer asset referenced by index.html exists', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src/renderer/index.html'), 'utf8');
  const references = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((match) => match[1]);
  assert.ok(references.length >= 10);
  for (const reference of references) {
    const file = path.join(ROOT, 'src/renderer', reference);
    assert.ok(fs.existsSync(file), `missing renderer asset: ${reference}`);
  }
});

test('all main-process files parse and every IPC action exists', () => {
  const { createHandlers } = require('../src/main/handlers');
  const actions = createHandlers({
    version: '1.0.0',
    dataDir: os.tmpdir(),
    wa: null,
    printReceipt: null,
  });
  for (const name of Object.keys(actions)) {
    assert.equal(typeof actions[name], 'function', `${name} must be a function`);
  }
  // Actions used by the renderer must be present in the handler map.
  const rendererFiles = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) rendererFiles.push(full);
    }
  };
  walk(path.join(ROOT, 'src/renderer/js'));
  const used = new Set();
  for (const file of rendererFiles) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/API\.invoke\('([^']+)'/g)) used.add(match[1]);
    for (const match of source.matchAll(/API\.invoke\(\s*`([^`$]+)`/g)) used.add(match[1]);
  }
  const missing = [...used].filter((name) => !actions[name]);
  assert.deepEqual(missing, [], `renderer calls unknown actions: ${missing.join(', ')}`);
});
