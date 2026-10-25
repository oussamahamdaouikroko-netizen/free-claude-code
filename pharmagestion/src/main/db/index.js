'use strict';
/**
 * Database access layer.
 *
 * One SQLite connection is shared by every service. better-sqlite3 is
 * synchronous, and every IPC handler runs on the main process, so no locking
 * games are needed — but every multi-step stock change must still run inside
 * `db.transaction(...)` (see later phases) so a power cut cannot leave a
 * half-written movement.
 *
 * Responsibilities:
 *  - open the file with safe pragmas (WAL, foreign keys, FULL sync);
 *  - take an automatic backup *before* an upgrade migrates the data;
 *  - apply migrations;
 *  - expose consistent backup / integrity-check helpers.
 */

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { migrate, SCHEMA_VERSION, MIGRATIONS, currentVersion } = require('./schema');
const { seedDefaults } = require('./seed');
const { AppError } = require('../utils/common');

let db = null;
let dbPath = null;

/** Default data folder: inside Electron's userData, never the install folder. */
function defaultDataDir(userDataDir) {
  return path.join(userDataDir, 'data');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function stamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}-` +
    `${String(date.getMilliseconds()).padStart(3, '0')}`
  );
}

/**
 * Open (or create) the database and bring it up to date.
 *
 * @param {string} filePath absolute path of the .sqlite file
 * @param {{
 *   seed?: boolean,
 *   backupDir?: string|null,
 *   onUpgrade?: (info: {from: number, to: number, file: string|null}) => void
 * }} [options] `backupDir`: where to store the copy taken before an upgrade
 */
function open(filePath, options = {}) {
  const { seed = true, backupDir = null, onUpgrade = null } = options;
  ensureDir(path.dirname(filePath));

  const existed = fs.existsSync(filePath) && fs.statSync(filePath).size > 0;
  db = new Database(filePath);
  dbPath = filePath;

  // WAL keeps reads fast while a write is in progress; FULL sync makes a power
  // cut far less likely to corrupt the file, which matters more than speed in
  // a pharmacy where the till is closed at night, not the computer.
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  const from = currentVersion(db);
  let upgradeBackup = null;

  if (existed && from > 0 && from < SCHEMA_VERSION && backupDir) {
    // Safety net required by the "backup before a major update" rule: copy the
    // current data before any migration touches it.
    upgradeBackup = path.join(ensureDir(backupDir), `pre-update-v${from}-${stamp()}.sqlite`);
    try {
      backupTo(upgradeBackup);
    } catch (error) {
      db.close();
      db = null;
      throw new AppError('BACKUP_BEFORE_UPGRADE_FAILED', error.message);
    }
  }

  try {
    const result = migrate(db);
    if (seed) seedDefaults(db);
    if (onUpgrade && result.applied.length) {
      onUpgrade({ from: result.from, to: result.to, file: upgradeBackup });
    }
  } catch (error) {
    // Never leave a half-opened connection behind.
    try {
      db.close();
    } catch (closeError) {
      /* already closed */
    }
    db = null;
    throw error;
  }

  return db;
}

function getDb() {
  if (!db) throw new AppError('DATABASE_NOT_OPEN');
  return db;
}

function getPath() {
  return dbPath;
}

function isOpen() {
  return Boolean(db && db.open);
}

function close() {
  if (db && db.open) db.close();
  db = null;
}

/** Close + reopen the same file (after a restore, for instance). */
function reopen(options = {}) {
  const file = dbPath;
  if (!file) throw new AppError('DATABASE_NOT_OPEN');
  close();
  return open(file, options);
}

/** Tests only: forget the current connection entirely. */
function closeAndReset() {
  close();
  dbPath = null;
}

/**
 * Consistent snapshot copy of the live database.
 * `VACUUM INTO` is safe while the app is running and produces a defragmented,
 * immediately usable database file.
 */
function backupTo(destination) {
  const source = getDb();
  ensureDir(path.dirname(destination));
  if (fs.existsSync(destination)) fs.rmSync(destination, { force: true });
  source.prepare('VACUUM INTO ?').run(destination);
  return destination;
}

/**
 * Check that any SQLite file is readable and internally consistent.
 * @returns {{ok: boolean, error?: string, schemaVersion?: number, tooNew?: boolean}}
 */
function checkIntegrity(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return { ok: false, error: 'FILE_NOT_FOUND' };
  let probe = null;
  try {
    probe = new Database(filePath, { readonly: true, fileMustExist: true });
    const rows = probe.pragma('integrity_check');
    const message = Array.isArray(rows) && rows.length ? String(rows[0].integrity_check) : 'unknown';
    if (message.toLowerCase() !== 'ok') return { ok: false, error: message };
    const version = Number(probe.pragma('user_version', { simple: true })) || 0;
    return { ok: true, schemaVersion: version, tooNew: version > SCHEMA_VERSION };
  } catch (error) {
    return { ok: false, error: error.message };
  } finally {
    if (probe && probe.open) probe.close();
  }
}

/** Quick health check of the *open* database (used by Settings). */
function quickCheck() {
  const rows = getDb().pragma('quick_check');
  const message = Array.isArray(rows) && rows.length ? String(rows[0].quick_check) : 'unknown';
  return { ok: message.toLowerCase() === 'ok', message };
}

/** Facts shown on the dashboard / settings screen. */
function stats() {
  const database = getDb();
  const tables = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => row.name);

  let sizeBytes = 0;
  try {
    sizeBytes = fs.statSync(dbPath).size;
  } catch (error) {
    sizeBytes = 0;
  }

  return {
    file: dbPath,
    sizeBytes,
    schemaVersion: currentVersion(database),
    latestSchemaVersion: SCHEMA_VERSION,
    tables,
    journalMode: String(database.pragma('journal_mode', { simple: true })),
    foreignKeys: Number(database.pragma('foreign_keys', { simple: true })) === 1,
  };
}

module.exports = {
  open,
  getDb,
  getPath,
  isOpen,
  close,
  closeAndReset,
  reopen,
  backupTo,
  checkIntegrity,
  quickCheck,
  stats,
  defaultDataDir,
  SCHEMA_VERSION,
  MIGRATIONS,
};
