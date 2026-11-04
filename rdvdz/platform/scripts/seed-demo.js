#!/usr/bin/env node
/**
 * Jeu de démonstration — à n'exécuter QUE sur une base de développement.
 *
 * Crée un environnement crédible pour tester l'interface :
 *  - 2 cliniques (Alger, El Oued) et 3 médecins vérifiés ;
 *  - 3 patients ;
 *  - du personnel : 1 admin, 1 finance, 1 manager de branche, 1 opérateur ;
 *  - des créneaux générés sur 14 jours ;
 *  - des rendez-vous dans des états différents (confirmé, en attente de
 *    paiement, terminé, annulé) ;
 *  - des paiements **simulés** uniquement (`livemode = false`) : le script
 *    refuse de tourner en production et n'invente jamais d'encaissement réel.
 *
 * Idempotent : relancer le script ne duplique rien (téléphones fixes + garde
 * sur le compte existant). Aucune donnée n'est supprimée.
 *
 * Usage :
 *   npm run migrate && npm run seed
 *   SEED_PASSWORD='MonMotDePasse#2026' npm run seed
 */

import { closeDatabase, migrate, one, openDatabase } from '../src/db.js';
import { validateConfig } from '../src/config.js';
import { config } from '../src/config.js';
import { seedTemplates } from '../src/modules/notifications/service.js';
import { hashPassword } from '../src/lib/crypto.js';
import { createBooking } from '../src/modules/booking/service.js';
import { generateSlots } from '../src/modules/booking/slots.js';
import { markPaid } from '../src/modules/payments/service.js';

const PASSWORD = process.env.SEED_PASSWORD || 'Demo#2026-Demo';
const FORCE = process.argv.includes('--force');

const isoDay = (offset = 0) => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
};

/** Crée un utilisateur (+ profil) si le numéro n'existe pas déjà. */
async function ensureUser({ phone, fullName, role, locale = 'fr', password = PASSWORD }) {
  const existing = await one('SELECT id, role FROM users WHERE phone = $1', [phone]);
  if (existing) {
    if (existing.role !== role) {
      throw new Error(
        `Le numéro ${phone} existe déjà avec le rôle ${existing.role} (attendu ${role}). ` +
          'Utilisez une autre base ou un autre numéro.',
      );
    }
    return { id: existing.id, created: false };
  }
  const { hash, salt } = hashPassword(password);
  const row = await one(
    `INSERT INTO users (role, full_name, phone, password_hash, password_salt, status, locale, phone_verified_at)
     VALUES ($1,$2,$3,$4,$5,'ACTIVE',$6, now()) RETURNING id`,
    [role, fullName, phone, hash, salt, locale],
  );
  return { id: row.id, created: true };
}

async function ensureClinic({ nameFr, nameAr, kind, wilayaCode, commune, address, phone }) {
  const existing = await one('SELECT id FROM clinics WHERE phone = $1', [phone]);
  if (existing) return existing.id;
  const row = await one(
    `INSERT INTO clinics (name_fr, name_ar, kind, wilaya_code, commune, address, phone, verified_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now()) RETURNING id`,
    [nameFr, nameAr, kind, wilayaCode, commune, address, phone],
  );
  return row.id;
}

async function ensureDoctor({ userId, clinicId, specialty, licenseNo, fee, teleconsultFee, bioFr, bioAr }) {
  const existing = await one('SELECT id FROM doctors WHERE user_id = $1', [userId]);
  if (existing) return existing.id;
  const row = await one(
    `INSERT INTO doctors
       (user_id, clinic_id, primary_specialty_code, license_no, consultation_fee,
        teleconsult_fee, teleconsult_enabled, slot_minutes, bio_fr, bio_ar, verified_at, verified_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,20,$8,$9, now(), NULL) RETURNING id`,
    [
      userId,
      clinicId,
      specialty,
      licenseNo,
      fee,
      teleconsultFee,
      teleconsultFee > 0,
      bioFr,
      bioAr,
    ],
  );
  return row.id;
}

async function ensurePatient({ userId = null, fullName, phone, wilayaCode, commune }) {
  const existing = await one('SELECT id FROM patients WHERE phone = $1', [phone]);
  if (existing) return existing.id;
  const row = await one(
    `INSERT INTO patients (user_id, full_name, phone, wilaya_code, commune, consent_at)
     VALUES ($1,$2,$3,$4,$5, now()) RETURNING id`,
    [userId, fullName, phone, wilayaCode, commune],
  );
  return row.id;
}

