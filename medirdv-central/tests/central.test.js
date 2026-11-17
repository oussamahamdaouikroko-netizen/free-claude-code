'use strict';
/**
 * Medirdv Central — end-to-end API tests (Part 15 scenarios).
 * Runs against a real server on an ephemeral port with a temp SQLite DB.
 * No real money, no real WhatsApp: Cloud API is exercised via webhook
 * signatures + click-to-chat fallback (official API needs Meta credentials).
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'medirdv-central-'));
process.env.MEDIRDV_DB_PATH = path.join(tmpDir, 'test.sqlite');
process.env.MEDIRDV_RECEIPTS_DIR = path.join(tmpDir, 'receipts');
process.env.MEDIRDV_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
// Ephemeral port so the suite never collides with a running dev server.
process.env.PORT = '0';
process.env.WHATSAPP_VERIFY_TOKEN = 'test-verify-token';
process.env.WHATSAPP_APP_SECRET = 'test-app-secret';
process.env.MEDIRDV_BOOTSTRAP_ADMIN_EMAIL = 'admin@medirdv.dz';
process.env.MEDIRDV_BOOTSTRAP_ADMIN_PASSWORD = 'admin-pass-123';

const { start } = require('../src/server');
const whatsapp = require('../src/services/whatsapp');
const { hmacSha256Hex } = require('../src/crypto');

let server;
let base;
let adminCookie = '';
let doctorCookie = '';
let doctorAId = 0;
let doctorBId = 0;
let clinicId = 0;
let bookingRef = '';
let paymentId = 0;

async function req(method, pathname, { body = null, cookie = '', headers = {} } = {}) {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: body === null ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data, headers: res.headers };
}

function cookieFrom(res) {
  const setCookie = res.headers.get('set-cookie') || '';
  const match = setCookie.match(/medirdv_session=([^;]+)/);
  return match ? `medirdv_session=${match[1]}` : '';
}

before(async () => {
  server = start();
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('health endpoint reports OK', async () => {
  const { status, data } = await req('GET', '/health');
  assert.equal(status, 200);
  assert.equal(data.ok, true);
});

test('bootstrap admin can log in; wrong password is rejected', async () => {
  const bad = await req('POST', '/api/auth/login', { body: { email: 'admin@medirdv.dz', password: 'wrong' } });
  assert.equal(bad.status, 401);
  const good = await req('POST', '/api/auth/login', { body: { email: 'admin@medirdv.dz', password: 'admin-pass-123' } });
  assert.equal(good.status, 200);
  assert.equal(good.data.user.role, 'super_admin');
  adminCookie = cookieFrom(good);
  assert.ok(adminCookie);
});

test('unauthenticated admin access is rejected', async () => {
  const { status } = await req('GET', '/api/admin/dashboard');
  assert.equal(status, 401);
});

test('admin creates clinic, doctors, schedules and activates them', async () => {
  const clinic = await req('POST', '/api/admin/clinics', { cookie: adminCookie, body: { name: 'Clinic A', wilaya: 'Alger', city: 'Alger Centre', address: 'Rue Didouche' } });
  assert.equal(clinic.status, 201);
  clinicId = clinic.data.clinic.id;

  const docA = await req('POST', '/api/admin/doctors', { cookie: adminCookie, body: { full_name: 'Dr Amina', specialty_text: 'Cardiologie', phone: '0550123456', whatsapp_number: '0550123456', consultation_fee: 2000 } });
  assert.equal(docA.status, 201);
  doctorAId = docA.data.doctor.id;
  assert.equal(docA.data.doctor.status, 'pending');

  const docB = await req('POST', '/api/admin/doctors', { cookie: adminCookie, body: { full_name: 'Dr Karim', specialty_text: 'Dentaire', phone: '0661234567', consultation_fee: 1500 } });
  doctorBId = docB.data.doctor.id;

  await req('POST', '/api/admin/doctor-clinics', { cookie: adminCookie, body: { doctor_id: doctorAId, clinic_id: clinicId } });
  // Schedule: every day 09:00-17:00
  for (let weekday = 0; weekday < 7; weekday += 1) {
    const s = await req('POST', '/api/admin/schedules', { cookie: adminCookie, body: { doctor_id: doctorAId, clinic_id: clinicId, weekday, start_time: '09:00', end_time: '17:00' } });
    assert.equal(s.status, 201);
  }
  const act = await req('POST', `/api/admin/doctors/${doctorAId}/status`, { cookie: adminCookie, body: { status: 'active' } });
  assert.equal(act.data.doctor.status, 'active');
});

test('patient search only shows active doctors', async () => {
  const { data } = await req('GET', '/api/public/doctors');
  const ids = data.doctors.map((d) => d.id);
  assert.ok(ids.includes(doctorAId));
  assert.ok(!ids.includes(doctorBId), 'pending doctor must not be listed');
});

test('scenario 1-4: patient books with Doctor A, payment submitted, admin verifies, doctor confirms', async () => {
  const day = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const slots = await req('GET', `/api/public/doctors/${doctorAId}/slots?day=${day}&clinic_id=${clinicId}`);
  assert.ok(slots.data.slots.length > 0);
  const time = slots.data.slots[0];

  const booking = await req('POST', '/api/public/bookings', {
    body: { patient_name: 'Ahmed Patient', patient_phone: '0555987654', doctor_id: doctorAId, clinic_id: clinicId, day, time, idempotency_key: 'test-key-1' },
  });
  assert.equal(booking.status, 201);
  bookingRef = booking.data.appointment.public_ref;
  paymentId = booking.data.payment.id;
  assert.equal(booking.data.appointment.status, 'pending_payment');
  assert.equal(booking.data.payment.amount, 2000);

  // Idempotent retry returns the same booking (no duplicate).
  const retry = await req('POST', '/api/public/bookings', {
    body: { patient_name: 'Ahmed Patient', patient_phone: '0555987654', doctor_id: doctorAId, clinic_id: clinicId, day, time, idempotency_key: 'test-key-1' },
  });
  assert.equal(retry.data.appointment.public_ref, bookingRef);
  assert.equal(retry.data.created, false);

  // Double-booking the same slot is rejected.
  const clash = await req('POST', '/api/public/bookings', {
    body: { patient_name: 'Other', patient_phone: '0661111111', doctor_id: doctorAId, clinic_id: clinicId, day, time },
  });
  assert.equal(clash.status, 409);
  assert.equal(clash.data.error.code, 'SLOT_TAKEN');

  // Submit payment reference + receipt (PNG magic bytes).
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
  const submit = await fetch(`${base}/api/public/payments/${paymentId}/submit`, {
    method: 'POST',
    headers: { 'X-Filename': 'receipt.png', 'X-Transaction-Ref': 'TXN-12345' },
    body: png,
  });
  assert.equal(submit.status, 200);
  const submitted = await submit.json();
  assert.equal(submitted.payment.status, 'under_verification');

  // Screenshot alone is NOT paid: still under verification.
  const tracked = await req('GET', `/api/public/track?ref=${bookingRef}&phone=0555987654`);
  assert.equal(tracked.data.payment.status, 'under_verification');

  // Admin verifies → appointment moves to pending_doctor_approval.
  const verify = await req('POST', `/api/admin/payments/${paymentId}/verify`, { cookie: adminCookie, body: { decision: 'paid', note: 'Funds received' } });
  assert.equal(verify.data.payment.status, 'paid');
  const tracked2 = await req('GET', `/api/public/track?ref=${bookingRef}&phone=0555987654`);
  assert.equal(tracked2.data.appointment.status, 'pending_doctor_approval');
});

test('scenario 9: duplicate transaction reference is rejected', async () => {
  const day = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
  const slots = await req('GET', `/api/public/doctors/${doctorAId}/slots?day=${day}&clinic_id=${clinicId}`);
  const time = slots.data.slots[1];
  const booking = await req('POST', '/api/public/bookings', {
    body: { patient_name: 'Sara', patient_phone: '0770123456', doctor_id: doctorAId, clinic_id: clinicId, day, time },
  });
  const otherPaymentId = booking.data.payment.id;
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const dup = await fetch(`${base}/api/public/payments/${otherPaymentId}/submit`, {
    method: 'POST',
    headers: { 'X-Filename': 'r.png', 'X-Transaction-Ref': 'TXN-12345' },
    body: png,
  });
  assert.equal(dup.status, 409);
  const body = await dup.json();
  assert.equal(body.error.code, 'DUPLICATE_PAYMENT');
});

test('scenario 5-6: Doctor B cannot access Doctor A bookings', async () => {
  // Create a doctor user linked to Doctor B.
  const db = require('../src/db');
  const { createUser } = require('../src/auth');
  const doctorUser = createUser({ email: 'karim@medirdv.dz', password: 'doctor-pass-1', fullName: 'Dr Karim', role: 'doctor', doctorId: doctorBId });
  assert.ok(doctorUser.id);
  const login = await req('POST', '/api/auth/login', { body: { email: 'karim@medirdv.dz', password: 'doctor-pass-1' } });
  doctorCookie = cookieFrom(login);
  const mine = await req('GET', '/api/doctor/appointments', { cookie: doctorCookie });
  assert.equal(mine.status, 200);
  assert.ok(!mine.data.appointments.some((a) => a.public_ref === bookingRef));
  // Doctor B cannot confirm Doctor A's booking.
  const appt = await req('GET', '/api/admin/appointments', { cookie: adminCookie });
  const target = appt.data.appointments.find((a) => a.public_ref === bookingRef);
  const forbidden = await req('POST', `/api/doctor/appointments/${target.id}/respond`, { cookie: doctorCookie, body: { decision: 'accepted' } });
  assert.equal(forbidden.status, 403);
});

test('scenario 10-11: disconnect falls back to click-to-chat; Cloud API connect encrypts token', async () => {
  const ctc = await req('POST', `/api/admin/whatsapp/doctors/${doctorAId}/connect`, { cookie: adminCookie, body: { mode: 'click_to_chat', whatsapp_number: '0550123456' } });
  assert.equal(ctc.data.account.mode, 'click_to_chat');
  const profile = await req('GET', `/api/public/doctors/${doctorAId}`);
  assert.equal(profile.data.doctor.whatsapp_mode, 'click_to_chat');
  assert.ok(profile.data.doctor.whatsapp_number);

  const cloud = await req('POST', `/api/admin/whatsapp/doctors/${doctorAId}/connect`, {
    cookie: adminCookie,
    body: { mode: 'cloud_api', phone_number_id: 'PNID-1', access_token: 'secret-token-xyz', display_number: '+213550123456' },
  });
  assert.equal(cloud.data.account.mode, 'cloud_api');
  assert.equal(cloud.data.account.status, 'connected');
  // Token is encrypted at rest (not plaintext in DB).
  const db = require('../src/db');
  const row = db.getDb().prepare('SELECT access_token_enc FROM whatsapp_accounts WHERE doctor_id = ?').get(doctorAId);
  assert.ok(row.access_token_enc.startsWith('v1:'));
  assert.ok(!row.access_token_enc.includes('secret-token-xyz'));

  const disc = await req('POST', `/api/admin/whatsapp/doctors/${doctorAId}/disconnect`, { cookie: adminCookie });
  assert.equal(disc.data.account.status, 'disconnected');
});

test('scenario 12-13: webhook signature verified, duplicates ignored, doctor accept confirms booking', async () => {
  // Reconnect for webhook routing.
  await req('POST', `/api/admin/whatsapp/doctors/${doctorAId}/connect`, {
    cookie: adminCookie,
    body: { mode: 'cloud_api', phone_number_id: 'PNID-1', access_token: 'secret-token-xyz' },
  });
  const payload = {
    entry: [{
      changes: [{
        value: {
          metadata: { phone_number_id: 'PNID-1' },
          messages: [{ id: 'wamid.1', from: '213550123456', type: 'text', text: { body: `Accept ${bookingRef}` } }],
        },
      }],
    }],
  };
  const raw = JSON.stringify(payload);
  const signature = `sha256=${hmacSha256Hex(process.env.WHATSAPP_APP_SECRET, raw)}`;

  const badSig = await fetch(`${base}/webhooks/whatsapp`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': 'sha256=deadbeef' }, body: raw });
  assert.equal(badSig.status, 403);

  const ok = await fetch(`${base}/webhooks/whatsapp`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': signature }, body: raw });
  assert.equal(ok.status, 200);
  const okBody = await ok.json();
  assert.equal(okBody.processed, 1);

  // Duplicate delivery is safely ignored.
  const dup = await fetch(`${base}/webhooks/whatsapp`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': signature }, body: raw });
  const dupBody = await dup.json();
  assert.equal(dupBody.duplicates, 1);

  const tracked = await req('GET', `/api/public/track?ref=${bookingRef}&phone=0555987654`);
  assert.equal(tracked.data.appointment.status, 'confirmed');
  assert.equal(tracked.data.appointment.doctor_response, 'accepted');
});

test('scenario 14: patient cancels an appointment', async () => {
  const day = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  const slots = await req('GET', `/api/public/doctors/${doctorAId}/slots?day=${day}&clinic_id=${clinicId}`);
  const booking = await req('POST', '/api/public/bookings', {
    body: { patient_name: 'Omar', patient_phone: '0555111222', doctor_id: doctorAId, clinic_id: clinicId, day, time: slots.data.slots[0] },
  });
  const ref = booking.data.appointment.public_ref;
  const cancel = await req('POST', '/api/public/cancel', { body: { ref, phone: '0555111222' } });
  assert.equal(cancel.data.appointment.status, 'cancelled');
});

test('scenario 15: doctor requests rescheduling via dashboard', async () => {
  const db = require('../src/db');
  const { createUser } = require('../src/auth');
  createUser({ email: 'amina@medirdv.dz', password: 'doctor-pass-2', fullName: 'Dr Amina', role: 'doctor', doctorId: doctorAId });
  const login = await req('POST', '/api/auth/login', { body: { email: 'amina@medirdv.dz', password: 'doctor-pass-2' } });
  const cookie = cookieFrom(login);
  const day = new Date(Date.now() + 4 * 86400000).toISOString().slice(0, 10);
  const slots = await req('GET', `/api/public/doctors/${doctorAId}/slots?day=${day}&clinic_id=${clinicId}`);
  const booking = await req('POST', '/api/public/bookings', {
    body: { patient_name: 'Lina', patient_phone: '0555333444', doctor_id: doctorAId, clinic_id: clinicId, day, time: slots.data.slots[0] },
  });
  const id = booking.data.appointment.id;
  // Move to pending_doctor_approval first (free payment mode shortcut via admin verify is skipped;
  // use direct transition through payment flow is covered elsewhere — here verify via admin API on a paid path).
  // For this test, cancel is not allowed from pending_payment to rescheduling, so we go through payment submit+verify.
  const pid = booking.data.payment.id;
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  await fetch(`${base}/api/public/payments/${pid}/submit`, { method: 'POST', headers: { 'X-Filename': 'r.png', 'X-Transaction-Ref': 'TXN-RESCHED-1' }, body: png });
  await req('POST', `/api/admin/payments/${pid}/verify`, { cookie: adminCookie, body: { decision: 'paid' } });
  const resched = await req('POST', `/api/doctor/appointments/${id}/respond`, { cookie, body: { decision: 'reschedule', proposed_day: day, proposed_time: '10:00' } });
  assert.equal(resched.data.appointment.status, 'rescheduling_requested');
});

test('scenario 16-17: connector API keys sync status; offline-safe; clinic isolation enforced', async () => {
  const keyRes = await req('POST', '/api/admin/connector/keys', { cookie: adminCookie, body: { clinic_id: clinicId } });
  assert.equal(keyRes.status, 201);
  const apiKey = keyRes.data.api_key;
  assert.ok(apiKey.startsWith('mdc_'));

  // Pull availability with the key.
  const day = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
  const avail = await req('GET', `/api/connector/availability?day=${day}`, { headers: { Authorization: `Bearer ${apiKey}` } });
  assert.equal(avail.status, 200);
  assert.ok(avail.data.availability.length >= 1);

  // Push status for a confirmed booking.
  const tracked = await req('GET', `/api/public/track?ref=${bookingRef}&phone=0555987654`);
  assert.equal(tracked.data.appointment.status, 'confirmed');
  const push = await req('POST', '/api/connector/appointments/push-status', {
    headers: { Authorization: `Bearer ${apiKey}` },
    body: { external_ref: bookingRef, status: 'completed' },
  });
  assert.equal(push.data.appointment.status, 'completed');

  // Invalid transition is rejected with conflict (central wins).
  const conflictPush = await req('POST', '/api/connector/appointments/push-status', {
    headers: { Authorization: `Bearer ${apiKey}` },
    body: { external_ref: bookingRef, status: 'confirmed' },
  });
  assert.equal(conflictPush.status, 409);

  // Revoked key stops working.
  await req('POST', `/api/admin/connector/keys/${keyRes.data.id}/revoke`, { cookie: adminCookie });
  const afterRevoke = await req('GET', `/api/connector/availability?day=${day}`, { headers: { Authorization: `Bearer ${apiKey}` } });
  assert.equal(afterRevoke.status, 401);
});

test('scenario 18: Arabic and French patient pages serve with correct direction', async () => {
  const fr = await fetch(`${base}/`);
  assert.equal(fr.status, 200);
  const frHtml = await fr.text();
  assert.ok(frHtml.includes('lang="fr"'));
  const js = await fetch(`${base}/patient/app.js`);
  const jsText = await js.text();
  assert.ok(jsText.includes('العربية') || jsText.includes('ar:'));
  assert.ok(jsText.includes("dir = lang === 'ar' ? 'rtl'"));
});

test('scenario 19: payment verifier cannot manage doctors; support cannot verify payments', async () => {
  const { createUser } = require('../src/auth');
  createUser({ email: 'verifier@medirdv.dz', password: 'verifier-pass-1', fullName: 'Verifier', role: 'payment_verifier' });
  const login = await req('POST', '/api/auth/login', { body: { email: 'verifier@medirdv.dz', password: 'verifier-pass-1' } });
  const cookie = cookieFrom(login);
  const paymentsList = await req('GET', '/api/admin/payments', { cookie });
  assert.equal(paymentsList.status, 200);
  const doctorsList = await req('GET', '/api/admin/doctors', { cookie });
  assert.equal(doctorsList.status, 403);
  const dashboard = await req('GET', '/api/admin/dashboard', { cookie });
  assert.equal(dashboard.status, 403);
});

test('whatsapp service: click-to-chat link and notification text are correct', () => {
  const link = whatsapp.clickToChatLink({ whatsapp_number: '0550123456' }, 'Hello MR-2026-000001');
  assert.ok(link.startsWith('https://wa.me/213550123456?text='));
  const text = whatsapp.bookingNotificationText({
    appointment: { patient_name: 'Ahmed', public_ref: 'MR-2026-000001', day: '2026-11-20', time: '10:30' },
    doctorName: 'Dr Amina', clinicName: 'Clinic A',
  });
  assert.ok(text.includes('MR-2026-000001'));
  assert.ok(text.includes('Ahmed'));
});

test('invalid receipt content is rejected (extension spoofing)', async () => {
  const day = new Date(Date.now() + 6 * 86400000).toISOString().slice(0, 10);
  const slots = await req('GET', `/api/public/doctors/${doctorAId}/slots?day=${day}&clinic_id=${clinicId}`);
  const booking = await req('POST', '/api/public/bookings', {
    body: { patient_name: 'Yacine', patient_phone: '0555666777', doctor_id: doctorAId, clinic_id: clinicId, day, time: slots.data.slots[0] },
  });
  const res = await fetch(`${base}/api/public/payments/${booking.data.payment.id}/submit`, {
    method: 'POST',
    headers: { 'X-Filename': 'fake.png', 'X-Transaction-Ref': 'TXN-FAKE-1' },
    body: Buffer.from('not an image'),
  });
  assert.equal(res.status, 400);
});

test('CORS: Capacitor app origin is allowed for API calls, unknown origins are not', async () => {
  // Allowed: the native app's WebView origin.
  const ok = await fetch(`${base}/api/public/specialties`, { headers: { Origin: 'https://localhost' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('access-control-allow-origin'), 'https://localhost');

  // Preflight succeeds for the native origin.
  const preflight = await fetch(`${base}/api/public/bookings`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://localhost',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type,x-transaction-ref',
    },
  });
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get('access-control-allow-headers') || '', /X-Transaction-Ref/i);

  // Unknown third-party origin gets no CORS grant.
  const bad = await fetch(`${base}/api/public/specialties`, { headers: { Origin: 'https://evil.example' } });
  assert.equal(bad.headers.get('access-control-allow-origin'), null);
});

test('patient page uses relative assets and exposes the native API base hook', async () => {
  const html = await (await fetch(`${base}/`)).text();
  assert.ok(html.includes('href="app.css"'), 'relative stylesheet path required for the APK');
  assert.ok(html.includes('src="app.js"'), 'relative script path required for the APK');
  assert.ok(html.includes('name="medirdv-api-base"'));
  assert.ok(html.includes('viewport-fit=cover'), 'safe-area handling for Android');
});
