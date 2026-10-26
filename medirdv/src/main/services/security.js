'use strict';
/**
 * Phase 7 — Multi-User RBAC, Security Hardening, Tamper-Evident SHA-256 Audit
 * Trail, AES-256-GCM Encrypted Backups (with Restore Verification & USB Copy),
 * At-Rest Field Encryption Envelope & Algerian Law 18-07 Compliance Tools.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const dbMod = require('../db');
const { getDb } = dbMod;
const { AppError, cleanText, nowLocal, requireId } = require('../utils/common');

const ROLES = ['admin', 'doctor', 'secretary', 'nurse', 'accountant'];
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes
const ENC_MAGIC = Buffer.from('MRDVENC1', 'ascii');

/**
 * Granular RBAC Permission Matrix across all 5 clinic roles.
 * Prefixes ending with ':*' grant all actions under that domain.
 */
const ROLE_PERMISSIONS = {
  admin: ['*'],
  doctor: [
    'app:*', 'license:*', 'auth:*', 'dashboard:*', 'patients:*', 'intake:*', 'appointments:*',
    'departments:list', 'treatments:list', 'medications:*', 'nomenclature:summary',
    'prescriptions:*', 'icd10:*', 'diagnoses:*', 'safety:*', 'certificates:*',
    'emr:*', 'print:*', 'chat:*', 'wa:status', 'privacy:export', 'privacy:consents', 'privacy:consent-record',
    'ops:slots', 'ops:waiting-room', 'ops:noshow-stats', 'ops:inventory', 'ops:rooms',
    'docs:*',
  ],
  secretary: [
    'app:*', 'license:*', 'auth:*', 'dashboard:*', 'patients:list', 'patients:get', 'patients:create', 'patients:update',
    'intake:create', 'intake:update', 'intake:for-patient', 'intake:latest', 'intake:pending', 'intake:for-appointment',
    'appointments:*', 'departments:list', 'treatments:list',
    'payments:*', 'secretary:confirm-payment', 'billing:preview', 'billing:invoice-create', 'billing:invoice-get', 'billing:invoices', 'billing:invoice-html', 'billing:z-report',
    'print:receipt', 'print:invoice', 'print:certificate', 'chat:*', 'wa:*',
    'privacy:consents', 'privacy:consent-record',
    'ops:slots', 'ops:waiting-room', 'ops:closures', 'ops:noshow-stats', 'ops:attendance', 'ops:rooms',
    'docs:list', 'docs:html',
  ],
  nurse: [
    'app:*', 'license:*', 'auth:*', 'dashboard:*', 'patients:list', 'patients:get',
    'intake:*', 'appointments:agenda', 'appointments:day-info', 'departments:list',
    'emr:consultations', 'emr:consultation-create', 'emr:labs', 'emr:lab-result',
    'emr:imaging', 'emr:vaccinations', 'emr:vaccination-record', 'emr:pregnancy',
    'emr:who-growth', 'emr:vitals-trends', 'emr:timeline',
    'ops:waiting-room', 'ops:inventory', 'ops:inventory-move', 'ops:inventory-alerts',
  ],
  accountant: [
    'app:*', 'license:*', 'auth:*', 'dashboard:*', 'patients:debtors',
    'treatments:list', 'payments:*', 'expenses:*', 'reports:*',
    'billing:*', 'export:*', 'print:receipt', 'print:daily-report', 'print:invoice',
    'ops:staff', 'ops:payroll', 'ops:payroll-run', 'ops:noshow-stats',
  ],
};

function hasPermission(role, action) {
  if (!role || role === 'admin') return true;
  const allowed = ROLE_PERMISSIONS[role];
  if (!allowed) return false;
  if (allowed.includes('*') || allowed.includes(action)) return true;
  const [prefix] = String(action || '').split(':');
  return allowed.includes(`${prefix}:*`);
}

