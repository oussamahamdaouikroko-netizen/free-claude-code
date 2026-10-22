'use strict';
/**
 * electron-builder `afterPack` hook.
 *
 * better-sqlite3 v13 ships prebuilt binaries inside the npm package, compiled
 * for the Node ABI. Its loader tries `prebuilds/<platform>-<arch>.node` first,
 * so a binary rebuilt for Electron (in build/Release) would be ignored and the
 * packaged app would crash with a NODE_MODULE_VERSION mismatch.
 *
 * Fix: once the app is packed, replace the prebuild of the target platform by
 * the Electron-rebuilt binary. This only touches `app.asar.unpacked`, never the
 * developer's node_modules.
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

exports.default = async function afterPack(context) {
  const platform = context.electronPlatformName; // 'win32' | 'linux' | 'darwin'
  const arch = archName(context);
  const resources =
    platform === 'darwin'
      ? path.join(
          context.appOutDir,
          `${context.packager.appInfo.productFilename}.app`,
          'Contents',
          'Resources',
        )
      : path.join(context.appOutDir, 'resources');

  const moduleDir = path.join(resources, 'app.asar.unpacked', 'node_modules', 'better-sqlite3');
  if (!fs.existsSync(moduleDir)) {
    throw new Error(`[after-pack] better-sqlite3 was not unpacked from the asar: ${moduleDir}`);
  }

  const rebuilt = path.join(moduleDir, 'build', 'Release', 'better_sqlite3.node');
  if (!fs.existsSync(rebuilt)) {
    throw new Error(
      '[after-pack] missing Electron build/Release/better_sqlite3.node.\n' +
        'Run `npx electron-builder install-app-deps` (npmRebuild must stay true).',
    );
  }

  const prebuildsDir = path.join(moduleDir, 'prebuilds');
  fs.mkdirSync(prebuildsDir, { recursive: true });

  // Keep only the target platform/arch: smaller installer, no ABI surprises.
  for (const file of fs.readdirSync(prebuildsDir)) {
    if (file.endsWith('.node') && file !== `${platform}-${arch}.node`) {
      fs.rmSync(path.join(prebuildsDir, file), { force: true });
    }
  }

  fs.copyFileSync(rebuilt, path.join(prebuildsDir, `${platform}-${arch}.node`));
  console.log(`[after-pack] better-sqlite3 prebuild replaced with the Electron build (${platform}-${arch})`);
};
