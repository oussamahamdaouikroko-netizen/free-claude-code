# Medirdv Central — REST API

Base: `http://<host>:8080` · All JSON. Errors: `{ "error": { "code", "message", "details" } }`.

## Auth

- `POST /api/auth/login` `{email, password}` → sets `medirdv_session` httpOnly cookie.
- `POST /api/auth/logout`, `GET /api/auth/me`.
- Roles: `super_admin`, `admin`, `payment_verifier`, `support`, `doctor`, `patient`.
  Permissions are enforced server-side (see `src/auth.js` `PERMISSIONS`).

## Public (patient, no auth)

| Method | Path | Description |
|---|---|---|
| GET | `/api/public/doctors?name=&specialty_id=&wilaya=&city=&clinic_id=&available_on=` | Search active doctors |
| GET | `/api/public/doctors/:id` | Doctor profile (active only) |
| GET | `/api/public/doctors/:id/slots?day=YYYY-MM-DD&clinic_id=` | Available slots (server-computed) |
| POST | `/api/public/bookings` | Create booking (idempotent via `idempotency_key`) |
| GET | `/api/public/track?ref=MR-…&phone=05…` | Track by reference + phone |
| POST | `/api/public/cancel` `{ref, phone}` | Cancel own booking |
| POST | `/api/public/payments/:id/submit` | Submit BaridiMob ref + receipt (raw body, `X-Filename`, `X-Transaction-Ref` headers) |
| GET | `/api/public/specialties`, `/api/public/wilayas` | Filter lists |

Booking body: `{patient_name, patient_phone, doctor_id, clinic_id?, day, time, lang?, idempotency_key?, source?}`.
Response: `{appointment, payment, instructions, next_step, created}`.

## Admin (session + permission)

| Method | Path | Permission |
|---|---|---|
| GET | `/api/admin/dashboard` | admin:dashboard |
| GET | `/api/admin/analytics?from=&to=` | admin:analytics |
| GET/POST | `/api/admin/doctors`, `POST /api/admin/doctors/:id/status` | admin:doctors |
| GET/POST | `/api/admin/clinics`, `POST /api/admin/doctor-clinics` | admin:clinics |
| POST | `/api/admin/schedules`, `POST /api/admin/blocked-dates` | admin:doctors |
| GET/POST | `/api/admin/specialties` | admin:doctors |
| GET | `/api/admin/patients?search=` | admin:patients |
| GET | `/api/admin/appointments?doctor_id=&status=&day=` | admin:appointments |
| POST | `/api/admin/appointments/:id/notify-doctor` | admin:appointments |
| POST | `/api/admin/appointments/:id/cancel` | admin:appointments |
| GET | `/api/admin/payments?status=&doctor_id=` | payments:view |
| POST | `/api/admin/payments/:id/verify` `{decision: paid\|rejected, note}` | payments:verify |
| POST | `/api/admin/payments/:id/refund` | payments:verify |
| GET | `/api/admin/whatsapp/accounts` | whatsapp:manage |
| POST | `/api/admin/whatsapp/doctors/:id/connect` | whatsapp:manage |
| POST | `/api/admin/whatsapp/doctors/:id/disconnect` | whatsapp:manage |
| GET | `/api/admin/whatsapp/messages?doctor_id=` | whatsapp:manage |
| POST | `/api/admin/whatsapp/retry-failed` | whatsapp:manage |
| POST | `/api/admin/connector/keys`, `POST /api/admin/connector/keys/:id/revoke` | connector:manage |
| GET | `/api/admin/audit?limit=` | admin:dashboard |
| POST | `/api/admin/users` | admin:settings (super_admin) |

## Doctor (session, own data only)

- `GET /api/doctor/profile`
- `GET /api/doctor/appointments?day=&status=`
- `POST /api/doctor/appointments/:id/respond` `{decision: accepted|rejected|reschedule, proposed_day?, proposed_time?, note?}`
- `POST /api/doctor/schedules`

## Connector (Bearer `mdc_…` API key)

- `POST /api/connector/appointments/push-status` `{external_ref, status, note?}`
- `GET /api/connector/availability?day=&doctor_id=`
- `GET /api/connector/appointments?day=`

## WhatsApp webhooks (Meta)

- `GET /webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…` — verification handshake.
- `POST /webhooks/whatsapp` — signed (`X-Hub-Signature-256`) event delivery; duplicates ignored.

## Health

- `GET /health` → `{ok: true}` (also checks DB).
