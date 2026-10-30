const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { useTempDb } = require('./helpers');
const { getDb } = require('../src/main/db');
const auth = require('../src/main/services/auth');
const security = require('../src/main/services/security');
const patients = require('../src/main/services/patients');
const billing = require('../src/main/services/billing');
const log = require('../src/main/log');

test('Phase 7 — legacy password migration, 5-role RBAC matrix, scrypt lockout & PIN unlock', (t) => {
  useTempDb(t);

  // Legacy clinic password setup auto-migrates to first admin user
  auth.setup({ password: 'clinicSecret', confirm: 'clinicSecret' });
  const users0 = security.listUsers();
  assert.equal(users0.length, 1);
  assert.equal(users0[0].username, 'admin');
  assert.equal(users0[0].role, 'admin');

  // Create doctor, secretary, nurse, accountant
  security.createUser({ username: 'dr.amrani', full_name: 'Dr Amrani', role: 'doctor', password: 'docPass', pin: '2468' });
  security.createUser({ username: 'sec.nadia', full_name: 'Nadia Sec', role: 'secretary', password: 'secPass' });
  security.createUser({ username: 'inf.karim', full_name: 'Karim Inf', role: 'nurse', password: 'nurPass' });
  security.createUser({ username: 'cpt.samir', full_name: 'Samir Cpt', role: 'accountant', password: 'accPass' });

  // RBAC enforcement
  auth.loginUser({ username: 'sec.nadia', password: 'secPass' });
  assert.equal(auth.currentUser().role, 'secretary');
  assert.doesNotThrow(() => auth.requireUnlocked('appointments:create'));
  assert.throws(() => auth.requireUnlocked('prescriptions:create'), (e) => e.code === 'FORBIDDEN');
  assert.throws(() => auth.requireUnlocked('users:create'), (e) => e.code === 'FORBIDDEN');

  auth.loginUser({ username: 'cpt.samir', password: 'accPass' });
  assert.doesNotThrow(() => auth.requireUnlocked('billing:z-report'));
  assert.throws(() => auth.requireUnlocked('emr:consultations'), (e) => e.code === 'FORBIDDEN');

  // Lock & quick PIN unlock for Dr Amrani
  auth.lock();
  assert.equal(auth.isUnlocked(), false);
  auth.unlockPin({ username: 'dr.amrani', pin: '2468' });
  assert.equal(auth.isUnlocked(), true);
  assert.equal(auth.currentUser().role, 'doctor');
  assert.doesNotThrow(() => auth.requireUnlocked('prescriptions:create'));

  // 5 consecutive failed logins trigger account lockout
  for (let i = 0; i < 4; i++) {
    assert.throws(() => auth.loginUser({ username: 'inf.karim', password: 'wrong' }), (e) => e.code === 'BAD_PASSWORD');
  }
  assert.throws(() => auth.loginUser({ username: 'inf.karim', password: 'wrong' }), (e) => e.code === 'TOO_MANY_ATTEMPTS');
  // Even correct password fails while locked out
  assert.throws(() => auth.loginUser({ username: 'inf.karim', password: 'nurPass' }), (e) => e.code === 'TOO_MANY_ATTEMPTS');

  // Reset back to admin unlocked for cleanliness
  auth.login('clinicSecret');
});

test('Phase 7 — tamper-evident SHA-256 audit chain detects row modification immediately', (t) => {
  useTempDb(t);
  const db = getDb();

  security.appendAudit({ username: 'admin', role: 'admin', action: 'test.one', entity_type: 'patient', entity_id: '1' });
  security.appendAudit({ username: 'dr.ali', role: 'doctor', action: 'test.two', entity_type: 'rx', entity_id: '9' });
  security.appendAudit({ username: 'admin', role: 'admin', action: 'test.three', entity_type: 'backup', entity_id: '2' });

  const checkOk = security.verifyAuditChain();
  assert.equal(checkOk.valid, true);
  assert.equal(checkOk.checked, 3);

  // Tamper directly with row #2 in SQLite
  const rows = db.prepare('SELECT id FROM audit_log ORDER BY id ASC').all();
  db.prepare("UPDATE audit_log SET summary = 'forged' WHERE id = ?").run(rows[1].id);

  const checkTampered = security.verifyAuditChain();
  assert.equal(checkTampered.valid, false);
  assert.equal(checkTampered.broken_at_id, rows[1].id);
});

