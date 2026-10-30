'use strict';
/**
 * Packaging checks that do not need Electron:
 *  - electron-builder configuration is valid and points at real files;
 *  - the afterPack hook keeps only the target better-sqlite3 binary.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { safeRemove } = require('./helpers');
const yaml = require('js-yaml');

const ROOT = path.join(__dirname, '..');

/** Read electron-builder.yml (single source of truth for the installer). */
function readConfig() {
  const file = path.join(ROOT, 'electron-builder.yml');
  return yaml.load(fs.readFileSync(file, 'utf8'));
}

test('electron-builder configuration is complete and files exist', () => {
  const config = readConfig();

  assert.equal(config.appId, 'dz.medirdv.desktop');
  assert.equal(config.productName, 'MediRDV');
  assert.equal(config.npmRebuild, true);
  assert.equal(config.asar, true);
  assert.deepEqual(config.win.target, [{ target: 'nsis', arch: ['x64'] }]);
  assert.equal(config.nsis.oneClick, false, 'the clinic must be able to choose the folder');
  assert.equal(config.nsis.createDesktopShortcut, true);
  assert.equal(config.nsis.deleteAppDataOnUninstall, false, 'uninstall must never delete clinic data');

  assert.ok(fs.existsSync(path.join(ROOT, config.win.icon)), 'installer icon exists');
  assert.ok(fs.existsSync(path.join(ROOT, config.afterPack)), 'afterPack hook exists');

  const licenseFile = path.join(ROOT, config.nsis.license);
  assert.ok(fs.existsSync(licenseFile), `license file exists: ${config.nsis.license}`);
  assert.match(fs.readFileSync(licenseFile, 'utf8'), /MIT/, 'license is the project MIT text');

  const unpacked = config.asarUnpack.join(' ');
  for (const pattern of ['better-sqlite3', '@whiskeysockets', 'whatsapp-rust-bridge', 'sharp', '@img']) {
    assert.ok(unpacked.includes(pattern), `${pattern} must be unpacked from the asar`);
  }

  const patterns = JSON.stringify(config.files);
  assert.match(patterns, /src\/\*\*\/\*/);
  assert.doesNotMatch(patterns, /tests/);
});

test('electron-builder accepts the configuration (schema validation)', async () => {
  // Uses electron-builder's own loader, which validates keys against its schema.
  const { getConfig } = require('app-builder-lib/out/util/config/config');
  const config = await getConfig(ROOT, null, null, undefined);
  assert.equal(config.appId, 'dz.medirdv.desktop');
  assert.equal(config.productName, 'MediRDV');
  assert.ok(config.nsis, 'nsis block was understood');
});

/** Build the folder structure electron-builder hands to the afterPack hook. */
function packFixture(prefix) {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const moduleDir = path.join(outDir, 'resources', 'app.asar.unpacked', 'node_modules', 'better-sqlite3');
  const prebuilds = path.join(moduleDir, 'prebuilds');
  const release = path.join(moduleDir, 'build', 'Release');
  const context = {
    electronPlatformName: 'win32',
    appOutDir: outDir,
    arch: 1, // x64
    packager: { appInfo: { productFilename: 'DentaRDV' } },
  };
  return { outDir, moduleDir, prebuilds, release, context };
}

test('afterPack prefers a native build and drops the other platforms', async () => {
  const hook = require('../scripts/after-pack').default;
  const { outDir, prebuilds, release, context } = packFixture('dentardv-pack-');
  fs.mkdirSync(prebuilds, { recursive: true });
  fs.mkdirSync(release, { recursive: true });

  for (const file of ['win32-x64.node', 'linux-x64.node', 'darwin-arm64.node']) {
    fs.writeFileSync(path.join(prebuilds, file), 'node-abi');
  }
  fs.writeFileSync(path.join(release, 'better_sqlite3.node'), 'electron-abi');

  try {
    await hook(context);
    assert.deepEqual(fs.readdirSync(prebuilds), ['win32-x64.node'], 'other platforms removed');
    assert.equal(fs.readFileSync(path.join(prebuilds, 'win32-x64.node'), 'utf8'), 'electron-abi');

    // A second platform builds independently.
    await hook({ ...context, electronPlatformName: 'linux' });
    assert.ok(fs.existsSync(path.join(prebuilds, 'linux-x64.node')));
  } finally {
    safeRemove(outDir);
  }
});

