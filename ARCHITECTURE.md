# Medirdv Central — Architecture Report (Phase 1) + System Design

## 1. Inspection of existing projects (no code was modified)

### 1.1 `free-claude-code` (repo root)
- Python 3.14, FastAPI + uvicorn proxy for Anthropic-compatible model routing.
- **Decision:** Medirdv Central is independent of this proxy. No shared code,
  no shared DB, no shared auth. The proxy stays untouched.

### 1.2 `medirdv/` — MediRDV desktop (Electron, Node ≥20)
- Offline-first single-clinic suite: SQLite via `better-sqlite3` (WAL),
  multi-department queues, patients, appointments, payments, expenses,
  prescriptions, Algerian Nomenclature meds catalog.
- WhatsApp: `@whiskeysockets/baileys` (unofficial WhatsApp Web protocol,
  QR pairing). Booking bot in `src/main/whatsapp/` (bot.js / intents.js /
  messages.js / service.js).
- **Findings:**
  - No HTTP API — IPC only (`src/main/ipc.js`, `handlers.js`). Cannot be
    reached remotely as-is.
  - WhatsApp transport is **unofficial** (Baileys). Central must NOT reuse
    this for the platform: Meta Cloud API is the only official path.
  - Appointment model is queue-number based per department/day
    (`appointments(day, department_id, queue_number)`), not slot-time based.
    Central uses explicit date+time slots; mapping is documented in
    `docs/DESKTOP_CONNECTOR.md`.
  - Local DB is a single SQLite file in the user profile (`data/`).
    Sync must be opt-in, conflict-aware, and offline-tolerant.

### 1.3 `dentardv/` — DentaRDV desktop (Electron)
- Same architecture as MediRDV, dental specialty. Same findings.

### 1.4 `dental-clinic-system/` (Google Apps Script)
- Spreadsheet-backed clinic system. Out of scope for direct sync; could
  export CSV → central import later.

### Conclusion
Build Central as a **separate web platform** (Python stdlib + SQLite) and
connect desktops through an **optional REST sync agent** that reads/writes
the local SQLite via a small adapter. Never rewrite the desktop apps.

## 2. Target architecture

```
                        ┌─────────────────────────────┐
                        │        Patient SPA          │
                        │  AR (RTL) / FR (LTR)        │
                        └──────────────┬──────────────┘
                                       │ HTTPS / REST
┌──────────────┐   ┌──────────────────▼──────────────────┐   ┌──────────────────┐
│ Admin SPA    │──▶│  Medirdv Central (Python stdlib)  │──▶│ Meta WhatsApp    │
│ Doctor portal│   │  http.server + sqlite3 (WAL)      │   │ Cloud API        │
└──────────────┘   │  RBAC · booking engine · payments │   │ (official)       │
                   │  WhatsApp router · sync API       │   └────────┬─────────┘
                   └──────┬───────────────┬────────────┘            │ webhook
                          │               │                         ▼
                   ┌──────▼──────┐ ┌──────▼──────────────┐  ┌──────────────────┐
                   │  SQLite DB  │ │  Receipts (files)   │  │  Doctor WhatsApp │
                   │  (WAL)      │ │  data/receipts/     │  │  Business number │
                   └─────────────┘ └─────────────────────┘  └──────────────────┘
                          ▲
                   ┌──────┴───────────────┐
                   │ connector-agent (opt)│──▶ MediRDV / DentaRDV local SQLite
                   │ REST sync + outbox   │
                   └──────────────────────┘
```

### Modules (Part 1.2)
- **Patient Platform** — `static/app.js` + `/api/v1/public/*`
- **Admin** — `/api/v1/admin/*`, RBAC in `app/auth.py`
- **WhatsApp Hub** — `app/whatsapp.py`: Cloud client, per-doctor router,
  webhook processor, Click-to-Chat fallback
- **Payment Engine** — `app/services.py` payment workflow + audit
- **Doctor Connector** — `app/server.py` `/api/v1/connector/*` + `connector-agent/`
- **Notification Engine** — `notifications` table + WhatsApp/in-app channels

## 3. Database (Part 9)

