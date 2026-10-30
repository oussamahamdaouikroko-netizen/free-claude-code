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
const { normalizeSearch } = require('../utils/common');

let db = null;
let dbPath = null;

/** Backfill `name_normalized` & `folded_search` on existing upgraded DB rows. */
function backfillNormalizedMedications(conn) {
  const needsBackfill = conn
    .prepare("SELECT 1 FROM medications WHERE name_normalized = '' LIMIT 1")
    .get();
  if (!needsBackfill) return 0;

  const rows = conn
    .prepare(
      `SELECT id, brand, dci, strength, form, laboratory, registration_number, specialty, keywords_ar
       FROM medications
       WHERE name_normalized = ''`,
    )
    .all();
  if (rows.length === 0) return 0;

  const updateStmt = conn.prepare(
    'UPDATE medications SET name_normalized = ?, folded_search = ? WHERE id = ?',
  );
  const tx = conn.transaction(() => {
    conn.exec('DROP TRIGGER IF EXISTS trg_medications_au;');
    for (const r of rows) {
      const nameNorm = normalizeSearch(r.brand);
      const folded = normalizeSearch(
        `${r.brand} ${r.dci} ${r.strength} ${r.form} ${r.laboratory} ${r.registration_number} ${r.specialty} ${r.keywords_ar}`,
      );
      updateStmt.run(nameNorm, folded, r.id);
    }
    conn.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_medications_au AFTER UPDATE ON medications BEGIN
        INSERT INTO medications_fts(medications_fts, rowid, brand, dci, strength, form, laboratory, keywords_ar, folded_search)
        VALUES ('delete', old.id, old.brand, old.dci, old.strength, old.form, old.laboratory, old.keywords_ar, old.folded_search);
        INSERT INTO medications_fts(rowid, brand, dci, strength, form, laboratory, keywords_ar, folded_search)
        VALUES (new.id, new.brand, new.dci, new.strength, new.form, new.laboratory, new.keywords_ar, new.folded_search);
      END;
      INSERT INTO medications_fts(medications_fts) VALUES('rebuild');
    `);
  });
  tx();
  return rows.length;
}

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
  backfillNormalizedMedications(db);
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
  backfillNormalizedMedications,
  defaultDataDir,
  SCHEMA_VERSION,
};
