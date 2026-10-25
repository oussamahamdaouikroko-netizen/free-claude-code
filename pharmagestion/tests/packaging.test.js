'use strict';
/**
 * Packaging checks that do not need Electron or Windows.
 *
 * The installer is only as good as its configuration: these tests pin the
 * installer file name, the 64-bit NSIS target, the "never delete user data"
 * flag, the exclusions (no tests, no docs in the package) and the afterPack
 * hook that guarantees a working better-sqlite3 binary inside the installer.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const yaml = require('js-yaml');
const { safeRemove } = require('./helpers');

const ROOT = path.join(__dirname, '..');

function readConfig() {
  return yaml.load(fs.readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf8'));
}

test('the installer is a 64-bit NSIS package named PharmaGestion-DZ-Setup.exe', () => {
  const config = readConfig();

  assert.equal(config.appId, 'dz.pharmagestion.desktop');
  assert.equal(config.productName, 'PharmaGestion DZ');
  assert.deepEqual(config.win.target, [{ target: 'nsis', arch: ['x64'] }]);
  assert.equal(config.win.artifactName, 'PharmaGestion-DZ-Setup.exe');
  assert.equal(config.win.requestedExecutionLevel, 'asInvoker', 'no admin rights needed');
  assert.equal(config.asar, true);
});

test('the installer lets the pharmacist choose the folder and keeps their data', () => {
  const { nsis } = readConfig();
  assert.equal(nsis.oneClick, false, 'a wizard, not a silent install');
  assert.equal(nsis.allowToChangeInstallationDirectory, true, 'installation folder can be chosen');
  assert.equal(nsis.createDesktopShortcut, true);
  assert.equal(nsis.createStartMenuShortcut, true);
  assert.equal(nsis.runAfterFinish, true, 'the app can be launched after installation');
  assert.equal(nsis.deleteAppDataOnUninstall, false, 'uninstall must NEVER delete pharmacy data');
  assert.equal(nsis.perMachine, false, 'per-user install works without administrator rights');
  assert.ok(nsis.installerLanguages.includes('fr_FR'));
  assert.ok(nsis.installerLanguages.includes('ar_SA'));
});

test('files referenced by the configuration exist', () => {
  const config = readConfig();
  assert.ok(fs.existsSync(path.join(ROOT, config.win.icon)), 'installer icon');
  assert.ok(fs.existsSync(path.join(ROOT, config.afterPack)), 'afterPack hook');
  // NSIS resolves `license` inside buildResources (assets/) first.
  const licenseFile = path.join(ROOT, 'assets', config.nsis.license);
  assert.ok(fs.existsSync(licenseFile), `license shown by the installer: ${config.nsis.license}`);
  assert.match(fs.readFileSync(licenseFile, 'utf8'), /MIT/);
  assert.ok(fs.existsSync(path.join(ROOT, 'src', 'main', 'index.js')), 'application entry point');
});

test('the package contains the application only, never tests or secrets', () => {
  const config = readConfig();
  const files = JSON.stringify(config.files);
  assert.match(files, /src\/\*\*\/\*/);
  assert.match(files, /package\.json/);
  for (const excluded of ['tests', 'docs', 'fixtures', 'scripts']) {
    assert.match(files, new RegExp(`!\\*\\*/${excluded}/\\*\\*`), `${excluded} must be excluded`);
  }
  assert.match(JSON.stringify(config.asarUnpack), /better-sqlite3/);
  assert.equal(config.npmRebuild, false, 'N-API prebuilds are used as-is');
});

test('electron-builder schema accepts the configuration (no unknown keys)', () => {
  // Validate against electron-builder's own JSON schema. This is the check that
  // catches a typo such as `createUninstaller`, which makes the real build fail
  // with "Invalid configuration object" *after* the tests have passed.
  const path = require('node:path');
  const appBuilderPath = require.resolve('app-builder-lib/package.json');
  const ajvPath = require.resolve('ajv', { paths: [path.dirname(appBuilderPath)] });
  const Ajv = require(ajvPath);
  const schema = require(path.join(path.dirname(appBuilderPath), 'scheme.json'));

  const ajv = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true, validateFormats: false });
  ajv.addSchema(schema, 'root');
  const validate = ajv.getSchema('root');
  const config = readConfig();

  const valid = validate(config);
  const details = valid
    ? ''
    : validate.errors
        .slice(0, 5)
        .map((error) => `${error.instancePath || '(root)'} ${error.message}`)
        .join('; ');
  assert.equal(valid, true, `electron-builder rejects electron-builder.yml: ${details}`);
});