Normalized SQLite schema, versioned migrations (`app/db.py`), foreign keys
ON, WAL mode, `Africa/Algiers` display timezone (UTC storage, Algiers render).
Entities: `users, patients, doctors, clinics, doctor_clinics, specialties,
blocked_dates, appointments, appointment_events, whatsapp_accounts,
whatsapp_messages, whatsapp_webhook_events, payments, payment_audit_logs,
notifications, device_connections, sync_queue, integration_logs,
system_settings, audit_logs`. Sensitive tokens encrypted at rest
(`app/security.py` HMAC-CTR + integrity tag; see `docs/SECURITY.md` for
production KMS recommendation). No diagnosis/medical-record fields in the
booking DB — only the minimum needed to book.

## 4. Booking state machine (Part 6)

```
draft → pending_payment → payment_verification → pending_doctor_approval
      → confirmed | rejected | rescheduling_requested | cancelled | expired
      → completed
```

- `pending_payment` when fee > 0 and policy = `baridimob`/`prepay`.
- `pending_doctor_approval` when fee = 0 or policy = `cash_at_clinic`.
- Idempotency: `Idempotency-Key` header + unique `ref` (`MR-YYYY-NNNNNN`).
- Double-booking prevention: transactional slot check + unique partial index
  on active `(doctor_id, clinic_id, date, time)`.
- Doctor response deadline (`system_settings.doctor_response_hours`, default
  24h): expiry job marks `expired`, notifies patient, offers alternatives.

## 5. WhatsApp design (Part 3)

- One `whatsapp_accounts` row per doctor connection: `waba_id`,
  `phone_number_id`, encrypted `access_token`, status, mode
  (`cloud` | `click_to_chat`).
- Send path: appointment → doctor → connected account → Cloud API
  `POST /{phone_number_id}/messages` with interactive buttons
  (`accept:REF`, `reject:REF`, `reschedule:REF`) or approved template when
  outside the 24h window.
- Receive path: `POST /webhooks/whatsapp` — verify `X-Hub-Signature-256`,
  dedupe by message id, route by `phone_number_id`, update appointment,
  notify patient. Every step logged (`whatsapp_messages`,
  `whatsapp_webhook_events`).
- Fallback: `wa.me/<number>?text=…` prefilled link; manual confirmation by
  admin/doctor. Clearly labeled `click_to_chat` in UI and API.
- **Never** Baileys / QR / unofficial scraping in Central.

## 6. Payments (Part 5)

BaridiMob is a manual transfer app — there is no public auto-verification
API. Workflow: system shows verified recipient details → patient transfers
independently → submits transaction reference + receipt → `under_verification`
→ authorized verifier checks actual receipt of funds → `paid` / `rejected`.
Duplicate `txn_ref` rejected at DB level. Full `payment_audit_logs` trail.
Cash-at-clinic policy supported. CIB/EDAHABIA/Baridi Pay reserved as
`payment_methods` rows for future official merchant APIs.

## 7. Security (Part 10)

PBKDF2-HMAC-SHA256 (200k rounds), session tokens hashed at rest, RBAC
enforced server-side on every route, rate limiting, parameterized SQL,
input validation, file-upload type/size checks, webhook HMAC verification,
audit logs, generic error messages. Algerian Law 18-07 (personal data)
considered: data minimization, consent text, patient access/correction/
deletion endpoints. See `docs/SECURITY.md`.

## 8. Development roadmap (Part 14)

| Phase | Status |
|---|---|
| 1 Inspection | ✅ this document |
| 2 Foundation (backend, DB, auth, admin, doctors, clinics, RBAC) | ✅ `app/` |
| 3 Patient platform (search, profiles, booking, tracking) | ✅ `static/` + public API |
| 4 Appointment engine (availability, states, deadlines) | ✅ `app/services.py` |
| 5 WhatsApp Hub (Cloud API, webhooks, routing, fallback) | ✅ `app/whatsapp.py` |
| 6 Payment Engine (BaridiMob, verification, audit) | ✅ `app/services.py` |
| 7 Desktop connector (REST + agent) | ✅ `/api/v1/connector/*` + `connector-agent/` |
| 8 Notifications & analytics | ✅ notifications table + `/api/v1/admin/stats` |
| 9 Security & testing | ✅ `tests/test_central.py` (Part 15 scenarios) |
| 10 Production deployment | ✅ `docs/DEPLOYMENT.md` |

## 9. What is intentionally NOT built

- No invented BaridiMob / CIB / EDAHABIA API.
- No unofficial WhatsApp automation.
- No auto-confirmation of appointments without doctor authorization
  (unless a doctor explicitly enables it in booking rules).
- No ratings/reviews (would be fabricated data).
- No modification of `medirdv/`, `dentardv/`, or `free-claude-code` code.
