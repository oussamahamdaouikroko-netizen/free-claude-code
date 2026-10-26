'use strict';
/**
 * Shared test helpers: throwaway databases and Windows-safe cleanup.
 */

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const db = require('../src/main/db');
const license = require('../src/main/services/license');

function safeRemove(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch (error) {
    console.warn(`[test] could not remove ${target}: ${error.code || error.message}`);
  }
}

function useTempDb() {
  db.closeAndReset();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dentardv-test-${process.pid}-`));
  const file = path.join(dir, 'dentardv.sqlite');
  db.open(file);
  license.init({ dataDir: dir, demo: true });
  return {
    file,
    dir,
    cleanup() {
      license.stopPeriodicCheck();
      try {
        db.close();
      } catch (_error) {
        /* already closed */
      }
      safeRemove(dir);
    },
  };
}

/** Today's local date, the same way the services see it. */
function today() {
  return require('../src/main/utils/dates').toISODate();
}

module.exports = { useTempDb, today, safeRemove };
