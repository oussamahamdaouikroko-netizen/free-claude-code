'use strict';
/**
 * Database access layer.
 *
 * Responsible for: opening the SQLite file, applying migrations, creating
 * consistent backups (online backup API, safe while the app is running),
 * restoring a backup and exposing the live connection to the services.
 *
 * A single connection is shared by every service; better-sqlite3 is
 * synchronous and single-threaded, which is exactly what an Electron app
 * needs (all IPC handlers run on the main process).
 */

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { migrate, SCHEMA_VERSION } = require('./schema');
const { seedDefaults } = require('./seed');

let db = null;
let dbPath = null;

/** Directory holding the SQLite file and its `backups/` folder. */
function defaultDataDir(userDataDir) {
  // Keep the data next to the user profile, not inside the install folder:
  // a Windows upgrade must never wipe clinic data.
  return path.join(userDataDir, 'data');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * Open (or create) the database.
 * @param {string} filePath absolute path to the .sqlite file
 * @param {{ seed?: boolean }} [options]
 */
function open(filePath, options = {}) {
  const { seed = true } = options;
  ensureDir(path.dirname(filePath));
  db = new Database(filePath);
  dbPath = filePath;

  // WAL keeps the UI responsive while WhatsApp writes messages, and
  // `full` sync makes a power cut far less likely to corrupt the file.
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  migrate(db);
  if (seed) seedDefaults(db);
  return db;
}

function getDb() {
  if (!db) throw new Error('Database is not open');
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

/**
 * Close + reopen, used after a restore.
 */
function reopen(options = {}) {
  const file = dbPath;
  close();
  return open(file, options);
}

/** Only used by tests: wipe an in-memory database cleanly. */
function closeAndReset() {
  close();
  dbPath = null;
}

/**
 * Create a consistent snapshot copy of the database.
 * `VACUUM INTO` is synchronous, safe while the app is running and produces a
 * defragmented file that can be restored directly by copying it back.
 * @param {string} destination file path
 * @returns {string} destination
 */
function backupTo(destination) {
  const source = getDb();
  ensureDir(path.dirname(destination));
  if (fs.existsSync(destination)) fs.rmSync(destination, { force: true });
  source.prepare('VACUUM INTO ?').run(destination);
  return destination;
}

/**
 * Verify that a SQLite file is readable and not corrupt.
 * @param {string} filePath
 * @returns {{ ok: boolean, error?: string, schemaVersion?: number }}
 */
function checkIntegrity(filePath) {
  let probe;
  try {
    probe = new Database(filePath, { readonly: true, fileMustExist: true });
    const rows = probe.pragma('integrity_check');
    const message = Array.isArray(rows) && rows.length ? String(rows[0].integrity_check) : 'unknown';
    if (message.toLowerCase() !== 'ok') return { ok: false, error: message };
    const version = probe.pragma('user_version', { simple: true });
    return { ok: true, schemaVersion: version };
  } catch (error) {
    return { ok: false, error: error.message };
  } finally {
    if (probe && probe.open) probe.close();
  }
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
  defaultDataDir,
  SCHEMA_VERSION,
};
