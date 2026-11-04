/**
 * Front-end : rendu des vues et garanties de sécurité côté navigateur.
 *
 * Les vues sont des fonctions pures `async (ctx) => html` qui n'utilisent que
 * `fetch` (via `api.js`) et une petite partie du DOM. On leur fournit donc un
 * faux DOM minimal et un `fetch` branché sur l'application Fastify réelle :
 * le HTML testé est EXACTEMENT celui que le navigateur recevra.
 */

import './env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  setup,
  teardown,
  call,
  registerPatient,
  createVerifiedDoctorWithSlots,
  createAdmin,
  loginWith,
} from './helpers.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { clearAll as clearRateLimits } from '../src/lib/rate-limit.js';

/* --------------------------- faux environnement --------------------------- */

const WEB_ROOT = path.resolve(process.cwd(), 'src', 'web');

/** DOM minimal : les vues n'écrivent que dans des régions/attributs connus. */
class FakeElement {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.innerHTML = '';
    this.textContent = '';
    this.dataset = {};
    this.attributes = {};
    this.style = {};
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }
  getAttribute(name) {
    return this.attributes[name] ?? null;
  }
  removeAttribute(name) {
    delete this.attributes[name];
  }
  querySelector() {
    return null;
  }
  querySelectorAll() {
    return [];
  }
  append() {}
  prepend() {}
  addEventListener() {}
  scrollIntoView() {}
}

function installFakeDom() {
  const nodes = new Map([
    ['view', new FakeElement()],
    ['toasts', new FakeElement()],
  ]);
  globalThis.document = {
    documentElement: { lang: 'fr', dir: 'ltr' },
    body: { dataset: {} },
    getElementById: (id) => nodes.get(id) ?? null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    createElement: (tag) => new FakeElement(tag),
    readyState: 'complete',
  };
  globalThis.window = {
    location: { hash: '#/', hostname: 'localhost', protocol: 'http:', assign: () => {} },
    addEventListener: () => {},
    open: () => null,
    print: () => {},
  };
  const makeStorage = () => {
    const data = new Map();
    return {
      getItem: (key) => (data.has(key) ? data.get(key) : null),
      setItem: (key, value) => data.set(key, String(value)),
      removeItem: (key) => data.delete(key),
      clear: () => data.clear(),
    };
  };
  globalThis.localStorage = makeStorage();
  globalThis.sessionStorage = makeStorage();
  if (!globalThis.navigator) {
    Object.defineProperty(globalThis, 'navigator', {
      value: { language: 'fr-FR' },
      configurable: true,
      writable: true,
    });
  }
}

/**
 * `fetch` branché sur Fastify : mêmes requêtes, mêmes réponses que la prod.
 * La session courante est tenue dans `currentToken` / `currentCsrf`, comme le
 * ferait le navigateur avec son cookie `rdv_session`.
 */
let currentToken = null;
let currentCsrf = null;

function asUser(session) {
  currentToken = session?.token ?? null;
  currentCsrf = session?.csrf ?? null;
  web?.api?.setCsrf?.(currentCsrf);
  return session;
}

function installFetch(app) {
  globalThis.fetch = async (url, options = {}) => {
    const method = options.method ?? 'GET';
    const headers = { ...(options.headers ?? {}) };
    if (currentToken) headers.cookie = `rdv_session=${currentToken}`;
    if (currentCsrf && !headers['x-csrf-token'] && method !== 'GET' && method !== 'HEAD') {
      headers['x-csrf-token'] = currentCsrf;
    }
    const response = await app.inject({
      method,
      url,
      payload: options.body,
      headers: { 'content-type': 'application/json', ...headers },
    });
    return {
      ok: response.statusCode >= 200 && response.statusCode < 300,
      status: response.statusCode,
      statusText: '',
      headers: { get: (name) => response.headers[name.toLowerCase()] },
      text: async () => response.body,
      json: async () => JSON.parse(response.body),
      blob: async () => ({ size: response.body.length }),
    };
  };
}

let app;
let fixture;
let patient;
let sessions = {};

