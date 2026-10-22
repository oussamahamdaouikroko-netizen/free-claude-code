'use strict';
/**
 * Renderer smoke test.
 *
 * Boots the real index.html in jsdom against the real HTTP demo server and
 * clicks through every screen. This catches the classic Electron-only bugs:
 * a missing script, a broken selector, a crash during render.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { safeRemove } = require('./helpers');
const { JSDOM, VirtualConsole } = require('jsdom');
const { startDemo } = require('../demo/server');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, { timeout = 5000, label = 'condition' } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = check();
    if (value) return value;
    await sleep(40);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

test('the full UI boots and every screen renders', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dentardv-ui-'));
  const demo = await startDemo({ port: 0, host: '127.0.0.1', dataDir });

  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (error) => errors.push(`jsdom: ${error.message}`));
  virtualConsole.on('error', (...args) => errors.push(`console.error: ${args.join(' ')}`));

  const dom = await JSDOM.fromURL(demo.url, {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      // jsdom has no fetch: forward relative requests to the demo server.
      window.fetch = (input, init) => fetch(new URL(String(input), demo.url), init);
      window.matchMedia = window.matchMedia || (() => ({
        matches: false,
        addListener() {},
        removeListener() {},
        addEventListener() {},
        removeEventListener() {},
      }));
    },
  });

  const { window } = dom;
  const $ = (selector) => window.document.querySelector(selector);
  const $$ = (selector) => [...window.document.querySelectorAll(selector)];

  t.after(async () => {
    dom.window.close();
    await sleep(150); // let pending fetches/timers settle before the server dies
    await demo.stop();
    safeRemove(dataDir);
  });

  // Demo mode auto-unlocks, so we land on the dashboard.
  await waitFor(() => $('.sidebar'), { label: 'application shell' });
  assert.equal($$('.nav-item').length, 8, 'all navigation entries are rendered');
  await waitFor(() => $('.kpi'), { label: 'dashboard KPIs' });
  assert.ok($$('.kpi').length >= 4);
  assert.match($('.page-title').textContent, /Bonjour|مرحبا/);
  assert.ok($('.appt'), 'seeded agenda is visible');

  // Visit every screen and check that its header is set and no crash happened.
  const screens = ['agenda', 'patients', 'treatments', 'expenses', 'reports', 'whatsapp', 'settings', 'dashboard'];
  for (const screen of screens) {
    const button = $(`[data-page="${screen}"]`);
    assert.ok(button, `nav button for ${screen}`);
    button.click();
    await waitFor(() => {
      const title = $('.page-title')?.textContent || '';
      return title && title.length > 1;
    }, { label: `${screen} header` });
    await sleep(250); // let the async render settle
    assert.ok($('.content')?.children.length > 0, `${screen} renders content`);
  }

  // Patients list contains the seeded people.
  $('[data-page="patients"]').click();
  await waitFor(() => $$('table.list tbody tr').length > 0, { label: 'patient rows' });

  // Open a patient file (dialog with history + payments).
  $$('table.list tbody button')[0].click();
  await waitFor(() => $('.modal.wide'), { label: 'patient file modal' });
  await waitFor(() => $$('.modal .table-wrap').length >= 2, { label: 'patient history and payments' });
  assert.ok($$('.modal .table-wrap').length >= 2, 'history and payment tables');
  $('.modal-foot .btn').click();
  await waitFor(() => !$('.modal'), { label: 'modal closed' });

  // Debtors filter: only the patients who still owe money are listed.
  $('[data-page="patients"]').click();
  await waitFor(() => $('.content .tabs'), { label: 'patients filters' });
  const filters = $$('.content .tabs button');
  assert.equal(filters.length, 2, 'two patient filters');
  filters[1].click();
  await waitFor(() => $$('table.list tbody tr').length > 0, { label: 'debtor rows' });
  const debtorRows = $$('table.list tbody tr');
  assert.ok(debtorRows.length >= 1, 'the demo data has patients with debts');
  for (const row of debtorRows) {
    assert.ok(row.querySelector('.badge.danger'), 'a listed patient must still owe money');
  }
  filters[0].click();
  await waitFor(() => $$('table.list tbody tr').length > debtorRows.length, {
    label: 'full list restored',
  });

  // Reports: daily then monthly.
  $('[data-page="reports"]').click();
  await waitFor(() => $('.tabs'), { label: 'report tabs' });
  $$('.tabs button')[1].click();
  await waitFor(() => $('.chart'), { label: 'monthly chart' });
  assert.ok($$('.chart .bar').length > 10);

  // Language switch to Arabic flips the document direction and translates the UI.
  $('.sidebar-foot button').click();
  await waitFor(() => window.document.documentElement.dir === 'rtl', { label: 'RTL switch' });
  await waitFor(
    () => /[\u0600-\u06FF]/.test($('[data-page="agenda"] .label')?.textContent || ''),
    { label: 'Arabic navigation labels' },
  );
  assert.match($('[data-page="agenda"] .label').textContent, /[\u0600-\u06FF]/);

  // Lock → login screen appears (proves the auth guard works end-to-end).
  const lockButton = $$('.sidebar-foot button')[1];
  lockButton.click();
  await waitFor(() => $('.auth-card'), { label: 'login screen' });

  const password = $('.auth-card input[type="password"]');
  password.value = '1234';
  $('.auth-card form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => $('.sidebar'), { label: 'dashboard after login' });

  assert.deepEqual(errors, [], 'no uncaught renderer errors');
});
