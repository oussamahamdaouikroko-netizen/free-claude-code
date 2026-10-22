'use strict';
/**
 * Packaging checks that do not need Electron:
 *  - electron-builder configuration is valid and points at real files;
 *  - the afterPack hook fixes better-sqlite3 for the packaged app.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

test('electron-builder configuration is complete and files exist', async () => {
  const { getConfig } = require('app-builder-lib/out/util/config/config');
  const config = await getConfig(ROOT, null, null, undefined);

  assert.equal(config.appId, 'dz.dentardv.desktop');
  assert.equal(config.productName, 'DentaRDV');
  assert.equal(config.npmRebuild, true);
  assert.ok(config.asar);
  assert.ok(Array.isArray(config.win.target));
  assert.equal(config.win.target[0].target, 'nsis');
  assert.equal(config.nsis.oneClick, false, 'the dentist must be able to choose the folder');
  assert.ok(fs.existsSync(path.resolve(ROOT, config.win.icon)), 'installer icon exists');
  assert.ok(fs.existsSync(path.resolve(ROOT, config.afterPack)), 'afterPack hook exists');
  const licenseFile = path.resolve(ROOT, config.nsis.license);
  assert.ok(fs.existsSync(licenseFile), `license file exists: ${config.nsis.license}`);
  assert.match(fs.readFileSync(licenseFile, 'utf8'), /MIT/, 'license is the project MIT text');

  const unpacked = config.asarUnpack.join(' ');
  for (const pattern of ['better-sqlite3', '@whiskeysockets', 'whatsapp-rust-bridge', 'sharp', '@img']) {
    assert.ok(unpacked.includes(pattern), `${pattern} must be unpacked from the asar`);
  }
});

test('afterPack replaces the Node prebuild with the Electron build', async () => {
  const hook = require('../scripts/after-pack').default;
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dentardv-pack-'));
  const moduleDir = path.join(outDir, 'resources', 'app.asar.unpacked', 'node_modules', 'better-sqlite3');
  const prebuilds = path.join(moduleDir, 'prebuilds');
  const release = path.join(moduleDir, 'build', 'Release');
  fs.mkdirSync(prebuilds, { recursive: true });
  fs.mkdirSync(release, { recursive: true });

  for (const file of ['win32-x64.node', 'linux-x64.node', 'darwin-arm64.node']) {
    fs.writeFileSync(path.join(prebuilds, file), 'node-abi');
  }
  fs.writeFileSync(path.join(release, 'better_sqlite3.node'), 'electron-abi');

  const context = {
    electronPlatformName: 'win32',
    appOutDir: outDir,
    arch: 1, // x64
    packager: { appInfo: { productFilename: 'DentaRDV' } },
  };

  try {
    await hook(context);
    assert.deepEqual(fs.readdirSync(prebuilds), ['win32-x64.node'], 'other platforms removed');
    assert.equal(fs.readFileSync(path.join(prebuilds, 'win32-x64.node'), 'utf8'), 'electron-abi');
    assert.equal(fs.readFileSync(path.join(release, 'better_sqlite3.node'), 'utf8'), 'electron-abi');

    // A second platform builds independently.
    await hook({ ...context, electronPlatformName: 'linux' });
    assert.ok(fs.existsSync(path.join(prebuilds, 'linux-x64.node')));
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('afterPack fails loudly when the native module was not rebuilt', async () => {
  const hook = require('../scripts/after-pack').default;
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dentardv-pack-bad-'));
  const moduleDir = path.join(outDir, 'resources', 'app.asar.unpacked', 'node_modules', 'better-sqlite3');
  fs.mkdirSync(moduleDir, { recursive: true });
  try {
    await assert.rejects(
      () =>
        hook({
          electronPlatformName: 'win32',
          appOutDir: outDir,
          arch: 1,
          packager: { appInfo: { productFilename: 'DentaRDV' } },
        }),
      /missing Electron build/,
    );
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('the packaged file list keeps tests and demo out of the app', async () => {
  const { getConfig } = require('app-builder-lib/out/util/config/config');
  const config = await getConfig(ROOT, null, null, undefined);
  const patterns = JSON.stringify(config.files);
  assert.match(patterns, /src\/\*\*\/\*/);
  assert.doesNotMatch(patterns, /tests/);
});
