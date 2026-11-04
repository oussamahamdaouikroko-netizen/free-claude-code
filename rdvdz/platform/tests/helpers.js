/**
 * Outils de test : base en mémoire, application HTTP, comptes et fixtures.
 *
 * Chaque fichier de test appelle `setup()` une fois : la base est recréée pour
 * garantir l'indépendance des fichiers (exécution séquentielle).
 */

import './env.js';
import { buildApp } from '../src/app.js';
import { closeDatabase, migrate, openDatabase } from '../src/db.js';
import { seedTemplates } from '../src/modules/notifications/service.js';
import { clearAll as clearRateLimits } from '../src/lib/rate-limit.js';

let app = null;

/** Application + base prêtes à l'emploi. */
export async function setup() {
  await openDatabase({ driver: 'pglite', pgliteDir: ':memory:' });
  await migrate();
  await seedTemplates();
  clearRateLimits();
  app = await buildApp({ logger: false });
  await app.ready();
  return app;
}

export async function teardown() {
  if (app) await app.close();
  app = null;
  await closeDatabase();
}

export function getApp() {
  return app;
}

/**
 * Requête HTTP sur l'application (sans réseau).
 * @param {'GET'|'POST'|'PUT'|'PATCH'|'DELETE'} method
 */
export async function call(method, url, { body, token, csrf, headers = {} } = {}) {
  const response = await app.inject({
    method,
    url,
    payload: body === undefined ? undefined : body,
    headers: {
      ...(token ? { cookie: `rdv_session=${token}` } : {}),
      ...(csrf ? { 'x-csrf-token': csrf } : {}),
      ...headers,
    },
  });
  let json = null;
  try {
    json = response.body ? JSON.parse(response.body) : null;
  } catch {
    json = null;
  }
  return { status: response.statusCode, body: json, raw: response.body, headers: response.headers };
}