async function ensureHours(doctorId, clinicId) {
  const existing = await one('SELECT count(*)::int AS n FROM clinic_hours WHERE doctor_id = $1', [doctorId]);
  if (existing.n > 0) return;
  // Dimanche → jeudi (semaine de travail algérienne), 8h-16h avec pause.
  for (const weekday of [0, 1, 2, 3, 4]) {
    await one(
      `INSERT INTO clinic_hours (clinic_id, doctor_id, weekday, opens, closes, break_start, break_end)
       VALUES ($1,$2,$3,'08:00','16:00','12:00','13:00') RETURNING id`,
      [clinicId, doctorId, weekday],
    );
  }
}

async function ensureBranch({ code, name, wilayaCode, commissionPct }) {
  const existing = await one('SELECT id FROM branches WHERE code = $1', [code]);
  if (existing) return existing.id;
  const row = await one(
    `INSERT INTO branches (code, name, wilaya_code, commission_pct, status)
     VALUES ($1,$2,$3,$4,'ACTIVE') RETURNING id`,
    [code, name, wilayaCode, commissionPct],
  );
  return row.id;
}

/** Réserve (si possible) un créneau libre du médecin. */
async function demoBooking({ doctorId, patientId, mode = 'IN_CLINIC', status = 'CONFIRMED', actor = null }) {
  const slot = await one(
    `SELECT id FROM doctor_slots
      WHERE doctor_id = $1 AND status = 'OPEN' AND starts_at > now()
      ORDER BY starts_at ASC LIMIT 1`,
    [doctorId],
  );
  if (!slot) return null;
  await one(`UPDATE doctor_slots SET status = 'OPEN' WHERE id = $1 RETURNING id`, [slot.id]);

  const result = await createBooking({
    slotId: slot.id,
    patientId,
    source: 'PATIENT_WEBSITE',
    notes: '',
    actor,
    idempotencyKey: `seed-${slot.id}`,
  }).catch((error) => {
    // Un créneau peut avoir été pris entre-temps : on l'ignore, le but est la
    // démonstration, pas une garantie de volumétrie.
    console.warn(`  ! réservation ignorée (${error.code ?? error.message})`);
    return null;
  });
  if (!result) return null;

  const appointmentId = result.appointment.id;
  if (status === 'AWAITING_PAYMENT') return appointmentId;

  // Paiement simulé : livemode=false, aucun revenu comptable.
  await one(
    `INSERT INTO payments (purpose, appointment_id, patient_id, provider, provider_ref, amount, status, livemode)
     VALUES ('BOOKING_SERVICE_FEE',$1,$2,'sandbox',$3,$4,'PENDING',false) RETURNING id`,
    [appointmentId, patientId, `seed_${appointmentId.slice(0, 8)}`, result.appointment.service_fee],
  );
  const payment = await one('SELECT * FROM payments WHERE appointment_id = $1', [appointmentId]);
  await markPaid(payment, { event: { livemode: false, provider: 'sandbox' }, actor });

  if (status === 'COMPLETED') {
    await one(`UPDATE appointments SET status = 'COMPLETED', completed_at = now() WHERE id = $1 RETURNING id`, [
      appointmentId,
    ]);
  }
  if (status === 'CANCELLED') {
    await one(
      `UPDATE appointments SET status = 'CANCELLED', cancel_reason = 'démonstration' WHERE id = $1 RETURNING id`,
      [appointmentId],
    );
  }
  return appointmentId;
}

