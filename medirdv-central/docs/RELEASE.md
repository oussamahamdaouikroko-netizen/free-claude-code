# Medirdv Central — Installation & Release

## v1.2.1 — the window always shows a screen

Fixed the "sign-up dashboard does not appear" report. The cause was not
credentials: `admin/app.js` referenced an undeclared variable, so the whole
script failed on load and every view stayed hidden.

- `app.js` declares `apiBase`; a `401` is now treated as the normal signed-out
  state.
- The desktop menu bar is visible again (`autoHideMenuBar: false`), so
  **Fichier → Récupérer l'accès administrateur…** is reachable.
- New `/admin/recover.html` + loopback-only `/api/recovery/reset` let the
  operator set new credentials from inside the app. Business records are never
  modified.
- `desktop/main.js` is a real source file instead of generated template text.
- 42 tests pass, including three that fail if the blank-screen bug returns.

Artifacts: `Medirdv-Central-Setup-1.2.1.exe` (111,960,120 B),
`Medirdv-Patient.apk` (3,441,411 B), and their `.sha256` files.
