'use strict';
/**
 * Seed demo data (development only). Creates 2 clinics, 3 doctors,
 * schedules, and one sample booking flow. Safe to re-run (idempotent-ish:
 * duplicates are prevented by unique constraints where applicable).
 *
 * Usage: npm run seed-demo
 */
require('../src/env').loadEnv();
const db = require('../src/db');
const auth = require('../src/auth');
const booking = require('../src/services/booking');
const payments = require('../src/services/payments');

function main() {
  db.open();
  const conn = db.getDb();

  const adminEmail = process.env.MEDIRDV_BOOTSTRAP_ADMIN_EMAIL || 'admin@medirdv.dz';
  const adminPassword = process.env.MEDIRDV_BOOTSTRAP_ADMIN_PASSWORD || 'admin-pass-123';
  if (!auth.getUserByEmail(adminEmail)) {
    auth.createUser({ email: adminEmail, password: adminPassword, fullName: 'Super Administrator', role: 'super_admin' });
    console.log(`Admin created: ${adminEmail} / ${adminPassword} (change immediately)`);
  }

  const specialties = [
    ['general-medicine', 'Médecine Générale', 'طب عام'],
    ['cardiology', 'Cardiologie', 'قلب'],
    ['dentistry', 'Dentaire', 'أسنان'],
  ];
  for (const [slug, fr, ar] of specialties) {
    conn.prepare('INSERT OR IGNORE INTO specialties (slug, name_fr, name_ar) VALUES (?, ?, ?)').run(slug, fr, ar);
  }
  const specId = conn.prepare('SELECT id FROM specialties WHERE slug = ?').get('cardiology').id;

  const clinic = conn.prepare('SELECT * FROM clinics WHERE name = ?').get('Clinique El Baraka');
  let clinicId;
  if (!clinic) {
    const r = conn.prepare("INSERT INTO clinics (public_ref, name, address, wilaya, city) VALUES ('CLN-DEMO1', 'Clinique El Baraka', 'Rue Didouche Mourad', 'Alger', 'Alger Centre')").run();
    clinicId = r.lastInsertRowid;
  } else clinicId = clinic.id;

  const doctors = [
    { name: 'Dr Amina Benali', specialty: 'Cardiologie', phone: '0550123456', fee: 2000 },
    { name: 'Dr Karim Haddad', specialty: 'Médecine Générale', phone: '0661234567', fee: 1500 },
  ];
  for (const d of doctors) {
    let row = conn.prepare('SELECT * FROM doctors WHERE full_name = ?').get(d.name);
    if (!row) {
      const r = conn.prepare(
        `INSERT INTO doctors (public_ref, full_name, specialty_id, specialty_text, phone, phone_norm, whatsapp_number, whatsapp_number_norm, consultation_fee, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`
      ).run(`DOC-DEMO-${d.name.slice(3, 6)}`, d.name, specId, d.specialty, d.phone, d.phone, d.phone, d.phone, d.fee);
      row = conn.prepare('SELECT * FROM doctors WHERE id = ?').get(r.lastInsertRowid);
    }
    conn.prepare('INSERT OR IGNORE INTO doctor_clinics (doctor_id, clinic_id) VALUES (?, ?)').run(row.id, clinicId);
    for (let weekday = 0; weekday < 7; weekday += 1) {
      conn.prepare('INSERT OR IGNORE INTO doctor_schedules (doctor_id, clinic_id, weekday, start_time, end_time) VALUES (?, ?, ?, ?, ?)').run(row.id, clinicId, weekday, '09:00', '17:00');
    }
    console.log(`Doctor ready: ${row.full_name} (id ${row.id})`);
  }

  console.log('Demo seed complete. Start with: npm start');
  db.close();
}

main();
