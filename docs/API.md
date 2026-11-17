# Medirdv Central — REST API Reference

Base: `http://HOST:PORT`. All JSON. Auth: `medirdv_session` HttpOnly cookie
+ `X-CSRF-Token` header on mutations (returned by login). Errors:
`{"error": "..."}` with 400/401/403/404/409/429/500.

## Public (no auth)

| Method | Path | Description |
|---|---|---|
| GET | `/api/v1/health` | Health + WhatsApp mode |
| GET | `/api/v1/public/specialties` | Specialty list |
| GET | `/api/v1/public/doctors?q=&specialty=&wilaya=&city=&clinic=` | Search **active** doctors only |
| GET | `/api/v1/public/doctors/{id}` | Doctor profile + clinics + WhatsApp mode |
| GET | `/api/v1/public/doctors/{id}/availability?date=&clinic_id=` | Server-side slots |
| POST | `/api/v1/public/bookings` | Create booking. Header `Idempotency-Key` prevents duplicates. Returns `{booking, duplicate, whatsapp}` |
| GET | `/api/v1/public/bookings/track?ref=&phone=` | Track by reference + phone |
| POST | `/api/v1/public/bookings/{ref}/payment` | Submit BaridiMob txn reference `{phone, txn_ref}` |
| POST | `/api/v1/public/bookings/{ref}/receipt` | Submit reference + receipt `{phone, txn_ref, filename, file_b64}` (JPG/PNG/PDF ≤5MB) |
| POST | `/api/v1/public/bookings/{ref}/cancel` | Cancel `{phone}` |
| GET | `/api/v1/public/bookings/{ref}/click-to-chat` | Fallback `wa.me` link |

## Auth

| Method | Path | Description |
|---|---|---|
| POST | `/api/v1/auth/login` | `{email, password}` → sets cookie, returns `{user, csrf_token}` |
| POST | `/api/v1/auth/logout` | Ends session |
| GET | `/api/v1/auth/me` | Current user |

## Admin (`/api/v1/admin/*`, RBAC enforced)

- `GET /stats` — dashboard KPIs + charts data
- `GET/POST /doctors`, `PUT /doctors/{id}`, `POST /doctors/{id}/status`
- `POST /doctors/{id}/clinics/{clinic_id}` — link schedule
- `GET/POST /clinics`
- `GET /appointments?status=&doctor_id=`
- `GET /payments?status=&ref=`, `POST /payments/{id}/verify` (`{decision: paid|rejected, notes}`), `POST /payments/{id}/refund`
- `GET/POST /whatsapp/accounts`, `POST /whatsapp/accounts/{doctor_id}/disconnect`
- `GET /whatsapp/messages?doctor_id=&ref=`, `POST /whatsapp/messages/{id}/retry`
- `GET /patients`, `GET/POST /users`, `GET/POST /settings`, `GET /audit`, `GET /monitoring`

## Doctor (`/api/v1/doctor/*`)

- `GET /me`, `GET /appointments`, `POST /appointments/{id}/respond` (`{action: accept|reject|reschedule|complete}`), `POST /availability` (block a date)

## Connector (`/api/v1/connector/*`, device token headers)

- `POST /register` `{doctor_id, device_id, app_kind}` → `{token}` (show once)
- `POST /heartbeat`, `POST /sync/push` `{kind, payload}`, `GET /sync/pull`, `POST /sync/ack` `{ids}`

## Webhook

- `GET /webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=&hub.challenge=` — Meta verification
- `POST /webhooks/whatsapp` — requires `X-Hub-Signature-256` (HMAC-SHA256 with `WHATSAPP_APP_SECRET`). Idempotent by payload hash.

## Booking statuses
`draft, pending_payment, payment_verification, pending_doctor_approval, confirmed, rejected, rescheduling_requested, cancelled, completed, expired`

## Payment statuses
`awaiting_payment, submitted, under_verification, paid, rejected, expired, refunded`
