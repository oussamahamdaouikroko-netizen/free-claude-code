'use strict';
/**
 * Renderer integration test (jsdom, no Electron).
 *
 * Loads the real index.html, evaluates the real scripts and boots the real
 * shell against a fake main process. It verifies what a pharmacist sees:
 * the ten sections of the navigation, the dashboard in both languages, the
 * right-to-left switch, and a working settings form.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const RENDERER = path.join(ROOT, 'src', 'renderer');

const SCRIPTS = [
  'js/i18n.js',
  'js/icons.js',
  'js/api.js',
  'js/ui.js',
  'js/app.js',
  'js/pages/dashboard.js',
  'js/pages/planned-sections.js',
  'js/pages/settings.js',
];

/** A fake main process with the same surface as the real IPC allowlist. */
function fakeBackend() {
  const state = {
    settings: {
      language: 'fr',
      setup_completed: false,
      pharmacy_name: '',
      pharmacist_name: '',
      pharmacy_phone: '',
      pharmacy_address: '',
      currency: 'DZD',
      expiry_threshold_1: 90,
      expiry_threshold_2: 60,
      expiry_threshold_3: 30,
      low_stock_threshold: 10,
      allow_negative_stock: false,
      backup_enabled: true,
      backup_keep: 30,
      last_backup_at: '',
      audit_keep_days: 730,
    },
    calls: [],
    backups: [],
  };

  const invoke = async (method, payload = {}) => {
    state.calls.push({ method, payload });
    switch (method) {
      case 'app:info':
        return {
          name: 'PharmaGestion DZ',
          version: '0.1.0',
          platform: 'win32',
          electron: '38.0.0',
          schemaVersion: 1,
          dataDir: '/tmp/pharmagestion/data',
          databaseFile: '/tmp/pharmagestion/data/pharmagestion.sqlite',
          today: '2026-10-25',
        };
      case 'settings:all':
        return { ...state.settings };
      case 'settings:set': {
        const values = payload.values || { [payload.key]: payload.value };
        for (const [key, value] of Object.entries(values)) {
          if (key === 'expiry_threshold_1' && Number(value) <= state.settings.expiry_threshold_2) {
            const error = new Error('thresholds');
            error.code = 'INVALID_THRESHOLDS';
            throw error;
          }
          state.settings[key] = value;
        }
        return { ...state.settings };
      }
      case 'settings:language':
        state.settings.language = payload.language;
        return { language: payload.language };
      case 'dashboard:summary':
        return {
          pharmacyName: state.settings.pharmacy_name,
          language: state.settings.language,
          today: '2026-10-25',
          database: { file: 'x', sizeBytes: 4096, schemaVersion: 1, integrityOk: true },
          backups: {
            enabled: true,
            due: true,
            keep: 30,
            last: null,
            count: state.backups.length,
          },
          modules: ['dashboard', 'stock', 'purchases', 'sales', 'customer_debts', 'supplier_debts', 'expiry', 'import_export', 'reports', 'settings'],
          counters: {
            medicines: 0,
            batches: 0,
            expiringSoon: 0,
            expired: 0,
            customerDebtCents: 0,
            supplierDebtCents: 0,
          },
          recentActivity: [],
        };
      case 'backup:list':
        return state.backups;
      case 'backup:create': {
        const entry = {
          name: 'pharmagestion-manual-20261025-120000-000.sqlite',
          path: '/tmp/pharmagestion/data/backups/pharmagestion-manual-20261025-120000-000.sqlite',
          kind: 'manual',
          size: 20480,
          created_at: '2026-10-25T12:00:00.000Z',
        };
        state.backups.unshift(entry);
        return entry;
      }
      case 'audit:list':
        return [];
      case 'db:stats':
        return {
          file: '/tmp/pharmagestion/data/pharmagestion.sqlite',
          sizeBytes: 4096,
          schemaVersion: 1,
          latestSchemaVersion: 1,
          tables: ['settings', 'audit_log'],
          journalMode: 'wal',
          foreignKeys: true,
        };
      case 'db:integrity':
        return { ok: true, message: 'ok', schemaVersion: 1 };
      case 'app:openFolder':
        return { opened: payload.kind };
      default:
        throw new Error(`unexpected method ${method}`);
    }
  };

  return { state, invoke };
}

