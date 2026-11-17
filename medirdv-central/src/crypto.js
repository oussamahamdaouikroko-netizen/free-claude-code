'use strict';
/**
 * Cryptographic primitives for Medirdv Central.
 *
 * - Passwords: scrypt (salted, constant-time compare). Same approach as the
 *   desktop apps (medirdv/src/main/services/auth.js), server-side here.
 * - Secrets at rest (WhatsApp tokens, connector keys): AES-256-GCM with a
 *   key from MEDIRDV_ENCRYPTION_KEY. Format: v1:<iv>:<tag>:<ciphertext> (base64).
 * - Webhook signatures: HMAC-SHA256 (Meta X-Hub-Signature-256).
 */
const crypto = require('node:crypto');

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, expected] = parts;
  let actual;
  try {
    actual = crypto.scryptSync(String(password), salt, 64).toString('hex');
  } catch {
    return false;
  }
  const a = Buffer.from(actual, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function getEncryptionKey() {
  const raw = process.env.MEDIRDV_ENCRYPTION_KEY || '';
  if (!raw) throw new Error('MEDIRDV_ENCRYPTION_KEY is not set');
  // Accept hex (64 chars) or base64 (44 chars) 32-byte keys.
  let key;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) key = Buffer.from(raw, 'hex');
  else {
    try {
      key = Buffer.from(raw, 'base64');
    } catch {
      key = Buffer.alloc(0);
    }
  }
  if (!key || key.length !== 32) {
    throw new Error('MEDIRDV_ENCRYPTION_KEY must be a 32-byte key (hex or base64)');
  }
  return key;
}

function encryptSecret(plaintext) {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`;
}

function decryptSecret(stored) {
  if (typeof stored !== 'string' || !stored.startsWith('v1:')) return null;
  const parts = stored.split(':');
  if (parts.length !== 4) return null;
  const [, ivB64, tagB64, ctB64] = parts;
  try {
    const key = getEncryptionKey();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(ctB64, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return null;
  }
}

function hmacSha256Hex(secret, data) {
  return crypto.createHmac('sha256', String(secret)).update(String(data)).digest('hex');
}

/** Constant-time compare for hex digests (webhook signatures). */
function timingSafeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

module.exports = {
  hashPassword,
  verifyPassword,
  encryptSecret,
  decryptSecret,
  hmacSha256Hex,
  timingSafeEqualHex,
  randomToken,
  sha256Hex,
};
