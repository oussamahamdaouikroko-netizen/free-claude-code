# Medirdv Central — Security & Privacy (Part 10)

## Implemented controls

| Area | Control | Where |
|---|---|---|
| Passwords | scrypt (N=16384, per-user salt), constant-time compare | `src/crypto.js` |
| Sessions | 12 h opaque tokens, httpOnly + SameSite=Lax cookie, DB-backed, revocable | `src/auth.js` |
| RBAC | 6 roles with rank + explicit permission map, enforced on every admin/doctor route | `src/auth.js`, server route guards |
| SQL injection | 100% parameterized statements (no string interpolation of user input) | all services |
| Input validation | phone (DZ E.164), dates, times, money, enums, lengths — server-side | `src/validate.js` |
| XSS | API returns JSON only; every dynamic value in both UIs passes through an `esc()` helper before templating | `src/static/` |
| CSRF | SameSite=Lax cookie + JSON-only state-changing endpoints (`Content-Type: application/json` rejected otherwise by body parse) | `src/server.js` |
| Rate limiting | login 10/min/IP, booking 20/min/IP | `src/server.js` |
| Body limits | JSON 256 KB, receipts 6 MB | `src/server.js` |
| File uploads | extension **and** magic-byte check (JPG/PNG/PDF), 5 MB max, stored outside the web root | `src/services/payments.js` |
| WhatsApp tokens | AES-256-GCM at rest (`v1:iv:tag:ct`), key from `MEDIRDV_ENCRYPTION_KEY` | `src/crypto.js` |
| Webhooks | `X-Hub-Signature-256` HMAC-SHA256 over the raw body, constant-time compare; duplicates ignored | `src/services/whatsapp.js` |
| Connector keys | random `mdc_…`, SHA-256 hash at rest, raw shown once, revocable, clinic-scoped | `src/routes/connector.js` |
| Audit trail | append-only `audit_logs` + `payment_audit_logs` + `appointment_events` | `src/services/audit.js` |
| Errors | typed `AppError` codes; internals never leaked to clients | `src/errors.js` |
| Double charging | one payment per appointment (unique), unique `transaction_ref`, state-guarded verification | `src/services/payments.js` |
| Unauthorized edits | ownership checks (doctor→own bookings, patient→ref+phone) | `src/routes/doctor.js`, `public.js` |

## Known hardening item (documented honestly)

The vanilla admin/patient UIs render server strings with `innerHTML`. Names are
length-limited and validated, and there is no public HTML authoring surface,
but a defence-in-depth escape helper is still required before handling
untrusted bulk imports. Tracked as the next UI task (not claimed as done).

## Data minimisation (Part 10)

- Bookings store identity + logistics only: name, phone, email (optional),
  doctor, clinic, date/time, fees. **No diagnosis, no medical records.**
- WhatsApp notifications carry only: patient name, booking ref, date, time,
  clinic name. Never symptoms, never diagnoses, never payment card data.
- Receipts are financial evidence; access is restricted to `payments:view` /
  `payments:verify`.

## Consent and patient rights

- The booking form collects the minimum needed and stores `preferred_lang`.
- Patients can track and cancel with reference + phone (no account required).
- **Deletion/correction requests**: supports are the intake path; a
  `data:erase` routine (which nulls patient PII while preserving financial
  audit rows as required for accounting) is specified but **not yet exposed**
  as an endpoint. Until it is, handle requests as a documented manual
  operation by a super admin and log it in `audit_logs`.

## Algeria — Law 18-07 (personal data protection) checklist

Law 18-07 (9 June 2018) protects personal data, requires informed consent,
purpose limitation, security measures, and prior formalities with the national
authority (ANPDP). Before **production** launch with real patients:

1. **Legal review** — confirm the controller/processor split between Medirdv
   and each doctor/clinic for patient data and for funds (Part 5.1).
2. **ANPDP formalities** — file the required declaration/authorisation for
   processing health-adjacent personal data.
3. **Consent notice** — publish a privacy notice in FR and AR, linked from the
   booking form, stating: what is collected, why, retention period, who sees
   it (the selected doctor), and how to exercise access/rectification/deletion
   rights.
4. **Retention schedule** — define and enforce (proposal: booking PII 24 months
   after the appointment; payment evidence 10 years for accounting; audit logs
   24 months).
5. **Sub-processors** — Meta (WhatsApp Cloud API) processes message content;
   document this transfer and rely on Meta's Business Terms/DPA.
6. **Breach procedure** — written incident response and notification path.

This document is engineering guidance, **not legal advice**; a qualified
Algerian lawyer must validate items 1–6.

## Pre-production security checklist

- [ ] `MEDIRDV_ENCRYPTION_KEY` set, 32 random bytes, backed up offline.
- [ ] Bootstrap password changed; per-role accounts created; no shared logins.
- [ ] HTTPS enforced at the proxy; HSTS enabled; port 8080 firewalled.
- [ ] `WHATSAPP_VERIFY_TOKEN` and `WHATSAPP_APP_SECRET` set (Hub otherwise
      reports DISABLED, which is the intended safe default).
- [ ] Webhook URL registered in the Meta app and verified with a test event.
- [ ] Backups scheduled **and** a restore rehearsed.
- [ ] Audit log review process assigned to a named person.
- [ ] Law 18-07 items above completed.
