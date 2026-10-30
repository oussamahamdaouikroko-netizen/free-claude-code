'use strict';
/**
 * Local dashboard protection.
 *
 * One password per clinic, stored as a scrypt hash (salted, constant-time
 * compare). The session lives in the main process only; after 30 minutes of
 * inactivity the dashboard locks itself again.
 */

const crypto = require('node:crypto');
const { getDb } = require('../db');
const security = require('./security');
const { AppError } = require('../utils/common');

const SESSION_MS = 30 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 60 * 1000;

let unlockedAt = 0;
let failedAttempts = 0;
let lockedUntil = 0;
let activeUser = null;

function readKey(key) {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : '';
}

function writeKey(key, value) {
  getDb()
    .prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    )
    .run(key, value);
}

function hash(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}

function hasPassword() {
  return Boolean(readKey('password_hash'));
}

function status() {
  security.ensureLegacyAdminMigrated();
  const locked = Date.now() < lockedUntil;
  return {
    has_password: hasPassword(),
    unlocked: isUnlocked(),
    locked,
    lock_seconds: locked ? Math.ceil((lockedUntil - Date.now()) / 1000) : 0,
    user: isUnlocked() ? currentUser() : null,
  };
}

function currentUser() {
  return activeUser || { id: null, username: 'admin', full_name: 'Administrateur', role: 'admin' };
}

function isUnlocked() {
  if (!unlockedAt) return false;
  if (Date.now() - unlockedAt > SESSION_MS) {
    unlockedAt = 0;
    return false;
  }
  return true;
}

/** Keep the session alive while the dentist is using the app. */
function touch() {
  if (unlockedAt) unlockedAt = Date.now();
}

function unlock(user = null) {
  unlockedAt = Date.now();
  failedAttempts = 0;
  lockedUntil = 0;
  activeUser = user || { id: null, username: 'admin', full_name: 'Administrateur', role: 'admin' };
}

function lock() {
  unlockedAt = 0;
  return { ok: true };
}

function assertPassword(password) {
  const value = String(password ?? '');
  if (value.length < 4) throw new AppError('PASSWORD_TOO_SHORT');
  if (value.length > 128) throw new AppError('PASSWORD_TOO_LONG');
  return value;
}

/** First-run password creation. */
function setup({ password, confirm } = {}) {
  if (hasPassword()) throw new AppError('PASSWORD_ALREADY_SET');
  const value = assertPassword(password);
  if (confirm !== undefined && confirm !== password) throw new AppError('PASSWORD_MISMATCH');
  const salt = crypto.randomBytes(16).toString('hex');
  writeKey('password_salt', salt);
  writeKey('password_hash', hash(value, salt));
  const migrated = security.ensureLegacyAdminMigrated();
  unlock(migrated);
  return status();
}

function login(password) {
  if (!hasPassword()) throw new AppError('PASSWORD_NOT_SET');
  if (Date.now() < lockedUntil) {
    throw new AppError('TOO_MANY_ATTEMPTS', 'Locked', {
      seconds: Math.ceil((lockedUntil - Date.now()) / 1000),
    });
  }
  const salt = readKey('password_salt');
  const expected = readKey('password_hash');
  const candidate = hash(String(password ?? ''), salt);
  const ok =
    candidate.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(candidate, 'hex'), Buffer.from(expected, 'hex'));

  if (!ok) {
    failedAttempts += 1;
    if (failedAttempts >= MAX_ATTEMPTS) {
      lockedUntil = Date.now() + LOCKOUT_MS;
      failedAttempts = 0;
      throw new AppError('TOO_MANY_ATTEMPTS', 'Locked', { seconds: LOCKOUT_MS / 1000 });
    }
    throw new AppError('BAD_PASSWORD', 'Wrong password', {
      attempts_left: MAX_ATTEMPTS - failedAttempts,
    });
  }
  const migrated = security.ensureLegacyAdminMigrated();
  unlock(migrated);
  return status();
}

function loginUser({ username, password } = {}) {
  const user = security.authenticateUser({ username, password });
  unlock(user);
  return status();
}

function unlockPin({ username, pin } = {}) {
  const uname = username || activeUser?.username || 'admin';
  const user = security.unlockWithPin({ username: uname, pin });
  unlock(user);
  return status();
}

function changePassword({ current, next, confirm } = {}) {
  if (!hasPassword()) throw new AppError('PASSWORD_NOT_SET');
  login(current);
  const value = assertPassword(next);
  if (confirm !== undefined && confirm !== next) throw new AppError('PASSWORD_MISMATCH');
  const salt = crypto.randomBytes(16).toString('hex');
  const pwHash = hash(value, salt);
  writeKey('password_salt', salt);
  writeKey('password_hash', pwHash);
  getDb()
    .prepare("UPDATE users SET password_salt = ?, password_hash = ? WHERE username = 'admin'")
    .run(salt, pwHash);
  unlock(activeUser);
  return { ok: true };
}

/** Guard used by the IPC layer for every sensitive channel. */
function requireUnlocked(method = '') {
  if (!isUnlocked()) throw new AppError('LOCKED');
  if (method) {
    security.assertPermission(currentUser().role, method);
  }
  touch();
  return true;
}

module.exports = {
  status,
  setup,
  login,
  loginUser,
  unlockPin,
  currentUser,
  lock,
  isUnlocked,
  touch,
  changePassword,
  hasPassword,
  requireUnlocked,
  SESSION_MS,
};