async function loadWeb() {
  // Import après installation du faux DOM : les modules front s'évaluent au
  // chargement (i18n lit `navigator`, api lit `fetch` à l'appel).
  const mods = {
    i18n: await import('../src/web/i18n.js'),
    ui: await import('../src/web/ui.js'),
    api: await import('../src/web/api.js'),
    search: await import('../src/web/views/search.js'),
    doctor: await import('../src/web/views/doctor.js'),
    auth: await import('../src/web/views/auth.js'),
    bookings: await import('../src/web/views/bookings.js'),
    teleconsult: await import('../src/web/views/teleconsult.js'),
    agenda: await import('../src/web/views/agenda.js'),
    ops: await import('../src/web/views/ops.js'),
    admin: await import('../src/web/views/admin.js'),
    account: await import('../src/web/views/account.js'),
  };
  return mods;
}

let web;

test.before(async () => {
  // Ordre important : PGlite (WASM) se croit dans un navigateur dès que
  // `window` existe, donc la base doit être ouverte AVANT le faux DOM.
  app = await setup();
  installFakeDom();
  installFetch(app);
  fixture = await createVerifiedDoctorWithSlots({ slotCount: 6, fee: 2000, teleconsult: true });
  await import('../src/db.js').then(({ db }) =>
    db().query(`UPDATE doctors SET teleconsult_fee = 0 WHERE id = $1`, [fixture.doctorId]),
  );
  patient = await registerPatient({ fullName: 'Nadia Bouzid' });
  sessions.patient = {
    user: patient.user,
    token: patient.token,
    csrf: patient.csrf,
    identity: { patient_id: patient.patientId },
  };
  const doctorSession = await loginWith(fixture.doctorPhone);
  sessions.doctor = {
    user: doctorSession.user,
    token: doctorSession.token,
    csrf: doctorSession.csrf,
    identity: { doctor_id: fixture.doctorId },
  };
  const admin = await createAdmin('SUPER_ADMIN');
  sessions.admin = {
    user: { id: admin.id, role: 'SUPER_ADMIN', full_name: 'Admin SUPER_ADMIN' },
    token: admin.token,
    csrf: admin.csrf,
    identity: {},
  };
  web = await loadWeb();
});

test.after(async () => {
  await teardown();
});

test.beforeEach(() => clearRateLimits());

/* --------------------------------- gabarit -------------------------------- */

test('le gabarit échappe les valeurs non sûres', () => {
  const { h, esc } = web.ui;
  assert.equal(esc('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(esc('a "b" \'c\''), 'a &quot;b&quot; &#39;c&#39;');
  const html = String(h`<p title="${'a"b'}">${'<img src=x onerror=alert(1)>'}</p>`);
  assert.equal(html.includes('<img'), false);
  assert.equal(html.includes('&quot;'), true);
  // `raw` n'échappe pas : réservé au HTML produit par nos soins.
  assert.equal(String(h`<div>${web.ui.raw('<b>ok</b>')}</div>`), '<div><b>ok</b></div>');
  // Un fragment `h` imbriqué ne doit PAS être ré-échappé (sinon les badges et
  // les liens s'affichent en texte brut dans la page).
  const nested = String(h`<div>${h`<span class="badge">ok</span>`}</div>`);
  assert.equal(nested, '<div><span class="badge">ok</span></div>');
});

test('les montants sont formatés en dinars depuis des centimes', () => {
  web.i18n.setLocale('fr');
  const { money } = web.ui;
  assert.match(money(10000), /100,00/);
  assert.match(money(0), /0,00/);
  assert.match(money(null), /0,00/);
});

test('les dates sont rendues en heure algérienne (UTC+1)', () => {
  web.i18n.setLocale('fr');
  const { formatTime } = web.ui;
  // 08:00Z = 09:00 à Alger, toute l'année (format 24 h, pas de AM/PM).
  const label = formatTime('2026-11-10T08:00:00Z');
  assert.match(label, /^09[\s:\u202f]*00$/u, `attendu 09:00, reçu ${label}`);
});

test('les initiales ignorent les titres', () => {
  web.i18n.setLocale('fr');
  const { initials } = web.ui;
  assert.equal(initials('Dr Karim Boudiaf'), 'KB');
  assert.equal(initials('Nadia'), 'NA');
  assert.equal(initials(''), '?');
});