function assertPermission(role, action) {
  if (!hasPermission(role, action)) {
    throw new AppError('FORBIDDEN', `Role '${role}' cannot execute '${action}'.`);
  }
}

/* -------------------------------------------------------------------------- */
/*  Scrypt Password & Quick PIN Hashing                                       */
/* -------------------------------------------------------------------------- */

function scryptHash(secret, saltHex) {
  return crypto.scryptSync(String(secret), saltHex, 64).toString('hex');
}

function constantTimeMatch(candidateHex, expectedHex) {
  if (!candidateHex || !expectedHex || candidateHex.length !== expectedHex.length) return false;
  return crypto.timingSafeEqual(Buffer.from(candidateHex, 'hex'), Buffer.from(expectedHex, 'hex'));
}

/**
 * Migrate an existing V1..V6 clinic `settings.password_hash` into the first
 * `admin` user row automatically so upgrades never lock anyone out.
 */
function ensureLegacyAdminMigrated() {
  const db = getDb();
  const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (count > 0) return null;

  const pwHash = db.prepare("SELECT value FROM settings WHERE key = 'password_hash'").get()?.value || '';
  const pwSalt = db.prepare("SELECT value FROM settings WHERE key = 'password_salt'").get()?.value || '';
  if (!pwHash || !pwSalt) return null;

  const doctorName = db.prepare("SELECT value FROM settings WHERE key = 'doctor_name'").get()?.value || 'Administrateur';
  const info = db
    .prepare(
      `INSERT INTO users (username, full_name, role, password_hash, password_salt, active)
       VALUES ('admin', ?, 'admin', ?, ?, 1)`,
    )
    .run(doctorName, pwHash, pwSalt);
  return db.prepare('SELECT id, username, full_name, role, active, created_at FROM users WHERE id = ?').get(info.lastInsertRowid);
}

function sanitizeUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    full_name: row.full_name,
    role: row.role,
    has_pin: Boolean(row.pin_hash),
    active: row.active,
    created_at: row.created_at,
    last_login_at: row.last_login_at,
  };
}

function listUsers() {
  ensureLegacyAdminMigrated();
  return getDb()
    .prepare('SELECT * FROM users ORDER BY id ASC')
    .all()
    .map(sanitizeUser);
}

