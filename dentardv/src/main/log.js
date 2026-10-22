'use strict';
/**
 * File logger for the main process.
 *
 * A packaged Windows app has no console: anything written with console.log()
 * disappears, which makes a support call ("it doesn't open") impossible to
 * diagnose. This module mirrors console output into `<dataDir>/dentardv.log`
 * and rotates the file once it grows past 1 MB, so the clinic can send one
 * small file instead of screenshots.
 *
 * Everything here is best effort: a failing log must never break the app.
 */

const fs = require('node:fs');
const path = require('node:path');

const MAX_BYTES = 1024 * 1024; // 1 MB, about a year of normal use
const MAX_KEPT = 2; // dentardv.log.1, dentardv.log.2

let logFile = null;
let stream = null;
let installed = null; // { level: original console method }

/** ISO timestamp without milliseconds — plenty for support. */
function stamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

/** Turn console arguments (objects, errors, arrays) into one readable line. */
function format(args) {
  return args
    .map((value) => {
      if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`;
      if (typeof value === 'string') return value;
      if (value === undefined) return 'undefined';
      try {
        return JSON.stringify(value);
      } catch (error) {
        return String(value);
      }
    })
    .join(' ');
}

function rotateIfNeeded(file) {
  try {
    if (!fs.existsSync(file)) return;
    if (fs.statSync(file).size < MAX_BYTES) return;
    for (let index = MAX_KEPT; index >= 1; index -= 1) {
      const from = index === 1 ? file : `${file}.${index - 1}`;
      const to = `${file}.${index}`;
      if (fs.existsSync(from)) fs.renameSync(from, to);
    }
  } catch (error) {
    /* rotation is optional */
  }
}

/** Start logging to `file`. Returns false when the folder is not writable. */
function init(file) {
  close();
  logFile = path.resolve(file);
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    rotateIfNeeded(logFile);
    stream = fs.createWriteStream(logFile, { flags: 'a' });
    stream.on('error', () => {
      stream = null; // disk full / read-only: silently stop writing
    });
  } catch (error) {
    stream = null;
    return false;
  }
  return true;
}

function write(level, args) {
  if (!stream) return;
  try {
    stream.write(`${stamp()} ${level.toUpperCase()} ${format(args)}\n`);
  } catch (error) {
    /* never throw from logging */
  }
}

/**
 * Mirror console.log/warn/error into the file while keeping the terminal
 * output (useful with `npm start` and in CI).
 */
function attachConsole() {
  if (installed) return;
  installed = {};
  for (const level of ['log', 'info', 'warn', 'error']) {
    installed[level] = console[level];
    const original = console[level].bind(console);
    console[level] = (...args) => {
      original(...args);
      write(level === 'log' || level === 'info' ? 'info' : level, args);
    };
  }
}

/** Restore the real console (used by tests and on shutdown). */
function detachConsole() {
  if (!installed) return;
  for (const [level, original] of Object.entries(installed)) console[level] = original;
  installed = null;
}

function close() {
  if (stream) {
    try {
      stream.end();
    } catch (error) {
      /* ignore */
    }
  }
  stream = null;
}

function currentFile() {
  return logFile;
}

module.exports = { init, attachConsole, detachConsole, write, close, currentFile, MAX_BYTES };
