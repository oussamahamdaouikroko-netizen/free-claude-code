'use strict';
/**
 * Shared test helpers: throwaway databases, data folders and Windows-safe
 * cleanup (SQLite keeps the .sqlite/-wal/-shm files locked on Windows until the
 * connection is closed, so deleting a folder needs retries).
 */

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const db = require('../src/main/db');

function safeRemove(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch (error) {
    console.warn(`[test] could not remove ${target}: ${error.code || error.message}`);
  }
}

/**
 * Open a fresh database in the OS temp folder.
 * @param {{ seed?: boolean }} [options]
 */
function useTempDb(options = {}) {
  db.closeAndReset();
  const file = path.join(
    os.tmpdir(),
    `pharmagestion-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
  db.open(file, { seed: options.seed !== false });
  return {
    file,
    cleanup() {
      try {
        db.close();
      } catch (error) {
        /* already closed */
      }
      for (const suffix of ['', '-wal', '-shm']) safeRemove(`${file}${suffix}`);
    },
  };
}

/** A temporary data folder shaped like the real one (data/ + backups/). */
function useTempDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pharmagestion-data-'));
  return {
    dir,
    backupsDir: path.join(dir, 'backups'),
    cleanup() {
      try {
        db.close();
      } catch (error) {
        /* already closed */
      }
      safeRemove(dir);
    },
  };
}

function today() {
  return require('../src/main/utils/dates').todayISO();
}

module.exports = { useTempDb, useTempDataDir, today, safeRemove };
