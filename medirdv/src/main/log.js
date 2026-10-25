'use strict';
/**
 * File logger for the main process.
 *
 * A packaged Windows app has no console: anything written with console.log()
 * disappears, which makes a support call ("it doesn't open") impossible to
 * diagnose. This module mirrors console output into `<dataDir>/medirdv.log`
 * and rotates the file once it grows past 1 MB, so the clinic can send one
 * small file instead of screenshots.
 *
 * Everything here is best effort: a failing log must never break the app.
 */

const fs = require('node:fs');
const path = require('node:path');

const MAX_BYTES = 1024 * 1024; // 1 MB, about a year of normal use
const MAX_KEPT = 2; // medirdv.log.1, medirdv.log.2

let logFile = null;
let stream = null;
let currentBytes = 0;
let installed = null; // { level: original console method }
let processHandlers = null;

/** ISO timestamp without milliseconds — plenty for support. */
function stamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

/** Scrub phone numbers, JIDs, and potential PII from application log lines (Law 18-07). */
function sanitizeLogText(line) {
  return String(line || '')
    .replace(/\b\d{6,16}@(s\.whatsapp\.net|lid)\b/g, '[JID-REDACTED]')
    .replace(/(^|[^\d])(\+?213|0)[567]\d{8}(?!\d)/g, '$1[PHONE-REDACTED]');
}

/** Turn console arguments (objects, errors, arrays) into one readable line. */
function format(args) {
  const joined = args
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
  return sanitizeLogText(joined);
}

function rotateIfNeeded(file, force = false) {
  try {
    if (!fs.existsSync(file)) return;
    if (!force && fs.statSync(file).size < MAX_BYTES) return;
    for (let index = MAX_KEPT; index >= 1; index -= 1) {
      const from = index === 1 ? file : `${file}.${index - 1}`;
      const to = `${file}.${index}`;
      if (fs.existsSync(from)) fs.renameSync(from, to);
    }
  } catch (error) {
    /* rotation is optional */
  }
}

function openAppendStream(file) {
  currentBytes = fs.existsSync(file) ? fs.statSync(file).size : 0;
  stream = fs.createWriteStream(file, { flags: 'a' });
  stream.on('error', () => {
    stream = null; // disk full / read-only: silently stop writing
  });
}

/** Start logging to `file`. Returns false when the folder is not writable. */
function init(file) {
  close();
  logFile = path.resolve(file);
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    rotateIfNeeded(logFile);
    openAppendStream(logFile);
  } catch (error) {
    stream = null;
    currentBytes = 0;
    return false;
  }
  return true;
}

function write(level, args) {
  if (!stream) return;
  try {
    const line = `${stamp()} ${level.toUpperCase()} ${format(args)}\n`;
    const byteLen = Buffer.byteLength(line, 'utf8');
    if (logFile && currentBytes + byteLen > MAX_BYTES) {
      try {
        stream.end();
      } catch (_err) {
        /* ignore */
      }
      stream = null;
      rotateIfNeeded(logFile, true);
      openAppendStream(logFile);
    }
    if (stream) {
      stream.write(line);
      currentBytes += byteLen;
    }
  } catch (error) {
    /* never throw from logging */
  }
}

/**
 * Capture uncaught background exceptions and promise rejections into `medirdv.log`
 * so errors occurring while minimized in the System Tray are never lost silently.
 */
function attachProcessErrorHandlers() {
  if (processHandlers) return;
  const onUncaught = (err) => {
    write('error', ['[bg-uncaughtException]', err]);
  };
  const onUnhandled = (reason) => {
    write('error', ['[bg-unhandledRejection]', reason]);
  };
  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onUnhandled);
  processHandlers = { onUncaught, onUnhandled };
}

function detachProcessErrorHandlers() {
  if (!processHandlers) return;
  process.off('uncaughtException', processHandlers.onUncaught);
  process.off('unhandledRejection', processHandlers.onUnhandled);
  processHandlers = null;
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
  currentBytes = 0;
}

function currentFile() {
  return logFile;
}

module.exports = {
  init,
  attachConsole,
  detachConsole,
  attachProcessErrorHandlers,
  detachProcessErrorHandlers,
  write,
  close,
  currentFile,
  sanitizeLogText,
  MAX_BYTES,
};
