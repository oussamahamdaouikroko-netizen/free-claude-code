'use strict';
/**
 * Security posture of the desktop application.
 *
 * These tests are deliberately strict: they check the Electron window options,
 * the preload surface, the IPC allowlist and the Content Security Policy. If a
 * future change relaxes one of them, the build fails here rather than in a
 * pharmacy.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  isTrustedFrameUrl,
  isValidMethodName,
  assertAllowedMethod,
  assertPayloadSize,
  toErrorPayload,
  MAX_PAYLOAD_JSON,
} = require('../src/main/security');
const { AppError } = require('../src/main/utils/common');
const { createHandlers, allowedMethods } = require('../src/main/handlers');

const ROOT = path.join(__dirname, '..');

test('only our own file:// window may use the bridge', () => {
  assert.equal(isTrustedFrameUrl('file:///C:/Program%20Files/PharmaGestion/index.html'), true);
  for (const url of [
    'https://evil.example/index.html',
    'http://localhost:3000/',
    'data:text/html,<h1>x</h1>',
    'about:blank',
    'javascript:alert(1)',
    '',
    null,
    undefined,
  ]) {
    assert.equal(isTrustedFrameUrl(url), false, `must refuse ${String(url)}`);
  }
});

test('method names must look like namespace:action', () => {
  assert.equal(isValidMethodName('backup:restore'), true);
  assert.equal(isValidMethodName('db:integrity'), true);
  for (const name of ['backup', 'backup:', ':restore', 'Backup:Restore', '__proto__', 'constructor', 'a:b:c', 'x'.repeat(80), null, 42]) {
    assert.equal(isValidMethodName(name), false, `must refuse ${String(name)}`);
  }
});

test('the allowlist refuses anything not declared, including prototype keys', () => {
  const allowed = new Set(['backup:create']);
  assert.equal(assertAllowedMethod(allowed, 'backup:create'), 'backup:create');
  for (const method of ['backup:restore', 'toString', 'constructor', '__proto__', 'valueOf']) {
    assert.throws(() => assertAllowedMethod(allowed, method), { code: 'UNKNOWN_METHOD' });
  }
});

test('oversized payloads are refused before any work happens', () => {
  assert.doesNotThrow(() => assertPayloadSize({ note: 'ok' }));
  const huge = { text: 'x'.repeat(MAX_PAYLOAD_JSON) };
  assert.throws(() => assertPayloadSize(huge), { code: 'INVALID_PAYLOAD' });
  const circular = {};
  circular.self = circular;
  assert.throws(() => assertPayloadSize(circular), { code: 'INVALID_PAYLOAD' });
});

test('unexpected errors never leak a stack trace to the window', () => {
  const appError = new AppError('BACKUP_NOT_FOUND', 'missing');
  assert.deepEqual(toErrorPayload(appError, (error) => error instanceof AppError), {
    code: 'BACKUP_NOT_FOUND',
    message: 'missing',
    details: undefined,
  });

  const crash = new Error('SQLITE_ERROR: no such table: patients (at db.js:42)');
  crash.stack = 'stack with internal paths';
  const payload = toErrorPayload(crash, (error) => error instanceof AppError);
  assert.deepEqual(payload, {
    code: 'INTERNAL_ERROR',
    message: 'Internal error, see pharmagestion.log',
  });
  assert.equal(JSON.stringify(payload).includes('db.js'), false);
});

test('handler objects have no prototype chain to abuse', () => {
  const handlers = createHandlers({
    version: 'test',
    dataDir: '/tmp',
    dialogs: {},
  });
  assert.equal(Object.getPrototypeOf(handlers), null);
  assert.equal(handlers.toString, undefined);
  assert.equal(handlers.constructor, undefined);
  assert.equal(handlers.__proto__, undefined);
  const allowed = allowedMethods(handlers);
  assert.deepEqual([...allowed].sort(), Object.keys(handlers).sort());
});

test('the BrowserWindow uses the secure Electron options', () => {
  const source = fs.readFileSync(path.join(ROOT, 'src', 'main', 'index.js'), 'utf8');
  assert.match(source, /contextIsolation:\s*true/);
  assert.match(source, /nodeIntegration:\s*false/);
  assert.match(source, /sandbox:\s*true/);
  assert.match(source, /webviewTag:\s*false/);
  assert.match(source, /allowRunningInsecureContent:\s*false/);
  assert.doesNotMatch(source, /nodeIntegration:\s*true/);
  assert.doesNotMatch(source, /webSecurity:\s*false/);
  assert.doesNotMatch(source, /enableRemoteModule:\s*true/);
  // Navigation and new windows are blocked; permissions are denied.
  assert.match(source, /setWindowOpenHandler/);
  assert.match(source, /will-navigate/);
  assert.match(source, /setPermissionRequestHandler/);
  assert.match(source, /will-attach-webview/);
  // Only local content is loaded. A boot failure uses a native dialog, never a
  // second document (no data: URL, no remote page).
  assert.match(source, /loadFile\(/);
  assert.doesNotMatch(source, /loadURL\(/);
  assert.doesNotMatch(source, /data:text\/html/);
});

test('the preload exposes a minimal, frozen surface', () => {
  const source = fs.readFileSync(path.join(ROOT, 'src', 'preload', 'index.js'), 'utf8');
  assert.match(source, /contextBridge\.exposeInMainWorld/);
  assert.match(source, /invoke/);
  // No direct Node access for the window.
  assert.doesNotMatch(source, /require\(['"]node:fs['"]\)/);
  assert.doesNotMatch(source, /exposeInMainWorld\(['"]require['"]/);
  assert.doesNotMatch(source, /process\.env/);
  // Method names are validated before they reach the main process.
  assert.match(source, /ALLOWED_METHOD/);
});

test('the Content-Security-Policy forbids remote code and any connection', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'index.html'), 'utf8');
  const match = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html);
  assert.ok(match, 'a CSP meta tag must be present');
  const csp = match[1];

  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /style-src 'self'/);
  assert.match(csp, /connect-src 'none'/);
  assert.doesNotMatch(csp, /unsafe-inline/);
  assert.doesNotMatch(csp, /unsafe-eval/);
  assert.doesNotMatch(csp, /\*/);
  assert.doesNotMatch(csp, /https?:/);

  // No inline <script> and no remote asset may be loaded by the page.
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/);
  const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
  for (const ref of refs) {
    assert.doesNotMatch(ref, /^(https?:)?\/\//, `remote asset in index.html: ${ref}`);
  }
});

