'use strict';
/**
 * First-run provisioning: the operator creates the first administrator.
 * This is the flow the desktop application uses, so it is tested standalone
 * (a fresh database with no users at all).
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'medirdv-setup-'));
process.env.MEDIRDV_DB_PATH = path.join(tmpDir, 'setup.sqlite');
process.env.MEDIRDV_RECEIPTS_DIR = path.join(tmpDir, 'receipts');
process.env.MEDIRDV_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
process.env.PORT = '0';
// Deliberately no bootstrap admin: we are testing first-run provisioning.
delete process.env.MEDIRDV_BOOTSTRAP_ADMIN_EMAIL;
delete process.env.MEDIRDV_BOOTSTRAP_ADMIN_PASSWORD;

const { start } = require('../src/server');

let server;
let base;

before(async () => {
  server = start({ port: 0, host: '127.0.0.1' });
  await new Promise((resolve) => server.once('listening', resolve));
  base = server.baseUrl;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function req(method, pathname, { body = null, cookie = '' } = {}) {
  const res = await fetch(base + pathname, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body === null ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  const setCookie = res.headers.get('set-cookie') || '';
  const match = setCookie.match(/medirdv_session=([^;]+)/);
  return { status: res.status, data, cookie: match ? `medirdv_session=${match[1]}` : '' };
}

test('a fresh instance reports that setup is required', async () => {
  const { status, data } = await req('GET', '/api/setup/status');
  assert.equal(status, 200);
  assert.equal(data.needs_setup, true);
});

test('admin routes are closed until an administrator exists', async () => {
  const { status } = await req('GET', '/api/admin/dashboard');
  assert.equal(status, 401);
});

test('the operator creates their own administrator account and is signed in', async () => {
  const created = await req('POST', '/api/setup/complete', {
    body: { email: 'patron@clinique.dz', password: 'MonMotDePasse2026', full_name: 'Dr Patron' },
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.user.role, 'super_admin');
  assert.ok(created.cookie, 'setup must sign the operator in');

  const me = await req('GET', '/api/auth/me', { cookie: created.cookie });
  assert.equal(me.data.user.email, 'patron@clinique.dz');

  const dashboard = await req('GET', '/api/admin/dashboard', { cookie: created.cookie });
  assert.equal(dashboard.status, 200);

  const status = await req('GET', '/api/setup/status');
  assert.equal(status.data.needs_setup, false);
});

test('setup cannot be run twice (no takeover of a provisioned instance)', async () => {
  const again = await req('POST', '/api/setup/complete', {
    body: { email: 'attaquant@evil.example', password: 'AnotherPassword123' },
  });
  assert.equal(again.status, 409);
  assert.equal(again.data.error.code, 'ALREADY_SETUP');
});

test('weak passwords are refused during setup', async () => {
  // Re-open the gate artificially is not possible, so assert the validator via
  // a direct call to the same code path used by the endpoint.
  const auth = require('../src/auth');
  assert.throws(() => auth.createUser({ email: 'x@y.dz', password: 'short', role: 'admin' }), /password/i);
});

test('an administrator can change their own password and must re-authenticate', async () => {
  const login = await req('POST', '/api/auth/login', { body: { email: 'patron@clinique.dz', password: 'MonMotDePasse2026' } });
  assert.equal(login.status, 200);

  const wrong = await req('POST', '/api/auth/password', {
    cookie: login.cookie,
    body: { current_password: 'not-the-password', new_password: 'NouveauMotDePasse2026' },
  });
  assert.equal(wrong.status, 401);

  const changed = await req('POST', '/api/auth/password', {
    cookie: login.cookie,
    body: { current_password: 'MonMotDePasse2026', new_password: 'NouveauMotDePasse2026' },
  });
  assert.equal(changed.status, 200);

  // Old password no longer works; the new one does.
  const oldLogin = await req('POST', '/api/auth/login', { body: { email: 'patron@clinique.dz', password: 'MonMotDePasse2026' } });
  assert.equal(oldLogin.status, 401);
  const newLogin = await req('POST', '/api/auth/login', { body: { email: 'patron@clinique.dz', password: 'NouveauMotDePasse2026' } });
  assert.equal(newLogin.status, 200);

  // Previous sessions were invalidated by the password change.
  const stale = await req('GET', '/api/admin/dashboard', { cookie: login.cookie });
  assert.equal(stale.status, 401);
});

test('the admin UI exposes the first-run setup screen', async () => {
  const html = await (await fetch(base + '/admin/')).text();
  assert.ok(html.includes('id="setup-form"'));
  assert.ok(html.includes('id="setup-password"'));
  assert.ok(html.includes('id="password-form"'));
});