test('afterPack keeps the Node-API prebuild when nothing was rebuilt', async () => {
  // better-sqlite3 v13 is a Node-API addon: `prebuilds/<platform>-<arch>.node`
  // is valid in Electron too, and @electron/rebuild produces no build/Release
  // binary for it. The hook must not fail in that (normal) case.
  const hook = require('../scripts/after-pack').default;
  const { outDir, prebuilds, context } = packFixture('dentardv-pack-napi-');
  fs.mkdirSync(prebuilds, { recursive: true });
  fs.writeFileSync(path.join(prebuilds, 'win32-x64.node'), 'napi');
  fs.writeFileSync(path.join(prebuilds, 'linux-x64.node'), 'napi');

  try {
    await hook(context);
    assert.deepEqual(fs.readdirSync(prebuilds), ['win32-x64.node']);
    assert.equal(fs.readFileSync(path.join(prebuilds, 'win32-x64.node'), 'utf8'), 'napi');
  } finally {
    safeRemove(outDir);
  }
});

test('afterPack fails loudly when no binary exists for the target', async () => {
  const hook = require('../scripts/after-pack').default;
  const { outDir, prebuilds, context } = packFixture('dentardv-pack-bad-');
  fs.mkdirSync(prebuilds, { recursive: true });
  fs.writeFileSync(path.join(prebuilds, 'linux-x64.node'), 'napi');
  try {
    await assert.rejects(() => hook(context), /no better-sqlite3 binary for win32-x64/);
  } finally {
    safeRemove(outDir);
  }
});

test('afterPack fails loudly when the module was not unpacked', async () => {
  const hook = require('../scripts/after-pack').default;
  const { outDir, context } = packFixture('dentardv-pack-missing-');
  try {
    await assert.rejects(() => hook(context), /was not unpacked from the asar/);
  } finally {
    safeRemove(outDir);
  }
});

/** Every local file the renderer asks for must exist next to index.html. */
test('the renderer only references files that exist', () => {
  const renderer = path.join(ROOT, 'src', 'renderer');
  const html = fs.readFileSync(path.join(renderer, 'index.html'), 'utf8');
  const refs = [...html.matchAll(/(?:src|href)="([^"#]+)"/g)].map((m) => m[1]);
  assert.ok(refs.length >= 14, `expected the full script list, got ${refs.length}`);
  for (const ref of refs) {
    if (/^(https?:|data:|mailto:)/.test(ref)) continue;
    assert.ok(
      fs.existsSync(path.join(renderer, ref)),
      `index.html references a missing file: ${ref}`,
    );
  }
});

/** Every require('./x') inside src must resolve, or the app dies at launch. */
test('every local require in the main process resolves', () => {
  const srcDir = path.join(ROOT, 'src');
  const files = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) files.push(full);
    }
  })(srcDir);

  assert.ok(files.length > 20, 'source tree was scanned');
  for (const file of files) {
    const code = fs.readFileSync(file, 'utf8');
    for (const match of code.matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
      const target = path.resolve(path.dirname(file), match[1]);
      const found = [target, `${target}.js`, path.join(target, 'index.js')].some((candidate) =>
        fs.existsSync(candidate),
      );
      assert.ok(found, `${path.relative(ROOT, file)} requires a missing module: ${match[1]}`);
    }
  }
});

/** electron-builder packs production dependencies; they must not be devDeps. */
test('runtime dependencies are declared as dependencies', () => {
  const pkg = require('../package.json');
  const runtime = ['better-sqlite3', 'pino', 'qrcode'];
  for (const name of runtime) {
    assert.ok(pkg.dependencies[name], `${name} must be a production dependency`);
    assert.ok(!pkg.devDependencies[name], `${name} must not be a devDependency`);
  }
  assert.ok(pkg.dependencies['@whiskeysockets/baileys'], 'baileys is a production dependency');
  // The whole UI and the main process ship from src/.
  assert.equal(pkg.main, 'src/main/index.js');
});