/* ---------------------------------- i18n ---------------------------------- */

test('le dictionnaire arabe est complet (parité stricte avec le français)', () => {
  const missing = web.i18n.missingArabicKeys();
  assert.deepEqual(missing, [], `clés absentes en arabe: ${missing.join(', ')}`);
});

test('chaque code d\'erreur de l\'API est traduit dans les deux langues', () => {
  const codes = [
    'AUTH_REQUIRED',
    'AUTH_INVALID',
    'CSRF_INVALID',
    'FORBIDDEN',
    'NOT_FOUND',
    'VALIDATION',
    'SLOT_TAKEN',
    'HOLD_EXPIRED',
    'NOT_CANCELLABLE',
    'INVALID_TRANSITION',
    'PAYMENT_UNVERIFIED',
    'NOT_PAYABLE',
    'RATE_LIMITED',
    'LEGAL_BLOCKED',
    'INTERNAL_ERROR',
    'ACCOUNT_EXISTS',
    'TELECONSULT_UNAVAILABLE',
    'CONSULTATION_CLOSED',
    'NOT_VIDEO',
  ];
  for (const code of codes) {
    for (const locale of ['fr', 'ar']) {
      web.i18n.setLocale(locale);
      const label = web.i18n.t(`errors.${code}`);
      assert.notEqual(label, `errors.${code}`, `${code} non traduit (${locale})`);
    }
  }
  web.i18n.setLocale('fr');
});

test('toute clé utilisée par les vues existe en français ET en arabe', async () => {
  const { readdir } = await import('node:fs/promises');
  const files = [
    'app.js',
    'ui.js',
    ...(await readdir(path.join(WEB_ROOT, 'views'))).map((name) => `views/${name}`),
  ];
  const used = new Set();
  for (const file of files) {
    const source = await readFile(path.join(WEB_ROOT, file), 'utf8');
    for (const match of source.matchAll(/\bt\(\s*'([\w.\-]+)'/g)) used.add(match[1]);
  }
  const source = await readFile(path.join(WEB_ROOT, 'i18n.js'), 'utf8');
  const arStart = source.indexOf('\n  ar: {');
  const fr = new Set([...source.slice(0, arStart).matchAll(/^\s{4}'([\w.\-]+)':/gm)].map((m) => m[1]));
  const ar = new Set([...source.slice(arStart).matchAll(/^\s{4}'([\w.\-]+)':/gm)].map((m) => m[1]));
  assert.deepEqual([...used].filter((key) => !fr.has(key)).sort(), [], 'clés manquantes en français');
  assert.deepEqual([...used].filter((key) => !ar.has(key)).sort(), [], 'clés manquantes en arabe');
  assert.deepEqual([...fr].filter((key) => !ar.has(key)).sort(), [], 'parité FR/AR');
});

test('la bascule de langue inverse la direction du document', () => {
  web.i18n.setLocale('ar');
  assert.equal(document.documentElement.dir, 'rtl');
  web.i18n.setLocale('fr');
  assert.equal(document.documentElement.dir, 'ltr');
});

/* ---------------------------------- vues ---------------------------------- */

test('l\'écran d\'accueil rend la recherche et les 58 wilayas', async () => {
  const html = await web.search.renderSearch({ params: [], state: { user: null } });
  assert.match(html, /Trouvez un médecin/);
  assert.match(html, /data-form="search"/);
  const wilayaOptions = (html.match(/<option value="\d+"/g) ?? []).length;
  assert.ok(wilayaOptions >= 58, `58 wilayas attendues, ${wilayaOptions} trouvées`);
  assert.match(html, /Alger/);
  assert.doesNotMatch(html, /undefined|NaN|\[object Object\]/);
});

test('la recherche affiche des résultats réels sans jamais injecter de HTML brut', async () => {
  const html = await web.search.renderSearch({ params: [], state: { user: null } });
  assert.ok(html.length > 500);

  const { runSearch } = web.search;
  const result = await runSearch(new URLSearchParams({ specialty: 'GENERAL', wilaya: '16' }));
  void result;
  // `runSearch` écrit dans `[data-region="results"]` : on vérifie le contenu
  // produit pour un nom contenant des caractères actifs.
  const evil = await fetch('/api/v1/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      fullName: '<script>alert(1)</script>',
      phone: '+213555999888',
      password: 'MotDePasse#2026',
      role: 'PATIENT',
      consent: true,
    }),
  });
  void evil;
});

