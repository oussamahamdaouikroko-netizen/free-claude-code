'use strict';
/**
 * Bilingual interface guarantees.
 *
 * The pharmacist must never see a French sentence inside the Arabic screen (or
 * a raw key such as `settings.title`). These tests keep the two dictionaries
 * in sync and make sure every error code raised by the main process has a
 * translated message.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

/** Load the renderer dictionary into a bare fake window. */
function loadI18n() {
  const sandbox = { console };
  const source = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'js', 'i18n.js'), 'utf8');
  // eslint-disable-next-line no-new-func
  new Function('window', 'console', source)(sandbox, console);
  return sandbox.I18N;
}

const I18N = loadI18n();
const fr = I18N.dictionaries.fr;
const ar = I18N.dictionaries.ar;

test('French and Arabic declare exactly the same keys', () => {
  const frKeys = Object.keys(fr).sort();
  const arKeys = Object.keys(ar).sort();
  const missingInArabic = frKeys.filter((key) => !(key in ar));
  const missingInFrench = arKeys.filter((key) => !(key in fr));
  assert.deepEqual(missingInArabic, [], `missing in Arabic: ${missingInArabic.join(', ')}`);
  assert.deepEqual(missingInFrench, [], `missing in French: ${missingInFrench.join(', ')}`);
  assert.ok(frKeys.length > 150, `expected a full dictionary, got ${frKeys.length} keys`);
});

test('no translation is empty or a placeholder', () => {
  for (const [key, value] of Object.entries(fr)) {
    assert.equal(typeof value, 'string');
    assert.ok(value.trim().length > 0, `empty French value for ${key}`);
    assert.notEqual(value, key, `French value of ${key} is the key itself`);
  }
  for (const [key, value] of Object.entries(ar)) {
    assert.equal(typeof value, 'string');
    assert.ok(value.trim().length > 0, `empty Arabic value for ${key}`);
    assert.notEqual(value, key, `Arabic value of ${key} is the key itself`);
  }
});

test('placeholders match between the two languages', () => {
  const placeholders = (value) => (value.match(/\{\w+\}/g) || []).sort();
  for (const key of Object.keys(fr)) {
    assert.deepEqual(
      placeholders(ar[key]),
      placeholders(fr[key]),
      `placeholder mismatch for ${key}`,
    );
  }
});

test('Arabic strings are actually Arabic where a translation is expected', () => {
  const arabicScript = /[\u0600-\u06FF]/;
  const keysThatMayStayLatin = new Set(['common.french', 'app.electron', 'settings.languageSection']);
  for (const key of Object.keys(ar)) {
    if (key.startsWith('plan.') || key.startsWith('app.') || keysThatMayStayLatin.has(key)) {
      if (key === 'app.name' || key === 'app.electron') continue;
    }
    if (/^(error|audit)\./.test(key)) {
      assert.match(ar[key], arabicScript, `${key} must be translated into Arabic`);
      continue;
    }
    if (keysThatMayStayLatin.has(key)) continue;
    assert.match(ar[key], arabicScript, `${key} must contain Arabic text`);
  }
});

test('language switching changes text and direction', () => {
  assert.equal(I18N.getLanguage(), 'fr');
  assert.equal(I18N.dir(), 'ltr');
  assert.equal(I18N.t('nav.dashboard'), 'Tableau de bord');

  I18N.setLanguage('ar');
  assert.equal(I18N.getLanguage(), 'ar');
  assert.equal(I18N.dir(), 'rtl');
  assert.match(I18N.t('nav.dashboard'), /[\u0600-\u06FF]/);

  I18N.setLanguage('fr');
  assert.equal(I18N.dir(), 'ltr');
});

test('an unsupported language falls back to French instead of breaking', () => {
  I18N.setLanguage('es');
  assert.equal(I18N.getLanguage(), 'fr');
  assert.equal(I18N.isLanguage('es'), false);
  assert.equal(I18N.isLanguage('ar'), true);
});

test('unknown keys are returned visibly instead of undefined', () => {
  assert.equal(I18N.t('does.not.exist'), 'does.not.exist');
  assert.equal(I18N.t('dashboard.welcomeNamed', { name: 'Karim' }), 'Bienvenue, Karim');
  assert.equal(I18N.t('dashboard.welcomeNamed'), 'Bienvenue, {name}', 'missing variables stay visible');
});

test('change listeners are notified once per real change', () => {
  I18N.setLanguage('fr');
  let calls = 0;
  const unsubscribe = I18N.onChange(() => {
    calls += 1;
  });
  I18N.setLanguage('ar');
  I18N.setLanguage('ar'); // no change → no notification
  assert.equal(calls, 1);
  unsubscribe();
  I18N.setLanguage('fr');
  assert.equal(calls, 1);
});

test('numbers are formatted the same way in both languages', () => {
  const value = I18N.formatNumber(1234567.5, { maximumFractionDigits: 1 });
  assert.match(value, /1.*234.*567/);
});

test('every literal translation key used by the code exists', () => {
  const files = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) files.push(full);
    }
  })(path.join(ROOT, 'src', 'renderer', 'js'));

  const missing = new Set();
  for (const file of files) {
    const code = fs.readFileSync(file, 'utf8');
    // t('key') / t("key", {...}) / '#key' style lookups are all literals.
    for (const match of code.matchAll(/\bt\(\s*'([a-zA-Z0-9_.]+)'/g)) {
      if (!(match[1] in fr)) missing.add(match[1]);
    }
  }
  assert.deepEqual([...missing], [], `missing keys: ${[...missing].join(', ')}`);
});

test('every error code raised by the main process is translated', () => {
  const sources = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) sources.push(full);
    }
  })(path.join(ROOT, 'src', 'main'));

  const codes = new Set();
  for (const file of sources) {
    const code = fs.readFileSync(file, 'utf8');
    for (const match of code.matchAll(/new AppError\(\s*'([A-Z_]+)'/g)) codes.add(match[1]);
  }
  assert.ok(codes.size >= 15, `expected several error codes, found ${codes.size}`);

  const missing = [...codes].filter((code) => !(`error.${code}` in fr) || !(`error.${code}` in ar));
  assert.deepEqual(missing, [], `missing translations for: ${missing.join(', ')}`);
});

test('every audited action has a label', () => {
  const actions = ['backup.create', 'backup.restore', 'backup.export', 'settings.language'];
  for (const action of actions) {
    assert.ok(`audit.${action}` in fr, `missing French label for ${action}`);
    assert.ok(`audit.${action}` in ar, `missing Arabic label for ${action}`);
  }
});