async function main() {
  validateConfig();
  if (config.isProduction) {
    throw new Error('seed-demo refuse de s’exécuter en production (données fictives + paiements simulés)');
  }
  if (config.payments.provider === 'chargily' && !FORCE) {
    console.warn(
      '[seed] PAYMENTS_PROVIDER=chargily : le jeu de démonstration crée uniquement des paiements ' +
        'simulés (aucun appel réseau). Utilisez PAYMENTS_PROVIDER=sandbox pour tester la caisse.',
    );
  }

  await openDatabase();
  await migrate();
  await seedTemplates();

  console.log('[seed] cliniques');
  const clinicAlger = await ensureClinic({
    nameFr: 'Clinique Es-Salem',
    nameAr: 'عيادة السلام',
    kind: 'POLYCLINIC',
    wilayaCode: 16,
    commune: 'Bab Ezzouar',
    address: '12 rue des Frères Bouadou, Bab Ezzouar',
    phone: '021234567',
  });
  const clinicElOued = await ensureClinic({
    nameFr: 'Cabinet dentaire El Oued',
    nameAr: 'عيادة الأسنان بالوادي',
    kind: 'DENTAL',
    wilayaCode: 39,
    commune: 'El Oued',
    address: 'Cité 400 logements, El Oued',
    phone: '032345678',
  });

  console.log('[seed] personnel');
  const admin = await ensureUser({ phone: '+213555000001', fullName: 'Amine Belkacem', role: 'SUPER_ADMIN' });
  const finance = await ensureUser({ phone: '+213555000002', fullName: 'Souad Haddad', role: 'FINANCE_MANAGER' });
  const manager = await ensureUser({ phone: '+213555000003', fullName: 'Yacine Ferhat', role: 'BRANCH_MANAGER' });
  const operator = await ensureUser({ phone: '+213555000004', fullName: 'Nassim Cherif', role: 'OPERATOR' });

  const branchAlger = await ensureBranch({
    code: 'ALG-CENTRE',
    name: 'Alger Centre',
    wilayaCode: 16,
    commissionPct: 20,
  });
  const branchElOued = await ensureBranch({
    code: 'ELOUED-01',
    name: 'El Oued',
    wilayaCode: 39,
    commissionPct: 15,
  });
  await one(
    `INSERT INTO branch_operators (branch_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING branch_id`,
    [branchAlger, operator.id],
  );
  await one(
    `INSERT INTO user_scopes (user_id, branch_id, wilaya_code) VALUES ($1,$2,16) ON CONFLICT DO NOTHING RETURNING user_id`,
    [operator.id, branchAlger],
  );
  await one(`UPDATE branches SET manager_user_id = $2 WHERE id = $1 RETURNING id`, [branchAlger, manager.id]);

  console.log('[seed] médecins');
  const doctorGeneral = await ensureUser({
    phone: '+213555000101',
    fullName: 'Dr Karim Boudiaf',
    role: 'DOCTOR',
  });
  const doctorCardio = await ensureUser({
    phone: '+213555000102',
    fullName: 'Dr Lila Mansouri',
    role: 'DOCTOR',
  });
  const doctorDentist = await ensureUser({
    phone: '+213555000103',
    fullName: 'Dr Samir Zitouni',
    role: 'DOCTOR',
    locale: 'ar',
  });

  const generalId = await ensureDoctor({
    userId: doctorGeneral.id,
    clinicId: clinicAlger,
    specialty: 'GENERAL',
    licenseNo: 'ORD-16-1001',
    fee: 3000,
    teleconsultFee: 1500,
    bioFr: 'Médecine générale, suivi des maladies chroniques.',
    bioAr: 'طب عام، متابعة الأمراض المزمنة.',
  });
  const cardioId = await ensureDoctor({
    userId: doctorCardio.id,
    clinicId: clinicAlger,
    specialty: 'CARDIO',
    licenseNo: 'ORD-16-1002',
    fee: 4500,
    teleconsultFee: 0,
    bioFr: 'Cardiologie interventionnelle, hypertension.',
    bioAr: 'أمراض القلب، ارتفاع ضغط الدم.',
  });
  const dentistId = await ensureDoctor({
    userId: doctorDentist.id,
    clinicId: clinicElOued,
    specialty: 'DENT',
    licenseNo: 'ORD-39-1003',
    fee: 2500,
    teleconsultFee: 0,
    bioFr: 'Soins dentaires, chirurgie buccale.',
    bioAr: 'علاج الأسنان والجراحة الفموية.',
  });

  await ensureHours(generalId, clinicAlger);
  await ensureHours(cardioId, clinicAlger);
  await ensureHours(dentistId, clinicElOued);
  await one(`UPDATE doctors SET clinic_id = $2 WHERE id = $1 RETURNING id`, [dentistId, clinicElOued]);

  console.log('[seed] branches des médecins');
  for (const [doctorId, branchId, pct] of [
    [generalId, branchAlger, 20],
    [cardioId, branchAlger, 20],
    [dentistId, branchElOued, 15],
  ]) {
    await one(
      `INSERT INTO doctor_branches (doctor_id, branch_id, commission_pct)
       VALUES ($1,$2,$3) ON CONFLICT (doctor_id, branch_id) DO UPDATE SET commission_pct = excluded.commission_pct
       RETURNING doctor_id`,
      [doctorId, branchId, pct],
    );
  }

  console.log('[seed] patients');
  const patientOne = await ensureUser({ phone: '+213555000201', fullName: 'Nadia Bouzid', role: 'PATIENT' });
  const patientTwo = await ensureUser({
    phone: '+213555000202',
    fullName: 'Rachid Meziane',
    role: 'PATIENT',
    locale: 'ar',
  });
  const patientThree = await ensureUser({ phone: '+213555000203', fullName: 'Farida Larbi', role: 'PATIENT' });

  const patientOneId = await ensurePatient({
    userId: patientOne.id,
    fullName: 'Nadia Bouzid',
    phone: '+213555000201',
    wilayaCode: 16,
    commune: 'Bab Ezzouar',
  });
  const patientTwoId = await ensurePatient({
    userId: patientTwo.id,
    fullName: 'Rachid Meziane',
    phone: '+213555000202',
    wilayaCode: 39,
    commune: 'El Oued',
  });
  const patientThreeId = await ensurePatient({
    userId: patientThree.id,
    fullName: 'Farida Larbi',
    phone: '+213555000203',
    wilayaCode: 16,
    commune: 'Hussein Dey',
  });

  console.log('[seed] créneaux (14 jours)');
  for (const doctorId of [generalId, cardioId, dentistId]) {
    const result = await generateSlots(doctorId, { from: isoDay(1), to: isoDay(14) });
    console.log(`  → ${doctorId.slice(0, 8)} : ${result.created} créé(s), ${result.skipped} déjà présent(s)`);
  }

  console.log('[seed] rendez-vous de démonstration');
  const existingAppointments = await one('SELECT count(*)::int AS n FROM appointments');
  if (existingAppointments.n > 0 && !FORCE) {
    console.log('  → des rendez-vous existent déjà : aucun ajout (utilisez --force pour en ajouter)');
  } else {
    const bookings = [
      { doctorId: generalId, patientId: patientOneId, status: 'CONFIRMED' },
      { doctorId: generalId, patientId: patientTwoId, status: 'AWAITING_PAYMENT' },
      { doctorId: cardioId, patientId: patientThreeId, status: 'CONFIRMED' },
      { doctorId: dentistId, patientId: patientTwoId, status: 'COMPLETED' },
      { doctorId: dentistId, patientId: patientOneId, status: 'CANCELLED' },
    ];
    for (const booking of bookings) {
      const id = await demoBooking(booking);
      if (id) console.log(`  → ${booking.status.padEnd(15)} ${id.slice(0, 8)}`);
    }
  }

  console.log('[seed] avis en attente de modération');
  const completed = await one(
    `SELECT id, doctor_id FROM appointments WHERE status = 'COMPLETED' LIMIT 1`,
  );
  if (completed) {
    await one(
      `INSERT INTO reviews (doctor_id, patient_id, appointment_id, rating, comment, status)
       SELECT $1,$2,$3,5,'Accueil correct et explications claires.','PENDING'
        WHERE NOT EXISTS (SELECT 1 FROM reviews WHERE appointment_id = $3)
        RETURNING id`,
      [completed.doctor_id, patientTwoId, completed.id],
    );
  }

  console.log('\n[seed] comptes de démonstration (mot de passe commun : voir SEED_PASSWORD)');
  const accounts = [
    ['SUPER_ADMIN', '+213555000001', 'Amine Belkacem'],
    ['FINANCE_MANAGER', '+213555000002', 'Souad Haddad'],
    ['BRANCH_MANAGER', '+213555000003', 'Yacine Ferhat'],
    ['OPERATOR', '+213555000004', 'Nassim Cherif'],
    ['DOCTOR', '+213555000101', 'Dr Karim Boudiaf'],
    ['DOCTOR', '+213555000102', 'Dr Lila Mansouri'],
    ['DOCTOR', '+213555000103', 'Dr Samir Zitouni'],
    ['PATIENT', '+213555000201', 'Nadia Bouzid'],
    ['PATIENT', '+213555000202', 'Rachid Meziane'],
    ['PATIENT', '+213555000203', 'Farida Larbi'],
  ];
  for (const [role, phone, name] of accounts) console.log(`  ${role.padEnd(16)} ${phone}  ${name}`);
  console.log(`  mot de passe : ${PASSWORD.replace(/./g, '*')} (défini par SEED_PASSWORD)`);
  console.log('\n[seed] ATTENTION : paiements simulés uniquement, aucune donnée réelle.');

  await closeDatabase();
}

main().catch(async (error) => {
  console.error('[seed] échec:', error.message);
  try {
    await closeDatabase();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