test('the renderer never builds HTML from data', () => {
  const rendererDir = path.join(ROOT, 'src', 'renderer', 'js');
  const files = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) files.push(full);
    }
  })(rendererDir);

  assert.ok(files.length >= 6);
  for (const file of files) {
    const code = fs.readFileSync(file, 'utf8');
    if (path.basename(file) === 'icons.js') {
      // The only innerHTML in the renderer: a fixed table of SVG path strings
      // defined in the same file. No user data reaches it.
      assert.equal((code.match(/\.innerHTML/g) || []).length, 1);
      assert.doesNotMatch(code, /params|dataset|value/, 'the icon table must stay static');
    } else {
      assert.doesNotMatch(code, /\.innerHTML/, `raw innerHTML assignment in ${path.basename(file)}`);
    }
    assert.doesNotMatch(code, /insertAdjacentHTML/, `insertAdjacentHTML in ${path.basename(file)}`);
    assert.doesNotMatch(code, /\beval\(/, `eval in ${path.basename(file)}`);
    assert.doesNotMatch(code, /new Function\(/, `new Function in ${path.basename(file)}`);
    assert.doesNotMatch(code, /fetch\(|XMLHttpRequest|WebSocket/, `network call in ${path.basename(file)}`);
  }
});

test('no secret, token or personal-data field is stored in the settings table', () => {
  const { SPECS } = require('../src/main/services/settings');
  for (const key of Object.keys(SPECS)) {
    assert.doesNotMatch(key, /password|token|secret|api_?key|whatsapp/i);
  }
  const schema = fs.readFileSync(path.join(ROOT, 'src', 'main', 'db', 'schema.js'), 'utf8');
  assert.doesNotMatch(schema, /whatsapp/i);
});
