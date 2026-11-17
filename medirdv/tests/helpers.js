'use strict';
/**
 * Shared test helpers: throwaway databases and Windows-safe cleanup.
 *
 * On Windows, SQLite keeps the .sqlite/-wal/-shm files locked until the
 * connection is closed, so deleting a data folder needs retries.
 */

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const db = require('../src/main/db');

function safeRemove(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch (error) {
    // A leftover temp folder must never turn a green run red.
    console.warn(`[test] could not remove ${target}: ${error.code || error.message}`);
  }
}

function useTempDb() {
  db.closeAndReset();
  const file = path.join(
    os.tmpdir(),
    `dentardv-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
  db.open(file);
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

/** Today's local date, the same way the services see it. */
function today() {
  return require('../src/main/utils/dates').toISODate();
}

module.exports = { useTempDb, today, safeRemove };
