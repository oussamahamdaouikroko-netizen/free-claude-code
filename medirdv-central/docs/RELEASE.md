# Medirdv Central — Installation & Release

## Artifacts

| Platform | File | Produced by |
|---|---|---|
| Windows (central admin) | `release/windows/Medirdv-Central-Setup-1.0.0.exe` | GitHub Actions `medirdv-central-windows.yml` |
| Android (patients) | `release/android/Medirdv-Patient.apk` | GitHub Actions `medirdv-central-android.yml` |
| Web admin | `http://<host>/admin/` | `npm start` (no build step) |
| Patient web | `http://<host>/` | `npm start` (no build step) |

The `.exe` and `.apk` are produced by CI, not committed to the repository.
`npm run build:windows` / `npm run build:android` generate the wrapper projects
and print the exact build commands. **No installer exists until a build
machine or CI run produces it** — `node scripts/build-release-list.js` writes
SHA-256 checksums only for files that actually exist.

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