function createUser(input = {}, actor = null) {
  ensureLegacyAdminMigrated();
  const username = cleanText(input.username, 40).toLowerCase();
  const fullName = cleanText(input.full_name, 100);
  const role = ROLES.includes(input.role) ? input.role : 'doctor';
  const password = String(input.password ?? '');
  if (!username || username.length < 2) throw new AppError('INVALID_INPUT', 'Username required.');
  if (!fullName) throw new AppError('INVALID_INPUT', 'Full name required.');
  if (password.length < 4) throw new AppError('PASSWORD_TOO_SHORT');

  const existing = getDb().prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) throw new AppError('USER_EXISTS', 'Username already exists.');

  const salt = crypto.randomBytes(16).toString('hex');
  const pwHash = scryptHash(password, salt);
  let pinSalt = '';
  let pinHash = '';
  if (input.pin) {
    const pinStr = String(input.pin).trim();
    if (!/^\d{4,8}$/.test(pinStr)) throw new AppError('INVALID_INPUT', 'PIN must be 4-8 digits.');
    pinSalt = crypto.randomBytes(16).toString('hex');
    pinHash = scryptHash(pinStr, pinSalt);
  }

  const info = getDb()
    .prepare(
      `INSERT INTO users (username, full_name, role, password_hash, password_salt, pin_hash, pin_salt, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
    )
    .run(username, fullName, role, pwHash, salt, pinHash, pinSalt);

  const created = sanitizeUser(getDb().prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid));
  appendAudit({
    user_id: actor?.id || null,
    username: actor?.username || 'system',
    role: actor?.role || 'admin',
    action: 'user.create',
    entity_type: 'user',
    entity_id: String(created.id),
    summary: `role=${created.role}`,
  });
  return created;
}

function updateUser(input = {}, actor = null) {
  const id = requireId(input.id);
  const current = getDb().prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!current) throw new AppError('NOT_FOUND');

  const fullName = input.full_name !== undefined ? cleanText(input.full_name, 100) : current.full_name;
  const role = input.role && ROLES.includes(input.role) ? input.role : current.role;
  const active = input.active !== undefined ? (input.active ? 1 : 0) : current.active;

  let pwSalt = current.password_salt;
  let pwHash = current.password_hash;
  if (input.password) {
    if (String(input.password).length < 4) throw new AppError('PASSWORD_TOO_SHORT');
    pwSalt = crypto.randomBytes(16).toString('hex');
    pwHash = scryptHash(input.password, pwSalt);
  }

  let pinSalt = current.pin_salt;
  let pinHash = current.pin_hash;
  if (input.pin !== undefined) {
    const pinStr = String(input.pin || '').trim();
    if (pinStr === '') {
      pinSalt = '';
      pinHash = '';
    } else {
      if (!/^\d{4,8}$/.test(pinStr)) throw new AppError('INVALID_INPUT', 'PIN must be 4-8 digits.');
      pinSalt = crypto.randomBytes(16).toString('hex');
      pinHash = scryptHash(pinStr, pinSalt);
    }
  }

  getDb()
    .prepare(
      `UPDATE users SET full_name = ?, role = ?, active = ?, password_hash = ?, password_salt = ?, pin_hash = ?, pin_salt = ?
       WHERE id = ?`,
    )
    .run(fullName, role, active, pwHash, pwSalt, pinHash, pinSalt, id);

  appendAudit({
    user_id: actor?.id || null,
    username: actor?.username || 'system',
    role: actor?.role || 'admin',
    action: 'user.update',
    entity_type: 'user',
    entity_id: String(id),
    summary: `role=${role},active=${active}`,
  });
  return sanitizeUser(getDb().prepare('SELECT * FROM users WHERE id = ?').get(id));
}

function authenticateUser({ username, password } = {}) {
  ensureLegacyAdminMigrated();
  const db = getDb();
  const uname = cleanText(username, 40).toLowerCase();
  const row = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(uname);
  if (!row) throw new AppError('BAD_PASSWORD');

  const now = Date.now();
  if (row.locked_until && now < row.locked_until) {
    throw new AppError('TOO_MANY_ATTEMPTS', 'Account temporarily locked', {
      seconds: Math.ceil((row.locked_until - now) / 1000),
    });
  }

  const candidate = scryptHash(String(password ?? ''), row.password_salt);
  if (!constantTimeMatch(candidate, row.password_hash)) {
    const attempts = (row.failed_attempts || 0) + 1;
    if (attempts >= MAX_LOGIN_ATTEMPTS) {
      db.prepare('UPDATE users SET failed_attempts = 0, locked_until = ? WHERE id = ?').run(now + LOCKOUT_MS, row.id);
      appendAudit({ user_id: row.id, username: row.username, role: row.role, action: 'auth.lockout', entity_type: 'user', entity_id: String(row.id) });
      throw new AppError('TOO_MANY_ATTEMPTS', 'Account locked', { seconds: LOCKOUT_MS / 1000 });
    }
    db.prepare('UPDATE users SET failed_attempts = ? WHERE id = ?').run(attempts, row.id);
    throw new AppError('BAD_PASSWORD', 'Invalid credentials', { attempts_left: MAX_LOGIN_ATTEMPTS - attempts });
  }

  const loginTime = nowLocal();
  db.prepare('UPDATE users SET failed_attempts = 0, locked_until = 0, last_login_at = ? WHERE id = ?').run(loginTime, row.id);
  appendAudit({ user_id: row.id, username: row.username, role: row.role, action: 'auth.login', entity_type: 'user', entity_id: String(row.id) });
  return sanitizeUser({ ...row, last_login_at: loginTime });
}

function unlockWithPin({ username, pin } = {}) {
  const db = getDb();
  const uname = cleanText(username, 40).toLowerCase();
  const row = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(uname);
  if (!row || !row.pin_hash) throw new AppError('BAD_PASSWORD');
  const now = Date.now();
  if (row.locked_until && now < row.locked_until) throw new AppError('TOO_MANY_ATTEMPTS');

  const candidate = scryptHash(String(pin ?? '').trim(), row.pin_salt);
  if (!constantTimeMatch(candidate, row.pin_hash)) {
    const attempts = (row.failed_attempts || 0) + 1;
    if (attempts >= MAX_LOGIN_ATTEMPTS) {
      db.prepare('UPDATE users SET failed_attempts = 0, locked_until = ? WHERE id = ?').run(now + LOCKOUT_MS, row.id);
      throw new AppError('TOO_MANY_ATTEMPTS');
    }
    db.prepare('UPDATE users SET failed_attempts = ? WHERE id = ?').run(attempts, row.id);
    throw new AppError('BAD_PASSWORD');
  }
  db.prepare('UPDATE users SET failed_attempts = 0, locked_until = 0 WHERE id = ?').run(row.id);
  appendAudit({ user_id: row.id, username: row.username, role: row.role, action: 'auth.pin_unlock', entity_type: 'user', entity_id: String(row.id) });
  return sanitizeUser(row);
}

/* -------------------------------------------------------------------------- */
/*  Tamper-Evident SHA-256 Hash-Chained Audit Trail                           */
/* -------------------------------------------------------------------------- */

const GENESIS_HASH = '0'.repeat(64);

function computeAuditHash({ prev_hash, created_at, username, role, action, entity_type, entity_id, summary }) {
  const payload = [
    prev_hash || GENESIS_HASH,
    created_at || '',
    username || 'system',
    role || 'system',
    action || '',
    entity_type || '',
    entity_id || '',
    summary || '',
  ].join('|');
  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
}

function appendAudit(entry = {}) {
  const db = getDb();
  const tx = db.transaction(() => {
    const last = db.prepare('SELECT entry_hash FROM audit_log ORDER BY id DESC LIMIT 1').get();
    const prevHash = last ? last.entry_hash : GENESIS_HASH;
    const createdAt = nowLocal();
    const username = cleanText(entry.username, 40) || 'system';
    const role = cleanText(entry.role, 30) || 'system';
    const action = cleanText(entry.action, 80) || 'unknown';
    const entityType = cleanText(entry.entity_type, 40);
    const entityId = cleanText(entry.entity_id, 40);
    // Law 18-07: never store raw patient medical content in audit summaries
    const summary = cleanText(entry.summary, 200);
    const entryHash = computeAuditHash({
      prev_hash: prevHash,
      created_at: createdAt,
      username,
      role,
      action,
      entity_type: entityType,
      entity_id: entityId,
      summary,
    });
    const info = db
      .prepare(
        `INSERT INTO audit_log
          (user_id, username, role, action, entity_type, entity_id, summary, prev_hash, entry_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.user_id || null,
        username,
        role,
        action,
        entityType,
        entityId,
        summary,
        prevHash,
        entryHash,
        createdAt,
      );
    return info.lastInsertRowid;
  });
  return tx();
}

