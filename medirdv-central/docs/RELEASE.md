# Medirdv Central — Installation & Release

## Artifacts

| Platform | File | Status |
|---|---|---|
| Windows (central admin) | `Medirdv-Central-Setup-1.0.0.exe` (97.2 MB) | **Built** — attached to release `medirdv-central-v1.0.0` |
| Android (patients) | `Medirdv-Patient.apk` (3.3 MB) | **Built** — attached to release `medirdv-central-v1.0.0` |
| Web admin | `http://<host>/admin/` | Runs from `npm start` (no build step) |
| Patient web | `http://<host>/` | Runs from `npm start` (no build step) |

Installers are built by CI (`.github/workflows/medirdv-central-*.yml`), not
committed. Local helpers:

```bash
node scripts/convert-icon.js          # build/icon.png → build/icon.ico
node scripts/build-windows.js         # prepare the Electron desktop project
node scripts/build-android.js         # prepare the Capacitor project + icons
node scripts/build-release-list.js    # checksums for files that actually exist
```

## Tagging a release

```bash
git tag medirdv-central-v1.0.1
git push origin medirdv-central-v1.0.1
```

Both workflows run the tests, build on native runners, verify the artifacts,
and attach them to a GitHub Release for the tag. A failing build fails the
job — nothing is published silently.

## CI release flow

```bash
git tag medirdv-central-v1.0.0
git push origin medirdv-central-v1.0.0
```

Both workflows run the test suite first, then build, upload the artifact, and
attach it to the GitHub Release for the tag. If either build fails, the job
fails and nothing is published.

## Windows installer notes

- NSIS, `oneClick: false` (user chooses install dir), desktop + Start Menu
  shortcuts, uninstall entry, `deleteAppDataOnUninstall: false` so settings and
  the saved server URL survive reinstalls and upgrades.
- The app is a thin shell: it loads `MEDIRDV_CENTRAL_URL` (default
  `http://localhost:8080/admin/`). Set the environment variable (or use the
  in-app settings once implemented) to point at production.
- Code signing: not configured. When a certificate is available, set
  `CSC_LINK`/`CSC_KEY_PASSWORD` in CI — unsigned builds will show SmartScreen
  warnings.

## Android APK notes

- Capacitor project, `appId: dz.medirdv.patient`, `appName: Medirdv`.
- Permissions are limited to `INTERNET` and (when push is configured)
  `POST_NOTIFICATIONS`. No location, camera, or broad storage access.
- `cleartext: false` — the app refuses plain HTTP, so set the production HTTPS
  base URL before building.
- Release build is unsigned (debug keystore) unless signing keys are added to
  CI secrets; add `keystore.properties` + `KEYSTORE_*` secrets for Play Store
  signing.

## Verification checklist before announcing a release

- [ ] CI test job green (24 tests).
- [ ] Installer installs on a clean Windows VM, launches, logs in against the
      API, and uninstalls cleanly.
- [ ] APK installs on a mid-range Android device, search + booking + tracking
      work against production, back button behaves correctly.
- [ ] `node scripts/build-release-list.js` shows both checksums.
- [ ] Database backup taken before deployment; restore rehearsed.
- [ ] Release notes list known limitations (see README "What is real").
