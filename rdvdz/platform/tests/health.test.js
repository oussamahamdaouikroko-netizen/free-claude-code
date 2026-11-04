/**
 * Santé du service et configuration de démarrage.
 *
 * Une plateforme de santé doit démarrer dans un état sûr : ces tests
 * garantissent qu'une configuration dangereuse empêche le démarrage plutôt
 * que de produire silencieusement des paiements fictifs ou des données
 * non protégées.
 */

import './env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, teardown, call } from './helpers.js';
import { config, validateConfig } from '../src/config.js';

test.before(async () => {
  await setup();
});

test.after(async () => {
  await teardown();
});

test('la sonde de santé répond sans authentification et n\'expose rien de sensible', async () => {
  const response = await call('GET', '/api/v1/health');
  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.service, 'rdvdz-api');
  const raw = JSON.stringify(response.body);
  assert.equal(/secret|password|database_url/i.test(raw), false);
});

test('les en-têtes de sécurité sont posés sur toutes les réponses', async () => {
  for (const url of ['/api/v1/health', '/api/v1/reference/wilayas', '/api/v1/inexistant']) {
    const response = await call('GET', url);
    assert.equal(response.headers['x-content-type-options'], 'nosniff', url);
    assert.equal(response.headers['x-frame-options'], 'DENY', url);
    assert.equal(response.headers['cross-origin-opener-policy'], 'same-origin', url);
  }
});

test('la CSP est stricte hors webhook', async () => {
  const response = await call('GET', '/api/v1/health');
  assert.match(response.headers['content-security-policy'], /default-src 'none'/);
  assert.match(response.headers['content-security-policy'], /frame-ancestors 'none'/);
});

test('une route inconnue renvoie un JSON d\'erreur, jamais une page HTML', async () => {
  const response = await call('GET', '/api/v1/route-qui-nexiste-pas');
  assert.equal(response.status, 404);
  assert.equal(response.body.error.code, 'NOT_FOUND');
});

test('un JSON invalide est rejeté proprement (400)', async () => {
  const { getApp } = await import('./helpers.js');
  const response = await getApp().inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: '{ceci n\'est pas du json',
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(response.statusCode, 400);
  const body = JSON.parse(response.body);
  assert.equal(body.error.code, 'BAD_JSON');
});

test('un corps trop volumineux est refusé avant traitement (413)', async () => {
  const response = await call('POST', '/api/v1/auth/login', {
    body: { identifier: 'x', password: 'y', remplissage: 'A'.repeat(3 * 1024 * 1024) },
  });
  assert.equal(response.status, 413);
});

test('les fonctionnalités sensibles sont désactivées par défaut dans la configuration', async () => {
  assert.equal(config.compliance.allowCrossBorder, false, 'aucun transfert de données hors d\'Algérie');
  assert.equal(config.compliance.walletEnabled, false, 'portefeuille non implémenté : pas de faux module');
  assert.equal(config.compliance.telemedicinePaidEnabled, false, 'téléconsultation payante en attente de validation');
  assert.ok(config.security.maxFailedLogins >= 5);
  assert.ok(config.security.sessionTtlHours <= 24 * 30);
});

test('la validation de configuration refuse une incohérence', async () => {
  const previous = config.compliance.telemedicineEnabled;
  config.compliance.telemedicineEnabled = false;
  config.compliance.telemedicinePaidEnabled = true;
  try {
    assert.throws(() => validateConfig(), /TELEMEDICINE_PAID_ENABLED/);
  } finally {
    config.compliance.telemedicineEnabled = previous;
    config.compliance.telemedicinePaidEnabled = false;
  }
  assert.equal(validateConfig(), true);
});

test('les référentiels publics répondent en arabe et en français', async () => {
  const wilayas = await call('GET', '/api/v1/reference/wilayas');
  assert.equal(wilayas.status, 200);
  assert.equal(wilayas.body.items.length, 58, 'les 58 wilayas');
  const alger = wilayas.body.items.find((w) => w.code === 16);
  assert.equal(alger.name_fr, 'Alger');
  assert.equal(alger.name_ar, 'الجزائر');

  const specialties = await call('GET', '/api/v1/reference/specialties');
  assert.equal(specialties.status, 200);
  assert.ok(specialties.body.items.length >= 10);
  assert.ok(specialties.body.items.every((s) => s.name_fr && s.name_ar));

  const settings = await call('GET', '/api/v1/reference/config');
  assert.equal(settings.status, 200);
  assert.ok(settings.body.brand?.name);
  assert.equal(settings.body.wallet?.enabled, false);
});
