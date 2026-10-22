'use strict';
/** Shared test helper: every test file gets a throwaway SQLite database. */

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const db = require('../src/main/db');

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
      for (const suffix of ['', '-wal', '-shm']) {
        try {
          fs.rmSync(`${file}${suffix}`, { force: true });
        } catch (error) {
          /* best effort */
        }
      }
    },
  };
}

/** Today's local date, the same way the services see it. */
function today() {
  return require('../src/main/utils/dates').toISODate();
}

module.exports = { useTempDb, today };
