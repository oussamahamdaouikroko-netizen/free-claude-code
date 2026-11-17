# Medirdv Central — Operator Manuals (Part 10/17)

## A0. First launch (desktop app)

The Windows application runs its own local server, so the very first launch
shows a **setup screen**: enter your name, email and password. That account is
the super administrator for this computer. Nothing is generated for you.

- Forgot the password? Dashboard header → **Mot de passe** (while signed in).
- Still on the 1.1.0 build? Uninstall and install 1.2.0 (data is preserved), or
  set new credentials without touching records:

  ```bash
  node scripts/reset-admin.js --data "<data folder>" \
       --email you@example.dz --password "your-new-password"
  ```

  *Help → Data folder…* in the app shows the exact path.

## A. Administrator manual

### Onboarding a new doctor (the Part 17 workflow)

1. **Create the profile** — *Médecins → Ajouter*: full name, specialty,
   phone, WhatsApp number, consultation fee. The doctor starts as `pending`.
2. **Add the clinic** — *Cliniques → Ajouter*: name, wilaya, commune, address,
   phone. Then link doctor ↔ clinic (API `POST /api/admin/doctor-clinics`;
   the dashboard form for linking is the next UI increment).
3. **Configure working hours** — `POST /api/admin/schedules` with
   `doctor_id`, `clinic_id`, `weekday` (0=Sunday), `start_time`, `end_time`.
   Repeat per weekday. Add holidays with `POST /api/admin/blocked-dates`.
4. **Connect WhatsApp** — *WhatsApp* tab:
   - **Official API:** complete Meta Embedded Signup for the doctor's business
     number, then `POST /api/admin/whatsapp/doctors/:id/connect` with
     `{mode:'cloud_api', phone_number_id, access_token, waba_id}`.
     The token is encrypted at rest; the Hub shows `connected`.
   - **Fallback:** `{mode:'click_to_chat', whatsapp_number}` — patients get a
     prefilled `wa.me` link instead. The dashboard clearly marks these doctors
     as click-to-chat only.
5. **Configure payments** — set `payment_mode` (`baridimob_manual`,
   `cash_at_clinic`, `free`) and, for BaridiMob, the doctor's recipient name
   and RIB, so patients see the right account.
6. **Activate** — *Médecins → active*. Only `active` doctors appear in the
   patient search.

### Daily operations

- **Payments** — open *Paiements*. For each `under_verification` row: open the
  receipt, check the transaction reference against the actual BaridiMob
  account, then **Vérifier (payé)** or **Rejeter** with a note. A screenshot
  is never sufficient: confirm the funds in the bank account.
- **Appointments** — *Rendez-vous*: filter by status, re-send the WhatsApp
  notification, or cancel. Bookings past the doctor's response deadline are
  expired automatically by the sweeper.
- **WhatsApp health** — *WhatsApp* shows each doctor's connection and last
  error. Use *Réessayer les messages échoués* to retry failed sends (safe:
  failures are recorded per message ID and never double-charge).
- **Audit review** — `GET /api/admin/audit` lists logins, doctor changes,
  payment decisions, and connector key events.

### Roles

| Role | Can do |
|---|---|
| Super Admin | everything, incl. creating users |
| Admin | doctors, clinics, appointments, WhatsApp, analytics (no payment verify by default) |
| Payment Verifier | view + verify/reject/refund payments only |
| Support | look up bookings/patients to assist; no financial actions |
| Doctor | own profile, schedule, own appointments and responses |
| Patient | own bookings via reference + phone |

## B. Doctor guide (short)

- You receive a WhatsApp message per new booking request with the booking ID,
  date, time, clinic, and patient name (no medical details).
- Reply **`Accept MR-2026-000001`**, **`Reject MR-2026-000001`**, or
  **`Reject MR-2026-000001 reschedule`**. Only your own bookings are accepted
  from your number; others are ignored.
- If you prefer the dashboard, log in and use *Rendez-vous* to accept, reject,
  or propose a new time.

## C. Patient guide (short)

1. Open the Medirdv site (or the Medirdv Android app).
2. Search by specialty, wilaya, or doctor name.
3. Pick a doctor, clinic, date, and an available time.
4. Enter your name and phone — no account needed.
5. If payment is required, transfer the exact amount via **BaridiMob** to the
   displayed recipient, then submit the transaction reference and receipt.
6. Track your booking any time with your reference (`MR-…`) and phone number.
7. You may cancel before the doctor's cancellation deadline.

## D. Support checklist (common issues)

| Symptom | Check |
|---|---|
| Doctor not visible to patients | status must be `active`; a clinic must be linked; at least one schedule row |
| No slots offered | schedule exists for that weekday; date not blocked; not past `booking_lead_hours` |
| WhatsApp send fails | doctor account `connected`? token expired? check *WhatsApp* tab last error |
| Payment stuck | receipt missing/duplicate reference; verify in bank, then decide |
| `SLOT_TAKEN` for a patient | another patient took the slot; offer the next available time |
| Connector 401 | key revoked or wrong clinic; issue a new key |
