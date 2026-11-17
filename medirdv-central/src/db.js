'use strict';
/**
 * Database access layer (node:sqlite, synchronous — same single-threaded
 * model as the desktop apps' better-sqlite3 layer).
 *
 * WAL + foreign keys + busy timeout. One connection per process.
 */
const fs = require('node:fs');
const path = require('node:path');
const { resolveDriver } = require('./sqlite');
const { migrate } = require('./schema');

let db = null;
let dbPath = null;

function resolveDbPath() {
  const raw = process.env.MEDIRDV_DB_PATH || './data/medirdv-central.sqlite';
  return path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
}

function open(filePath) {
  const target = filePath || resolveDbPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // Driver is resolved (and probed) once; node:sqlite on the server, with a
  // better-sqlite3 fallback for the Electron desktop build.
  const driver = resolveDriver();
  db = driver.open(target);
  dbPath = target;
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = FULL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  migrate(db);
  return db;
}

function getDb() {
  if (!db) throw new Error('Database is not open');
  return db;
}

function getPath() {
  return dbPath;
}

function close() {
  if (db) db.close();
  db = null;
}

let txDepth = 0;

/** Run `fn` inside an IMMEDIATE transaction (double-booking / payment guards).
 *  Reentrant: nested calls join the outer transaction (SQLite has no savepoints
 *  here), so services may call each other inside one transaction. */
function withTransaction(fn) {
  const connection = getDb();
  if (txDepth > 0) return fn(connection);
  connection.exec('BEGIN IMMEDIATE');
  txDepth += 1;
  try {
    const result = fn(connection);
    connection.exec('COMMIT');
    return result;
  } catch (error) {
    connection.exec('ROLLBACK');
    throw error;
  } finally {
    txDepth -= 1;
  }
}

function utcNow() {
  return new Date().toISOString();
}

/** Which SQLite driver is in use (diagnostics / health endpoint). */
function getDriver() {
  return db && db.driver ? db.driver : null;
}

module.exports = { open, getDb, getPath, close, withTransaction, utcNow, resolveDbPath, getDriver };
