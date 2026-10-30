'use strict';
/**
 * Feature 4 — Windows Autostart (`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`),
 * working directory fix, `--autostart` detection, idempotent toggle, and offline
 * exponential retry backoff.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { useTempDb } = require('./helpers');
const { APP_NAME, STARTUP_DELAY_SECONDS } = require('../src/main/config');
const autostart = require('../src/main/autostart');
const auth = require('../src/main/services/auth');
const { createHandlers } = require('../src/main/handlers');
const { WhatsAppService, computeBackoffDelayMs } = require('../src/main/whatsapp/service');

function createFakeWindowsRegistry() {
  const store = new Map();
  const calls = [];
  const runner = (args) => {
    calls.push(args);
    const op = args[0];
    if (op === 'add') {
      const vIdx = args.indexOf('/v');
      const dIdx = args.indexOf('/d');
      const name = args[vIdx + 1];
      const data = args[dIdx + 1];
      store.set(name, data);
      return 'The operation completed successfully.\r\n';
    }
    if (op === 'query') {
      const vIdx = args.indexOf('/v');
      const name = args[vIdx + 1];
      if (!store.has(name)) {
        throw new Error('ERROR: The system was unable to find the specified registry key or value.');
      }
      return `\r\n${autostart.RUN_KEY_PATH}\r\n    ${name}    REG_SZ    ${store.get(name)}\r\n\r\n`;
    }
    if (op === 'delete') {
      const vIdx = args.indexOf('/v');
      const name = args[vIdx + 1];
      if (!store.has(name)) {
        throw new Error('ERROR: The system was unable to find the specified registry key or value.');
      }
      store.delete(name);
      return 'The operation completed successfully.\r\n';
    }
    throw new Error(`Unexpected reg.exe op: ${op}`);
  };
  return { store, calls, runner };
}

test('Feature 4 — quoted Registry command handles spaces in packaged .exe and unpackaged script modes', () => {
  assert.equal(STARTUP_DELAY_SECONDS, 15);
  assert.equal(autostart.RUN_KEY_PATH, 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run');

  const packagedCmd = autostart.buildAutostartCommand({
    isPackaged: true,
    execPath: 'C:\\Users\\Dr Ahmed Benali\\AppData\\Local\\Programs\\medirdv\\MediRDV.exe',
  });
  assert.equal(
    packagedCmd,
    '"C:\\Users\\Dr Ahmed Benali\\AppData\\Local\\Programs\\medirdv\\MediRDV.exe" --autostart',
  );

  const scriptCmd = autostart.buildAutostartCommand({
    isPackaged: false,
    execPath: 'C:\\Program Files\\Electron\\electron.exe',
    appRoot: 'C:\\Users\\Cabinet El Hayat\\Documents\\medirdv',
  });
  assert.equal(
    scriptCmd,
    '"C:\\Program Files\\Electron\\electron.exe" "C:\\Users\\Cabinet El Hayat\\Documents\\medirdv" --autostart',
  );

  assert.equal(autostart.isAutostartLaunch(['C:\\MediRDV.exe']), false);
  assert.equal(autostart.isAutostartLaunch(['C:\\MediRDV.exe', '--autostart']), true);
});

test('Feature 4 — first-run default enable + idempotent enable/disable with zero duplicates', (t) => {
  useTempDb(t);
  const reg = createFakeWindowsRegistry();
  const opts = {
    platform: 'win32',
    runner: reg.runner,
    isPackaged: true,
    execPath: 'C:\\Program Files\\MediRDV\\MediRDV.exe',
    appName: APP_NAME,
  };

  // First run: enabled automatically by default
  const first = autostart.ensureDefaultAutostartOnFirstRun(opts);
  assert.equal(first.enabled, true);
  assert.equal(reg.store.size, 1);
  assert.equal(reg.store.get(APP_NAME), '"C:\\Program Files\\MediRDV\\MediRDV.exe" --autostart');

  // Calling enable 4 more times overwrites the single value (never duplicates)
  for (let i = 0; i < 4; i += 1) {
    autostart.enableAutostart(opts);
  }
  assert.equal(reg.store.size, 1);
  assert.equal(autostart.getAutostartStatus(opts).enabled, true);

  // Disabling removes the key; disabling a second time does not throw
  const off1 = autostart.disableAutostart(opts);
  assert.equal(off1.enabled, false);
  assert.equal(reg.store.has(APP_NAME), false);

  const off2 = autostart.disableAutostart(opts);
  assert.equal(off2.enabled, false);

  // Subsequent boots respect user's disabled preference
  const nextBoot = autostart.ensureDefaultAutostartOnFirstRun(opts);
  assert.equal(nextBoot.enabled, false);
  assert.equal(reg.store.has(APP_NAME), false);
});

test('Feature 4 — IPC app:autostart-get / app:autostart-set & working directory recovery', (t) => {
  useTempDb(t);
  auth.setup({ password: '1234', confirm: '1234' });
  auth.login('1234');

  const reg = createFakeWindowsRegistry();
  const changedEvents = [];
  const handlers = createHandlers({
    version: '2.2.0',
    dataDir: os.tmpdir(),
    autostartOptions: {
      platform: 'win32',
      runner: reg.runner,
      isPackaged: true,
      execPath: 'C:\\Clinic Apps\\MediRDV\\MediRDV.exe',
    },
    onAutostartChanged: (status) => changedEvents.push(status.enabled),
  });

  assert.equal(handlers['app:autostart-get']().enabled, false);
  const enabledRes = handlers['app:autostart-set']({ enabled: true });
  assert.equal(enabledRes.enabled, true);
  assert.equal(handlers['app:autostart-get']().enabled, true);

  const disabledRes = handlers['app:autostart-set']({ enabled: false });
  assert.equal(disabledRes.enabled, false);
  assert.deepEqual(changedEvents, [true, false]);

  // Simulate Windows Registry launching with cwd = temp/System32-like folder
  const originalCwd = process.cwd();
  const expectedAppRoot = path.resolve(__dirname, '..');
  try {
    process.chdir(os.tmpdir());
    const fixed = autostart.ensureAppWorkingDirectory({
      isPackaged: false,
      appRoot: expectedAppRoot,
    });
    assert.equal(fixed.changed, true);
    assert.equal(path.resolve(process.cwd()), expectedAppRoot);
  } finally {
    process.chdir(originalCwd);
  }
});

test('Feature 4 — offline startup triggers automatic exponential retry backoff instead of dying', async (t) => {
  const tmp = useTempDb(t);

  assert.equal(computeBackoffDelayMs(1), 3000);
  assert.equal(computeBackoffDelayMs(2), 6000);
  assert.equal(computeBackoffDelayMs(3), 12000);
  assert.equal(computeBackoffDelayMs(4), 24000);
  assert.equal(computeBackoffDelayMs(5), 48000);
  assert.equal(computeBackoffDelayMs(6), 60000);
  assert.equal(computeBackoffDelayMs(9), 60000);

  const statuses = [];
  const wa = new WhatsAppService({
    authDir: `${tmp.file}-wa-auth`,
    onStatus: (s) => statuses.push(s.state),
  });

  // Simulate offline machine: connect() fails with ENOTFOUND
  wa.connect = async () => {
    throw new Error('getaddrinfo ENOTFOUND web.whatsapp.com');
  };

  const status = await wa.start({ background: true });
  assert.equal(status.state, 'connecting');
  assert.equal(wa.attempts, 1);
  assert.ok(wa.reconnectTimer, 'should schedule automatic exponential backoff timer');
  assert.match(status.last_error, /ENOTFOUND/);

  await wa.stop();
  assert.equal(wa.state, 'stopped');
});
