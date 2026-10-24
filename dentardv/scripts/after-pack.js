'use strict';
/**
 * electron-builder `afterPack` hook.
 *
 * better-sqlite3 v13 is a Node-API (N-API) addon: its `prebuilds/<platform>-<arch>.node`
 * binary works unchanged in Node and in Electron, so no rebuild is required.
 *
 * This hook therefore:
 *  1. keeps only the prebuild of the target platform (smaller installer, no
 *     accidental load of another platform's binary),
 *  2. replaces it with `build/Release/better_sqlite3.node` when a native build
 *     does exist (older better-sqlite3 versions, or a forced `--build-from-source`),
 *  3. fails loudly if neither binary is present, so a broken installer is never
 *     published.
 *
 * It only touches `app.asar.unpacked`, never the developer's node_modules.
 */

const fs = require('node:fs');
const path = require('node:path');

function archName(context) {
  try {
    const { Arch } = require('builder-util');
    if (context.arch === Arch.arm64) return 'arm64';
    if (context.arch === Arch.ia32) return 'ia32';
    if (context.arch === Arch.x64) return 'x64';
  } catch (error) {
    /* fall through to the numeric mapping */
  }
  return context.arch === 3 ? 'arm64' : context.arch === 0 ? 'ia32' : 'x64';
}

function resourcesDir(context) {
  if (context.electronPlatformName === 'darwin') {
    return path.join(
      context.appOutDir,
      `${context.packager.appInfo.productFilename}.app`,
      'Contents',
      'Resources',
    );
  }
  return path.join(context.appOutDir, 'resources');
}

exports.default = async function afterPack(context) {
  const platform = context.electronPlatformName; // 'win32' | 'linux' | 'darwin'
  const arch = archName(context);
  const resources = resourcesDir(context);

  const moduleDir = path.join(resources, 'app.asar.unpacked', 'node_modules', 'better-sqlite3');
  if (!fs.existsSync(moduleDir)) {
    throw new Error(`[after-pack] better-sqlite3 was not unpacked from the asar: ${moduleDir}`);
  }

  const prebuildsDir = path.join(moduleDir, 'prebuilds');
  const targetName = `${platform}-${arch}.node`;
  const targetPath = path.join(prebuildsDir, targetName);
  const rebuiltPath = path.join(moduleDir, 'build', 'Release', 'better_sqlite3.node');

  // Keep only the target platform: the other binaries are dead weight.
  if (fs.existsSync(prebuildsDir)) {
    for (const file of fs.readdirSync(prebuildsDir)) {
      if (file.endsWith('.node') && file !== targetName) {
        fs.rmSync(path.join(prebuildsDir, file), { force: true });
      }
    }
  }

  if (fs.existsSync(rebuiltPath)) {
    fs.mkdirSync(prebuildsDir, { recursive: true });
    fs.copyFileSync(rebuiltPath, targetPath);
    console.log(`[after-pack] better-sqlite3: using the native build (${targetName})`);
    return;
  }

  if (fs.existsSync(targetPath)) {
    console.log(
      `[after-pack] better-sqlite3: keeping the shipped Node-API prebuild (${targetName})`,
    );
    return;
  }

  throw new Error(
    `[after-pack] no better-sqlite3 binary for ${platform}-${arch}. ` +
      `Looked for build/Release/better_sqlite3.node and prebuilds/${targetName}.`,
  );
};
