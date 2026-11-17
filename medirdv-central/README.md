# Medirdv Central

Centralized multi-doctor healthcare booking, official WhatsApp Hub and
BaridiMob payment verification for Algeria.

**Independent project.** It lives beside `medirdv/` and `dentardv/` and never
modifies them; it connects to them only through the documented connector API.

```
┌───────────────────┐   ┌────────────────────┐   ┌─────────────────────┐
│ Patient web (FR/AR)│   │  Admin dashboard   │   │ Doctor self-service │
└─────────┬─────────┘   └─────────┬──────────┘   └──────────┬──────────┘
          └───────────────┬───────┴──────────────────────────┘
                  ┌───────▼────────┐
                  │  Central API   │  (node:http, zero deps)
                  └───┬────────┬───┘
        ┌─────────────▼──┐  ┌──▼──────────────────┐  ┌─────────────────┐
        │ SQLite (WAL)   │  │ Meta WhatsApp Cloud │  │ Medirdv/Dentardv│
        │ bookings, money│  │ API (per doctor)    │  │ desktop (REST)  │
        └────────────────┘  └─────────────────────┘  └─────────────────┘
```

## Quick start

```bash
cd medirdv-central
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"  # → MEDIRDV_ENCRYPTION_KEY
# set MEDIRDV_BOOTSTRAP_ADMIN_PASSWORD in .env
npm run seed-demo     # optional demo doctors/clinics
npm start
```

- Patient platform: <http://localhost:8080/> (French/Arabic, RTL aware)
- Admin dashboard: <http://localhost:8080/admin/>
- Health: <http://localhost:8080/health>

## Desktop app: standalone or connected

Installing `Medirdv-Central-Setup.exe` gives a **working application with no
setup**: it starts the bundled server on this computer, creates a local
administrator, and opens the dashboard. Data lives in
`%APPDATA%\Medirdv Central\data`.

For a multi-administrator network deployment, use *File → Use a shared server…*
so every client shares one authoritative database. *File → Use local database*
switches back. Credentials: *Account → Local administrator…*.

A CI job boots this exact bundled server inside Electron and asserts the
database driver, `/health`, admin login and the dashboard respond before the
installer is packaged.

## Scripts

| Command | Purpose |
|---|---|
| `npm start` | run the server |
| `npm run dev` | run with file watching |
| `npm test` | full test suite (23 tests, Part 15 scenarios) |
| `npm run seed-demo` | demo admin, clinics, doctors, schedules |
| `npm run build:windows` | prepare the Electron wrapper for the NSIS installer |
| `npm run build:android` | prepare the Capacitor project for the APK |

## What is real vs. what needs your credentials

| Capability | Status |
|---|---|
| Booking, slots, double-booking guard, idempotency | **Working**, tested |
| Payment submit + manual verification + audit | **Working**, tested |
| WhatsApp Cloud API send/receive, signature check, per-doctor routing | **Working** (needs Meta app credentials to go live) |
| Click-to-Chat fallback | **Working** |
| Connector sync API for desktop apps | **Working**, tested (desktop-side agent not bundled) |
| FR/AR UI, admin dashboard, analytics | **Working** |
| Windows `.exe` / Android `.apk` | **Built by CI** and attached to release `medirdv-central-v1.1.0` (see `release/RELEASE.md`) |
| BaridiMob automatic verification | **Not implemented** — no official merchant API; manual verification by design |
| Email/SMS notifications | **Not implemented** (in-app + WhatsApp only) |

## Documentation

- `docs/ARCHITECTURE.md` — inspection report, stack rationale, data model
- `docs/API.md` — REST endpoints and webhooks
- `docs/DEPLOYMENT.md` — servers, migrations, backups
- `docs/SECURITY.md` — controls, Law 18-07 checklist
- `docs/OPERATIONS.md` — admin, doctor, patient, and support guides

## Safety rules baked into the code

- A screenshot never marks a payment paid — only a human verifier can.
- A booking is never sent to another doctor's number: routing uses the
  doctor's own `phone_number_id`, and webhook replies are matched to that ID.
- No unofficial WhatsApp automation (Baileys/QR) is used by Central.
- WhatsApp messages carry only name, reference, date/time, clinic.
- No invented BaridiMob API.
