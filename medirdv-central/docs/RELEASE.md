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
  shortcuts, uninstall entry, `deleteAppDataOnUninstall: false` so data and
  settings survive reinstalls and upgrades.
- **No server is required to start.** By default the app runs *standalone*:
  it starts the bundled Medirdv Central server on a free local port and opens
  the dashboard. Data is stored per-user in
  `%APPDATA%\Medirdv Central\data\medirdv-central.sqlite`.
- The first run generates a local administrator account in
  `administrator.json`. You can view or change it from **Account → Local
  administrator…**.
- **Network deployments** use *connected* mode: **File → Use a shared server…**
  saves `{ mode: "remote", centralUrl }` in `settings.json` and every client
  then shares one authoritative database (Part 18.4). Switch back at any time
  with **File → Use local database**.
- Build variants: `node scripts/build-windows.js --mode standalone` (default)
  or `--mode connected --api-base https://central.example.dz`.
- Code signing: not configured. When a certificate is available, set
  `CSC_LINK`/`CSC_KEY_PASSWORD` in CI — unsigned builds will show SmartScreen
  warnings.

## Android APK notes

- Capacitor project, `appId: dz.medirdv.patient`, `appName: Medirdv`.
- Permissions are limited to `INTERNET` and (when push is configured)
  `POST_NOTIFICATIONS`. No location, camera, or broad storage access.
- `cleartext: false` — the app refuses plain HTTP.
- **No server is baked in by default.** On first launch the app shows a
  "connect to your Medirdv server" screen, validates the address against
  `/health`, and stores it on the device. A build can still ship a
  pre-configured address with `--api-base https://…` for a managed rollout.
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
