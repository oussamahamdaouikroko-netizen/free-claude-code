'use strict';
/**
 * The dashboard must never render a blank window.
 *
 * This test executes the real admin/app.js against a stub DOM built from the
 * real admin/index.html, exactly as the browser would: every getElementById
 * resolves, and the file must run to completion without throwing. A single
 * undeclared identifier previously made the whole script die on load, leaving
 * the window empty — this test exists so that can never ship again.
 */
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ADMIN = path.join(__dirname, '..', 'src', 'static', 'admin');
const html = fs.readFileSync(path.join(ADMIN, 'index.html'), 'utf8');
const source = fs.readFileSync(path.join(ADMIN, 'app.js'), 'utf8');

/** Build a DOM stub whose ids come from the real markup. */
function buildDom() {
  const elements = new Map();
  const makeElement = (id) => ({
    id,
    value: '',
    textContent: '',
    innerHTML: '',
    dataset: {},
    style: {},
    disabled: false,
    classList: {
      _set: new Set(),
      add(...names) { names.forEach((n) => this._set.add(n)); },
      remove(...names) { names.forEach((n) => this._set.delete(n)); },
      contains(name) { return this._set.has(name); },
      toggle(name, force) {
        const on = force === undefined ? !this._set.has(name) : Boolean(force);
        if (on) this._set.add(name); else this._set.delete(name);
        return on;
      },
    },
    addEventListener() {},
    focus() {},
    reset() {},
    appendChild() {},
  });

  for (const match of html.matchAll(/id="([^"]+)"/g)) {
    elements.set(match[1], makeElement(match[1]));
  }

  const document = {
    getElementById: (id) => elements.get(id) || null,
    querySelector: (selector) => {
      const meta = selector.match(/meta\[name="medirdv-api-base"\]/);
      if (meta) return { getAttribute: () => '' };
      return null;
    },
    querySelectorAll: () => [],
    addEventListener() {},
    createElement: (tag) => makeElement(tag),
    body: makeElement('body'),
  };
  return { document, elements };
}

test('app.js runs to completion and shows the setup screen on a fresh install', async () => {
  const { document, elements } = buildDom();
  const calls = [];
  const context = vm.createContext({
    document,
    console,
    setTimeout,
    clearTimeout,
    alert() {},
    URLSearchParams,
    fetch: async (url) => {
      calls.push(url);
      if (url.endsWith('/api/setup/status')) {
        return { ok: true, status: 200, json: async () => ({ needs_setup: true }) };
      }
      return { ok: false, status: 401, json: async () => ({ error: { message: 'no session' } }) };
    },
    window: { location: { origin: 'http://127.0.0.1:8080', hash: '' } },
  });

  vm.runInContext(source, context, { filename: 'app.js' });

  // Let the boot() promise chain resolve.
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.ok(calls.some((url) => url.endsWith('/api/setup/status')), 'boot() called the setup status endpoint');
  assert.equal(elements.get('login-view').classList.contains('hidden'), true, 'login form hidden during setup');
  assert.equal(elements.get('setup-view').classList.contains('hidden'), false, 'setup form visible');
  assert.equal(elements.get('app-view').classList.contains('hidden'), true, 'dashboard not shown yet');
});

test('a failing API leaves the login form on screen with a readable message', async () => {
  const { document, elements } = buildDom();
  const context = vm.createContext({
    document,
    console,
    setTimeout,
    clearTimeout,
    alert() {},
    URLSearchParams,
    fetch: async () => {
      throw new Error('connect ECONNREFUSED');
    },
    window: { location: { origin: 'http://127.0.0.1:8080', hash: '' } },
  });

  vm.runInContext(source, context, { filename: 'app.js' });
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(elements.get('login-view').classList.contains('hidden'), false, 'login form still visible');
  const shown = elements.get('login-error').textContent;
  assert.match(shown, /Impossible de joindre le service local/, 'the user is told what went wrong');
  assert.match(shown, /Redémarrer le service local/, 'the message names the menu entry to use');
});

test('an unsigned-in session (401) is treated as normal, not as a failure', async () => {
  const { document, elements } = buildDom();
  const context = vm.createContext({
    document,
    console,
    setTimeout,
    clearTimeout,
    alert() {},
    URLSearchParams,
    fetch: async (url) => {
      if (url.endsWith('/api/setup/status')) {
        return { ok: true, status: 200, json: async () => ({ needs_setup: false }) };
      }
      return { ok: false, status: 401, json: async () => ({ error: { message: 'Unauthorized' } }) };
    },
    window: { location: { origin: 'http://127.0.0.1:8080', hash: '' } },
  });

  vm.runInContext(source, context, { filename: 'app.js' });
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(elements.get('login-view').classList.contains('hidden'), false);
  assert.equal(elements.get('login-error').textContent, '', 'no scary error for a plain signed-out state');
});

test('the login screen offers in-app recovery', () => {
  assert.match(html, /recover\.html/, 'login screen links to the recovery page');
  const recover = fs.readFileSync(path.join(ADMIN, 'recover.html'), 'utf8');
  const script = fs.readFileSync(path.join(ADMIN, 'recover.js'), 'utf8');
  assert.match(recover, /id="recover-form"/);
  assert.match(script, /\/api\/recovery\/reset/);
  assert.ok(!/localhost:8080/.test(script), 'recovery never hardcodes a host');
});
