# Medirdv Central — Architecture Report (Phase 1) + System Design

## 1. Existing project inspection (Phase 1)

| Project | Stack | Data | WhatsApp | Role in Central |
|---|---|---|---|---|
| `medirdv/` | Electron 38 + better-sqlite3 + vanilla JS | Local SQLite (`medirdv.sqlite`), offline-first | Baileys (unofficial, local QR) | **Untouched.** Connector client via REST adapter (Part 7). |
| `dentardv/` | Electron 38 + better-sqlite3 + vanilla JS | Local SQLite (`dentardv.sqlite`), offline-first | Baileys (unofficial, local QR) | **Untouched.** Same connector adapter. |
| `free-claude-code` (root) | Python 3.14 + FastAPI proxy | None (stateless proxy) | Discord/Telegram bots | **Unrelated.** No shared code; Central does not import it. |
| `dental-clinic-system/` | Google Apps Script | Google Sheets | Apps Script WhatsApp | **Untouched.** Legacy; not connected. |

**Key findings**
- Desktop apps are offline-first with local SQLite and per-clinic queues (`departments`, `appointments` with `queue_number`). They have **no HTTP API** — IPC only (`medirdv:invoke`). Central therefore connects via a new REST adapter + optional sync agent, never by modifying desktop code (Part 16).
- Desktop WhatsApp uses Baileys (unofficial). Central **must not** reuse it (Part 3.1): Central uses only the official Meta Cloud API. The two WhatsApp systems are deliberately separate.
- No central project existed. Central is built as a **new independent project** (`medirdv-central/`) so existing builds, tests, and releases are unaffected.

## 2. Technology choices

| Layer | Choice | Why |
|---|---|---|
| Runtime | Node.js 22+ (CommonJS) | Matches desktop team skills; `node:sqlite` built-in → zero native deps. |
| Database | SQLite (WAL, FK, `node:sqlite`) | Single-file authoritative store; trivial backup; no DB server to operate. Postgres migration path documented in DEPLOYMENT.md. |
| HTTP | `node:http` (no framework) | Auditable surface, no dependency risk. |
| Frontend | Vanilla HTML/CSS/JS, no build step | Mobile-first, works on low-end devices + slow connections; FR/AR RTL. |
| Auth | scrypt + opaque sessions (httpOnly cookie) | Same primitives as desktop `auth.js`; backend RBAC. |
| Secrets | AES-256-GCM at rest | WhatsApp tokens encrypted; connector keys hashed. |
| WhatsApp | Meta Cloud API only | Official; per-doctor Phone Number ID routing. |
| Payments | BaridiMob manual verification | No invented API; human verification + audit trail. |
| Windows app | Electron wrapper (electron-builder NSIS) | Same pattern as `medirdv/`; built by CI on Windows runner. |
| Android app | Capacitor (PWA + APK) | Real installable APK; single FR/AR codebase; documented justification in `scripts/build-android.js`. |

## 3. Module map

```
medirdv-central/
  src/
    server.js            HTTP server, routing, rate limits, static UI
    db.js / schema.js    SQLite open + append-only migrations (v1)
    auth.js              users, sessions, RBAC (6 roles)
    crypto.js            scrypt, AES-GCM, HMAC webhook signatures
    validate.js          server-side validation (phones DZ, dates, money)
    errors.js            typed AppError + HTTP mapping
    routes/
      admin.js           doctors, clinics, schedules, dashboard, analytics
      public.js          search, booking, tracking, payment submit
      whatsapp.js        Cloud API connect, webhooks, doctor replies
      connector.js       desktop sync API (per-clinic keys)
      doctor.js          doctor self-service (own data only)
    services/
      booking.js         availability, state machine, double-book guard
      payments.js        BaridiMob workflow, receipts, verification
      whatsapp.js        official Cloud API client + routing
      notify.js          in-app notifications
      audit.js           append-only audit trail
    static/
      patient/           public booking site (FR/AR, RTL)
      admin/             central dashboard
  tests/central.test.js  17 end-to-end tests (Part 15 scenarios)
  scripts/               seed-demo, build-windows, build-android
  docs/                  this documentation set
```

## 4. Data model (normalized, Part 9)

