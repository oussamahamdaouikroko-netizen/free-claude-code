# Security & Privacy (Part 10)

## Implemented
- **Passwords:** PBKDF2-HMAC-SHA256, 200k rounds, per-password salt.
- **Sessions:** random 256-bit tokens; only SHA-256 hashes stored; 12h expiry;
  HttpOnly + SameSite=Lax cookies; `Secure` flag via `COOKIE_SECURE=true`.
- **CSRF:** per-session token required (`X-CSRF-Token`) on all mutations.
- **RBAC:** 6 roles enforced server-side on every route (see `app/auth.py`).
  Payment verification requires `payment_verifier`/`super_admin`; support
  agents cannot see financial data; doctors only see their own bookings.
- **Encryption at rest:** WhatsApp access tokens encrypted with an
  HMAC-CTR stream cipher + integrity tag keyed from `ENCRYPTION_KEY`
  (stdlib-only, no pip dependency). **Production recommendation:** move to
  a KMS/HSM (e.g. AWS KMS envelope encryption) — the cipher is a
  dependency-free stopgap, not a substitute for managed key storage.
- **Webhooks:** `X-Hub-Signature-256` HMAC verification; payload-hash dedupe.
- **Rate limiting:** per-IP token bucket (300/min) in-process; also enforce
  at your reverse proxy.
- **Input validation:** email/phone/date/time formats, length caps,
  parameterized SQL everywhere (no string-built queries with user input).
- **File uploads:** extension allowlist (JPG/PNG/PDF), 5MB cap, magic-byte
  check, random filenames, stored outside web root.
- **Audit logs:** every admin/doctor/payment action recorded.
- **Errors:** generic messages to clients; details only in server logs.

## Privacy (Algerian Law 18-07 — personal data protection)
- Data minimization: booking DB stores name/phone/date/time only — **no
  diagnoses, no medical records**.
- Consent: booking form states the purpose; patients can request access,
  correction or deletion via support (admin can delete/anonymize patient
  rows; audit log records the action).
- WhatsApp messages carry only the minimum needed (name, ref, date, clinic).
- **Before production:** have an Algerian data-protection lawyer review
  retention periods, consent wording, and cross-border (Meta) data flows.

## Operational checklist
- Change bootstrap admin password; disable default accounts.
- Run behind HTTPS (reverse proxy) with `COOKIE_SECURE=true`.
- Back up `data/medirdv_central.db` (SQLite WAL — use `.backup` or copy
  with the server stopped) and `data/receipts/` regularly.
- Rotate `SESSION_SECRET` / `ENCRYPTION_KEY` with a migration plan
  (rotating `ENCRYPTION_KEY` requires re-encrypting stored tokens).
- Keep `WHATSAPP_MODE=cloud` in production; `mock` is for dev/tests only.