function verifyAuditChain() {
  const rows = getDb().prepare('SELECT * FROM audit_log ORDER BY id ASC').all();
  let expectedPrev = GENESIS_HASH;
  for (const r of rows) {
    if (r.prev_hash !== expectedPrev) {
      return { valid: false, checked: rows.length, broken_at_id: r.id, reason: 'prev_hash_mismatch' };
    }
    const recomputed = computeAuditHash(r);
    if (r.entry_hash !== recomputed) {
      return { valid: false, checked: rows.length, broken_at_id: r.id, reason: 'entry_hash_tampered' };
    }
    expectedPrev = r.entry_hash;
  }
  return { valid: true, checked: rows.length, head_hash: expectedPrev };
}

function listAuditLog({ limit = 100, action = '' } = {}) {
  const max = Math.min(500, Math.max(1, Number(limit) || 100));
  if (action) {
    return getDb()
      .prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY id DESC LIMIT ?')
      .all(cleanText(action, 80), max);
  }
  return getDb().prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(max);
}

/* -------------------------------------------------------------------------- */
/*  AES-256-GCM Encryption At Rest & Password-Encrypted Backups + USB Copy    */
/* -------------------------------------------------------------------------- */

function deriveAesKey(password, saltBuf) {
  return crypto.scryptSync(String(password), saltBuf, 32);
}

