'use strict';
/**
 * File logger for the main process.
 *
 * A packaged Windows app has no console window: messages written with
 * console.log() disappear, which makes a support call ("it does not open")
 * impossible to diagnose. This module mirrors console output into
 * `<data>/pharmagestion.log` and rotates the file once it passes 1 MB.
 *
 * Privacy rule: never write customer names, phone numbers, addresses or debt
 * amounts to this file. Log IDs and technical facts only.
 */

const fs = require('node:fs');
const path = require('node:path');

const MAX_BYTES = 1024 * 1024;
const MAX_KEPT = 2;

let logFile = null;
let stream = null;
let installed = null;

function stamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

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
    /* rotation is best effort */
  }
}

/** Start logging into `file`. Returns false when the folder is not writable. */
function init(file) {
  close();
  logFile = path.resolve(file);
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    rotateIfNeeded(logFile);
    stream = fs.createWriteStream(logFile, { flags: 'a' });
    stream.on('error', () => {
      stream = null;
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
    /* logging must never throw */
  }
}

/** Mirror console output into the file while keeping the terminal output. */
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