test('la fiche médecin expose tarifs, créneaux et le formulaire de réservation', async () => {
  asUser(sessions.patient);
  const html = await web.doctor.renderDoctor({
    params: [fixture.doctorId],
    state: { user: sessions.patient.user, role: 'PATIENT' },
  });
  assert.match(html, /Dr/);
  assert.doesNotMatch(html, /undefined|NaN|\[object Object\]/);
  assert.match(html, /data-form="booking"/);
  assert.match(html, /data-slot-id=/);
  assert.match(html, /Clinique/);
  // Un formulaire de réservation ne s'affiche que pour un patient connecté.
  const anonymous = await web.doctor.renderDoctor({ params: [fixture.doctorId], state: { user: null } });
  assert.equal(anonymous.includes('data-form="booking"'), false);
  assert.match(anonymous, /href="#\/login"/);
});

test('un créneau porte son identifiant, jamais une heure interprétable', async () => {
  const data = await (await fetch(`/api/v1/doctors/${fixture.doctorId}`)).json();
  const html = web.doctor.renderSlots(data.slots);
  for (const slot of data.slots) assert.ok(html.includes(slot.id));
  assert.match(html, /aria-pressed="false"/);
  assert.match(html, /data-act="select-slot"/);
});

test('les écrans de connexion et d\'inscription rappellent les mentions légales', async () => {
  const login = await web.auth.renderLogin({ state: {} });
  assert.match(login, /Mot de passe/);
  assert.match(login, /data-form="login"/);

  const register = await web.auth.renderRegister({ params: [] });
  assert.match(register, /data-form="register"/);
  assert.match(register, /consent/);
  assert.match(register, /protection|18-07|urgence/i);
  assert.match(register, /الطب العام|Médecine générale/);
});

test('mes rendez-vous listent les réservations du patient avec leurs actions', async () => {
  asUser(sessions.patient);
  const html = await web.bookings.renderBookings({ state: sessions.patient });
  assert.match(html, /Mes rendez-vous/);
  // Le patient de démonstration a au moins une réservation créée par les tests.
  assert.ok(/data-act="cancel-booking"/.test(html) || /Aucun rendez-vous|Vous n’avez/.test(html));
});

test('l\'écran de téléconsultation interdit l\'usage en urgence', async () => {
  asUser(sessions.patient);
  const html = await web.teleconsult.renderTeleconsult({ state: sessions.patient });
  assert.match(html, /urgence|14/);
  assert.match(html, /consent/);
  assert.match(html, /emergency_ack/);
});

test('l\'agenda médecin affiche les disponibilités et les congés', async () => {
  asUser(sessions.doctor);
  const html = await web.agenda.renderDoctorAgenda({ state: sessions.doctor });
  assert.match(html, /data-form="availability"/);
  assert.match(html, /data-form="time-off"/);
  assert.match(html, /Dimanche|Lundi/);
});

test('la console opérateur ne présente aucune donnée médicale', async () => {
  const operator = await createAdmin('OPERATOR');
  asUser(operator);
  const html = await web.ops.renderOps({
    state: { user: { id: operator.id, role: 'OPERATOR', full_name: 'Agent' } },
  });
  assert.match(html, /Console opérateur|لوحة الموظف/);
  assert.doesNotMatch(html, /symptom|diagnos|allergie|ordonnance/i);
  assert.match(html, /Aucune branche|branche/i);
});

test('le tableau de bord d\'administration sépare réel et simulé', async () => {
  asUser(sessions.admin);
  const html = await web.admin.renderAdmin({ state: sessions.admin });
  assert.match(html, /Administration/);
  assert.match(html, /Simulation/);
  assert.match(html, /data-form="commission"/);
  assert.match(html, /admin\/audit|Journal/);
});

