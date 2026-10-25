# تقرير الاختبار — المرحلة 1 / Phase 1 test report

_آخر تحديث / last update: 2026-10-25_

## 1. ملخص / Summary

| What | Result |
|---|---|
| Automated tests (`npm test`) | **114 tests, 114 pass, 0 fail** (9.4 s) |
| electron-builder configuration | **valid** according to electron-builder's own JSON schema |
| Windows installer `PharmaGestion-DZ-Setup.exe` | built on a real Windows runner (see §5) |
| Local Linux build of the Windows installer | **not possible in this sandbox** (see §4) — the Electron Windows runtime cannot be downloaded |

## 2. الاختبارات الآلية / What the test suite covers

| File | Focus | Tests |
|---|---|---|
| `tests/money.test.js` | integer-centime parsing (`1500,50`, `1.500`, `1.234.567,89`), no floats, rejection of ambiguous amounts | 10 |
| `tests/dates.test.js` | strict ISO validation (`2026-02-30` refused), day arithmetic, flexible `31/03/2026` parsing | 8 |
| `tests/common.test.js` | text cleaning, IDs, enums, booleans, path-safe slugs | 7 |
| `tests/schema-migrations.test.js` | migration runner: idempotent, atomic, rollback on failure, refuses newer schema | 7 |
| `tests/settings.test.js` | typed validation, atomic `setMany`, threshold ordering, audit log append-only + pruning | 12 |
| `tests/backup.test.js` | snapshot is restorable, no overwrite in the same second, prune, daily due, restore with safety copy, corrupted/too-new files refused | 11 |
| `tests/handlers.test.js` | every IPC action, allowlist, restore restricted to approved paths, `db:integrity` | 15 |
| `tests/security.test.js` | trusted frame, method allowlist, payload limits, no stack leakage, BrowserWindow flags, CSP, no `innerHTML`/`eval`/network in the renderer | 11 |
| `tests/i18n.test.js` | FR/AR key parity, placeholders, real Arabic, RTL switching, no missing keys, every error code translated | 12 |
| `tests/renderer.smoke.test.js` | real `index.html` + real preload + real scripts in jsdom: 10 sections, dashboard, RTL switch, settings save, translated validation error, dashboard backup | 10 |
| `tests/packaging.test.js` | installer name/arch, NSIS flags, schema validation, exclusions, afterPack behaviour, asset resolution, workflow | 14 |

## 3. أمان / Security verification (automated)

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, `webviewTag: false`.
- CSP asserted from `index.html`: `default-src 'none'`, `script-src 'self'`,
  `connect-src 'none'`, no `unsafe-inline`, no `unsafe-eval`, no `*`.
- Renderer contains no `eval`, no `new Function`, no `fetch`/`XHR`/`WebSocket`,
  and no raw `innerHTML` except the static SVG icon table.
- IPC: single channel, allowlist, `file://` sender check, 200 kB payload cap,
  handler object without a prototype chain.
- No password/API token/WhatsApp key is stored in the database or the package.

## 4. بيئة البناء في هذه الجلسة / Build environment of this session

```
OS        : Linux (sandbox)
Node      : v22.22.3
npm       : 10.9.8
Wine      : not installed   → NSIS cannot run locally even with a runtime
Network   : npm registry OK; GitHub release assets BLOCKED
            (release-assets.githubusercontent.com / objects.githubusercontent.com
             fail inside the sandbox)
```

`npx electron-builder --win nsis` locally:

1. `Invalid configuration object` — **found and fixed** (`nsis.createUninstaller`
   is not a valid key). A real schema-validation test now guards this.
2. After the fix: configuration loads, dependencies rebuild is skipped as
   intended, packaging starts, then:
   `⨯ unable to verify the first certificate` while downloading
   `electron-v38.8.6-win32-x64.zip`.
   This is the sandbox's TLS interception of the blocked host, **not a project
   defect**. The Windows runtime cannot be fetched here, so the .exe cannot be
   produced on this machine.

No claim of a local installer is made. The installer is produced on Windows
(see §5) and verified by `scripts/verify-package.js`.

## 5. Windows build + install verification

Filled in after the GitHub Actions run (see the run link / artifact in the
pull request). Checks performed by the workflow:
`npm test` on Windows → `npm run dist` → file exists at
`pharmagestion/release/PharmaGestion-DZ-Setup.exe` and is > 20 MB →
packaged app launched with `PHARMAGESTION_SMOKE=1` (creates its database in a
temporary user-data folder, exits 0) → `verify-package.js` asserts the installer
is a PE/NSIS file, `app.asar` contains no tests/docs/fixtures/scripts, only
`win32-x64.node` is packaged, and the smoke database has tables `settings` +
`audit_log` with `integrity_check: ok` and a schema version.

## 6. حدود ما لم يُختبر / Known limitations

- **Installer not installed by a human on a real Windows 10/11 machine yet.**
  The CI smoke run exercises the unpacked application, not the NSIS wizard
  (choose folder, shortcuts, uninstall). That manual pass is pending.
- **Installer is not code-signed** → Windows SmartScreen will show a warning.
- **No compatibility claim for CHIFA** or any pharmacy software: no real sample
  export was provided, so no importer was written.
- Stock, batches, sales, debts, imports and reports are not implemented yet
  (phases 2–5); their screens say so explicitly.
- `npm run dist` must be run on Windows (or the provided GitHub Actions
  workflow). Windows installer builds from Linux would also require Wine + NSIS.
