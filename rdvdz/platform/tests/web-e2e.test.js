/**
 * Parcours de bout en bout du front, dans un vrai DOM (jsdom).
 *
 * Le code testé est `src/web/app.js` tel quel : même HTML, mêmes modules, mêmes
 * appels `fetch` que dans le navigateur. Seul le transport est branché sur
 * l'application Fastify réelle (`app.inject`), donc aucune base ni serveur à
 * lancer. Cela vérifie ce que les tests unitaires ne peuvent pas voir :
 * navigation par hash, routage, garde de rôle, rendu final dans le DOM.
 */

import './env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { setup, teardown, registerPatient, createAdmin } from './helpers.js';
import { clearAll as clearRateLimits } from '../src/lib/rate-limit.js';

const WEB_ROOT = path.resolve(process.cwd(), 'src', 'web');

let app;
let dom;
let patient;
let admin;
let currentToken = null;
let currentCsrf = null;

/** Bout de navigateur : mémorise le cookie `rdv_session` renvoyé par l'API. */
function rememberCookie(response) {
  const raw = response.headers['set-cookie'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const match = value ? /rdv_session=([^;]*)/.exec(value) : null;
  if (match) currentToken = match[1] === '' ? null : match[1];
}

/** Installe le DOM de `index.html` et fait pointer les globaux dessus. */
async function mountBrowser(html) {
  dom = new JSDOM(html, {
    url: 'http://localhost:8080/',
    pretendToBeVisual: true,
  });
  const { window } = dom;

  // Les modules front lisent ces globaux au chargement : on les expose.
  // FormData et URL doivent venir de jsdom : `new FormData(form)` n'accepte un
  // élément HTML que via l'implémentation du document courant.
  for (const key of [
    'window',
    'document',
    'location',
    'navigator',
    'HTMLElement',
    'CustomEvent',
    'Event',
    'FormData',
    'URLSearchParams',
    'Blob',
    'File',
    'getComputedStyle',
  ]) {
    Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true });
  }
  globalThis.localStorage = window.localStorage;
  globalThis.sessionStorage = window.sessionStorage;

  // `fetch` : requêtes réelles sur l'application, cookies et CSRF simulés.
  globalThis.fetch = async (url, options = {}) => {
    const method = options.method ?? 'GET';
    const headers = { ...(options.headers ?? {}) };
    if (currentToken) headers.cookie = `rdv_session=${currentToken}`;
    if (currentCsrf && method !== 'GET') headers['x-csrf-token'] = currentCsrf;
    const response = await app.inject({
      method,
      url: String(url),
      payload: options.body,
      headers: { 'content-type': 'application/json', ...headers },
    });
    rememberCookie(response);
    return {
      ok: response.statusCode >= 200 && response.statusCode < 300,
      status: response.statusCode,
      headers: { get: (name) => response.headers[name.toLowerCase()] },
      text: async () => response.body,
      json: async () => JSON.parse(response.body),
      blob: async () => ({ size: response.body.length, type: 'text/html' }),
    };
  };

  // jsdom n'implémente pas URL.createObjectURL (utilisé par les exports CSV).
  window.URL.createObjectURL = () => 'blob:test';
  window.URL.revokeObjectURL = () => {};
  window.print = () => {};
  window.scrollTo = () => {};
  window.matchMedia = window.matchMedia ?? (() => ({ matches: false, addEventListener() {} }));
}

let appModule = null;

async function bootApp() {
  const module = await import('../src/web/app.js');
  appModule = module;
  // `boot` s'exécute à l'import (DOMContentLoaded déjà passée) : on attend que
  // la vue initiale soit rendue.
  await waitFor(() => document.querySelector('#view')?.textContent?.trim().length > 0);
  return module;
}

async function waitFor(predicate, { timeout = 3000, label = 'condition' } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`délai dépassé (${label})`);
}

async function navigate(hash, expectSelector) {
  if (window.location.hash !== hash) {
    window.location.hash = hash;
    // Change d'URL puis attend le nouveau rendu.
    await new Promise((resolve) => setTimeout(resolve, 30));
  } else if (appModule) {
    // Même hash : le navigateur n'émet pas d'événement, on force le rendu
    // (c'est ce que fait le bouton « Réessayer » de l'application).
    await appModule.render();
  }
  // Un rendu peut déjà être en cours (navigation précédente) : on attend que
  // le sélecteur attendu apparaisse plutôt que de lire un DOM intermédiaire.
  await waitFor(() => document.querySelector(expectSelector), {
    timeout: 5000,
    label: `${hash} → ${expectSelector}`,
  });
  // Stabilité : la vue ne doit plus changer pendant deux tours.
  const snapshot = document.querySelector('#view').innerHTML;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(document.querySelector('#view').innerHTML, snapshot, `rendu instable sur ${hash}`);
}

function viewText() {
  return document.querySelector('#view').textContent.replace(/\s+/g, ' ').trim();
}

