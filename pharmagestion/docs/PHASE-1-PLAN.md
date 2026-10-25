# المرحلة 1 — تقرير الفحص والخطة / Phase 1 — inspection, plan, unknowns

## 1. ما وُجد في المستودع قبل البدء (Inspection before coding)

The repository already contained four unrelated things:

| Path | What it is | Decision |
|---|---|---|
| `api/`, `core/`, `providers/`, `config/`, `cli/`, `messaging/`, `tests/`, `pyproject.toml` | A Python (FastAPI) Claude/Anthropic-compatible proxy. Nothing to do with pharmacy software. | **Not modified.** |
| `dentardv/` | A finished Electron desktop app (dental appointment booking) — bot, marketing, portable demo. | **Not modified.** |
| `medirdv/` | A finished Electron desktop app for medical clinics (SQLite, better-sqlite3, electron-builder NSIS, bilingual FR/AR UI, backups, jsdom renderer tests). **This is the closest working reference.** | **Read only**, used as an architectural reference. |
| `dental-clinic-system/` | Google Apps Script prototypes. | **Not modified.** |

There was **no root `package.json`**, no shared build configuration and **no
PharmaGestion project at all** — the current folder did not contain a pharmacy
application. So a new sub-project was created, next to the existing ones, in the
same style as `medirdv` (which is proven to build a Windows installer in this
repository's CI).

### Patterns reused from `medirdv` (deliberately, not blindly)

- One Electron main process + one narrow preload bridge + one IPC channel.
- `better-sqlite3` with a single shared connection (synchronous, simple).
- `VACUUM INTO` for consistent backups, restore with a safety copy.
- Versioned migration runner driven by `PRAGMA user_version`.
- electron-builder NSIS configuration with `deleteAppDataOnUninstall: false`.
- `scripts/after-pack.js` to keep the right `better-sqlite3` prebuild.
- Cross-platform `tests/run.js` (Windows `cmd.exe` does not expand globs).
- Renderer tested with jsdom (no Electron needed in CI).

### What was *not* reused

- The medical domain code, patients/appointments/prescriptions tables, WhatsApp
  integration, login/password gate, chat bot, marketing/demo modes.
  PharmaGestion DZ starts from a **new schema** with **integer centimes** money
  (MediRDV uses `REAL`), because a ledger must not use binary floating point.

## 2. Stack chosen (and why)

| Need | Choice | Reason |
|---|---|---|
| Desktop shell | Electron 38 | Required by the brief, same as the working sibling app. |
| Storage | SQLite via `better-sqlite3` 13 | N-API prebuilds: no C++ toolchain, works in Node and Electron, ships `win32-x64.node`. |
| UI | Plain HTML/CSS/JS (no framework) | A beginner maintainer can read it; no build step; no supply-chain risk. |
| Packaging | electron-builder 26, NSIS x64 | Produces `PharmaGestion-DZ-Setup.exe`. |
| Tests | Node's built-in `node:test` + jsdom | No test framework to install. |
| Barcode | *Deferred to phase 5* | USB keyboard-wedge scanners already work with plain inputs; a camera library would add a native dependency and must be evaluated first. |

## 3. Phase 1 scope (what this change delivers)

1. Project skeleton, `package.json`, ESLint-free plain CommonJS.
2. SQLite foundation: `settings`, `audit_log`, migration runner, safe pragmas
   (WAL, `synchronous=FULL`, foreign keys), refuse a newer schema.
3. Data folder in `%APPDATA%\PharmaGestion DZ\data` with `backups/`, `exports/`,
   log file; automatic daily backup + manual backup + verified restore + a
   pre-update safety copy before any migration of an existing database.
4. Bilingual UI (FR/AR), RTL switch, ten-section navigation, dashboard,
   settings screen (identity, language, expiry thresholds, backup policy,
   backups list, diagnostics, audit trail).
5. Security: context isolation, sandbox, no node integration, strict CSP,
   IPC allowlist, payload size limits, URL/method validation.
6. Windows installer configuration + CI workflow + packaging verification
   script.
7. 113 automated tests.

Phase 2 (medicines, batches, movements, expiry dashboard) starts only after this
phase is green — as requested.

## 4. Unknowns / open questions (must be answered before the related phase)

| # | Unknown | Blocks | How to resolve |
|---|---|---|---|
| 1 | **No real CHIFA / pharmacy-software export sample** is available. | Phase 4 (importer), any compatibility claim | Ask the pharmacist for 1 CSV, 1 Excel and 1 XML export (anonymised). Never claim CHIFA support before testing against it. |
| 2 | Exact column names, encoding (Windows-1256 / UTF-8), decimal separator and date format of those exports. | Phase 4 | Inspect the real files; the importer wizard maps columns manually anyway. |
| 3 | Whether the pharmacy sells by box, unit or both (partial box). | Phase 2/3 stock model | Confirm with the pharmacist; the schema will store integer quantities plus an optional unit label. |
| 4 | Whether prices include TVA or not. | Phase 3/5 reports | Confirm; reports will show the basis explicitly and never claim "net profit". |
| 5 | Whether barcode labels contain expiry/batch (GS1 AI 17/10) or only a product code. | Phase 5 | Test with the pharmacy's actual scanner and products. |
| 6 | Windows version actually used in the shop (10 or 11) and whether the account is administrator. | Packaging | Installer is per-user, so it works without administrator rights. |
| 7 | Installer is **not code-signed**. | Distribution | SmartScreen will warn on first run. A code-signing certificate is needed for a clean install; decide later. |

## 5. Explicit non-claims

- Not compatible with CHIFA or any other software (untested, no sample).
- No WhatsApp notifications in this phase, and no credentials are stored in the
  desktop app.
- No XML import/export until a real schema is known.
