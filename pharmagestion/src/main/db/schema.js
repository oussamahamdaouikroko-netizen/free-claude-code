'use strict';
/**
 * SQLite schema + migrations for PharmaGestion DZ.
 *
 * How migrations work (deliberately simple, safe for a beginner maintainer):
 *   - `MIGRATIONS` is an ordered, append-only list. **Never edit an existing
 *     entry once it has shipped** — a pharmacy database in the field already
 *     contains it. Add a new entry instead.
 *   - Each entry runs in its own transaction; if one statement fails, nothing
 *     of that migration is kept and the app refuses to continue with a clear
 *     error, instead of running on a half-built database.
 *   - SQLite's own `PRAGMA user_version` remembers the last applied migration.
 *   - A database created by a *newer* version of the app is refused rather
 *     than corrupted.
 *
 * Phase 1 creates the foundation only: key/value settings and an append-only
 * audit log. Stock, batches, purchases, sales, debts and imports arrive in
 * later phases as new migrations (2, 3, …) so that an existing pharmacy
 * database is upgraded in place, never recreated.
 */

const SCHEMA_VERSION = 1;

const MIGRATION_1 = `
-- Key/value application settings (language, pharmacy identity, backup policy,
-- expiry thresholds…). Values are TEXT: numbers/booleans are validated in
-- src/main/services/settings.js, never here.
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Append-only audit log. Every sensitive action (restore, manual adjustment,
-- negative stock override…) is written here. It must never contain customer
-- names, phone numbers or other personal data: use internal IDs instead.
CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         TEXT NOT NULL DEFAULT (datetime('now')),
  action     TEXT NOT NULL,
  entity     TEXT,
  entity_id  INTEGER,
  severity   TEXT NOT NULL DEFAULT 'info'
             CHECK (severity IN ('info', 'warning', 'critical')),
  details    TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_at     ON audit_log(at);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action);
`;

/** Ordered, append-only list of migrations. */
const MIGRATIONS = [
  { version: 1, name: 'core_settings_and_audit', up: MIGRATION_1 },
];

const { AppError } = require('../utils/common');

/** Read the schema version recorded inside a database. */
function currentVersion(db) {
  return Number(db.pragma('user_version', { simple: true })) || 0;
}

/** Name of the next migration to apply, or null when up to date. */
function nextMigration(db, migrations = MIGRATIONS) {
  const version = currentVersion(db);
  return migrations.find((entry) => entry.version > version) || null;
}

/**
 * Apply every pending migration.
 * @param {import('better-sqlite3').Database} db
 * @param {{ migrations?: Array<{version:number,name:string,up:string}> }} [options]
 * @returns {{ from: number, to: number, applied: string[] }}
 */
function migrate(db, options = {}) {
  const migrations = options.migrations || MIGRATIONS;
  const from = currentVersion(db);
  const target = migrations.reduce((max, entry) => Math.max(max, entry.version), 0);

  if (from > target) {
    throw new AppError(
      'SCHEMA_TOO_NEW',
      `This database uses schema v${from} but this application only knows v${target}. ` +
        'Please install the newer version of PharmaGestion DZ instead of opening it here.',
    );
  }

  const applied = [];
  for (const entry of migrations) {
    if (entry.version <= from) continue;
    if (!Number.isInteger(entry.version) || entry.version <= 0) {
      throw new AppError('MIGRATION_INVALID', `Invalid migration version: ${entry.version}`);
    }
    // `BEGIN IMMEDIATE` takes the write lock right away: two copies of the app
    // can never migrate the same file at the same time.
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(entry.up);
      db.pragma(`user_version = ${entry.version}`);
      db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch (rollbackError) {
        // The transaction was already aborted by SQLite.
      }
      throw new AppError(
        'MIGRATION_FAILED',
        `Migration ${entry.version} (${entry.name}) failed: ${error.message}`,
        { version: entry.version, name: entry.name },
      );
    }
    applied.push(entry.name);
  }

  return { from, to: currentVersion(db), applied };
}

module.exports = { SCHEMA_VERSION, MIGRATIONS, MIGRATION_1, currentVersion, nextMigration, migrate };
