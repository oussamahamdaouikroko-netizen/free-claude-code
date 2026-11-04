/**
 * Authentification et comptes.
 *
 * Décisions :
 *  - un seul modèle `users` avec un rôle ; les profils (patient, médecin) sont
 *    des tables satellites (`patients`, `doctors`) reliées par `user_id` ;
 *  - le téléphone est l'identifiant principal en Algérie, l'e-mail est
 *    optionnel ;
 *  - un compte médecin démarre `PENDING` : il n'apparaît pas dans l'annuaire
 *    tant qu'un administrateur n'a pas vérifié son inscription à l'Ordre ;
 *  - verrouillage progressif après 5 échecs (15 minutes).
 */

import { db, many, one } from '../../db.js';
import { config } from '../../config.js';
import { AppError, Errors } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import {
  hashPassword,
  verifyPassword,
  normalizePhone,
  numericCode,
  randomToken,
  sha256,
  safeEqual,
} from '../../lib/crypto.js';
import { revokeAllSessions } from '../../lib/security.js';

export const CONSENT_VERSION = '2026-11-v1';
const ROLES_SELF_SIGNUP = ['PATIENT', 'DOCTOR'];

/** Normalise un e-mail basique (pas de validation parfaite : c'est un contact). */
function normalizeEmail(value) {
  const email = String(value ?? '').trim().toLowerCase();
  if (!email) return null;
  if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(email)) throw Errors.validation({ email: 'invalid' });
  return email.slice(0, 190);
}

/** Politique de mot de passe : longueur + variété minimale. */
function assertPassword(password) {
  const value = String(password ?? '');
  if (value.length < 10) throw Errors.validation({ password: 'min length 10' });
  if (value.length > 128) throw Errors.validation({ password: 'max length 128' });
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(value)).length;
  if (classes < 2) throw Errors.validation({ password: 'must mix at least 2 character classes' });
  return value;
}

/**
 * Inscription.
 * @param {object} input
 * @param {string} input.fullName
 * @param {string} input.phone
 * @param {string} [input.email]
 * @param {string} input.password
 * @param {'PATIENT'|'DOCTOR'} [input.role]
 * @param {'ar'|'fr'} [input.locale]
 * @param {boolean} input.consent
 * @param {object} [input.doctor] profil médecin (spécialité, clinique, licence)
 */