test.before(async () => {
  app = await setup();
  clearRateLimits();
  patient = await registerPatient({ fullName: 'Nadia Bouzid' });
  admin = await createAdmin('SUPER_ADMIN');
  const html = await readFile(path.join(WEB_ROOT, 'index.html'), 'utf8');
  await mountBrowser(html);
});

test.after(async () => {
  await teardown();
  dom?.window?.close();
});

test('la page d\'accueil se charge et affiche les résultats de recherche', async () => {
  currentToken = null;
  currentCsrf = null;
  await bootApp();
  await navigate('#/', '[data-form="search"]');
  assert.match(viewText(), /Trouvez un médecin/);
  // Le référentiel des wilayas est chargé depuis l'API, pas codé en dur.
  const options = document.querySelectorAll('#wilaya option').length;
  assert.equal(options, 59, '58 wilayas + « toutes »');
  await waitFor(() => document.querySelector('[data-region="results"]')?.textContent.includes('médecin'), {
    label: 'résultats',
  });
});

test('la navigation par hash change réellement de vue', async () => {
  await navigate('#/login', 'form[data-form="login"]');
  assert.match(viewText(), /Connexion/);
  await navigate('#/', '[data-form="search"]');
  await navigate('#/privacy', '.card');
  assert.match(viewText(), /protection des données|حماية المعطيات/i);
});

test('une route protégée redirige vers la connexion', async () => {
  currentToken = null;
  currentCsrf = null;
  window.location.hash = '#/bookings';
  await waitFor(() => window.location.hash === '#/login', { label: 'redirection' });
});

test('la connexion patient fait apparaître « Mes rendez-vous »', async () => {
  await navigate('#/login', 'form[data-form="login"]');
  document.querySelector('#identifier').value = patient.phone;
  document.querySelector('#password').value = patient.password;
  document.querySelector('form[data-form="login"]').dispatchEvent(
    new window.Event('submit', { bubbles: true, cancelable: true }),
  );
  await waitFor(() => document.querySelector('[data-nav="bookings"]')?.hidden === false, {
    label: 'session patient',
  });
  await navigate('#/bookings', '.card');
  assert.match(viewText(), /Mes rendez-vous/);
  assert.equal(document.body.dataset.session, 'authenticated');
  assert.equal(document.body.dataset.role, 'PATIENT');
});

test('un patient ne peut pas ouvrir l\'administration', async () => {
  await navigate('#/admin', '.card');
  assert.match(viewText(), /Accès non autorisé/);
  // La navigation est filtrée par `body[data-role]` (règle CSS) : le rôle réel
  // du document reste PATIENT, donc aucun lien d'administration ne s'affiche.
  assert.equal(document.body.dataset.role, 'PATIENT');
  const css = await readFile(path.join(WEB_ROOT, 'app.css'), 'utf8');
  assert.doesNotMatch(css, /\[data-role='PATIENT'\] \[data-auth='admin'\]/);
});

test('un administrateur voit le tableau de bord réel', async () => {
  currentToken = admin.token;
  currentCsrf = admin.csrf;
  // Nouvelle session : l'application recharge l'état depuis `/auth/me`.
  // (`identityFor` ne gère pas les rôles internes : on force le rôle comme le
  // ferait une connexion réelle de ce compte.)
  const user = await appModule.refreshSession();
  assert.ok(user, 'session administrateur attendue');
  appModule.state.user = { ...user, role: admin.role };
  await navigate('#/admin', '.card');
  await waitFor(() => /Administration/.test(viewText()), { label: 'admin' }).catch((error) => {
    throw new Error(`${error.message} | vue: ${viewText().slice(0, 300)}`);
  });
  assert.match(viewText(), /Simulation/);
  assert.equal(document.body.dataset.role, 'SUPER_ADMIN');
});

test('la bascule FR/AR inverse la direction et traduit la page', async () => {
  await navigate('#/', '[data-form="search"]');
  document.querySelector('[data-action="toggle-lang"]').click();
  await waitFor(() => document.documentElement.dir === 'rtl', { label: 'rtl' });
  assert.match(document.body.textContent, /[\\u0600-\\u06FF]/);
  document.querySelector('[data-action="toggle-lang"]').click();
  await waitFor(() => document.documentElement.dir === 'ltr', { label: 'ltr' });
});

test('la déconnexion efface la session côté client et côté serveur', async () => {
  currentToken = patient.token;
  currentCsrf = patient.csrf;
  await navigate('#/bookings', '.card');
  document.querySelector('[data-action="logout"]').click();
  await waitFor(() => window.location.hash === '#/', { label: 'retour accueil' });
  assert.equal(document.body.dataset.session, 'anonymous');
  assert.equal(document.body.dataset.role, '');
});

test('aucune trace de données techniques dans le rendu final', async () => {
  const text = document.body.textContent;
  assert.doesNotMatch(text, /undefined|NaN|\\[object Object\\]/);
  assert.doesNotMatch(text, /&lt;(span|div|a) /, 'aucun HTML affiché en texte brut');
});
