'use strict';
/**
 * SQLite driver resolution.
 *
 * Medirdv Central prefers Node's built-in `node:sqlite` (zero dependencies,
 * used by the server, the tests and the Android/web deployments). In the
 * Windows desktop build, however, the server runs on **Electron's** embedded
 * Node, whose feature set can differ from the Node release of the same
 * version. Loading `node:sqlite` there can throw or be disabled.
 *
 * To keep the desktop app dependable, this module:
 *   1. tries `node:sqlite`;
 *   2. falls back to `better-sqlite3` (already the SQLite driver used by the
 *      existing Medirdv/Dentardv desktop applications) when the built-in API
 *      is unavailable;
 *   3. exposes a thin adapter so `db.js` speaks one API regardless of driver.
 *
 * The adapter normalises the small differences that matter here:
 *   - bind parameters: `node:sqlite` is strict about types/undefined
 *   - `.all()` / `.get()` / `.run()` result shapes
 *   - `exec()` for pragmas and transactions
 *
 * A CI job asserts the desktop runtime can actually open a database with the
 * resolved driver, so this is verified rather than assumed.
 */

let cached = null;

function normaliseParams(params) {
  return params.map((value) => {
    if (value === undefined) return null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (value instanceof Date) return value.toISOString();
    return value;
  });
}

/** Adapter over node:sqlite's DatabaseSync. */
function nodeSqliteDriver() {
  const { DatabaseSync } = require('node:sqlite');
  return {
    name: 'node:sqlite',
    open(filePath) {
      const database = new DatabaseSync(filePath);
      return {
        driver: 'node:sqlite',
        exec: (sql) => database.exec(sql),
        prepare(sql) {
          const statement = database.prepare(sql);
          return {
            run: (...params) => statement.run(...normaliseParams(params)),
            get: (...params) => statement.get(...normaliseParams(params)),
            all: (...params) => statement.all(...normaliseParams(params)),
          };
        },
        close: () => database.close(),
        raw: database,
      };
    },
  };
}

/** Adapter over better-sqlite3 (used by the Electron desktop build). */
function betterSqliteDriver() {
  // eslint-disable-next-line global-require
  const Database = require('better-sqlite3');
  return {
    name: 'better-sqlite3',
    open(filePath) {
      const database = new Database(filePath);
      return {
        driver: 'better-sqlite3',
        exec: (sql) => database.exec(sql),
        prepare(sql) {
          const statement = database.prepare(sql);
          return {
            run: (...params) => statement.run(...normaliseParams(params)),
            get: (...params) => statement.get(...normaliseParams(params)),
            all: (...params) => statement.all(...normaliseParams(params)),
          };
        },
        close: () => database.close(),
        raw: database,
      };
    },
  };
}

function tryDriver(factory) {
  try {
    const driver = factory();
    // Probe with a real in-memory database: merely requiring the module is
    // not enough (Electron can expose the module and still fail to open).
    const probe = driver.open(':memory:');
    probe.exec('CREATE TABLE __probe (id INTEGER PRIMARY KEY, name TEXT)');
    probe.exec("INSERT INTO __probe (name) VALUES ('ok')");
    const row = probe.prepare('SELECT name FROM __probe').get();
    probe.close();
    if (!row || row.name !== 'ok') throw new Error('probe query returned no row');
    return driver;
  } catch (error) {
    return { error };
  }
}

/**
 * Resolve a working SQLite driver.
 * @param {string} [preferred] 'node:sqlite' | 'better-sqlite3'
 * @returns {{name: string, open: Function}}
 */
function resolveDriver(preferred) {
  if (cached && (!preferred || cached.name === preferred)) return cached;

  const order = [];
  const force = preferred || process.env.MEDIRDV_SQLITE_DRIVER;
  if (force === 'better-sqlite3') order.push(['better-sqlite3', betterSqliteDriver]);
  else if (force === 'node:sqlite') order.push(['node:sqlite', nodeSqliteDriver]);
  else order.push(['node:sqlite', nodeSqliteDriver], ['better-sqlite3', betterSqliteDriver]);

  const failures = [];
  for (const [name, factory] of order) {
    const result = tryDriver(factory);
    if (!result.error) {
      cached = result;
      return result;
    }
    failures.push(`${name}: ${result.error.message}`);
  }

  const error = new Error(
    'No usable SQLite driver found. Tried: ' + failures.join(' | ') +
      '. Install better-sqlite3 (desktop) or run Node 22+ with node:sqlite.'
  );
  error.code = 'NO_SQLITE_DRIVER';
  throw error;
}

function driverName() {
  return cached ? cached.name : null;
}

/** Test hook. */
function resetDriverCache() {
  cached = null;
}

module.exports = { resolveDriver, driverName, resetDriverCache };