test('Phase 7 — AES-256-GCM at-rest encryption, password-encrypted backup + restore test, USB copy & Law 18-07 tools', (t) => {
  useTempDb(t);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'medirdv-sec-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  // At-rest AES-256-GCM envelope
  const enc = security.encryptAtRest('Données sensibles 18-07', 'MasterPass!2026');
  assert.match(enc, /^enc1:/);
  assert.equal(security.decryptAtRest(enc, 'MasterPass!2026'), 'Données sensibles 18-07');

  const p = patients.create({
    full_name: 'Meriem Benkhedda',
    phone: '0558112233',
    chifa_number: 'CHIFA-554433',
    nss: '900101016777',
    allergies: 'Pénicilline',
  });
  billing.createInvoice({
    patient_id: p.id,
    day: '2026-10-24',
    description: 'Consultation',
    price: 2000,
    paid_amount: 2000,
  });

  // Encrypted backup + automatic restore-probe verification + USB copy
  const encPath = path.join(tmpDir, 'clinic.sqlite.enc');
  const bak = security.createEncryptedBackup({ password: 'BackupKey#99', targetPath: encPath, verify: true });
  assert.equal(bak.verified, true);
  assert.throws(
    () => security.verifyEncryptedBackup({ filePath: encPath, password: 'WrongPassword' }),
    (e) => e.code === 'BAD_PASSWORD',
  );

  const usbDir = path.join(tmpDir, 'usb-drive');
  fs.mkdirSync(usbDir);
  const usbRes = security.copyBackupToUsb({ usbDir, password: 'BackupKey#99' });
  assert.equal(usbRes.ok, true);
  assert.equal(usbRes.encrypted, true);
  assert.equal(usbRes.sha256.length, 64);

  // Law 18-07 consent, export, and irreversible anonymization (preserving accounting invoice totals)
  security.recordConsent18_07({ patient_id: p.id, consent_type: 'whatsapp', granted: true });
  const exported = security.exportPatientData18_07(p.id);
  assert.equal(exported.patient.full_name, 'Meriem Benkhedda');
  assert.equal(exported.consents.length, 1);

  const anon = security.anonymizePatient18_07(p.id, { reason: 'Retrait consentement patient' });
  assert.equal(anon.ok, true);
  const afterAnon = patients.get(p.id);
  assert.match(afterAnon.full_name, /^Patient Anonymisé #/);
  assert.equal(afterAnon.phone, null);
  assert.equal(afterAnon.chifa_number, '');
  assert.equal(afterAnon.nss, '');

  const invs = billing.listInvoices({ patient_id: p.id });
  assert.equal(invs[0].total_amount, 2000);
  assert.equal(invs[0].chifa_number, '');

  // Restore encrypted backup brings back pre-anonymization snapshot cleanly
  security.restoreEncryptedBackup({ filePath: encPath, password: 'BackupKey#99' });
  assert.equal(patients.get(p.id).full_name, 'Meriem Benkhedda');

  // Law 18-07 log redaction check (no raw phone/JID written to log output)
  const scrubbed = log.sanitizeLogText('Probe 0558112233 and +213661223344 and 213558112233@s.whatsapp.net');
  assert.ok(!scrubbed.includes('0558112233'), 'raw Algerian phone number scrubbed');
  assert.ok(!scrubbed.includes('661223344'), '+213 Algerian phone number scrubbed');
  assert.ok(scrubbed.includes('[PHONE-REDACTED]'));
  assert.ok(scrubbed.includes('[JID-REDACTED]'));
});