`users`, `sessions`, `patients`, `specialties`, `doctors`, `clinics`,
`doctor_clinics`, `doctor_schedules`, `blocked_dates`, `appointments`,
`appointment_events`, `whatsapp_accounts`, `whatsapp_messages`,
`whatsapp_webhook_events`, `payment_methods`, `payments`,
`payment_audit_logs`, `notifications`, `device_connections`,
`integration_logs`, `audit_logs`, `system_settings`, `schema_migrations`.

Invariants:
- Partial unique index `idx_appt_no_double` prevents double bookings.
- Unique `idempotency_key` prevents duplicate bookings on retry/refresh.
- Unique `transaction_ref` (non-empty) prevents duplicate payments.
- Unique `wa_message_id` in webhook events makes deliveries idempotent.
- Timestamps UTC ISO-8601; Africa/Algiers is display-only.

## 5. Booking state machine

```
draft → pending_payment → payment_verification → pending_doctor_approval
  → confirmed → completed | cancelled | rescheduling_requested
  → rejected | cancelled | expired
```

Invalid transitions throw `INVALID_STATE`. A sweeper expires stale pending
bookings. Doctors never auto-confirm unless `auto_confirm` is explicitly set
(and even then, the transition is recorded in `appointment_events`).

## 6. WhatsApp routing (Part 3)

1. Patient books → appointment `pending_payment`.
2. Payment verified → `pending_doctor_approval`.
3. Admin (or auto-policy) calls `notify-doctor` → message sent via the
   **doctor's own** `phone_number_id` (Cloud API).
4. Doctor replies `Accept MR-…` → webhook (signature-verified) → `confirmed`.
5. `Reject` → `rejected`; `Reschedule` → `rescheduling_requested`.
6. Unconnected doctors → Click-to-Chat link (`wa.me`) with prefilled text.
   Central never claims to read Click-to-Chat conversations.

## 7. Desktop connector (Part 7)

- Per-clinic API keys (`mdc_…`, SHA-256 hashed at rest, revocable).
- `POST /api/connector/appointments/push-status` — central wins on conflict.
- `GET /api/connector/availability` + `GET /api/connector/appointments` — pull.
- Every sync attempt logged in `integration_logs`.
- Central works fully offline from the desktop app; sync is best-effort.

## 8. What is NOT built (honest scope)

- **No BaridiMob merchant API** — none is assumed or invented. Payments are
  verified manually by an authorised human, with a full audit trail.
- **No Embedded Signup UI automation** — the dashboard accepts the identifiers
  returned by Meta's Embedded Signup and stores the token encrypted. Wiring the
  Meta JS SDK popup needs a Meta app ID/config ID (`WHATSAPP_EMBEDDED_SIGNUP_*`).
- **`.exe`/`.apk` are CI-built, not committed** — the development sandbox
  cannot reach Electron/Android SDK download hosts, so both are compiled on
  GitHub Actions runners and attached to release `medirdv-central-v1.0.0`
  (installer 97.2 MB, APK 3.3 MB, SHA-256 published). Local build scripts
  prepare the projects; CI performs and verifies the compilation.
- **Installers are unsigned** — Windows SmartScreen and Android "unknown
  sources" warnings apply until signing certificates are added.
- **No email/SMS sending** — in-app notification table + WhatsApp only.
- **No medical records** — bookings carry identity + logistics only (Part 10).
- **No patient self-service deletion endpoint** — specified in SECURITY.md as a
  manual, audited super-admin operation until the routine is exposed.
- **No desktop-side sync agent binary** — the connector REST API is complete
  and tested; the optional agent that runs beside Medirdv/Dentardv is a future
  deliverable (the desktop apps remain untouched, Part 16).

## 9. Test coverage (Part 15)

`npm test` runs 24 tests against a real HTTP server and a temporary database.
Scenarios 1–20 of Part 15 are covered, including: multi-doctor isolation,
duplicate payment rejection, WhatsApp signature verification + duplicate
delivery handling, click-to-chat fallback, connector offline/reconnect and
conflict handling, FR/AR rendering, RBAC restrictions, response deadlines,
expiry sweeping, explicit auto-confirm, and a guard test asserting that the
desktop projects and their build config are still intact and that Central uses
no unofficial WhatsApp library.