function encryptBuffer(plainBuf, password) {
  if (!password || String(password).length < 4) throw new AppError('PASSWORD_TOO_SHORT');
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveAesKey(password, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plainBuf), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([ENC_MAGIC, salt, iv, tag, encrypted]);
}

function decryptBuffer(encBuf, password) {
  if (!Buffer.isBuffer(encBuf) || encBuf.length < 8 + 16 + 12 + 16) {
    throw new AppError('INVALID_ENCRYPTED_BACKUP', 'Invalid encrypted archive.');
  }
  if (!encBuf.subarray(0, 8).equals(ENC_MAGIC)) {
    throw new AppError('INVALID_ENCRYPTED_BACKUP', 'Missing MRDVENC1 header.');
  }
  const salt = encBuf.subarray(8, 24);
  const iv = encBuf.subarray(24, 36);
  const tag = encBuf.subarray(36, 52);
  const ciphertext = encBuf.subarray(52);
  const key = deriveAesKey(password || '', salt);
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (_) {
    throw new AppError('BAD_PASSWORD', 'Cannot decrypt backup with given password.');
  }
}

function encryptAtRest(plaintext, secret) {
  if (!plaintext) return '';
  return `enc1:${encryptBuffer(Buffer.from(String(plaintext), 'utf8'), secret).toString('base64')}`;
}

function decryptAtRest(payload, secret) {
  if (!payload) return '';
  if (!String(payload).startsWith('enc1:')) return String(payload);
  const raw = Buffer.from(String(payload).slice(5), 'base64');
  return decryptBuffer(raw, secret).toString('utf8');
}