test('common electron-builder pitfalls are absent', () => {
  const config = readConfig();
  // `createUninstaller` is not part of the NSIS options: the uninstaller is
  // always generated. Passing it breaks the whole build.
  assert.equal(config.nsis.createUninstaller, undefined);
  // The licence file must be resolvable from the build resources folder.
  assert.ok(fs.existsSync(path.join(ROOT, 'assets', config.nsis.license)));
  // An artifactName with a version placeholder would produce a different file
  // name than the one promised to the pharmacy.
  assert.doesNotMatch(config.win.artifactName, /\$\{/);
});

test('package.json declares the identity, entry point and scripts', () => {
  const pkg = require('../package.json');
  assert.equal(pkg.name, 'pharmagestion-dz');
  assert.equal(pkg.productName, 'PharmaGestion DZ');
  assert.equal(pkg.main, 'src/main/index.js');
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.ok(pkg.description.length > 20);
  assert.equal(pkg.scripts.start, 'electron .');
  assert.equal(pkg.scripts.dist, 'electron-builder --win nsis');
  assert.equal(pkg.scripts.test, 'node tests/run.js');
  // Runtime dependencies stay small and offline.
  assert.deepEqual(Object.keys(pkg.dependencies), ['better-sqlite3']);
  for (const name of ['electron', 'electron-builder', 'jsdom', 'js-yaml']) {
    assert.ok(pkg.devDependencies[name], `${name} must be a devDependency`);
    assert.ok(!pkg.dependencies[name], `${name} must not ship in the installer`);
  }
});

test('better-sqlite3 ships a Node-API binary Electron can load, including win32-x64', () => {
  const moduleDir = path.join(ROOT, 'node_modules', 'better-sqlite3');
  const windowsBinary = path.join(moduleDir, 'prebuilds', 'win32-x64.node');
  assert.ok(fs.existsSync(windowsBinary), 'the Windows prebuild is installed');
  const symbols = fs.readFileSync(windowsBinary).toString('latin1');
  assert.match(symbols, /napi_register_module_v1/, 'binary registers through N-API');
  assert.doesNotMatch(symbols, /node_register_module_v/, 'binary is not tied to the Node ABI');
});

/* ----------------------------- afterPack hook ----------------------------- */

function packFixture(prefix) {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const moduleDir = path.join(outDir, 'resources', 'app.asar.unpacked', 'node_modules', 'better-sqlite3');
  const prebuilds = path.join(moduleDir, 'prebuilds');
  const release = path.join(moduleDir, 'build', 'Release');
  return {
    outDir,
    prebuilds,
    release,
    context: {
      electronPlatformName: 'win32',
      appOutDir: outDir,
      arch: 1, // x64
      packager: { appInfo: { productFilename: 'PharmaGestion DZ' } },
    },
  };
}

test('afterPack keeps only the Windows binary in the package', async () => {
  const hook = require('../scripts/after-pack').default;
  const { outDir, prebuilds, context } = packFixture('pg-pack-');
  fs.mkdirSync(prebuilds, { recursive: true });
  for (const file of ['win32-x64.node', 'linux-x64.node', 'darwin-arm64.node']) {
    fs.writeFileSync(path.join(prebuilds, file), 'napi');
  }
  try {
    await hook(context);
    assert.deepEqual(fs.readdirSync(prebuilds), ['win32-x64.node']);
  } finally {
    safeRemove(outDir);
  }
});

test('afterPack prefers a native rebuild when one exists', async () => {
  const hook = require('../scripts/after-pack').default;
  const { outDir, prebuilds, release, context } = packFixture('pg-pack-native-');
  fs.mkdirSync(prebuilds, { recursive: true });
  fs.mkdirSync(release, { recursive: true });
  fs.writeFileSync(path.join(prebuilds, 'win32-x64.node'), 'napi');
  fs.writeFileSync(path.join(release, 'better_sqlite3.node'), 'electron-abi');
  try {
    await hook(context);
    assert.equal(fs.readFileSync(path.join(prebuilds, 'win32-x64.node'), 'utf8'), 'electron-abi');
  } finally {
    safeRemove(outDir);
  }
});

test('afterPack fails the build when no Windows binary is available', async () => {
  const hook = require('../scripts/after-pack').default;
  const { outDir, prebuilds, context } = packFixture('pg-pack-bad-');
  fs.mkdirSync(prebuilds, { recursive: true });
  fs.writeFileSync(path.join(prebuilds, 'linux-x64.node'), 'napi');
  try {
    await assert.rejects(() => hook(context), /no better-sqlite3 binary for win32-x64/);
  } finally {
    safeRemove(outDir);
  }
});

test('afterPack fails the build when better-sqlite3 was not unpacked', async () => {
  const hook = require('../scripts/after-pack').default;
  const { outDir, context } = packFixture('pg-pack-missing-');
  try {
    await assert.rejects(() => hook(context), /was not unpacked from the asar/);
  } finally {
    safeRemove(outDir);
  }
});

/* ------------------------------ source tree ------------------------------ */

test('the renderer only references files that exist', () => {
  const renderer = path.join(ROOT, 'src', 'renderer');
  const html = fs.readFileSync(path.join(renderer, 'index.html'), 'utf8');
  const refs = [...html.matchAll(/(?:src|href)="([^"#]+)"/g)].map((match) => match[1]);
  assert.ok(refs.length >= 10, `expected the full asset list, got ${refs.length}`);
  for (const ref of refs) {
    if (/^(https?:|data:|mailto:)/.test(ref)) continue;
    assert.ok(fs.existsSync(path.join(renderer, ref)), `index.html references a missing file: ${ref}`);
  }
});

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

  assert.ok(files.length >= 10, 'source tree was scanned');
  for (const file of files) {
    const code = fs.readFileSync(file, 'utf8');
    for (const match of code.matchAll(/require\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
      const target = path.resolve(path.dirname(file), match[1]);
      const found = [target, `${target}.js`, path.join(target, 'index.js')].some((candidate) =>
        fs.existsSync(candidate),
      );
      assert.ok(found, `${path.relative(ROOT, file)} requires a missing module: ${match[1]}`);
    }
  }
});

test('the Windows workflow builds and publishes the installer', () => {
  const workflowPath = path.join(ROOT, '..', '.github', 'workflows', 'pharmagestion-windows.yml');
  assert.ok(fs.existsSync(workflowPath), 'the build workflow exists');
  const workflow = yaml.load(fs.readFileSync(workflowPath, 'utf8'));

  assert.ok(workflow.jobs.test, 'tests run first');
  assert.equal(workflow.jobs.test['runs-on'], 'ubuntu-latest');
  assert.ok(workflow.jobs.build, 'a Windows build job exists');
  assert.equal(workflow.jobs.build['runs-on'], 'windows-latest');
  assert.deepEqual(workflow.jobs.build.needs, 'test');
  assert.equal(workflow.jobs.build.defaults.run['working-directory'], 'pharmagestion');

  const steps = workflow.jobs.build.steps;
  const script = steps.map((step) => step.run || '').join('\n');
  assert.match(script, /npm ci/);
  assert.match(script, /npm run dist/);
  assert.match(script, /PharmaGestion-DZ-Setup\.exe/, 'the build verifies the exact output path');
  assert.match(script, /PHARMAGESTION_SMOKE/, 'the packaged application is smoke-tested');

  const upload = steps.find((step) => step.with && step.with.name === 'PharmaGestion-DZ-Setup');
  assert.ok(upload, 'the installer is uploaded as an artifact');
  assert.match(JSON.stringify(upload.with.path), /release\/PharmaGestion-DZ-Setup\.exe/);

  // The build publishes its facts (path, size, SHA-256) where a human can read
  // them without downloading anything.
  assert.match(script, /Get-FileHash/, 'the installer hash is reported');
  assert.ok(
    steps.some((step) => /build report/i.test(step.name || '')),
    'a build report step publishes the verification output',
  );
});

test('a version tag publishes a downloadable release (no paths filter)', () => {
  const workflowPath = path.join(ROOT, '..', '.github', 'workflows', 'pharmagestion-release.yml');
  assert.ok(fs.existsSync(workflowPath), 'the release workflow exists');
  const workflow = yaml.load(fs.readFileSync(workflowPath, 'utf8'));

  const tags = workflow.on.push.tags;
  assert.ok(tags.includes('pharmagestion-v*'), 'tag pattern is declared');
  // A tag push must always build: a `paths` filter here would silently skip the
  // release whenever the tagged commit only touched documentation.
  assert.equal(workflow.on.push.paths, undefined, 'no paths filter on tag pushes');
  assert.equal(workflow.jobs.release.with.publish_release, true);
  assert.equal(workflow.jobs.release.uses, './.github/workflows/pharmagestion-windows.yml');
  assert.equal(workflow.permissions.contents, 'write', 'needed to create the release');

  // The reusable workflow must declare workflow_call and be allowed to publish.
  const main = yaml.load(
    fs.readFileSync(path.join(ROOT, '..', '.github', 'workflows', 'pharmagestion-windows.yml'), 'utf8'),
  );
  assert.ok(main.on.workflow_call, 'the build workflow is reusable');
  const releaseStep = main.jobs.build.steps.find((step) => String(step.uses).includes('action-gh-release'));
  assert.ok(releaseStep, 'the release step exists');
  assert.match(releaseStep.if, /inputs\.publish_release/);
  assert.match(JSON.stringify(releaseStep.with), /PharmaGestion-DZ-Setup\.exe/);
});
