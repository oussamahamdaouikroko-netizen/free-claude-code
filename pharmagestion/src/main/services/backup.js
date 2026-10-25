'use strict';
/**
 * Backup + restore.
 *
 *  - one automatic snapshot per day (configurable, can be turned off);
 *  - manual backup at any time, also used before a restore;
 *  - restore verifies the file first, keeps a safety copy of the *current*
 *    database, swaps the file and reopens it (migrating if it is older);
 *  - old snapshots are pruned so a shop PC's disk never fills up.
 *
 * The database file lives in the user-data folder (`%APPDATA%\PharmaGestion
 * DZ\data`), never in the installation folder, so an uninstall or an update
 * cannot delete the pharmacy's history.
 */

const fs = require('node:fs');
const path = require('node:path');
const db = require('../db');
const settings = require('./settings');
const audit = require('./audit');
const { AppError, nowLocal } = require('../utils/common');
const { todayISO } = require('../utils/dates');

const KEEP_SAFETY_COPIES = 5;

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

/** `20261025-143012-345`: sorts chronologically and never collides. */
function stamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}-` +
    `${String(date.getMilliseconds()).padStart(3, '0')}`
  );
}

/** Which kind of snapshot a file name represents. */
function kindOf(name) {
  if (name.startsWith('pharmagestion-auto-')) return 'auto';
  if (name.startsWith('pharmagestion-manual-')) return 'manual';
  if (name.startsWith('pre-update-')) return 'pre-update';
  if (name.startsWith('before-restore-')) return 'before-restore';
  return 'external';
}

/**
 * Create a snapshot now.
 * @param {{kind?: 'auto'|'manual'}} [options]
 */
function create(options = {}) {
  const kind = options.kind === 'manual' ? 'manual' : 'auto';
  const dir = ensureDir(backupsDir());
  const file = path.join(dir, `pharmagestion-${kind}-${stamp()}.sqlite`);
  db.backupTo(file);
  const stat = fs.statSync(file);
  settings.set('last_backup_at', nowLocal());
  prune();
  if (kind === 'manual') {
    audit.log('backup.create', { entity: 'backup', details: path.basename(file) });
  }
  return {
    file,
    name: path.basename(file),
    kind,
    size: stat.size,
    created_at: nowLocal(),
  };
}

/** All snapshots, newest first. */
function list() {
  let dir;
  try {
    dir = backupsDir();
  } catch (error) {
    return [];
  }
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.sqlite'))
    .map((name) => {
      const file = path.join(dir, name);
      let stat;
      try {
        stat = fs.statSync(file);
      } catch (error) {
        return null;
      }
      return {
        name,
        path: file,
        kind: kindOf(name),
        size: stat.size,
        created_at: new Date(stat.mtimeMs).toISOString(),
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.name.localeCompare(a.name));
}

function remove(file) {
  try {
    fs.rmSync(file, { force: true });
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Delete old snapshots: `backup_keep` for daily/manual ones, and at most
 * `KEEP_SAFETY_COPIES` of each safety kind (pre-update / before-restore).
 */
function prune() {
  const keep = Math.max(1, settings.getInt('backup_keep'));
  const files = list();
  const daily = files.filter((entry) => entry.kind === 'auto' || entry.kind === 'manual');
  const safety = files.filter((entry) => entry.kind === 'pre-update' || entry.kind === 'before-restore');

  for (const entry of daily.slice(keep)) remove(entry.path);

  for (const kind of ['pre-update', 'before-restore']) {
    const group = safety.filter((entry) => entry.kind === kind);
    for (const entry of group.slice(KEEP_SAFETY_COPIES)) remove(entry.path);
  }
}

/** Is today's automatic snapshot still missing? */
function isDue() {
  if (!settings.getBool('backup_enabled')) return false;
  if (!db.isOpen()) return false;
  const last = settings.getRaw('last_backup_at');
  return !last || last.slice(0, 10) < todayISO();
}

/** Called at startup and hourly: creates at most one automatic backup per day. */
function maybeAutoBackup() {
  try {
    if (!isDue()) return null;
    const result = create({ kind: 'auto' });
    console.log('[backup] daily backup created:', result.name);
    return result;
  } catch (error) {
    console.error('[backup] automatic backup failed:', error.message);
    return null;
  }
}

/**
 * Restore a snapshot.
 * @param {string} sourceFile
 */
function restore(sourceFile) {
  if (!sourceFile || !fs.existsSync(sourceFile)) throw new AppError('BACKUP_NOT_FOUND');

  const integrity = db.checkIntegrity(sourceFile);
  if (!integrity.ok) {
    throw new AppError('BACKUP_CORRUPT', `Backup file is not readable: ${integrity.error}`);
  }
  if (integrity.tooNew) {
    throw new AppError(
      'BACKUP_TOO_NEW',
      'This backup was created by a newer version of PharmaGestion DZ. Install that version first.',
    );
  }

  const target = db.getPath();
  if (!target) throw new AppError('DATABASE_NOT_OPEN');

  // Safety net: a wrong click must never lose today's data.
  const safetyFile = path.join(ensureDir(backupsDir()), `before-restore-${stamp()}.sqlite`);
  db.backupTo(safetyFile);

  db.close();
  try {
    // WAL/SHM side files belong to the old database; leaving them would let
    // SQLite replay stale pages over the restored file.
    for (const suffix of ['-wal', '-shm']) {
      const side = `${target}${suffix}`;
      if (fs.existsSync(side)) fs.rmSync(side, { force: true });
    }
    fs.copyFileSync(sourceFile, target);
    db.open(target, { backupDir: backupsDir() });
    audit.log('backup.restore', {
      entity: 'backup',
      severity: 'critical',
      details: `${path.basename(sourceFile)} (safety copy: ${path.basename(safetyFile)})`,
    });
    if (onRestored) onRestored();
    return {
      ok: true,
      restoredFrom: path.basename(sourceFile),
      safetyFile,
      schemaVersion: integrity.schemaVersion,
    };
  } catch (error) {
    try {
      if (!db.isOpen()) db.open(target);
    } catch (reopenError) {
      console.error('[backup] cannot reopen database after a failed restore', reopenError.message);
    }
    throw new AppError('RESTORE_FAILED', error.message);
  }
}

/** Copy the live database to a user-chosen destination (save dialog). */
function exportCopy(destination) {
  if (!destination) throw new AppError('BACKUP_DESTINATION_REQUIRED');
  const file = db.backupTo(destination);
  audit.log('backup.export', { entity: 'backup', details: path.basename(destination) });
  return { file, size: fs.statSync(file).size };
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
  remove,
  isDue,
  maybeAutoBackup,
  restore,
  exportCopy,
  startScheduler,
  stopScheduler,
  backupsDir,
  kindOf,
};