function createEncryptedBackup({ password, targetPath, verify = true } = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'medirdv-encbak-'));
  try {
    const tmpSqlite = path.join(tmpDir, 'snapshot.sqlite');
    dbMod.backupTo(tmpSqlite);
    const plain = fs.readFileSync(tmpSqlite);
    const encrypted = encryptBuffer(plain, password);

    const outPath =
      targetPath ||
      path.join(
        path.dirname(dbMod.getPath()),
        'backups',
        `medirdv-encrypted-${Date.now()}.sqlite.enc`,
      );
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, encrypted);

    let verification = null;
    if (verify) {
      verification = verifyEncryptedBackup({ filePath: outPath, password });
    }
    appendAudit({ action: 'backup.encrypted_create', entity_type: 'backup', summary: path.basename(outPath) });
    return {
      ok: true,
      file: outPath,
      size: encrypted.length,
      verified: Boolean(verification?.ok),
      schemaVersion: verification?.schemaVersion || null,
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function verifyEncryptedBackup({ filePath, password } = {}) {
  if (!filePath || !fs.existsSync(filePath)) throw new AppError('BACKUP_NOT_FOUND');
  const encBuf = fs.readFileSync(filePath);
  const plain = decryptBuffer(encBuf, password);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'medirdv-verify-'));
  try {
    const probePath = path.join(tmpDir, 'probe.sqlite');
    fs.writeFileSync(probePath, plain);
    const check = dbMod.checkIntegrity(probePath);
    if (!check.ok) throw new AppError('INVALID_ENCRYPTED_BACKUP', check.error || 'Corrupt SQLite image.');
    return { ok: true, schemaVersion: check.schemaVersion };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function restoreEncryptedBackup({ filePath, password } = {}) {
  verifyEncryptedBackup({ filePath, password });
  const plain = decryptBuffer(fs.readFileSync(filePath), password);
  const liveFile = dbMod.getPath();
  const safetyCopy = `${liveFile}.pre-restore-${Date.now()}.bak`;
  dbMod.backupTo(safetyCopy);
  dbMod.close();
  fs.writeFileSync(liveFile, plain);
  for (const suffix of ['-wal', '-shm']) {
    if (fs.existsSync(liveFile + suffix)) fs.rmSync(liveFile + suffix, { force: true });
  }
  dbMod.open(liveFile);
  appendAudit({ action: 'backup.encrypted_restore', entity_type: 'backup', summary: path.basename(filePath) });
  return { ok: true };
}

function copyBackupToUsb({ usbDir, password } = {}) {
  if (!usbDir || !fs.existsSync(usbDir)) throw new AppError('FILE_NOT_FOUND', 'USB target folder not found.');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  if (password) {
    const dest = path.join(usbDir, `medirdv-usb-${stamp}.sqlite.enc`);
    const created = createEncryptedBackup({ password, targetPath: dest, verify: true });
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(dest)).digest('hex');
    return { ok: true, encrypted: true, file: dest, sha256, size: created.size };
  }
  const dest = path.join(usbDir, `medirdv-usb-${stamp}.sqlite`);
  dbMod.backupTo(dest);
  const check = dbMod.checkIntegrity(dest);
  if (!check.ok) throw new AppError('BACKUP_CORRUPT');
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(dest)).digest('hex');
  appendAudit({ action: 'backup.usb_copy', entity_type: 'backup', summary: path.basename(dest) });
  return { ok: true, encrypted: false, file: dest, sha256 };
}

/* -------------------------------------------------------------------------- */
/*  Algerian Law 18-07 Data Protection (Consent, Portability, Anonymization)  */
/* -------------------------------------------------------------------------- */

