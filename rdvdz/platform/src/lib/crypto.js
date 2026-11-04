/**
 * Primitives cryptographiques.
 *
 * Choix : uniquement des modules natifs de Node (`node:crypto`) — aucune
 * dépendance externe, rien à compiler, comportement auditable.
 *  - mots de passe : scrypt (N=16384, r=8, p=1), sel aléatoire 16 octets ;
 *  - jetons : 32 octets aléatoires, stockés HACHÉS en base ;
 *  - signatures : HMAC-SHA256 avec comparaison à temps constant ;
 *  - documents : AES-256-GCM (authentifié, pas seulement chiffré).
 */

import {
  createCipheriv,
  createHash,
  createDecipheriv,
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';

const SCRYPT_N = 16384;
const SCRYPT_r = 8;
const SCRYPT_p = 1;
const KEY_LEN = 64;

/** Hache un mot de passe. @returns {{hash: string, salt: string}} */
export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(String(password), salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_r,
    p: SCRYPT_p,
    maxmem: 64 * 1024 * 1024,
  }).toString('hex');
  return { hash, salt };
}

/** Compare un mot de passe au couple (hash, salt) à temps constant. */
export function verifyPassword(password, hash, salt) {
  if (!hash || !salt) return false;
  const candidate = scryptSync(String(password), salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_r,
    p: SCRYPT_p,
    maxmem: 64 * 1024 * 1024,
  });
  const expected = Buffer.from(String(hash), 'hex');
  if (candidate.length !== expected.length) return false;
  return timingSafeEqual(candidate, expected);
}

/** Jeton opaque (cookie de session, secret d'appareil, code de partage). */
export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

/** Empreinte SHA-256 (stockage des jetons, somme des documents). */
export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

/** HMAC-SHA256 hexadécimal. */
export function hmac(secret, payload) {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

/** Comparaison de deux chaînes hexadécimales à temps constant. */
export function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ''), 'utf8');
  const right = Buffer.from(String(b ?? ''), 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Code numérique à 6 chiffres (OTP). */
export function numericCode(digits = 6) {
  const max = 10 ** digits;
  return String(randomBytes(4).readUInt32BE(0) % max).padStart(digits, '0');
}

/* ------------------------------ chiffrement ------------------------------- */

/** Clé AES-256 dérivée du secret de stockage. */
function storageKey(secret) {
  const raw = Buffer.from(String(secret), 'utf8');
  if (raw.length < 32) throw new Error('STORAGE_ENCRYPTION_KEY trop courte (min. 32 octets)');
  return raw.subarray(0, 32);
}

/**
 * Chiffre un tampon : format `iv(12) | tag(16) | ciphertext`.
 * @returns {Buffer}
 */
export function encryptBuffer(buffer, secret) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', storageKey(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(buffer), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

/** Déchiffre un tampon produit par `encryptBuffer` (lève si altéré). */
export function decryptBuffer(payload, secret) {
  const iv = payload.subarray(0, 12);
  const tag = payload.subarray(12, 28);
  const ciphertext = payload.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', storageKey(secret), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Signature d'un lien à durée de vie limitée.
 * Le lien lie l'identifiant, l'utilisateur et l'instant d'expiration : il ne
 * peut pas être rejoué par un autre compte.
 */
export function signLink({ secret, documentId, userId, expiresAt }) {
  return hmac(secret, `${documentId}.${userId}.${expiresAt}`);
}

export function verifyLink({ secret, documentId, userId, expiresAt, signature, now = Date.now() }) {
  if (!expiresAt || Number(expiresAt) < now) return false;
  return safeEqual(signLink({ secret, documentId, userId, expiresAt }), signature);
}

/**
 * Normalise un numéro de téléphone algérien en E.164.
 * Accepte `05 50 12 34 56`, `+213550123456`, `00213550123456`.
 * @returns {string|null} `+213550123456` ou null si invalide
 */
export function normalizePhone(input) {
  let digits = String(input ?? '').replace(/\D/g, '');
  if (!digits) return null;
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('213')) digits = digits.slice(3);
  if (digits.startsWith('0')) digits = digits.slice(1);
  // Mobile (5/6/7) ou fixe (2/3/4) : 9 chiffres au total en Algérie.
  if (!/^[2-7]\d{8}$/.test(digits)) return null;
  return `+213${digits}`;
}

/** Masque un contact pour les journaux (`+2135•••••56`). */
export function maskPhone(phone) {
  const value = String(phone ?? '');
  if (value.length < 6) return '•••';
  return `${value.slice(0, 5)}${'•'.repeat(Math.max(3, value.length - 7))}${value.slice(-2)}`;
}
