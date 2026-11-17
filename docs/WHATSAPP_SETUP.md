# WhatsApp Hub — Official Meta Setup (Part 3)

Central uses **only** the official WhatsApp Business Platform (Cloud API).
No Baileys, no QR pairing, no unofficial automation — ever.

## 1. Meta prerequisites
1. Create a Meta Business account and a WhatsApp Business Account (WABA).
2. Create a WhatsApp app in Meta for Developers; add the WhatsApp product.
3. Add a phone number (a real SIM or virtual number that can receive SMS/voice OTP **once**, during Meta setup — Central never stores OTPs or passwords).
4. Note: WABA ID, Phone Number ID, and a permanent System User access token
   (with `whatsapp_business_messaging` permission).

## 2. Embedded Signup (per doctor)
Doctors authorize Central through Meta's Embedded Signup flow:
1. Doctor clicks "Connect WhatsApp" in the admin dashboard.
2. Meta hosts the signup; the doctor picks/creates their WABA and number.
3. Central receives the authorization code, exchanges it for a token
   server-side, and stores it **encrypted at rest** (`whatsapp_accounts.access_token_enc`).
4. Status becomes `connected`. Messages route by that doctor's Phone Number ID.

Until Meta approves your app for Embedded Signup, onboard doctors manually:
Admin → WhatsApp → Connect → enter Phone Number ID + access token.

## 3. Webhook configuration (Meta dashboard)
- Callback URL: `https://YOUR-DOMAIN/webhooks/whatsapp`
- Verify token: value of `WHATSAPP_VERIFY_TOKEN` in `.env`
- App secret: value of `WHATSAPP_APP_SECRET` (used for `X-Hub-Signature-256`)
- Subscribe to `messages` field.

Central verifies every webhook signature and deduplicates by payload hash.
Duplicate deliveries are safely ignored (test 13).

## 4. Message templates
Interactive buttons work inside the 24h customer-service window. Outside it,
Meta requires **approved templates**. Create templates in Meta Business
Manager (e.g. `booking_request_v1`, `appointment_confirmation_v1`) and set
their names in Admin → Settings (`whatsapp_template_booking`,
`whatsapp_template_confirmation`). Central's Cloud client sends interactive
buttons; if Meta rejects the payload, the message is marked `failed` and can
be retried from the admin inbox — never silently dropped.

## 5. Click-to-Chat fallback
Doctors who cannot use the Cloud API register a public WhatsApp number.
Patients get a `wa.me/<number>?text=<prefilled booking>` link and send the
message manually. The UI and API label these doctors `click_to_chat`.
Central **cannot** read or manage those conversations — confirmation is
manual (admin/doctor marks it). This limitation is stated in the UI.

## 6. Privacy
Only appointment-related messages are processed. Personal conversations of
doctors are never accessed. WhatsApp messages contain only the minimum
needed to process the booking (name, reference, date/time, clinic) — no
diagnoses or medical records.
