'use strict';
/**
 * Android build helper (Part 18.3).
 *
 * Medirdv Patient ships as a Capacitor app wrapping the patient PWA
 * (src/static/patient/). Justification for Capacitor over a fully native
 * rewrite (documented honestly):
 *  - The patient surface is a single, lightweight booking flow; a native
 *    rewrite would duplicate the FR/AR RTL UI for no clinical benefit.
 *  - Capacitor gives a real installable APK (not a bare WebView link):
 *    proper icon, package id, permissions, back-button handling, and
 *    push-notification hooks via @capacitor/push-notifications.
 *  - The same PWA remains installable from the browser (low-end devices,
 *    slow connections) with zero app-store friction.
 * A full Flutter/React Native rewrite remains possible later; the backend
 * API is platform-agnostic and would not change.
 *
 * The actual APK is built by CI (.github/workflows/medirdv-central-android.yml)
 * with the Android SDK. This script never pretends an .apk exists until
 * Gradle has produced it.
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'release', 'android-app');

function main() {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(
    path.join(OUT, 'capacitor.config.ts'),
    `import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'dz.medirdv.patient',
  appName: 'Medirdv',
  webDir: '../../src/static/patient',
  server: {
    // The app talks to the central backend over HTTPS only.
    // Set MEDIRDV_PUBLIC_URL to the production deployment before building.
    cleartext: false,
  },
  plugins: {
    PushNotifications: { presentationOptions: ['badge', 'sound', 'alert'] },
  },
};

export default config;
`
  );
  fs.writeFileSync(
    path.join(OUT, 'README.md'),
    `# Medirdv Patient — Android (Capacitor)

Package: \`dz.medirdv.patient\` · Name: Medirdv

## Build (CI or Android Studio machine)

\`\`\`bash
cd release/android-app
npm install
npx cap add android
npx cap sync
cd android && ./gradlew assembleRelease
\`\`\`

Output: \`release/android/Medirdv-Patient.apk\` (copy after build).

## Permissions (minimal)

- INTERNET (API + WhatsApp links)
- POST_NOTIFICATIONS (booking updates, when configured)

No location, camera, or storage permissions are requested by the app itself.
Receipt upload uses the system file picker (no broad storage access).
`
  );
  console.log('[build-android] Capacitor project prepared at release/android-app/');
  console.log('[build-android] To produce the APK (CI or Android SDK machine):');
  console.log('  cd release/android-app && npm install && npx cap add android && npx cap sync');
  console.log('  cd android && ./gradlew assembleRelease');
  console.log('  Output: release/android/Medirdv-Patient.apk');
  console.log('[build-android] NOTE: no .apk is claimed until Gradle succeeds.');
}

main();
