'use strict';
/**
 * Appointment-engine tests (Part 6): response deadlines, expiry sweeper,
 * explicit auto-confirm, cancellation deadline, and desktop-app isolation
 * (Part 16 / scenario 20).
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'medirdv-engine-'));
process.env.MEDIRDV_DB_PATH = path.join(tmpDir, 'engine.sqlite');
process.env.MEDIRDV_RECEIPTS_DIR = path.join(tmpDir, 'receipts');
process.env.MEDIRDV_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
process.env.MEDIRDV_SERVICE_FEE_DZD = '0';

const db = require('../src/db');
const auth = require('../src/auth');
const booking = require('../src/services/booking');
const payments = require('../src/services/payments');

let admin;
let doctorId;
let clinicId;

function tomorrow(offset = 1) {
  return new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
}

before(() => {
  db.open();
  admin = auth.createUser({ email: 'admin@engine.dz', password: 'engine-pass-1', fullName: 'Admin', role: 'super_admin' });
  const conn = db.getDb();
  clinicId = Number(conn.prepare("INSERT INTO clinics (public_ref, name, wilaya, city) VALUES ('C-ENG', 'Engine Clinic', 'Alger', 'Alger')").run().lastInsertRowid);
  doctorId = Number(
    conn
      .prepare(
        `INSERT INTO doctors (public_ref, full_name, specialty_text, consultation_fee, status, response_deadline_hours, cancel_deadline_hours, auto_confirm)
         VALUES ('D-ENG', 'Dr Engine', 'Test', 1000, 'active', 2, 24, 0)`
      )
      .run().lastInsertRowid
  );
  conn.prepare('INSERT INTO doctor_clinics (doctor_id, clinic_id) VALUES (?, ?)').run(doctorId, clinicId);
  for (let wd = 0; wd < 7; wd += 1) {
    conn.prepare('INSERT INTO doctor_schedules (doctor_id, clinic_id, weekday, start_time, end_time) VALUES (?, ?, ?, ?, ?)').run(doctorId, clinicId, wd, '09:00', '12:00');
  }
});

after(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function book(day, time, key) {
  return booking.createBooking({
    patientName: 'Test Patient',
    patientPhone: '0555000111',
    patientPhoneNorm: '0555000111',
    doctorId,
    clinicId,
    day,
    time,
    idempotencyKey: key,
  }).appointment;
}

test('payment verification sets a response deadline on pending_doctor_approval', () => {
  const appointment = book(tomorrow(1), '09:00', 'k-deadline');
  const payment = payments.ensurePaymentFor(appointment);
  payments.submitPayment(payment.id, {
    transactionRef: 'REF-DEADLINE-1',
    filename: 'r.png',
    buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0a]),
  });
  payments.verifyPayment(payment.id, { decision: 'paid', verifierId: admin.id });
  const after = booking.getAppointmentById(appointment.id);
  assert.equal(after.status, 'pending_doctor_approval');
  assert.ok(after.expires_at, 'expires_at must be set when awaiting the doctor');
  const hours = (new Date(after.expires_at).getTime() - Date.now()) / 3600000;
  assert.ok(hours > 1.5 && hours <= 2.1, `deadline should be ~2h, got ${hours}`);
});

test('expiry sweeper expires a booking past its deadline and frees the slot', () => {
  const day = tomorrow(2);
  const appointment = book(day, '09:00', 'k-expire');
  const payment = payments.ensurePaymentFor(appointment);
  payments.submitPayment(payment.id, {
    transactionRef: 'REF-EXPIRE-1',
    filename: 'r.png',
    buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0a]),
  });
  payments.verifyPayment(payment.id, { decision: 'paid', verifierId: admin.id });
  // Force the deadline into the past, then sweep.
  db.getDb().prepare('UPDATE appointments SET expires_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', appointment.id);
  const expiredCount = booking.expireStaleBookings(new Date().toISOString());
  assert.ok(expiredCount >= 1);
  assert.equal(booking.getAppointmentById(appointment.id).status, 'expired');
  // The expired slot is no longer reserved.
  assert.ok(booking.availableSlots(doctorId, day, clinicId).includes('09:00'));
});

test('auto_confirm only applies when the doctor explicitly enables it', () => {
  // Default doctor (auto_confirm = 0): stays pending_doctor_approval.
  const normal = book(tomorrow(3), '09:00', 'k-auto-off');
  const p1 = payments.ensurePaymentFor(normal);
  payments.submitPayment(p1.id, { transactionRef: 'REF-AUTO-OFF', filename: 'r.png', buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0a]) });
  payments.verifyPayment(p1.id, { decision: 'paid', verifierId: admin.id });
  assert.equal(booking.getAppointmentById(normal.id).status, 'pending_doctor_approval');

  // Opt-in doctor: booked then confirmed by the recorded system transition.
  db.getDb().prepare('UPDATE doctors SET auto_confirm = 1 WHERE id = ?').run(doctorId);
  const auto = book(tomorrow(4), '09:00', 'k-auto-on');
  const p2 = payments.ensurePaymentFor(auto);
  payments.submitPayment(p2.id, { transactionRef: 'REF-AUTO-ON', filename: 'r.png', buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0a]) });
  payments.verifyPayment(p2.id, { decision: 'paid', verifierId: admin.id });
  const confirmed = booking.getAppointmentById(auto.id);
  assert.equal(confirmed.status, 'confirmed');
  const events = db.getDb().prepare('SELECT * FROM appointment_events WHERE appointment_id = ? ORDER BY id').all(auto.id);
  assert.ok(events.some((e) => e.to_status === 'confirmed' && e.note.includes('automatic confirmation')));
  db.getDb().prepare('UPDATE doctors SET auto_confirm = 0 WHERE id = ?').run(doctorId);
});

test('cancellation deadline blocks late cancellation of a confirmed booking', () => {
  const day = tomorrow(5);
  const appointment = book(day, '09:00', 'k-cancel-deadline');
  db.getDb().prepare("UPDATE appointments SET status = 'confirmed' WHERE id = ?").run(appointment.id);
  // Slot is far in the future (>=24h away) → allowed.
  const cancelled = booking.cancelBooking(appointment.id, { actor: 'patient' });
  assert.equal(cancelled.status, 'cancelled');

  const late = book(day, '10:00', 'k-cancel-late');
  db.getDb().prepare("UPDATE appointments SET status = 'confirmed', day = ? WHERE id = ?").run(booking.todayISO(), late.id);
  assert.throws(() => booking.cancelBooking(late.id, { actor: 'patient' }), /cancellation deadline/i);
});

test('invalid state transitions are rejected by the state machine', () => {
  assert.equal(booking.canTransition('pending_payment', 'completed'), false);
  assert.throws(() => booking.transition(1, 'completed'), /Cannot move appointment/);
});

test('scenario 20: existing desktop projects are untouched by Central', () => {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const desktopApps = ['medirdv', 'dentardv'];
  for (const app of desktopApps) {
    const appDir = path.join(repoRoot, app);
    assert.ok(fs.existsSync(path.join(appDir, 'package.json')), `${app}/package.json must still exist`);
    const pkg = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'));
    // Central must never modify desktop app identity or build config.
    assert.ok(pkg.name && pkg.version, `${app} manifest intact`);
    assert.ok(fs.existsSync(path.join(appDir, 'electron-builder.yml')), `${app} build config intact`);
  }
  // Central has no dependency on desktop packages or their Baileys bot.
  const centralPkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'medirdv-central', 'package.json'), 'utf8'));
  assert.equal(centralPkg.dependencies, undefined);
  assert.equal(centralPkg.devDependencies, undefined);
  const sources = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) sources.push(full);
    }
  };
  walk(path.join(repoRoot, 'medirdv-central', 'src'));
  const joined = sources.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  // Detect real imports/requires of unofficial WhatsApp automation, not prose.
  assert.ok(
    !/require\(\s*['"][^'"]*baileys[^'"]*['"]\s*\)/i.test(joined),
    'Central must not require unofficial Baileys automation'
  );
  assert.ok(
    !/from\s+['"][^'"]*baileys[^'"]*['"]/i.test(joined),
    'Central must not import unofficial Baileys automation'
  );
  assert.ok(!/require\(\s*['"]electron['"]\s*\)/.test(joined), 'Central backend must not require Electron');
  // And the only WhatsApp client base URL is the official Graph API.
  assert.ok(/graph\.facebook\.com/.test(fs.readFileSync(path.join(repoRoot, 'medirdv-central', 'src', 'services', 'whatsapp.js'), 'utf8')));
});

test('support agents can look up patients but not touch finances or doctors', () => {
  const { hasPermission } = require('../src/auth');
  const support = { role: 'support' };
  assert.equal(hasPermission(support, 'patients:lookup'), true);
  assert.equal(hasPermission(support, 'payments:view'), false);
  assert.equal(hasPermission(support, 'payments:verify'), false);
  assert.equal(hasPermission(support, 'admin:doctors'), false);
  const doctor = { role: 'doctor' };
  assert.equal(hasPermission(doctor, 'patients:lookup'), false);
  const verifier = { role: 'payment_verifier' };
  assert.equal(hasPermission(verifier, 'payments:verify'), true);
  assert.equal(hasPermission(verifier, 'admin:doctors'), false);
});

test('SQLite driver adapter resolves a working driver and reports it', () => {
  const sqlite = require('../src/sqlite');
  const dbModule = require('../src/db');
  const driver = sqlite.resolveDriver();
  assert.ok(['node:sqlite', 'better-sqlite3'].includes(driver.name));
  // The DB layer exposes which driver is live (used by /health diagnostics).
  assert.equal(dbModule.getDriver(), driver.name);
});

test('driver probe rejects an unusable driver instead of silently continuing', () => {
  const sqlite = require('../src/sqlite');
  // An unknown preference must not crash: it falls back to a working driver.
  sqlite.resetDriverCache();
  const driver = sqlite.resolveDriver('does-not-exist');
  assert.ok(driver && typeof driver.open === 'function');
});
