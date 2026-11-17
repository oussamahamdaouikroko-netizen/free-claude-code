'use strict';
/**
 * Authentication + role-based authorization (backend-enforced, Part 8).
 *
 * Roles: super_admin > admin > payment_verifier > support > doctor > patient.
 * Sessions are opaque tokens in httpOnly cookies; passwords are scrypt-hashed.
 */
const crypto = require('node:crypto');
const { getDb, utcNow } = require('./db');
const { hashPassword, verifyPassword, randomToken } = require('./crypto');
const { unauthorized, forbidden, validation } = require('./errors');
const { requireEmail, requirePassword, cleanText } = require('./validate');

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const COOKIE_NAME = process.env.MEDIRDV_SESSION_COOKIE || 'medirdv_session';

const ROLES = ['super_admin', 'admin', 'payment_verifier', 'support', 'doctor', 'patient'];

/** Minimum role rank required per permission. Higher rank includes lower. */
const RANK = { patient: 1, doctor: 2, support: 3, payment_verifier: 4, admin: 5, super_admin: 6 };

const PERMISSIONS = {
  'admin:dashboard': 'admin',
  'admin:doctors': 'admin',
  'admin:clinics': 'admin',
  'admin:appointments': 'admin',
  'admin:patients': 'admin',
  // Support agents may look up a booking/patient to help, but nothing more.
  'patients:lookup': 'support',
  'admin:analytics': 'admin',
  'admin:settings': 'super_admin',
  'payments:view': 'payment_verifier',
  'payments:verify': 'payment_verifier',
  'whatsapp:manage': 'admin',
  'connector:manage': 'admin',
  'doctor:self': 'doctor',
  'patient:self': 'patient',
};

function rankOf(role) {
  return RANK[role] || 0;
}

function hasPermission(user, permission) {
  if (!user) return false;
  const required = PERMISSIONS[permission];
  if (!required) return false;
  return rankOf(user.role) >= rankOf(required);
}

function requirePermission(user, permission) {
  if (!user) throw unauthorized();
  if (!hasPermission(user, permission)) throw forbidden(`Missing permission: ${permission}`);
}

function createUser({ email, password, fullName, role, doctorId = null, patientId = null }) {
  const normalizedEmail = requireEmail(email);
  requirePassword(password);
  if (!ROLES.includes(role)) throw validation(`role must be one of: ${ROLES.join(', ')}`);
  const db = getDb();
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(normalizedEmail);
  if (existing) throw validation('An account with this email already exists');
  const now = utcNow();
  const result = db
    .prepare(
      `INSERT INTO users (email, password_hash, full_name, role, doctor_id, patient_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(normalizedEmail, hashPassword(password), cleanText(fullName, 120), role, doctorId, patientId, now, now);
  return getUserById(result.lastInsertRowid);
}

function getUserById(id) {
  const row = getDb().prepare('SELECT * FROM users WHERE id = ?').get(id);
  return row || null;
}

function getUserByEmail(email) {
  const row = getDb().prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').toLowerCase());
  return row || null;
}

function login(email, password) {
  const user = getUserByEmail(email);
  if (!user || !user.is_active) return null;
  if (!verifyPassword(password, user.password_hash)) return null;
  return user;
}

function createSession(userId, { ip = '', userAgent = '' } = {}) {
  const id = randomToken(32);
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
  getDb()
    .prepare(
      `INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at, ip, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(id, userId, now.toISOString(), expires, now.toISOString(), String(ip).slice(0, 64), String(userAgent).slice(0, 300));
  return { id, expiresAt: expires };
}

function getSessionUser(sessionId) {
  if (!sessionId) return null;
  const db = getDb();
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
  if (!session) return null;
  if (new Date(session.expires_at).getTime() < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
    return null;
  }
  const user = getUserById(session.user_id);
  if (!user || !user.is_active) return null;
  db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(utcNow(), sessionId);
  return user;
}

function destroySession(sessionId) {
  if (sessionId) getDb().prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
}

function parseCookies(header) {
  const cookies = {};
  for (const part of String(header || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

function sessionCookieHeader(sessionId, expiresAt) {
  const maxAge = Math.max(0, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000));
  return `${COOKIE_NAME}=${encodeURIComponent(sessionId)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}`;
}

function clearCookieHeader() {
  return `${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`;
}

function timingSafeTokenCompare(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ba.length !== bb.length || ba.length === 0) return false;
  return crypto.timingSafeEqual(ba, bb);
}

module.exports = {
  ROLES,
  RANK,
  PERMISSIONS,
  rankOf,
  hasPermission,
  requirePermission,
  createUser,
  getUserById,
  getUserByEmail,
  login,
  createSession,
  getSessionUser,
  destroySession,
  parseCookies,
  sessionCookieHeader,
  clearCookieHeader,
  timingSafeTokenCompare,
  COOKIE_NAME,
};
