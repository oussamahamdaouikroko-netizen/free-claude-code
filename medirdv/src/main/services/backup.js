'use strict';
/**
 * Backup + restore.
 *
 *  - One automatic snapshot per day, stored in <data>/backups.
 *  - Old snapshots are pruned (default: keep the last 30).
 *  - Restore verifies the SQLite file first, keeps a safety copy of the
 *    current database, then swaps the file and reopens the connection.
 */

const fs = require('node:fs');
const path = require('node:path');
const db = require('../db');
const settings = require('./settings');
const { AppError, nowLocal } = require('../utils/common');
const { toISODate } = require('../utils/dates');

let dataDir = '';
let timer = null;
let onRestored = null;

function init(directory, { restored } = {}) {
  dataDir = directory;
  onRestored = typeof restored === 'function' ? restored : null;
}

function backupsDir() {
  if (!dataDir) throw new AppError('BACKUP_NOT_READY');
  return path.join(dataDir, 'backups');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function stamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/**
 * Create a backup now.
 * @param {{reason?: 'auto'|'manual'}} [options]
 * @returns {{file: string, size: number, created_at: string}}
 */
function create(options = {}) {
  const dir = ensureDir(backupsDir());
  const file = path.join(dir, `medirdv-${stamp()}.sqlite`);
  db.backupTo(file);
  const stat = fs.statSync(file);
  settings.set('last_backup_at', nowLocal());
  prune();
  return {
    file,
    name: path.basename(file),
    size: stat.size,
    created_at: nowLocal(),
    reason: options.reason === 'manual' ? 'manual' : 'auto',
  };
}

/** Delete oldest snapshots above the configured limit. */
function prune() {
  const keep = Math.max(1, settings.getInt('backup_keep'));
  const files = list();
  for (const entry of files.slice(keep)) {
    try {
      fs.rmSync(entry.path, { force: true });
    } catch (error) {
      console.error('[backup] cannot remove old snapshot', entry.name, error.message);
    }
  }
}

/** @returns {Array<{path,name,size,created_at}>} newest first */
function list() {
  const dir = backupsDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.sqlite'))
    .map((name) => {
      const file = path.join(dir, name);
      const stat = fs.statSync(file);
      return {
        name,
        path: file,
        size: stat.size,
        created_at: new Date(stat.mtimeMs).toISOString(),
      };
    })
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

/** Is the daily snapshot due? */
function isDue() {
  if (!settings.getBool('backup_enabled')) return false;
  if (!db.isOpen()) return false;
  const last = settings.get('last_backup_at');
  return !last || last.slice(0, 10) < toISODate();
}

/** Called at startup and every hour: creates at most one backup per day. */
function maybeAutoBackup() {
  try {
    if (!isDue()) return null;
    const result = create({ reason: 'auto' });
    console.log('[backup] daily backup created:', result.name);
    return result;
  } catch (error) {
    console.error('[backup] automatic backup failed:', error.message);
    return null;
  }
}

/**
 * Restore a backup file.
 * @param {string} sourceFile
 * @param {'restore'|'import'} [mode] `import` keeps the source file intact
 */
function restore(sourceFile, mode = 'restore') {
  if (!sourceFile || !fs.existsSync(sourceFile)) throw new AppError('BACKUP_NOT_FOUND');
  const integrity = db.checkIntegrity(sourceFile);
  if (!integrity.ok) throw new AppError('BACKUP_CORRUPT', integrity.error);

  const target = db.getPath();
  if (!target) throw new AppError('DATABASE_NOT_OPEN');

  // Safety net: never lose the current database, even on a wrong click.
  const safetyDir = ensureDir(path.join(dataDir, 'backups'));
  const safetyFile = path.join(safetyDir, `before-restore-${stamp()}.sqlite`);
  if (mode === 'restore') db.backupTo(safetyFile);

  db.close();
  try {
    // WAL/SHM side files must go, otherwise SQLite might replay stale pages.
    for (const suffix of ['-wal', '-shm']) {
      const side = `${target}${suffix}`;
      if (fs.existsSync(side)) fs.rmSync(side, { force: true });
    }
    fs.copyFileSync(sourceFile, target);
    db.open(target);
    if (onRestored) onRestored();
    return { ok: true, safety_file: safetyFile, schema_version: integrity.schemaVersion };
  } catch (error) {
    // Try to reopen the previous database so the app stays usable.
    try {
      if (!db.isOpen()) db.open(target);
    } catch (reopenError) {
      console.error('[backup] cannot reopen database', reopenError.message);
    }
    throw new AppError('RESTORE_FAILED', error.message);
  }
}

/** Start the hourly check that triggers the daily snapshot. */
function startScheduler(intervalMs = 60 * 60 * 1000) {
  stopScheduler();
  maybeAutoBackup();
  timer = setInterval(maybeAutoBackup, intervalMs);
  if (timer.unref) timer.unref();
}

function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  init,
  create,
  list,
  prune,
  isDue,
  maybeAutoBackup,
  restore,
  backupTo: (file) => db.backupTo(file),
  startScheduler,
  stopScheduler,
  backupsDir,
};
