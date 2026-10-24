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
      // Enforce Chromium-strict attribute name validation (catches string-spread bugs like ...'A5').
      const origSetAttr = window.Element.prototype.setAttribute;
      window.Element.prototype.setAttribute = function setAttributeStrict(name, val) {
        if (!/^[A-Za-z_:][A-Za-z0-9_.:-]*$/.test(String(name))) {
          throw new Error(`InvalidCharacterError: '${name}' is not a valid attribute name`);
        }
        return origSetAttr.call(this, name, val);
      };
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
  assert.equal($$('.nav-item').length, 9, 'all 9 navigation entries are rendered');
  assert.ok($('.brand-logo-img'), 'brand stethoscope/cross logo image is rendered');
  await waitFor(() => $('.kpi'), { label: 'dashboard KPIs' });
  assert.ok($$('.kpi').length >= 4);
  assert.match($('.page-title').textContent, /Bonjour|مرحبا/);
  assert.ok($('.appt'), 'seeded agenda is visible');
  assert.ok($$('.dept-tab').length >= 3, 'multi-department filter tabs are visible');

  // Visit every screen and check that its header is set and no crash happened.
  const screens = ['agenda', 'prescriptions', 'patients', 'treatments', 'expenses', 'reports', 'whatsapp', 'settings', 'dashboard'];
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

  // Prescriptions module: composer + history + Algerian drugs catalog + certificates.
  $('[data-page="prescriptions"]').click();
  await waitFor(() => $('.rx-composer-grid'), { label: 'prescription composer grid' });
  assert.ok($('.rx-header-strip'), 'live clinic/doctor/specialty prescription header preview');
  await waitFor(() => $$('.drug-option').length >= 3, { label: 'Algerian medications search list' });
  // Click an Algerian drug to add it into the prescription composer.
  $$('.drug-option')[0].click();
  await waitFor(() => $$('.rx-item-card').length >= 1, { label: 'drug added to prescription' });

  // Patients list contains the seeded people.
  $('[data-page="patients"]').click();
  await waitFor(() => $$('table.list tbody tr').length > 0, { label: 'patient rows' });

  // Open a patient file (dialog with prescriptions + history + payments).
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

  // Navigation uses real SVG icons, not emoji.
  assert.equal($$('.nav-item svg').length, 9, 'one icon per navigation entry');
  assert.doesNotMatch($$('.nav-item .label').map((node) => node.textContent).join(''), /[\u{1F300}-\u{1FAFF}]/u);

  // Reports: daily then monthly, with the Google Sheets export card.
  $('[data-page="reports"]').click();
  await waitFor(() => $('.tabs'), { label: 'report tabs' });
  await waitFor(() => $$('.content .btn').some((btn) => /Google Sheets/.test(btn.textContent)), {
    label: 'export card',
  });
  const exportButton = $$('.content .btn').find((btn) => /Google Sheets/.test(btn.textContent) && btn.querySelector('svg'));
  assert.ok(exportButton, 'the export button carries an SVG icon');

  $$('.tabs button')[1].click();
  await waitFor(() => $('.chart'), { label: 'monthly chart' });
  assert.ok($$('.chart .bar').length > 10);

  // Downloading the .xlsx through the demo server produces a real file.
  window.API.invoke('export:sheet', { kind: 'daily' }).then((result) => {
    window.__exportResult = result;
  });
  await waitFor(() => window.__exportResult, { label: 'generated workbook' });
  assert.equal(window.__exportResult.ok, true);
  assert.match(window.__exportResult.filename, /\.xlsx$/);
  assert.ok(window.__exportResult.file, 'the demo server stores it on disk');

  // Language switch to Arabic flips the document direction and translates the UI.
  $('.sidebar-foot button').click();
  await waitFor(() => window.document.documentElement.dir === 'rtl', { label: 'RTL switch' });
  await waitFor(
    () => /[\u0600-\u06FF]/.test($('[data-page="agenda"] .label')?.textContent || ''),
    { label: 'Arabic navigation labels' },
  );
  assert.match($('[data-page="agenda"] .label').textContent, /[\u0600-\u06FF]/);

  // Verify Settings screen renders all cards cleanly in Arabic RTL (regression guard).
  $('[data-page="settings"]').click();
  await waitFor(() => $$('.content .card').length >= 10, { label: 'Arabic Settings cards' });
  assert.ok(!$('.content .error-text'), 'no render error card in Arabic Settings');

  // Mini Chat + Secretary queue advance in Arabic RTL.
  $('[data-page="dashboard"]').click();
  await waitFor(() => $('.queue-live-bar'), { label: 'live queue bar on dashboard' });
  assert.ok($('.chat-fab'), 'floating Mini Chat button is rendered');
  $('.chat-fab').click();
  await waitFor(() => $('.mini-chat:not(.hidden)'), { label: 'Mini Chat panel opened' });
  await waitFor(() => $$('.mini-chat .chat-item').length >= 3, { label: 'seeded Mini Chat items' });

  const initialItems = $$('.mini-chat .chat-item').length;
  $('.queue-live-bar .btn.primary').click();
  await waitFor(() => $$('.mini-chat .chat-item').length > initialItems, {
    label: 'new turn_now and queue_ahead messages in Mini Chat',
  });

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
