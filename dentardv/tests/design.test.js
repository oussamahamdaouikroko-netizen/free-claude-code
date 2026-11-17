'use strict';
/**
 * Design layer: SVG icons, sound effects and the Google Sheets export card.
 *
 * The renderer has no build step, so these modules are loaded by index.html in
 * the real app and executed here in jsdom exactly as the browser would.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const RENDERER = path.join(__dirname, '..', 'src', 'renderer', 'js');

/** Loads real renderer scripts into a jsdom window, in <script> order. */
function boot(files, html = '<!doctype html><html><body></body></html>') {
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'http://localhost/' });
  for (const file of files) {
    const script = dom.window.document.createElement('script');
    script.textContent = fs.readFileSync(path.join(RENDERER, file), 'utf8');
    dom.window.document.body.appendChild(script);
  }
  return dom;
}

test('the icon set renders valid, self-contained SVG', () => {
  const dom = boot(['icons.js']);
  const { Icons, document } = dom.window;

  assert.ok(Icons.names().length >= 45, 'a full set, not a handful of glyphs');
  for (const name of Icons.names()) {
    const svg = Icons.el(name);
    assert.equal(svg.tagName.toLowerCase(), 'svg', `${name} is an svg`);
    assert.equal(svg.getAttribute('viewBox'), '0 0 24 24', `${name} uses the 24px grid`);
    assert.equal(svg.getAttribute('stroke'), 'currentColor', `${name} inherits the text colour`);
    assert.equal(svg.getAttribute('aria-hidden'), 'true', `${name} is decorative by default`);
    assert.ok(svg.innerHTML.length > 10, `${name} has geometry`);
    assert.doesNotMatch(svg.innerHTML, /https?:/, `${name} loads nothing from the network`);
  }

  // No emoji is left in the set, and every name used by the UI exists.
  for (const name of ['dashboard', 'calendar', 'users', 'tooth', 'wallet', 'chart', 'whatsapp', 'settings']) {
    assert.ok(Icons.has(name), `navigation icon ${name}`);
  }
  assert.equal(Icons.has('nope'), false);

  const labelled = Icons.el('print', { label: 'Imprimer', size: 30 });
  assert.equal(labelled.getAttribute('role'), 'img');
  assert.equal(labelled.getAttribute('aria-label'), 'Imprimer');
  assert.equal(labelled.getAttribute('width'), '30');
  assert.equal(document.querySelectorAll('svg').length, 0, 'el() does not touch the document');
});

test('the iconizer replaces emoji bullets with SVG, in both languages', () => {
  const dom = boot(['icons.js', 'i18n.js', 'ui.js'], `<!doctype html><html><body>
    <button id="pay">💵 Payer la séance</button>
    <button id="ar" dir="rtl">🖨️ طبع التقرير</button>
    <div id="plain">Aucun emoji ici</div>
    <div id="unknown">☂️ Parapluie</div>
  </body></html>`);
  const { UI, document } = dom.window;

  UI.iconize(document.body);

  const pay = document.getElementById('pay');
  assert.equal(pay.querySelectorAll('svg').length, 1);
  assert.equal(pay.textContent, 'Payer la séance', 'the emoji is gone, the words stay');
  assert.ok(pay.classList.contains('has-icon'));

  const ar = document.getElementById('ar');
  assert.equal(ar.querySelectorAll('svg').length, 1, 'Arabic labels get the same icon');
  assert.equal(ar.textContent, 'طبع التقرير');

  assert.equal(document.getElementById('plain').querySelectorAll('svg').length, 0);
  // An emoji with no match is left untouched instead of being deleted.
  assert.equal(document.getElementById('unknown').textContent, '☂️ Parapluie');
});

test('sounds are opt-out and stay silent without a Web Audio context', () => {
  const dom = boot(['sfx.js']);
  const { SFX } = dom.window;
  assert.equal(typeof SFX.click, 'function');
  assert.equal(SFX.isEnabled(), true, 'on by default');
  assert.equal(SFX.setEnabled(false), false);
  assert.equal(dom.window.localStorage.getItem('dentardv.sounds'), 'off');
  assert.equal(SFX.setEnabled(true), true);
  assert.equal(dom.window.localStorage.getItem('dentardv.sounds'), 'on');

  // jsdom has no AudioContext: every call must be a no-op, never a crash.
  assert.equal(dom.window.AudioContext, undefined);
  assert.doesNotThrow(() => {
    SFX.click();
    SFX.success();
    SFX.error();
    SFX.open();
  });

  // The global click delegation is what makes every button audible.
  const button = dom.window.document.createElement('button');
  dom.window.document.body.append(button);
  SFX.install();
  assert.doesNotThrow(() => button.click());
});
