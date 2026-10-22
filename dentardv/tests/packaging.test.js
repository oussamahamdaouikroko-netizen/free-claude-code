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

  assert.equal(config.appId, 'dz.dentardv.desktop');
  assert.equal(config.productName, 'DentaRDV');
  assert.equal(config.npmRebuild, true);
  assert.equal(config.asar, true);
  assert.deepEqual(config.win.target, [{ target: 'nsis', arch: ['x64'] }]);
  assert.equal(config.nsis.oneClick, false, 'the dentist must be able to choose the folder');
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
  assert.equal(config.appId, 'dz.dentardv.desktop');
  assert.equal(config.productName, 'DentaRDV');
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

test('the GitHub Actions workflow builds the Windows installer', () => {
  const workflow = yaml.load(
    fs.readFileSync(path.join(ROOT, '..', '.github', 'workflows', 'dentardv-windows.yml'), 'utf8'),
  );
  assert.ok(workflow.jobs.test, 'tests run first');
  assert.equal(workflow.jobs.test['runs-on'], 'ubuntu-latest');
  assert.ok(workflow.jobs.build, 'windows build job exists');
  assert.equal(workflow.jobs.build['runs-on'], 'windows-latest');
  assert.deepEqual(workflow.jobs.build.needs, 'test');
  assert.equal(workflow.jobs.build.defaults.run['working-directory'], 'dentardv');

  const script = workflow.jobs.build.steps.map((step) => step.run || '').join('\n');
  assert.match(script, /electron-builder --win nsis/);
  assert.match(script, /npm ci/);
  assert.match(script, /npm test/);

  // The installer must be downloadable, and a tag must publish a release.
  const upload = workflow.jobs.build.steps.find((step) => String(step.uses).includes('upload-artifact'));
  assert.match(JSON.stringify(upload.with.path), /release\/\*\.exe/);
  const release = workflow.jobs.build.steps.find((step) => String(step.uses).includes('action-gh-release'));
  assert.ok(release, 'release step exists');
  assert.match(release.if, /refs\/tags\/v/);
});
