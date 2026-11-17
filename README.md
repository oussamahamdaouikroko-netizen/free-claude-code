# Medirdv Central — Centralized Healthcare Booking Platform for Algeria

One central system that connects **patients, doctors, clinics, WhatsApp Business
accounts, appointments and payments** — managed from a single administrator
dashboard owned by the Medirdv platform.

> **Independent project.** This folder (`medirdv-central/`) is a new, standalone
> application. It does **not** modify, replace or depend on the existing
> `medirdv/` / `dentardv/` desktop apps or the `free-claude-code` proxy.
> Desktop apps connect later through the optional sync agent
> (`connector-agent/`) — see `docs/DESKTOP_CONNECTOR.md`.

## What it does

- **Patient platform** (AR RTL + FR LTR, mobile-first): search doctors by
  specialty / wilaya / city / clinic, view profiles, book in a few steps
  (guest booking allowed), pay via BaridiMob instructions + receipt submission,
  track bookings by reference.
- **Admin dashboard**: doctors, clinics, appointments, payments (verify/reject),
  WhatsApp accounts, patients, analytics, monitoring, audit logs.
- **WhatsApp Hub**: official Meta WhatsApp Business Platform (Cloud API) —
  multi-doctor accounts, per-doctor routing by Phone Number ID, webhook
  handling of doctor Accept / Reject / Reschedule, Click-to-Chat fallback.
- **Payment engine**: BaridiMob manual workflow (instructions → transaction
  reference + receipt → admin verification → Paid/Rejected), cash-at-clinic
  policy, full audit trail, duplicate-reference protection. **No fake payment
  API is invented** — see `docs/PAYMENTS.md`.
- **Appointment engine**: server-side availability, double-booking prevention,
  doctor response deadlines, cancellation / rescheduling.
- **Desktop connector**: REST sync API + offline outbox queue for Medirdv /
  Dentardv desktop apps (optional lightweight agent).
- **Security**: RBAC (6 roles), PBKDF2 password hashing, session tokens,
  encrypted WhatsApp credentials at rest, webhook signature verification,
  rate limiting, audit logs.

## Technology choices (Part 13)

| Layer | Choice | Why |
|---|---|---|
| Backend | Python 3.11+ **stdlib only** (`http.server`, `sqlite3`, `urllib`) | Zero pip installs; runs anywhere; easy to audit |
| Database | SQLite (WAL) with versioned migrations | Single-file backup, no server to install; normalized schema |
| Frontend | Vanilla HTML/CSS/JS SPA (no build step) | Fast, mobile-first, AR/FR i18n, no npm needed |
| WhatsApp | Meta Cloud API (official) + `wa.me` fallback | Only official integration; no Baileys/QR scraping |
| Payments | Manual BaridiMob verification | No official auto-verify API exists — never simulated |
| Tests | `unittest` (stdlib) | `python3 -m unittest` |

## Quick start

```bash
cd medirdv-central
cp .env.example .env        # edit secrets (see below)
python3 run.py              # starts on http://0.0.0.0:8080
```

Open `http://localhost:8080` in a browser.

**Default accounts (change immediately in production):**

| Role | Email | Password |
|---|---|---|
| Super admin | `admin@medirdv.dz` | `admin123` |
| Doctor (demo) | `doctor@medirdv.dz` | `doctor123` |

Seed demo data (2 doctors, 2 clinics, specialties) with:

```bash
python3 seed.py
```

## Configuration (`.env`)

Copy `.env.example` to `.env`. Key variables:

- `PORT`, `HOST`, `DATA_DIR`, `DB_PATH`
- `SESSION_SECRET`, `ENCRYPTION_KEY` — long random strings (generate with
  `python3 -c "import secrets; print(secrets.token_urlsafe(48))"`)
- `WHATSAPP_MODE=cloud|mock|disabled` — `mock` is for local dev/tests only
  and is clearly labeled in every log; it never pretends to be Meta.
- `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN` — for webhooks
- `META_GRAPH_VERSION` — e.g. `v21.0`

Never commit a real `.env`. See `docs/DEPLOYMENT.md`.

## Project layout

```
medirdv-central/
  run.py                  entrypoint (python3 run.py)
  seed.py                 demo data seeder
  app/
    config.py             env-based configuration
    db.py                 schema + migrations + connection helpers
    security.py           hashing, tokens, encryption, validation, rate limit
    auth.py               RBAC roles & permission matrix
    i18n.py               Arabic / French message strings
    whatsapp.py           Cloud API client, router, webhook processor
    services.py           business logic (doctors, booking, payments, …)
    server.py             HTTP router + REST API + static file serving
  static/
    index.html            SPA shell
    style.css             design system (RTL/LTR aware)
    app.js                patient site + admin + doctor portal
  tests/
    test_central.py       scenario tests (Part 15)
  docs/                   deployment, manuals, API, security, WhatsApp setup…
  connector-agent/        optional desktop sync agent (Node, reference)
```

## Documentation

- `ARCHITECTURE.md` — inspection report, architecture, roadmap (Phase 1)
- `docs/API.md` — REST API reference
- `docs/WHATSAPP_SETUP.md` — Meta Embedded Signup + webhook setup
- `docs/PAYMENTS.md` — BaridiMob workflow & verification policy
- `docs/ADMIN_MANUAL.md`, `docs/DOCTOR_ONBOARDING.md`, `docs/PATIENT_GUIDE.md`
- `docs/SECURITY.md`, `docs/DESKTOP_CONNECTOR.md`, `docs/DEPLOYMENT.md`

## Honesty rules enforced by this codebase

1. WhatsApp messages are only sent via the **official Cloud API** when a
   doctor has connected an authorized account. Otherwise the system offers
   Click-to-Chat and says so explicitly.
2. A payment is **never** marked Paid from a screenshot alone — only an
   authorized verifier can confirm receipt of funds.
3. Messages are always routed by the appointment's doctor → that doctor's
   Phone Number ID. Cross-doctor leakage is prevented by design + tests.
4. `WHATSAPP_MODE=mock` logs what *would* be sent; it is never presented as
   a real delivery.
