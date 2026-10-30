'use strict';
/**
 * Windows Autostart manager for DentaRDV (`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`).
 * Zero admin rights required, atomic & idempotent.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { APP_NAME } = require('./config');
const settings = require('./services/settings');
const { AppError } = require('./utils/common');

const RUN_KEY_PATH = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const AUTOSTART_FLAG = '--autostart';
const DEFAULT_APP_ROOT = path.resolve(__dirname, '..', '..');

function quoteWinArg(value) {
  const raw = String(value ?? '').trim().replace(/"/g, '');
  if (!raw) throw new AppError('INVALID_AUTOSTART_PATH');
  return `"${raw}"`;
}

function buildAutostartCommand(options = {}) {
  const isPackaged = Boolean(options.isPackaged);
  const execPath = options.execPath || process.execPath;
  const appRoot = options.appRoot || DEFAULT_APP_ROOT;
  const flag = options.flag || AUTOSTART_FLAG;

  if (isPackaged) {
    return `${quoteWinArg(execPath)} ${flag}`;
  }
  return `${quoteWinArg(execPath)} ${quoteWinArg(appRoot)} ${flag}`;
}

function isAutostartLaunch(argv = process.argv) {
  return Array.isArray(argv) && argv.some((arg) => String(arg).trim() === AUTOSTART_FLAG);
}

function resolveAppWorkingDirectory(options = {}) {
  const isPackaged = Boolean(options.isPackaged);
  const execPath = options.execPath || process.execPath;
  const appRoot = options.appRoot || DEFAULT_APP_ROOT;

  if (isPackaged && execPath) {
    const exeDir = path.dirname(path.resolve(execPath));
    if (fs.existsSync(exeDir)) return exeDir;
  }
  return path.resolve(appRoot);
}

function ensureAppWorkingDirectory(options = {}) {
  const previousCwd = process.cwd();
  const targetDir = resolveAppWorkingDirectory(options);
  let changed = false;
  if (targetDir && fs.existsSync(targetDir) && path.resolve(previousCwd) !== path.resolve(targetDir)) {
    process.chdir(targetDir);
    changed = true;
  }
  return {
    previousCwd,
    cwd: process.cwd(),
    targetDir,
    changed,
  };
}

function defaultRegRunner(args) {
  return execFileSync('reg.exe', args, {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function parseRegQueryValue(output, valueName) {
  if (!output) return null;
  const escaped = String(valueName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^\\s*${escaped}\\s+REG_SZ\\s+(.+?)\\s*$`, 'im');
  const match = String(output).match(re);
  return match ? match[1].trim() : null;
}

function safePersistSetting(key, value) {
  try {
    settings.set(key, value);
  } catch (_err) {
    /* DB may not be open in standalone unit tests */
  }
}

function safeReadSetting(key, fallback = null) {
  try {
    const val = settings.get(key);
    return val === undefined || val === null ? fallback : val;
  } catch (_err) {
    return fallback;
  }
}

function getAutostartStatus(options = {}) {
  const platform = options.platform || process.platform;
  const appName = options.appName || APP_NAME;
  const runner = options.runner || defaultRegRunner;
  const expectedCommand = buildAutostartCommand(options);

  if (platform !== 'win32' && !options.runner) {
    const saved = safeReadSetting('autostart_enabled', '1');
    return {
      supported: false,
      platform,
      appName,
      keyPath: RUN_KEY_PATH,
      enabled: saved !== '0',
      command: saved !== '0' ? expectedCommand : null,
      expectedCommand,
    };
  }

  try {
    const stdout = runner(['query', RUN_KEY_PATH, '/v', appName]);
    const currentCommand = parseRegQueryValue(stdout, appName);
    return {
      supported: true,
      platform,
      appName,
      keyPath: RUN_KEY_PATH,
      enabled: Boolean(currentCommand),
      command: currentCommand,
      expectedCommand,
    };
  } catch (_err) {
    return {
      supported: true,
      platform,
      appName,
      keyPath: RUN_KEY_PATH,
      enabled: false,
      command: null,
      expectedCommand,
    };
  }
}

function enableAutostart(options = {}) {
  const platform = options.platform || process.platform;
  const appName = options.appName || APP_NAME;
  const runner = options.runner || defaultRegRunner;
  const command = buildAutostartCommand(options);

  if (platform === 'win32' || options.runner) {
    runner(['add', RUN_KEY_PATH, '/v', appName, '/t', 'REG_SZ', '/d', command, '/f']);
  }

  safePersistSetting('autostart_enabled', '1');
  safePersistSetting('autostart_initialized', '1');

  return {
    supported: platform === 'win32' || Boolean(options.runner),
    enabled: true,
    appName,
    keyPath: RUN_KEY_PATH,
    command,
  };
}

function disableAutostart(options = {}) {
  const platform = options.platform || process.platform;
  const appName = options.appName || APP_NAME;
  const runner = options.runner || defaultRegRunner;

  if (platform === 'win32' || options.runner) {
    const current = getAutostartStatus(options);
    if (current.enabled) {
      try {
        runner(['delete', RUN_KEY_PATH, '/v', appName, '/f']);
      } catch (_err) {
        /* ignore */
      }
    }
  }

  safePersistSetting('autostart_enabled', '0');
  safePersistSetting('autostart_initialized', '1');

  return {
    supported: platform === 'win32' || Boolean(options.runner),
    enabled: false,
    appName,
    keyPath: RUN_KEY_PATH,
    command: null,
  };
}

function setAutostartEnabled(enabled, options = {}) {
  return enabled ? enableAutostart(options) : disableAutostart(options);
}

function ensureDefaultAutostartOnFirstRun(options = {}) {
  const initialized = safeReadSetting('autostart_initialized', '0') === '1';
  const enabledSetting = safeReadSetting('autostart_enabled', '1') !== '0';

  if (!initialized) {
    try {
      return enableAutostart(options);
    } catch (err) {
      console.warn('[autostart] first-run registration warning:', err.message);
      return getAutostartStatus(options);
    }
  }

  if (enabledSetting) {
    try {
      return enableAutostart(options);
    } catch (err) {
      console.warn('[autostart] command refresh warning:', err.message);
    }
  }

  return getAutostartStatus(options);
}

module.exports = {
  RUN_KEY_PATH,
  AUTOSTART_FLAG,
  buildAutostartCommand,
  isAutostartLaunch,
  resolveAppWorkingDirectory,
  ensureAppWorkingDirectory,
  getAutostartStatus,
  getStatus: getAutostartStatus,
  enableAutostart,
  disableAutostart,
  setAutostartEnabled,
  setEnabled: setAutostartEnabled,
  ensureDefaultAutostartOnFirstRun,
  ensureDefaultInitialized: ensureDefaultAutostartOnFirstRun,
};
