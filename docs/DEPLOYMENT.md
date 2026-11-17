# Deployment (Part 14 — Phase 10)

## Requirements
- Python 3.11+ (stdlib only — no pip installs).
- A reverse proxy (nginx/Caddy) for HTTPS in production.

## Production setup
```bash
cd medirdv-central
cp .env.example .env
# Edit .env: SESSION_SECRET, ENCRYPTION_KEY (long random), COOKIE_SECURE=true,
# WHATSAPP_MODE=cloud, WHATSAPP_APP_SECRET, WHATSAPP_VERIFY_TOKEN, PORT=8080
python3 seed.py            # optional demo data (skip in production)
python3 run.py             # or run under systemd / pm2 / a container
```

## Reverse proxy (nginx example)
```nginx
server {
  listen 443 ssl;
  server_name central.medirdv.dz;
  # ... ssl_certificate directives ...
  location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  }
  location /webhooks/whatsapp {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
  }
}
```

## Environments
- **Development:** `WHATSAPP_MODE=mock`, local `.env`.
- **Staging:** real Meta test numbers, `WHATSAPP_MODE=cloud`, separate DB.
- **Production:** `WHATSAPP_MODE=cloud`, HTTPS, `COOKIE_SECURE=true`,
  changed bootstrap password, backups enabled.

## Backups & recovery
- DB: `data/medirdv_central.db` (+ `-wal`/`-shm`). Stop the server or use
  `sqlite3 medirdv_central.db ".backup 'backup.db'"`.
- Receipts: copy `data/receipts/` alongside the DB.
- Recovery: restore both, restart. Migrations are additive and idempotent.

## Administrator manual (summary)
1. Log in → Doctors: add doctor, set specialty/wilaya/fee/policy, Activate.
2. Clinics: add clinic; link doctor with working days/hours/slot minutes.
3. WhatsApp: Connect each doctor (Cloud API or Click-to-Chat).
4. Settings: set `baridimob_recipient` + instructions.
5. Payments: review `under_verification`, Verify/Reject with notes.
6. Monitoring: check failed messages, unprocessed webhooks, sync failures.

## Doctor onboarding (summary)
1. Admin creates your profile and clinic schedule.
2. Connect your WhatsApp Business number (Embedded Signup or manual token).
3. Set your BaridiMob recipient details via admin.
4. Receive booking requests on WhatsApp; tap Accept / Reject / Reschedule —
   or use the doctor portal. Block dates when unavailable.

## Patient guide (summary)
1. Search by name/specialty/wilaya. 2. Pick a doctor, clinic, date, time.
3. Enter name + phone. 4. If prepay: transfer via BaridiMob, submit the
   transaction reference (+ receipt). 5. Track with your reference + phone.
   6. The doctor confirms via WhatsApp / your tracking page.
