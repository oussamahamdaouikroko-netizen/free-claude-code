'use strict';
/**
 * Cross-platform test runner.
 *
 * `npm test` must behave the same on Windows (cmd.exe), Linux and macOS:
 * the shell does not expand globs on Windows, so this script lists the test
 * files itself and hands an explicit list to Node's test runner.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const testsDir = __dirname;
const files = fs
  .readdirSync(testsDir)
  .filter((name) => name.endsWith('.test.js'))
  .sort()
  .map((name) => path.join(testsDir, name));

if (files.length === 0) {
  console.error('[tests] no *.test.js file found');
  process.exit(1);
}

console.log(`[tests] ${files.length} files`);

// --test-concurrency=1: the tests share the single SQLite connection owned by
// the services, so they must not run in parallel.
const child = spawn(
  process.execPath,
  ['--test', '--test-concurrency=1', ...files],
  { stdio: 'inherit', env: { ...process.env, NODE_OPTIONS: '' } },
);

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