/** Extrait le jeton de session du `Set-Cookie`. */
export function cookieToken(headers) {
  const raw = headers['set-cookie'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;
  const match = /rdv_session=([^;]+)/.exec(value);
  return match ? match[1] : null;
}

let counter = 0;
function uniquePhone() {
  counter += 1;
  // Numéros mobiles algériens valides et distincts (0550xxxxxx).
  return `0550${String(100000 + counter).slice(-6)}`;
}

/** Crée un compte et renvoie {user, token, csrf, id...}. */
export async function registerPatient({ fullName = 'Patient Test', phone, email } = {}) {
  // Les fixtures sont créées en masse par les tests : elles ne doivent pas
  // consommer le quota de limitation de débit (qui a son propre test).
  clearRateLimits();
  const result = await call('POST', '/api/v1/auth/register', {
    body: {
      fullName,
      phone: phone ?? uniquePhone(),
      email: email ?? null,
      password: 'MotDePasse#2026',
      role: 'PATIENT',
      locale: 'fr',
      consent: true,
    },
  });
  if (result.status !== 201) throw new Error(`register failed: ${JSON.stringify(result.body)}`);
  const login = await call('POST', '/api/v1/auth/login', {
    body: { identifier: result.body.user.phone, password: 'MotDePasse#2026' },
  });
  if (login.status !== 200) throw new Error(`login failed: ${JSON.stringify(login.body)}`);
  return {
    user: login.body.user,
    token: cookieToken(login.headers),
    csrf: login.body.csrf_token,
    patientId: login.body.identity.patient_id,
    phone: result.body.user.phone,
    password: 'MotDePasse#2026',
  };
}

export async function registerDoctor({ fullName = 'Dr Test', specialtyCode = 'GENERAL', licenseNo = null } = {}) {
  const phone = uniquePhone();
  const result = await call('POST', '/api/v1/auth/register', {
    body: {
      fullName,
      phone,
      password: 'MotDePasse#2026',
      role: 'DOCTOR',
      locale: 'fr',
      consent: true,
      doctor: { specialtyCode, licenseNo },
    },
  });
  if (result.status !== 201) throw new Error(`doctor register failed: ${JSON.stringify(result.body)}`);
  return { userId: result.body.user.id, phone, password: 'MotDePasse#2026' };
}

/** Connexion (utile après activation par un administrateur). */
export async function loginWith(phone, password = 'MotDePasse#2026') {
  const login = await call('POST', '/api/v1/auth/login', { body: { identifier: phone, password } });
  if (login.status !== 200) throw new Error(`login failed: ${JSON.stringify(login.body)}`);
  return { user: login.body.user, token: cookieToken(login.headers), csrf: login.body.csrf_token, ...login.body.identity };
}

/**
 * Crée un administrateur directement en base (pas de route d'inscription
 * publique pour les rôles internes : c'est volontaire).
 */
export async function createAdmin(role = 'SUPER_ADMIN') {
  const { db } = await import('../src/db.js');
  const { hashPassword, randomToken } = await import('../src/lib/crypto.js');
  const { createSession } = await import('../src/lib/security.js');
  const phone = uniquePhone();
  const { hash, salt } = hashPassword('MotDePasse#2026');
  const row = await db().query(
    `INSERT INTO users (role, full_name, phone, password_hash, password_salt, status, locale)
     VALUES ($1,$2,$3,$4,$5,'ACTIVE','fr') RETURNING id`,
    [role, `Admin ${role}`, phone, hash, salt],
  );
  const session = await createSession(row.rows[0].id, { ip: '127.0.0.1' });
  return { id: row.rows[0].id, role, token: session.token, csrf: session.csrf, phone, password: 'MotDePasse#2026' };
}

/** Crée une clinique vérifiée + un médecin vérifié avec des créneaux. */
export async function createVerifiedDoctorWithSlots({
  specialtyCode = 'GENERAL',
  wilayaCode = 16,
  slotCount = 6,
  fee = 2000,
  teleconsult = false,
} = {}) {
  const { db } = await import('../src/db.js');
  const doctor = await registerDoctor({ specialtyCode });
  const admin = await createAdmin('ADMIN');

  const clinic = await db().query(
    `INSERT INTO clinics (name_fr, name_ar, kind, wilaya_code, commune, address, phone)
     VALUES ('Clinique Test','عيادة اختبار','MEDICAL',$1,'Bab Ezzouar','Rue 1','0550111111') RETURNING id`,
    [wilayaCode],
  );
  const clinicId = clinic.rows[0].id;
  const doctorRow = await db().query(
    `UPDATE doctors SET clinic_id = $2, consultation_fee = $3, teleconsult_fee = $4,
            teleconsult_enabled = $5, slot_minutes = 20
      WHERE user_id = $1 RETURNING id`,
    [doctor.userId, clinicId, fee, teleconsult ? 1000 : 0, teleconsult],
  );
  const doctorId = doctorRow.rows[0].id;

  // Vérification par l'administrateur (jamais automatique en production).
  const verified = await call('POST', `/api/v1/admin/doctors/${doctorId}/verify`, {
    token: admin.token,
    csrf: admin.csrf,
    body: { note: 'test' },
  });
  if (verified.status !== 200) throw new Error(`verify failed: ${JSON.stringify(verified.body)}`);

  const login = await loginWith(doctor.phone);

  // Créneaux: génération directe en base pour un test déterministe.
  const slots = [];
  const base = new Date();
  base.setUTCDate(base.getUTCDate() + 1);
  base.setUTCHours(8, 0, 0, 0);
  for (let i = 0; i < slotCount; i += 1) {
    const starts = new Date(base.getTime() + i * 60 * 60 * 1000);
    const ends = new Date(starts.getTime() + 20 * 60 * 1000);
    const inserted = await db().query(
      `INSERT INTO doctor_slots (doctor_id, starts_at, ends_at, mode, status)
       VALUES ($1,$2,$3,'IN_CLINIC','OPEN') RETURNING id, starts_at`,
      [doctorId, starts, ends],
    );
    slots.push(inserted.rows[0]);
  }

  return {
    doctorId,
    clinicId,
    slots,
    admin,
    doctorLogin: login,
    doctorUserId: doctor.userId,
    doctorPhone: doctor.phone,
  };
}

export function tomorrow() {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

export function dayAfter(n) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + n);
  return date.toISOString().slice(0, 10);
}

export { uniquePhone };
