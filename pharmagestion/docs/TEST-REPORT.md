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

## 5. Windows build + install verification (real run)

Built on a GitHub Actions `windows-latest` runner by
`.github/workflows/pharmagestion-windows.yml` (run for PR #7). **All steps green.**

| Check | Result |
|---|---|
| `npm test` on Windows | 114/114 pass |
| `npm run dist` (electron-builder 26.18, NSIS x64) | success |
| Installer path | `pharmagestion/release/PharmaGestion-DZ-Setup.exe` |
| Installer size | **100.06 MB** (104 921 115 bytes) |
| Installer format | Windows PE (MZ header) + NSIS (Nullsoft marker) |
| SHA-256 | `c14bf8de2d2461b9ade3f6133b749d7da3248e329f4be33523c217c5055bef25` |
| Packaged app launched (`PHARMAGESTION_SMOKE=1`) | exit code 0 |
| Database created by the packaged app | `%TEMP%\pg-smoke\pharmagestion.sqlite` — **outside** the install folder |
| Tables created | `settings`, `audit_log` |
| Seeded settings | 16 |
| Schema version | v1 |
| `PRAGMA integrity_check` | `ok` |
| Database inside `win-unpacked` | none (verified) |
| `app.asar` contents | application only — no `tests/`, `docs/`, `fixtures/`, `scripts/` |
| SQLite binaries packaged | only `win32-x64.node` |

### Published artifact

| | |
|---|---|
| Release | <https://github.com/oussamahamdaouikroko-netizen/free-claude-code/releases/tag/pharmagestion-v0.1.0> |
| Download | <https://github.com/oussamahamdaouikroko-netizen/free-claude-code/releases/download/pharmagestion-v0.1.0/PharmaGestion-DZ-Setup.exe> |
| Size | 104 921 112 bytes (100.06 MiB) |
| SHA-256 | shown next to the asset on the release page |

> **Why the hash is not pinned in this file.** Each build embeds build
> timestamps, so two builds of the same source produce installers that differ by
> a few bytes (and therefore by hash). GitHub displays the SHA-256 of the
> published asset on the release page: compare it with
> `certutil -hashfile PharmaGestion-DZ-Setup.exe SHA256` after downloading.
> Hashes observed during this work: `c14bf8de…` (first PR build),
> `b307ca10…` (PR build of 0729a88), `0816b9c0…` (first release build).
> All three installers were produced from the same, verified configuration.

Raw verification output (from the build):

```
[1/4] Windows installer
  [ok] installer exists: ...\pharmagestion\release\PharmaGestion-DZ-Setup.exe
  [ok] size: 100.1 MB
  [ok] installer is a Windows PE executable (MZ header)
  [ok] installer is generated by NSIS (Nullsoft marker found)
[2/4] Unpacked application
  [ok] app.asar is present
  [ok] app.asar contains the application only (no tests, docs, fixtures, scripts)
[3/4] SQLite binary inside the package
  [ok] win32-x64.node is packaged
[4/4] Smoke-run database
  [ok] database created outside the install folder
  [ok] tables: audit_log, settings, sqlite_sequence
  [ok] default settings seeded: 16
  [ok] schema version: v1
  [ok] integrity_check: ok
  [ok] no database inside the installation folder
PASSED
```

## 6. حدود ما لم يُختبر / Known limitations

- **The NSIS wizard itself was not clicked through by a human yet.**
  The CI run proves the installer is a valid NSIS executable, that it was built
  from a clean Windows machine, and that the packaged application starts and
  creates its database outside the installation folder. Still to confirm by
  hand on a real Windows 10/11 PC: choosing the install folder, the desktop and
  Start Menu shortcuts, "launch after install", and that uninstalling keeps
  `%APPDATA%\PharmaGestion DZ\data` intact.
- **Installer is not code-signed** → Windows SmartScreen will show a warning.
- **No compatibility claim for CHIFA** or any pharmacy software: no real sample
  export was provided, so no importer was written.
- Stock, batches, sales, debts, imports and reports are not implemented yet
  (phases 2–5); their screens say so explicitly.
- `npm run dist` must be run on Windows (or the provided GitHub Actions
  workflow). Windows installer builds from Linux would also require Wine + NSIS.
