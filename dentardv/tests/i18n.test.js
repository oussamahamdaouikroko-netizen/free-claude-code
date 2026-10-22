'use strict';
/**
 * Translation coverage: every key used by the renderer must exist in both
 * languages, and both dictionaries must stay in sync.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

/** Load i18n.js in a sandbox and capture the dictionary. */
function loadDictionary() {
  const source = fs.readFileSync(path.join(ROOT, 'src/renderer/js/i18n.js'), 'utf8');
  const dict = {};
  const sandbox = {
    window: { I18N: { t: (key) => key } },
    document: {
      documentElement: {},
      addEventListener() {},
      dispatchEvent() {},
    },
    localStorage: { getItem: () => null, setItem() {} },
    CustomEvent: class {},
    Intl,
    console,
  };
  // Expose both dictionaries through a tiny probe appended to the source.
  const probe = source.replace(
    '  window.I18N = {',
    '  window.__DICT = DICT;\n  window.I18N = {',
  );
  vm.runInNewContext(probe, sandbox, { filename: 'i18n.js' });
  Object.assign(dict, sandbox.window.__DICT);
  return dict;
}

test('French and Arabic dictionaries have the same keys', () => {
  const dict = loadDictionary();
  const fr = Object.keys(dict.fr).sort();
  const ar = Object.keys(dict.ar).sort();
  const missingInArabic = fr.filter((key) => !(key in dict.ar));
  const missingInFrench = ar.filter((key) => !(key in dict.fr));
  assert.deepEqual(missingInArabic, [], 'missing Arabic translations');
  assert.deepEqual(missingInFrench, [], 'missing French translations');
  assert.ok(fr.length > 150, `dictionary looks too small: ${fr.length}`);
});

test('no French text is left in the Arabic dictionary', () => {
  const dict = loadDictionary();
  // Keys allowed to stay in Latin script (brand, example numbers, language names).
  const allowed = new Set(['app.name', 'common.french', 'common.arabic', 'auth.clinicPlaceholder']);
  const suspicious = [];
  for (const [key, value] of Object.entries(dict.ar)) {
    if (allowed.has(key)) continue;
    const letters = value.replace(/\{[^}]*\}/g, '').match(/\p{L}+/gu) || [];
    const arabic = letters.filter((word) => /[\u0600-\u06FF]/.test(word)).length;
    if (letters.length >= 2 && arabic === 0) suspicious.push(key);
  }
  assert.deepEqual(suspicious, [], 'Arabic entries without Arabic text');
});

test('every t() key used by the renderer exists in the dictionary', () => {
  const dict = loadDictionary();
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) files.push(full);
    }
  };
  walk(path.join(ROOT, 'src/renderer/js'));

  const used = new Set();
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/\bt\('([a-zA-Z0-9_.]+)'/g)) used.add(match[1]);
  }
  const missing = [...used].filter((key) => !(key in dict.fr) && !(key in dict.ar));
  assert.deepEqual(missing, [], `missing translation keys: ${missing.join(', ')}`);
  assert.ok(used.size > 50, `expected many translated keys, got ${used.size}`);
});

test('error codes returned by services have a translation', () => {
  const dict = loadDictionary();
  const servicesDir = path.join(ROOT, 'src/main');
  const codes = new Set();

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) {
        const source = fs.readFileSync(full, 'utf8');
        for (const match of source.matchAll(/new AppError\(\s*'([A-Z_]+)'/g)) codes.add(match[1]);
        for (const match of source.matchAll(/throw new AppError\('([A-Z_]+)'/g)) codes.add(match[1]);
      }
    }
  };
  walk(servicesDir);

  const missing = [...codes].filter((code) => !(`error.${code}` in dict.fr));
  assert.deepEqual(missing, [], `error codes without a French message: ${missing.join(', ')}`);
  assert.ok(codes.size >= 15, `expected several error codes, got ${codes.size}`);
});