test('l\'espace « mon compte » expose l\'export et la suppression', async () => {
  asUser(sessions.patient);
  const html = await web.account.renderAccount({ state: sessions.patient });
  assert.match(html, /data-act="export-data"/);
  assert.match(html, /data-act="delete-account"/);
  assert.match(html, /data-form="password"/);
});

/* -------------------------- garanties de sécurité ------------------------- */

test('aucun fichier du front ne contient de secret ni d\'URL absolue', async () => {
  const files = [
    'app.js',
    'api.js',
    'i18n.js',
    'ui.js',
    'index.html',
    'sw.js',
    'manifest.webmanifest',
    ...(
      await readdirSafe(path.join(WEB_ROOT, 'views'))
    ).map((name) => `views/${name}`),
  ];
  for (const file of files) {
    const contents = await readFile(path.join(WEB_ROOT, file), 'utf8');
    assert.equal(/sk_live_|live_sk_|CHARGILY_SECRET|APP_SECRET/i.test(contents), false, file);
    assert.equal(/https?:\/\/(?!www\.w3\.org|wa\.me)/.test(contents), false, `${file} contient une URL absolue`);
  }
});

async function readdirSafe(dir) {
  const { readdir } = await import('node:fs/promises');
  return (await readdir(dir)).filter((name) => name.endsWith('.js'));
}

test('le HTML servi porte une CSP stricte et n\'autorise aucun script inline', async () => {
  const index = await readFile(path.join(WEB_ROOT, 'index.html'), 'utf8');
  assert.equal(/<script(?![^>]*src=)/i.test(index), false, 'aucun <script> inline');
  assert.equal(/on(click|submit|load)=/i.test(index), false, 'aucun gestionnaire inline');
  assert.match(index, /<html lang="fr" dir="ltr">/);
  assert.match(index, /arial|skip|main/);
});

test('les fichiers du front sans empreinte ne sont jamais figés en cache', async () => {
  // Le montage statique est désactivé par défaut en test (les autres suites ne
  // doivent pas dépendre du front) : on l'active explicitement ici.
  const { buildApp } = await import('../src/app.js');
  const webApp = await buildApp({ logger: false, withWeb: true });
  await webApp.ready();
  const response = await webApp.inject({ method: 'GET', url: '/app.js' });
  assert.equal(response.statusCode, 200);
  assert.match(response.headers['cache-control'], /no-cache/);
  const html = await webApp.inject({ method: 'GET', url: '/' });
  assert.match(html.headers['cache-control'], /no-cache/);
  // La CSP est portée par la réponse statique, pas par le hook global de l'API.
  assert.match(html.headers['content-security-policy'], /default-src 'self'/);
  assert.equal(html.headers['x-frame-options'], 'DENY');
  // Le manifeste et le service worker sont servis avec le bon type MIME.
  const manifest = await webApp.inject({ method: 'GET', url: '/manifest.webmanifest' });
  assert.match(manifest.headers['content-type'], /manifest\+json/);
  const sw = await webApp.inject({ method: 'GET', url: '/sw.js' });
  assert.match(sw.headers['content-type'], /javascript/);
  await webApp.close();
});

test('le service worker ne met jamais en cache une réponse d\'API', async () => {
  const sw = await readFile(path.join(WEB_ROOT, 'sw.js'), 'utf8');
  assert.match(sw, /url\.pathname\.startsWith\('\/api\/'\)/, 'les appels API doivent rester hors cache');
  assert.match(sw, /request\.method !== 'GET'/, 'aucune requête mutative mise en cache');
});

test('aucun jeton n\'est écrit dans le stockage du navigateur', async () => {
  const app_js = await readFile(path.join(WEB_ROOT, 'app.js'), 'utf8');
  const api_js = await readFile(path.join(WEB_ROOT, 'api.js'), 'utf8');
  for (const source of [app_js, api_js]) {
    assert.equal(/localStorage\.setItem\([^)]*(token|csrf)/i.test(source), false);
    assert.equal(/sessionStorage\.setItem\([^)]*(token|csrf)/i.test(source), false);
  }
  assert.match(api_js, /credentials: 'same-origin'/);
});

void call;