export async function register(input) {
  const role = input.role ?? 'PATIENT';
  if (!ROLES_SELF_SIGNUP.includes(role)) throw Errors.forbidden('Rôle non ouvert à l\'inscription');

  const fullName = String(input.fullName ?? '').trim();
  if (fullName.length < 3) throw Errors.validation({ full_name: 'min length 3' });
  const phone = normalizePhone(input.phone);
  if (!phone) throw Errors.validation({ phone: 'numéro algérien invalide' });
  const email = normalizeEmail(input.email);
  const password = assertPassword(input.password);
  if (!input.consent) throw Errors.validation({ consent: 'obligatoire' });

  const existing = await one('SELECT id FROM users WHERE phone = $1 OR ($2::text IS NOT NULL AND lower(email) = $2)', [
    phone,
    email,
  ]);
  if (existing) throw Errors.conflict('ACCOUNT_EXISTS', 'Un compte existe déjà avec ce téléphone ou cet e-mail');

  const { hash, salt } = hashPassword(password);
  const locale = input.locale === 'ar' ? 'ar' : 'fr';

  const user = await one(
    `INSERT INTO users (role, full_name, phone, email, password_hash, password_salt, status, locale)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, role, full_name, phone, email, status, locale`,
    [role, fullName, phone, email, hash, salt, role === 'DOCTOR' ? 'PENDING' : 'ACTIVE', locale],
  );

  await db().query(
    `INSERT INTO consent_records (user_id, kind, version, granted, ip) VALUES ($1,'TERMS',$2,true,$3)`,
    [user.id, CONSENT_VERSION, input.ip ?? null],
  );
  await db().query(
    `INSERT INTO consent_records (user_id, kind, version, granted, ip) VALUES ($1,'PRIVACY',$2,true,$3)`,
    [user.id, CONSENT_VERSION, input.ip ?? null],
  );

  if (role === 'PATIENT') {
    await db().query(
      `INSERT INTO patients (user_id, full_name, phone, wilaya_code, consent_version, consent_at)
       VALUES ($1,$2,$3,$4,$5, now())`,
      [user.id, fullName, phone, input.wilayaCode ?? null, CONSENT_VERSION],
    );
  }

  if (role === 'DOCTOR') {
    const specialty = await one('SELECT code FROM specialties WHERE code = $1 AND active', [
      input.doctor?.specialtyCode ?? '',
    ]);
    if (!specialty) throw Errors.validation({ specialty: 'spécialité inconnue' });
    await db().query(
      `INSERT INTO doctors (user_id, clinic_id, primary_specialty_code, license_no, bio_fr, bio_ar)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        user.id,
        input.doctor?.clinicId ?? null,
        specialty.code,
        input.doctor?.licenseNo ?? null,
        String(input.doctor?.bioFr ?? '').slice(0, 2000),
        String(input.doctor?.bioAr ?? '').slice(0, 2000),
      ],
    );
  }

  await audit({
    actor: { id: user.id, role: user.role },
    action: 'auth.register',
    entity: 'user',
    entityId: user.id,
    ip: input.ip,
    userAgent: input.userAgent,
    details: { role },
  });

  return {
    user,
    needs_verification: role === 'DOCTOR',
    message:
      role === 'DOCTOR'
        ? 'Compte créé. Votre inscription sera vérifiée par un administrateur avant publication.'
        : 'Compte créé. Vérifiez votre numéro de téléphone pour recevoir les confirmations.',
  };
}

/** Connexion : verrouillage après N échecs, message identique quelle que soit la cause. */
export async function login({ identifier, password, ip, userAgent }) {
  const value = String(identifier ?? '').trim();
  const phone = normalizePhone(value);
  const email = value.includes('@') ? value.toLowerCase() : null;

  const user = await one(
    `SELECT * FROM users WHERE ($1::text IS NOT NULL AND phone = $1) OR ($2::text IS NOT NULL AND lower(email) = $2)`,
    [phone, email],
  );

  // Réponse volontairement générique (pas d'énumération de comptes).
  const invalid = () => new AppError('AUTH_INVALID', 'Identifiants invalides', 401);

  if (!user) {
    // Coût constant : on hache quand même pour éviter une différence de timing.
    verifyPassword(password ?? '', 'x'.repeat(128), 'x'.repeat(32));
    throw invalid();
  }
  if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
    throw Errors.rateLimited(
      Math.ceil((new Date(user.locked_until).getTime() - Date.now()) / 1000),
    );
  }
  if (user.status === 'SUSPENDED') throw Errors.forbidden('Compte suspendu');
  if (user.status === 'DELETED') throw invalid();

  const ok = verifyPassword(String(password ?? ''), user.password_hash, user.password_salt);
  if (!ok) {
    const failed = Number(user.failed_logins) + 1;
    const lock = failed >= config.security.maxFailedLogins
      ? new Date(Date.now() + config.security.lockoutMinutes * 60_000)
      : null;
    await db().query(
      'UPDATE users SET failed_logins = $2, locked_until = $3 WHERE id = $1',
      [user.id, lock ? 0 : failed, lock],
    );
    await audit({
      actor: { id: user.id, role: user.role },
      action: 'auth.login.failed',
      entity: 'user',
      entityId: user.id,
      ip,
      userAgent,
      details: { failed_attempts: failed, locked: Boolean(lock) },
    });
    if (lock) throw Errors.rateLimited(config.security.lockoutMinutes * 60);
    throw invalid();
  }

  await db().query(
    'UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = $1',
    [user.id],
  );
  await audit({
    actor: { id: user.id, role: user.role },
    action: 'auth.login.success',
    entity: 'user',
    entityId: user.id,
    ip,
    userAgent,
  });

  return sanitizeUser(user);
}

/** Version publique d'un utilisateur (jamais de hash ni de secret). */
export function sanitizeUser(user) {
  return {
    id: user.id,
    role: user.role,
    full_name: user.full_name,
    phone: user.phone,
    email: user.email,
    status: user.status,
    locale: user.locale,
    phone_verified_at: user.phone_verified_at ?? null,
    mfa_enabled: Boolean(user.mfa_secret),
  };
}

/** Émet un code OTP (stocké haché, usage unique). */
export async function requestOtp({ phone, purpose = 'VERIFY', ip }) {
  const normalized = normalizePhone(phone);
  if (!normalized) throw Errors.validation({ phone: 'invalid' });
  if (!['LOGIN', 'VERIFY', 'RESET'].includes(purpose)) throw Errors.validation({ purpose: 'invalid' });

  const code = numericCode(6);
  const expiresAt = new Date(Date.now() + config.security.otpTtlMinutes * 60_000);
  await db().query(
    `INSERT INTO otp_codes (phone, purpose, code_hash, expires_at) VALUES ($1,$2,$3,$4)`,
    [normalized, purpose, sha256(code), expiresAt],
  );
  await audit({
    action: 'auth.otp.requested',
    entity: 'phone',
    entityId: normalized,
    ip,
    details: { purpose },
  });

  // En production, le code part par SMS via l'adaptateur SMS et n'est JAMAIS
  // renvoyé dans la réponse HTTP.
  return {
    sent: true,
    expires_in: config.security.otpTtlMinutes * 60,
    ...(config.notifications.otpDebug ? { debug_code: code } : {}),
  };
}

/** Vérifie un OTP et marque le téléphone comme vérifié. */
export async function verifyOtp({ phone, code, purpose = 'VERIFY' }) {
  const normalized = normalizePhone(phone);
  if (!normalized) throw Errors.validation({ phone: 'invalid' });
  const row = await one(
    `SELECT * FROM otp_codes
      WHERE phone = $1 AND purpose = $2 AND consumed_at IS NULL
      ORDER BY created_at DESC LIMIT 1`,
    [normalized, purpose],
  );
  if (!row) throw Errors.conflict('OTP_NOT_FOUND', 'Aucun code en attente');
  if (new Date(row.expires_at).getTime() < Date.now()) {
    throw Errors.conflict('OTP_EXPIRED', 'Code expiré');
  }
  if (row.attempts >= config.security.maxOtpAttempts) {
    throw Errors.rateLimited(300);
  }
  if (!safeEqual(sha256(String(code ?? '')), row.code_hash)) {
    await db().query('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = $1', [row.id]);
    throw Errors.conflict('OTP_INVALID', 'Code invalide');
  }
  await db().query('UPDATE otp_codes SET consumed_at = now() WHERE id = $1', [row.id]);
  await db().query('UPDATE users SET phone_verified_at = now() WHERE phone = $1', [normalized]);
  await audit({ action: 'auth.otp.verified', entity: 'phone', entityId: normalized, details: { purpose } });
  return { verified: true };
}

/** Changement de mot de passe (déconnecte les autres sessions). */
export async function changePassword(userId, { current, next, sessionId }) {
  const user = await one('SELECT * FROM users WHERE id = $1', [userId]);
  if (!user) throw Errors.notFound('User');
  if (!verifyPassword(String(current ?? ''), user.password_hash, user.password_salt)) {
    throw Errors.forbidden('Mot de passe actuel incorrect');
  }
  const value = assertPassword(next);
  const { hash, salt } = hashPassword(value);
  await db().query('UPDATE users SET password_hash = $2, password_salt = $3, updated_at = now() WHERE id = $1', [
    userId,
    hash,
    salt,
  ]);
  await revokeAllSessions(userId, null);
  void sessionId;
  await audit({
    actor: { id: userId, role: user.role },
    action: 'auth.password.changed',
    entity: 'user',
    entityId: userId,
  });
  return { ok: true };
}

/** Rattachement du profil selon le rôle (patient ou médecin). */
export async function identityFor(user) {
  if (!user) return {};
  if (user.role === 'PATIENT') {
    const patient = await one('SELECT * FROM patients WHERE user_id = $1', [user.id]);
    return { patientId: patient?.id ?? null, patient: patient ?? null };
  }
  if (user.role === 'DOCTOR') {
    const doctor = await one('SELECT * FROM doctors WHERE user_id = $1', [user.id]);
    return { doctorId: doctor?.id ?? null, doctor: doctor ?? null };
  }
  return {};
}

/**
 * Droit d'accès du patient : export, rectification, suppression logique
 * (loi 18-07, droits des personnes).
 */
export async function exportPersonalData(userId) {
  const user = await one(
    `SELECT id, role, full_name, phone, email, locale, created_at FROM users WHERE id = $1`,
    [userId],
  );
  if (!user) throw Errors.notFound('User');
  const patient = await one('SELECT * FROM patients WHERE user_id = $1', [userId]);
  const appointments = patient
    ? await many(
        `SELECT a.reference, a.status, a.source, a.service_fee, a.created_at, s.starts_at
           FROM appointments a JOIN doctor_slots s ON s.id = a.slot_id
          WHERE a.patient_id = $1 ORDER BY s.starts_at DESC LIMIT 500`,
        [patient.id],
      )
    : [];
  const payments = patient
    ? await many(
        `SELECT id, purpose, amount, currency, status, provider, livemode, paid_at
           FROM payments WHERE patient_id = $1 ORDER BY created_at DESC LIMIT 500`,
        [patient.id],
      )
    : [];
  const consents = await many(
    'SELECT kind, version, granted, created_at FROM consent_records WHERE user_id = $1',
    [userId],
  );
  return { exported_at: new Date().toISOString(), user, patient, appointments, payments, consents };
}

export async function rectifyPersonalData(userId, { fullName, wilayaCode, commune }) {
  if (fullName !== undefined) {
    const name = String(fullName).trim();
    if (name.length < 3) throw Errors.validation({ full_name: 'min length 3' });
    await db().query('UPDATE users SET full_name = $2, updated_at = now() WHERE id = $1', [userId, name]);
    await db().query('UPDATE patients SET full_name = $2, updated_at = now() WHERE user_id = $1', [userId, name]);
  }
  if (wilayaCode !== undefined || commune !== undefined) {
    await db().query(
      'UPDATE patients SET wilaya_code = coalesce($2, wilaya_code), commune = coalesce($3, commune), updated_at = now() WHERE user_id = $1',
      [userId, wilayaCode ?? null, commune ?? null],
    );
  }
  await audit({ actor: { id: userId }, action: 'auth.data.rectified', entity: 'user', entityId: userId });
  return { ok: true };
}

/**
 * Suppression logique : le compte ne peut plus se connecter, les données
 * médicales sont conservées selon la durée légale, tout le reste est purgé par
 * le worker après la période de rétention.
 */
export async function requestDeletion(userId, { actor = null } = {}) {
  await db().query(`UPDATE users SET status = 'DELETED', updated_at = now() WHERE id = $1`, [userId]);
  await revokeAllSessions(userId);
  await audit({
    actor: actor ?? { id: userId },
    action: 'auth.data.deletion_requested',
    entity: 'user',
    entityId: userId,
  });
  return { ok: true, message: 'Compte désactivé. Les données médicales sont conservées selon la durée légale.' };
}

export { randomToken };