test('better-sqlite3 ships a Node-API binary that Electron can load', () => {
  // This is why afterPack can keep the packaged prebuild instead of rebuilding:
  // a N-API addon exports napi_register_module_v1 and never the legacy
  // node_register_module_v / NODE_MODULE_VERSION entry points. If a future
  // better-sqlite3 release switched back to the Node ABI, the packaged app
  // would crash on first launch, so fail here instead.
  const binary = path.join(
    ROOT,
    'node_modules',
    'better-sqlite3',
    'prebuilds',
    'win32-x64.node',
  );
  assert.ok(fs.existsSync(binary), 'the Windows prebuild is installed');
  const symbols = fs.readFileSync(binary).toString('latin1');
  assert.match(symbols, /napi_register_module_v1/, 'binary registers through N-API');
  assert.doesNotMatch(symbols, /node_register_module_v/, 'binary is not tied to the Node ABI');

  const version = require('better-sqlite3/package.json').version;
  assert.match(version, /^\d+\./, 'better-sqlite3 version is readable');
});

test('the GitHub Actions workflow builds the Windows installer', () => {
  const workflow = yaml.load(
    fs.readFileSync(path.join(ROOT, '..', '.github', 'workflows', 'medirdv-windows.yml'), 'utf8'),
  );
  assert.ok(workflow.jobs.test, 'tests run first');
  assert.equal(workflow.jobs.test['runs-on'], 'ubuntu-latest');
  assert.ok(workflow.jobs.build, 'windows build job exists');
  assert.equal(workflow.jobs.build['runs-on'], 'windows-latest');
  assert.deepEqual(workflow.jobs.build.needs, 'test');
  assert.equal(workflow.jobs.build.defaults.run['working-directory'], 'medirdv');

  const script = workflow.jobs.build.steps.map((step) => step.run || '').join('\n');
  assert.match(script, /electron-builder --win nsis/);
  assert.match(script, /npm ci/);
  assert.match(script, /npm test/);

  // The installer and the portable sales demo must be downloadable.
  const uploads = workflow.jobs.build.steps.filter((step) => String(step.uses).includes('upload-artifact'));
  const installer = uploads.find((step) => step.with.name === 'MediRDV-Setup-windows');
  assert.ok(installer, 'installer artifact');
  assert.match(JSON.stringify(installer.with.path), /release\/MediRDV-Setup-\*\.exe/);
  const demo = uploads.find((step) => step.with.name === 'MediRDV-Demo-portable');
  assert.ok(demo, 'the portable demo is built too');
  assert.match(JSON.stringify(demo.with.path), /MediRDV-Demo-\*\.exe/);
  assert.match(script, /electron-builder --win --config electron-builder\.demo\.yml/);
  const release = workflow.jobs.build.steps.find((step) => String(step.uses).includes('action-gh-release'));
  assert.ok(release, 'release step exists');
  assert.match(release.if, /refs\/tags\/medirdv-v/);
});

test('packaging & gitignore strictly exclude developer keygen, private keys, and license CSV ledger', () => {
  for (const cfgFile of ['electron-builder.yml', 'electron-builder.demo.yml']) {
    const cfg = yaml.load(fs.readFileSync(path.join(ROOT, cfgFile), 'utf8'));
    const rules = cfg.files.map(String);
    assert.ok(rules.includes('!tools/**'), `${cfgFile} must exclude tools/**`);
    assert.ok(rules.includes('!**/*keygen*'), `${cfgFile} must exclude *keygen*`);
    assert.ok(rules.includes('!**/*.pem'), `${cfgFile} must exclude *.pem`);
    assert.ok(rules.includes('!**/*.key'), `${cfgFile} must exclude *.key`);
    assert.ok(rules.includes('!**/issued_licenses.csv'), `${cfgFile} must exclude issued_licenses.csv`);
  }

  for (const gi of [path.join(ROOT, '.gitignore'), path.join(ROOT, '..', '.gitignore')]) {
    const content = fs.readFileSync(gi, 'utf8');
    assert.match(content, /tools\//, `${gi} ignores tools/`);
    assert.match(content, /\*\.pem/, `${gi} ignores *.pem`);
    assert.match(content, /issued_licenses\.csv/, `${gi} ignores issued_licenses.csv`);
  }

  // Ensure nothing inside shipped `src/` contains an Ed25519 private key or signing logic
  function walkSrc(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walkSrc(full);
      else if (ent.isFile() && /\.(js|json|html|css)$/.test(ent.name)) {
        const text = fs.readFileSync(full, 'utf8');
        assert.doesNotMatch(text, /BEGIN PRIVATE KEY/, `${full} must never contain a private key`);
        assert.doesNotMatch(text, /crypto\.sign\s*\(/, `${full} must only verify, never sign`);
      }
    }
  }
  walkSrc(path.join(ROOT, 'src'));
});