function recordConsent18_07(input = {}) {
  const db = getDb();
  const patientId = requireId(input.patient_id, 'patient_id');
  const p = db.prepare('SELECT id FROM patients WHERE id = ?').get(patientId);
  if (!p) throw new AppError('PATIENT_NOT_FOUND');
  const cType = ['care', 'whatsapp', 'data_processing'].includes(input.consent_type)
    ? input.consent_type
    : 'data_processing';
  const granted = input.granted === false || input.granted === 0 ? 0 : 1;
  const info = db
    .prepare(
      `INSERT INTO patient_consents (patient_id, consent_type, granted, recorded_by, revoked_at, notes)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      patientId,
      cType,
      granted,
      cleanText(input.recorded_by, 80) || 'clinic',
      granted ? '' : nowLocal(),
      cleanText(input.notes, 300),
    );
  appendAudit({
    action: granted ? 'privacy.consent_grant' : 'privacy.consent_revoke',
    entity_type: 'patient',
    entity_id: String(patientId),
    summary: cType,
  });
  return db.prepare('SELECT * FROM patient_consents WHERE id = ?').get(info.lastInsertRowid);
}

function listConsents18_07(patientId) {
  return getDb()
    .prepare('SELECT * FROM patient_consents WHERE patient_id = ? ORDER BY id DESC')
    .all(requireId(patientId, 'patient_id'));
}

function exportPatientData18_07(patientId, actor = null) {
  const db = getDb();
  const id = requireId(patientId, 'patient_id');
  const patient = db.prepare('SELECT * FROM patients WHERE id = ?').get(id);
  if (!patient) throw new AppError('PATIENT_NOT_FOUND');

  const bundle = {
    law: 'Loi algérienne n° 18-07 relative à la protection des personnes physiques dans le traitement des données à caractère personnel',
    exported_at: nowLocal(),
    patient,
    consents: listConsents18_07(id),
    appointments: db.prepare('SELECT * FROM appointments WHERE patient_id = ? ORDER BY day DESC').all(id),
    consultations: db.prepare('SELECT * FROM consultations WHERE patient_id = ? ORDER BY day DESC').all(id),
    prescriptions: db.prepare('SELECT * FROM prescriptions WHERE patient_id = ? ORDER BY day DESC').all(id),
    lab_results: db.prepare('SELECT * FROM lab_results WHERE patient_id = ? ORDER BY day DESC').all(id),
    imaging_orders: db.prepare('SELECT * FROM imaging_orders WHERE patient_id = ? ORDER BY day DESC').all(id),
    vaccinations: db.prepare('SELECT * FROM patient_vaccinations WHERE patient_id = ? ORDER BY administered_day DESC').all(id),
    invoices: db.prepare('SELECT * FROM invoices WHERE patient_id = ? ORDER BY day DESC').all(id),
  };

  appendAudit({
    user_id: actor?.id || null,
    username: actor?.username || 'system',
    role: actor?.role || 'admin',
    action: 'privacy.export_18_07',
    entity_type: 'patient',
    entity_id: String(id),
  });
  return bundle;
}

function anonymizePatient18_07(patientId, { reason = '', actor = null } = {}) {
  const db = getDb();
  const id = requireId(patientId, 'patient_id');
  const existing = db.prepare('SELECT id FROM patients WHERE id = ?').get(id);
  if (!existing) throw new AppError('PATIENT_NOT_FOUND');

  const anonLabel = `Patient Anonymisé #${id}`;
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE patients SET
         full_name = ?, phone = NULL, phone_norm = NULL,
         birth_date = NULL, allergies = '', chronic_conditions = '',
         marital_status = '', occupation = '', chifa_number = '', nss = '',
         commune = '', emergency_contact_name = '', emergency_contact_phone = '',
         legal_guardian_name = '', legal_guardian_phone = '',
         insurance_org_name = '', notes = NULL, updated_at = datetime('now')
       WHERE id = ?`,
    ).run(anonLabel, id);

    db.prepare('DELETE FROM patient_intake WHERE patient_id = ?').run(id);
    db.prepare('UPDATE prescriptions SET patient_name = ? WHERE patient_id = ?').run(anonLabel, id);
    db.prepare('UPDATE medical_certificates SET patient_name = ? WHERE patient_id = ?').run(anonLabel, id);
    // Preserve sequential accounting amounts while scrubbing PII on invoices
    db.prepare("UPDATE invoices SET patient_name = ?, chifa_number = '', nss = '' WHERE patient_id = ?").run(
      anonLabel,
      id,
    );
  });
  tx();

  appendAudit({
    user_id: actor?.id || null,
    username: actor?.username || 'system',
    role: actor?.role || 'admin',
    action: 'privacy.anonymize_18_07',
    entity_type: 'patient',
    entity_id: String(id),
    summary: cleanText(reason, 120) || 'Law 18-07 erasure request',
  });
  return { ok: true, anonymized_id: id, full_name: anonLabel };
}

module.exports = {
  ROLES,
  ROLE_PERMISSIONS,
  hasPermission,
  assertPermission,
  ensureLegacyAdminMigrated,
  listUsers,
  createUser,
  updateUser,
  authenticateUser,
  unlockWithPin,
  appendAudit,
  verifyAuditChain,
  listAuditLog,
  encryptBuffer,
  decryptBuffer,
  encryptAtRest,
  decryptAtRest,
  createEncryptedBackup,
  verifyEncryptedBackup,
  restoreEncryptedBackup,
  copyBackupToUsb,
  recordConsent18_07,
  listConsents18_07,
  exportPatientData18_07,
  anonymizePatient18_07,
};