async function bootRenderer() {
  const html = fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8').replace(/<script src="[^"]+"><\/script>/g, '');
  const dom = new JSDOM(html, { url: 'file:///C:/app/index.html', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  window.scrollTo = () => {};

  const backend = fakeBackend();

  // Run the real preload script against a fake ipcRenderer. This exercises the
  // actual bridge (method-name validation, unwrapping, typed errors) instead of
  // a hand-written stub.
  const fakeIpcRenderer = {
    invoke: async (channel, method, payload) => {
      if (channel !== 'pharmagestion:invoke') throw new Error(`unexpected channel ${channel}`);
      try {
        const data = await backend.invoke(method, payload);
        return { ok: true, data };
      } catch (error) {
        return { ok: false, error: { code: error.code || 'INTERNAL_ERROR', message: error.message } };
      }
    },
    on: () => {},
    removeListener: () => {},
  };
  const fakeRequire = (name) => {
    if (name !== 'electron') throw new Error(`unexpected require(${name}) in the preload`);
    return {
      contextBridge: {
        exposeInMainWorld: (key, api) => {
          window[key] = api;
        },
      },
      ipcRenderer: fakeIpcRenderer,
    };
  };
  const preloadSource = fs.readFileSync(path.join(ROOT, 'src', 'preload', 'index.js'), 'utf8');
  // eslint-disable-next-line no-new-func
  new Function('require', 'process', 'window', preloadSource)(
    fakeRequire,
    { platform: 'win32' },
    window,
  );
  assert.ok(window.pharmagestion, 'the preload exposed its bridge');
  assert.equal(typeof window.pharmagestion.invoke, 'function');

  for (const script of SCRIPTS) {
    // The same files the packaged application loads, in the same order.
    window.eval(fs.readFileSync(path.join(RENDERER, script), 'utf8'));
  }

  await window.AppNav.boot();
  return { dom, window, backend };
}

/**
 * Wait until `condition()` is true. CI runners are much slower than a laptop,
 * so a fixed `setTimeout(30)` is a flaky test waiting to happen: poll instead,
 * with a generous ceiling.
 */
async function waitFor(condition, description, timeoutMs = 5000) {
  const started = Date.now();
  for (;;) {
    if (condition()) return;
    if (Date.now() - started > timeoutMs) {
      throw new Error(`timed out waiting for ${description}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('the shell boots and renders the ten sections', async () => {
  const { window } = await bootRenderer();
  const navItems = window.document.querySelectorAll('.nav-item');
  assert.equal(navItems.length, 10, 'all ten navigation entries are present');
  const labels = [...navItems].map((item) => item.textContent.trim());
  assert.ok(labels.some((label) => label.includes('Tableau de bord')));
  assert.ok(labels.some((label) => label.includes('Alertes de péremption')));
  assert.ok(labels.some((label) => label.includes('Réglages et sauvegardes')));

  // Eight sections are honest placeholders, two are functional.
  assert.equal(window.AppNav.IMPLEMENTED.size, 2);
  assert.ok(window.document.querySelector('.nav-item.is-active'));
  assert.match(window.document.querySelector('.page-title').textContent, /Tableau de bord/);
});

test('the dashboard shows real system state, not fake numbers', async () => {
  const { window } = await bootRenderer();
  const text = window.document.querySelector('#content').textContent;
  assert.match(text, /Bienvenue/);
  assert.match(text, /Base de données/);
  assert.match(text, /Saine/, 'the database health is displayed');
  assert.match(text, /0,00 DA/, 'empty debts are shown as zero money');
  assert.match(text, /Aucune action enregistrée/, 'empty audit trail is explained');
  // The phase reminder is honest about what is not built yet.
  assert.match(text, /Phase 2/);
});

test('switching to Arabic mirrors the layout and translates the shell', async () => {
  const { window, backend } = await bootRenderer();
  await window.AppNav.switchLanguage('ar');

  assert.equal(window.document.documentElement.getAttribute('dir'), 'rtl');
  assert.equal(window.document.documentElement.getAttribute('lang'), 'ar');
  const nav = window.document.querySelectorAll('.nav-item');
  assert.equal(nav.length, 10);
  assert.match([...nav].map((item) => item.textContent).join(' '), /[\u0600-\u06FF]/);
  assert.match(window.document.querySelector('.page-title').textContent, /[\u0600-\u06FF]/);

  // The choice is persisted through the main process.
  const saved = backend.state.calls.filter((call) => call.method === 'settings:language');
  assert.equal(saved.length, 1);
  assert.equal(saved[0].payload.language, 'ar');

  // And switching back restores left-to-right.
  await window.AppNav.switchLanguage('fr');
  assert.equal(window.document.documentElement.getAttribute('dir'), 'ltr');
});

test('a planned section explains itself instead of showing an empty table', async () => {
  const { window } = await bootRenderer();
  await window.AppNav.navigate('expiry');
  const text = window.document.querySelector('#content').textContent;
  assert.match(text, /Cette partie est prévue/);
  assert.match(text, /90, 60 et 30 jours/);
  assert.match(text, /Phase 2/);
  assert.match(window.document.querySelector('.page-title').textContent, /Alertes de péremption/);
  assert.equal(window.document.querySelectorAll('table').length, 0);
});

test('the settings screen saves the pharmacy identity', async () => {
  const { window, backend } = await bootRenderer();
  await window.AppNav.navigate('settings');

  const nameInput = window.document.getElementById('set-pharmacy-name');
  assert.ok(nameInput, 'the identity form is rendered');
  nameInput.value = 'Pharmacie El Nour';
  const form = nameInput.closest('form');
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));

  // Wait for the async save round-trip.
  await waitFor(
    () => backend.state.calls.some((call) => call.method === 'settings:set'),
    'settings:set to be called',
  );
  const saveCall = backend.state.calls.find((call) => call.method === 'settings:set');
  assert.ok(saveCall, 'settings:set was called');
  assert.equal(saveCall.payload.values.pharmacy_name, 'Pharmacie El Nour');
  assert.equal(backend.state.settings.pharmacy_name, 'Pharmacie El Nour');
});

test('an invalid threshold shows a translated error, not a crash', async () => {
  const { window, backend } = await bootRenderer();
  await window.AppNav.navigate('settings');
  const firstThreshold = window.document.querySelector('#content input[type="number"]');
  firstThreshold.value = '5';
  firstThreshold.closest('form').dispatchEvent(
    new window.Event('submit', { bubbles: true, cancelable: true }),
  );
  await waitFor(
    () => window.document.querySelector('.toast-error'),
    'the translated validation error to appear',
  );

  const toast = window.document.querySelector('.toast-error');
  assert.ok(toast, 'an error toast is shown');
  assert.match(toast.textContent, /seuils doivent être décroissants/);
  assert.ok(backend.state.settings.expiry_threshold_1 >= 90, 'nothing invalid was stored');
});

test('a backup can be created from the dashboard', async () => {
  const { window, backend } = await bootRenderer();
  const backupButton = [...window.document.querySelectorAll('#content button')].find((button) =>
    button.textContent.includes('Sauvegarder maintenant'),
  );
  assert.ok(backupButton, 'the quick action exists');
  backupButton.click();
  await waitFor(() => backend.state.backups.length === 1, 'the backup to be created');
  await waitFor(
    () => window.document.querySelector('.toast-success'),
    'the confirmation toast to appear',
  );

  assert.ok(backend.state.calls.some((call) => call.method === 'backup:create'));
  assert.equal(backend.state.backups.length, 1);
});

test('the language toggle in the top bar is visible and works', async () => {
  const { window } = await bootRenderer();
  const toggle = window.document.querySelector('.topbar .lang-toggle');
  assert.ok(toggle, 'visible language switch');
  assert.match(toggle.textContent, /العربية/);
  toggle.click();
  await waitFor(
    () => window.document.documentElement.getAttribute('dir') === 'rtl',
    'the Arabic layout to be applied',
  );
  assert.equal(window.document.documentElement.getAttribute('dir'), 'rtl');
  assert.match(window.document.querySelector('.topbar .lang-toggle').textContent, /Français/);
});

test('unknown routes fall back to the dashboard instead of a blank screen', async () => {
  const { window } = await bootRenderer();
  await window.AppNav.navigate('does-not-exist');
  assert.match(window.document.querySelector('.page-title').textContent, /Tableau de bord/);
  assert.ok(window.document.querySelectorAll('.nav-item.is-active').length === 1);
});
