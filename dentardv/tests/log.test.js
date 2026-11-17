'use strict';
/**
 * The main-process log file.
 *
 * A packaged Windows app has no console, so this file is the only trace left
 * when something goes wrong at the clinic. It must therefore: capture console
 * output, never throw, and stay small (rotation).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { safeRemove } = require('./helpers');
const log = require('../src/main/log');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait until the write stream has flushed the file. */
async function readLog(file, minBytes = 1) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const content = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (content.length >= minBytes) return content;
    await sleep(20);
  }
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

test('console output is mirrored into the log file with a timestamp', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dentardv-log-'));
  const file = path.join(dir, 'logs', 'dentardv.log');
  t.after(() => {
    log.detachConsole();
    log.close();
    safeRemove(dir);
  });

  assert.equal(log.init(file), true, 'the nested folder is created');
  assert.equal(log.currentFile(), file);
  log.attachConsole();

  console.log('[test] clinic', 'Cabinet El Oued');
  console.error(new Error('boom'));
  console.warn('[test] warning');

  const content = await readLog(file, 20);
  assert.match(content, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} INFO \[test\] clinic Cabinet El Oued/m);
  assert.match(content, /ERROR Error: boom/, 'errors keep their stack');
  assert.match(content, /WARN \[test\] warning/);

  // Caller is still restored: the terminal keeps working after detaching.
  log.detachConsole();
  console.log('after detach');
  assert.doesNotMatch(await readLog(file, 20), /after detach/);
});

test('the log rotates instead of growing forever', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dentardv-log-rot-'));
  const file = path.join(dir, 'dentardv.log');
  t.after(() => {
    log.detachConsole();
    log.close();
    safeRemove(dir);
  });

  // A file already bigger than the limit is moved aside on the next start.
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, 'x'.repeat(log.MAX_BYTES + 10));
  log.init(file);

  assert.ok(fs.existsSync(`${file}.1`), 'the old log is kept as dentardv.log.1');
  assert.ok(fs.statSync(`${file}.1`).size > log.MAX_BYTES);
  assert.equal(fs.existsSync(file) ? fs.statSync(file).size : 0, 0, 'a fresh log starts empty');
  log.close();
});

test('logging never throws, even on an unusable path', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dentardv-log-bad-'));
  try {
    // A directory where the file should be: opening the stream must fail
    // gracefully and later writes must become no-ops.
    const target = path.join(dir, 'dentardv.log');
    fs.mkdirSync(target);
    assert.equal(log.init(target), true, 'init reports the folder, the stream fails later');
    assert.doesNotThrow(() => log.write('error', ['still', 'safe']));
    assert.doesNotThrow(() => log.detachConsole());
    log.close();
  } finally {
    safeRemove(dir);
  }
});
