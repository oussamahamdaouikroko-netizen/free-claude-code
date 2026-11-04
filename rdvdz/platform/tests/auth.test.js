/**
 * Authentification, sessions, CSRF, OTP, verrouillage, droits des personnes.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import './env.js';
import { setup, teardown, call, registerPatient, createAdmin, cookieToken, uniquePhone } from './helpers.js';
import { hashPassword, verifyPassword, normalizePhone } from '../src/lib/crypto.js';
import { clearAll as clearRateLimits } from '../src/lib/rate-limit.js';

test.before(async () => {
  await setup();
});

// Chaque test part d'un compteur de limitation vierge : la limitation de débit
// a son propre test dédié, elle ne doit pas polluer les autres.
test.beforeEach(() => {
  clearRateLimits();
});

test.after(async () => {
  await teardown();
});

test('les mots de passe sont salés et vérifiés à temps constant', () => {
  const a = hashPassword('MotDePasse#2026');
  const b = hashPassword('MotDePasse#2026');
  assert.notEqual(a.hash, b.hash, 'deux sels différents ⇒ deux empreintes différentes');
  assert.equal(a.hash.length, 128);
  assert.equal(verifyPassword('MotDePasse#2026', a.hash, a.salt), true);
  assert.equal(verifyPassword('MotDePasse#2027', a.hash, a.salt), false);
  assert.equal(verifyPassword('', a.hash, a.salt), false);
});

test('les téléphones algériens sont normalisés, les invalides rejetés', () => {
  assert.equal(normalizePhone('0550 12 34 56'), '+213550123456');
  assert.equal(normalizePhone('00213550123456'), '+213550123456');
  assert.equal(normalizePhone('+213 550 12 34 56'), '+213550123456');
  assert.equal(normalizePhone('12345'), null);
  assert.equal(normalizePhone('+33612345678'), null, 'un numéro français n\'est pas accepté');
});

test('inscription : consentement et politique de mot de passe obligatoires', async () => {
  const noConsent = await call('POST', '/api/v1/auth/register', {
    body: { fullName: 'Sans Accord', phone: uniquePhone(), password: 'MotDePasse#2026', consent: false },
  });
  assert.equal(noConsent.status, 422);
  assert.equal(noConsent.body.error.code, 'VALIDATION');

  const weak = await call('POST', '/api/v1/auth/register', {
    body: { fullName: 'Mot Faible', phone: uniquePhone(), password: 'court', consent: true },
  });
  assert.equal(weak.status, 422);

  const badPhone = await call('POST', '/api/v1/auth/register', {
    body: { fullName: 'Mauvais Numéro', phone: '0612', password: 'MotDePasse#2026', consent: true },
  });
  assert.equal(badPhone.status, 422);
});

test('inscription + connexion + cookie HttpOnly + jeton CSRF', async () => {
  const patient = await registerPatient();
  assert.ok(patient.token);
  assert.ok(patient.csrf);
  assert.equal(patient.user.role, 'PATIENT');

  // Le cookie est HttpOnly (le JavaScript ne peut pas le lire).
  const login = await call('POST', '/api/v1/auth/login', {
    body: { identifier: patient.phone, password: patient.password },
  });
  const setCookie = String(login.headers['set-cookie']);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  assert.doesNotMatch(JSON.stringify(login.body), /password_hash|password_salt/);
  assert.ok(cookieToken(login.headers), 'un cookie de session est bien émis');
});

test('une mutation sans jeton CSRF est refusée', async () => {
  const patient = await registerPatient();
  const response = await call('PUT', '/api/v1/me/profile', {
    token: patient.token,
    body: { full_name: 'Nouveau Nom' },
  });
  assert.equal(response.status, 403);
  assert.equal(response.body.error.code, 'CSRF_INVALID');
});

test('l\'accès sans session renvoie 401 (pas de fuite d\'information)', async () => {
  const response = await call('GET', '/api/v1/bookings');
  assert.equal(response.status, 401);
  assert.equal(response.body.error.code, 'AUTH_REQUIRED');
});

test('un mauvais mot de passe ne révèle pas si le compte existe', async () => {
  const patient = await registerPatient();
  const wrongExisting = await call('POST', '/api/v1/auth/login', {
    body: { identifier: patient.phone, password: 'MauvaisMotDePasse#1' },
  });
  const unknown = await call('POST', '/api/v1/auth/login', {
    body: { identifier: uniquePhone(), password: 'MauvaisMotDePasse#1' },
  });
  assert.equal(wrongExisting.status, 401);
  assert.equal(unknown.status, 401);
  assert.equal(wrongExisting.body.error.code, unknown.body.error.code, 'code identique dans les deux cas');
});

test('verrouillage après 5 échecs, puis refus même avec le bon mot de passe', async () => {
  const patient = await registerPatient();
  for (let i = 0; i < 5; i += 1) {
    await call('POST', '/api/v1/auth/login', {
      body: { identifier: patient.phone, password: `Mauvais#${i}aaaa` },
    });
  }
  const locked = await call('POST', '/api/v1/auth/login', {
    body: { identifier: patient.phone, password: patient.password },
  });
  assert.equal(locked.status, 429);
  assert.equal(locked.body.error.code, 'RATE_LIMITED');
  assert.ok(locked.body.error.details.retry_after > 0);
});

test('OTP : vérification, usage unique et code invalide', async () => {
  const patient = await registerPatient();
  const requested = await call('POST', '/api/v1/auth/otp/request', {
    body: { phone: patient.phone, purpose: 'VERIFY' },
  });
  assert.equal(requested.status, 200);
  assert.ok(requested.body.debug_code, 'en mode test le code est renvoyé (jamais en production)');

  const bad = await call('POST', '/api/v1/auth/otp/verify', {
    body: { phone: patient.phone, code: '000000', purpose: 'VERIFY' },
  });
  assert.equal(bad.status, 409);

  const ok = await call('POST', '/api/v1/auth/otp/verify', {
    body: { phone: patient.phone, code: requested.body.debug_code, purpose: 'VERIFY' },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.verified, true);

  const replay = await call('POST', '/api/v1/auth/otp/verify', {
    body: { phone: patient.phone, code: requested.body.debug_code, purpose: 'VERIFY' },
  });
  assert.equal(replay.status, 409, 'un code ne peut pas être rejoué');
});

test('un compte médecin reste PENDING et absent de l\'annuaire jusqu\'à vérification', async () => {
  const admin = await createAdmin('ADMIN');
  const register = await call('POST', '/api/v1/auth/register', {
    body: {
      fullName: 'Dr Non Vérifié',
      phone: uniquePhone(),
      password: 'MotDePasse#2026',
      role: 'DOCTOR',
      consent: true,
      doctor: { specialtyCode: 'CARDIO', licenseNo: 'ORD-999' },
    },
  });
  assert.equal(register.status, 201);
  assert.equal(register.body.needs_verification, true);

  const pending = await call('GET', '/api/v1/admin/doctors/pending', {
    token: admin.token,
    csrf: admin.csrf,
  });
  assert.equal(pending.status, 200);
  assert.equal(pending.body.items.length, 1);

  const search = await call('GET', '/api/v1/doctors?specialty=CARDIO');
  assert.equal(search.body.items.length, 0, 'non vérifié ⇒ invisible');

  const verify = await call('POST', `/api/v1/admin/doctors/${pending.body.items[0].id}/verify`, {
    token: admin.token,
    csrf: admin.csrf,
    body: { note: 'Ordre vérifié' },
  });
  assert.equal(verify.status, 200);

  const searchAfter = await call('GET', '/api/v1/doctors?specialty=CARDIO');
  assert.equal(searchAfter.body.items.length, 1);
  assert.equal(searchAfter.body.items[0].verified, true);
});

test('changement de mot de passe : ancien mot de passe exigé, sessions révoquées', async () => {
  const patient = await registerPatient();
  const wrong = await call('POST', '/api/v1/auth/password', {
    token: patient.token,
    csrf: patient.csrf,
    body: { current: 'MauvaisActuel#1', next: 'NouveauMotDePasse#2026' },
  });
  assert.equal(wrong.status, 403);

  const ok = await call('POST', '/api/v1/auth/password', {
    token: patient.token,
    csrf: patient.csrf,
    body: { current: patient.password, next: 'NouveauMotDePasse#2026' },
  });
  assert.equal(ok.status, 200);

  const session = await call('GET', '/api/v1/auth/me', { token: patient.token });
  assert.equal(session.status, 401, 'la session courante est révoquée par sécurité');

  const relogin = await call('POST', '/api/v1/auth/login', {
    body: { identifier: patient.phone, password: 'NouveauMotDePasse#2026' },
  });
  assert.equal(relogin.status, 200);
});

test('droits des personnes : export, rectification, suppression logique', async () => {
  const patient = await registerPatient({ fullName: 'Nom Initial' });

  const exported = await call('GET', '/api/v1/me/export', { token: patient.token });
  assert.equal(exported.status, 200);
  assert.equal(exported.body.user.full_name, 'Nom Initial');
  assert.ok(Array.isArray(exported.body.consents));
  assert.doesNotMatch(JSON.stringify(exported.body), /password_hash/);

  const rectified = await call('PUT', '/api/v1/me/profile', {
    token: patient.token,
    csrf: patient.csrf,
    body: { full_name: 'Nom Rectifié', commune: 'Es Sénia' },
  });
  assert.equal(rectified.status, 200);
  const after = await call('GET', '/api/v1/me/profile', { token: patient.token });
  assert.equal(after.body.user.full_name, 'Nom Rectifié');
  assert.equal(after.body.patient.commune, 'Es Sénia');

  const deleted = await call('POST', '/api/v1/me/delete', { token: patient.token, csrf: patient.csrf });
  assert.equal(deleted.status, 200);
  const login = await call('POST', '/api/v1/auth/login', {
    body: { identifier: patient.phone, password: patient.password },
  });
  assert.equal(login.status, 401, 'un compte supprimé ne peut plus se connecter');
});

test('les en-têtes de sécurité sont présents sur chaque réponse', async () => {
  const response = await call('GET', '/api/v1/health');
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(response.headers['x-frame-options'], 'DENY');
  assert.match(String(response.headers['content-security-policy']), /default-src 'none'/);
});

test('un opérateur ne peut pas créer de compte administrateur via l\'inscription publique', async () => {
  const attempt = await call('POST', '/api/v1/auth/register', {
    body: {
      fullName: 'Faux Admin',
      phone: uniquePhone(),
      password: 'MotDePasse#2026',
      role: 'SUPER_ADMIN',
      consent: true,
    },
  });
  assert.equal(attempt.status, 422);
});
