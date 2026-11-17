'use strict';
/**
 * Android build helper (Part 18.3) — Medirdv Patient APK.
 *
 * Technology note (Part 18.3 asks for a justified choice): the patient surface
 * is a single lightweight booking flow that already exists as a mobile-first
 * FR/AR RTL web app. It is packaged with **Capacitor**, which produces a real
 * native Android application — own package id, own icon, own permissions,
 * proper back-button handling, native HTTP and push hooks — rather than a
 * WebView pointing at a remote site. The app bundles its UI locally and talks
 * to the central API over HTTPS, so it also works on slow connections and
 * does not depend on the website being reachable to render.
 *
 * This script prepares everything the APK build needs (config, API base,
 * icons). The APK itself is built by CI with the Android SDK:
 * `.github/workflows/medirdv-central-android.yml`.
 *
 * Usage: node scripts/build-android.js [--api-base https://central.example.dz]
 */
const fs = require('node:fs');
const path = require('node:path');
const { decodePng, resize } = require('./convert-icon');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'release', 'android-app');
const WEB_DIR = path.join(OUT, 'www');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

function argValue(flag, fallback = '') {
  const index = process.argv.indexOf(flag);
  return index > -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const apiBase = argValue('--api-base', process.env.MEDIRDV_PUBLIC_URL || 'https://central.medirdv.dz')
  .trim()
  .replace(/\/+$/, '');

/* --------------------------------- www/ ---------------------------------- */
// Copy the patient UI into the app bundle (offline-capable shell) and inject
// the central API base so the APK knows where to call.
fs.rmSync(WEB_DIR, { recursive: true, force: true });
fs.mkdirSync(WEB_DIR, { recursive: true });

const sourceDir = path.join(ROOT, 'src', 'static', 'patient');
for (const file of fs.readdirSync(sourceDir)) {
  fs.copyFileSync(path.join(sourceDir, file), path.join(WEB_DIR, file));
}

const indexPath = path.join(WEB_DIR, 'index.html');
let html = fs.readFileSync(indexPath, 'utf8');
html = html.replace(
  '<meta name="medirdv-api-base" content="">',
  `<meta name="medirdv-api-base" content="${apiBase}">`
);
html = html.replace(
  '<title>',
  '<meta name="format-detection" content="telephone=no">\n<title>'
);
fs.writeFileSync(indexPath, html);

if (!fs.existsSync(path.join(WEB_DIR, 'index.html'))) {
  throw new Error('Patient UI could not be bundled (missing index.html)');
}

/* ---------------------------- capacitor.config ---------------------------- */
fs.writeFileSync(
  path.join(OUT, 'capacitor.config.json'),
  JSON.stringify(
    {
      appId: 'dz.medirdv.patient',
      appName: 'Medirdv',
      webDir: 'www',
      bundledWebRuntime: false,
      android: {
        allowMixedContent: false,
        backgroundColor: '#0e7c7b',
      },
      server: {
        androidScheme: 'https',
        cleartext: false,
      },
      plugins: {
        SplashScreen: {
          launchShowDuration: 800,
          backgroundColor: '#0e7c7b',
          showSpinner: false,
        },
      },
    },
    null,
    2
  )
);

/* ------------------------------ package.json ------------------------------ */
// The Capacitor CLI requires its own npm package at the project root.
fs.writeFileSync(
  path.join(OUT, 'package.json'),
  JSON.stringify(
    {
      name: 'medirdv-patient-app',
      version: pkg.version,
      private: true,
      description: 'Medirdv Patient — Android application (Capacitor)',
      scripts: {
        sync: 'cap sync android',
        'build:apk': 'cd android && ./gradlew assembleRelease',
      },
      dependencies: {
        '@capacitor/core': '^8.6.2',
        '@capacitor/android': '^8.6.2',
      },
      devDependencies: { '@capacitor/cli': '^8.6.2' },
      capacitor: { android: { minVersion: 23, targetVersion: 35 } },
    },
    null,
    2
  )
);

/* --------------------------------- icons --------------------------------- */
// Generate Android mipmap densities from build/icon.png using our zlib PNG
// encoder, so the APK ships a real launcher icon without extra dependencies.
const { encodePng } = require('./png');
const iconSource = path.join(ROOT, 'build', 'icon.png');
const DENSITIES = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
const androidRes = path.join(OUT, 'android-res');
fs.rmSync(androidRes, { recursive: true, force: true });

if (fs.existsSync(iconSource)) {
  const image = decodePng(fs.readFileSync(iconSource));
  for (const [density, size] of Object.entries(DENSITIES)) {
    const dir = path.join(androidRes, `mipmap-${density}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'ic_launcher.png'), encodePng(resize(image, size), size, size));
    fs.writeFileSync(path.join(dir, 'ic_launcher_round.png'), encodePng(resize(image, size), size, size));
    fs.writeFileSync(path.join(dir, 'ic_launcher_foreground.png'), encodePng(resize(image, size), size, size));
  }
  // Splash artwork.
  const splashDir = path.join(androidRes, 'drawable');
  fs.mkdirSync(splashDir, { recursive: true });
  fs.writeFileSync(path.join(splashDir, 'splash.png'), encodePng(resize(image, 512), 512, 512));
  console.log(`[build-android] Launcher icons generated (${Object.keys(DENSITIES).join(', ')})`);
} else {
  console.warn('[build-android] build/icon.png missing — Android will use the default Capacitor icon');
}

/* --------------------------------- README -------------------------------- */
fs.writeFileSync(
  path.join(OUT, 'README.md'),
  `# Medirdv Patient — Android (Capacitor)

- App name: **Medirdv**
- Package: \`dz.medirdv.patient\`
- Version: ${pkg.version}
- API base baked into this build: \`${apiBase}\`
- UI is bundled locally (works on slow/flaky networks); data comes from the
  central API over HTTPS.

## Build

\`\`\`bash
cd release/android-app
npm install                 # installs the Capacitor CLI + platform
npx cap add android         # requires this directory to be an npm package
npx cap sync android
cd android && ./gradlew assembleRelease
\`\`\`

Launcher icons are generated into \`android-res/\` and copied into
\`android/app/src/main/res/\` by CI after \`cap add\`.

The generated launcher icons live in \`android-res/\`; CI copies them into
\`android/app/src/main/res/\` after \`cap add\`.

## Notes

- \`cleartext: false\` — the app refuses plain HTTP.
- Permissions: INTERNET only (plus POST_NOTIFICATIONS if push is enabled later).
- The server address can be changed inside the app (⚙ in the header) without
  rebuilding, so a single APK can serve staging and production.
`
);

console.log('[build-android] Capacitor project prepared at release/android-app/');
console.log(`[build-android] API base baked in: ${apiBase}`);
console.log('[build-android] Build the APK with the Android SDK (CI workflow) — no .apk is claimed until Gradle succeeds.');
