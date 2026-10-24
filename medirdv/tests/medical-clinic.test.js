'use strict';
/**
 * MediRDV — Multi-specialty clinic, WhatsApp department routing, Algerian
 * Nomenclature medications, prescriptions (Ordonnances) & certificates tests.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { useTempDb } = require('./helpers');

const settings = require('../src/main/services/settings');
const departments = require('../src/main/services/departments');
const patients = require('../src/main/services/patients');
const appointments = require('../src/main/services/appointments');
const prescriptions = require('../src/main/services/prescriptions');
const reports = require('../src/main/services/reports');
const bot = require('../src/main/whatsapp/bot');
const { prescriptionHtml, certificateHtml } = require('../src/main/print');

test('clinic settings store doctor identity, specialty & location and appear on printed prescriptions', (t) => {
  const ctx = useTempDb();
  t.after(() => ctx.cleanup());

  settings.setMany({
    clinic_name: 'Clinique El Chifa',
    clinic_wilaya: 'Alger',
    clinic_address: '18 Rue Didouche Mourad, Alger Centre',
    clinic_phone: '023 45 67 89',
    doctor_name: 'Dr. Amine Benali',
    doctor_specialty: 'Cardiologie & Maladies Vasculaires',
    doctor_ordre: 'CNOM-16-4821',
  });

  const profile = reports.clinicProfile();
  assert.equal(profile.name, 'Clinique El Chifa');
  assert.equal(profile.doctor_name, 'Dr. Amine Benali');
  assert.equal(profile.doctor_specialty, 'Cardiologie & Maladies Vasculaires');

  const patient = patients.create({
    full_name: 'Hadj Tahar',
    phone: '0551001122',
    birth_date: '1964-03-10',
    blood_group: 'O+',
    allergies: 'Pénicillines',
    chronic_conditions: 'HTA',
  });

  const rx = prescriptions.create({
    patient_id: patient.id,
    diagnosis: 'HTA essentielle grade 2',
    vitals_bp: '155/95',
    vitals_hr: '76',
    exams_requested: 'ECG 12 dérivations, Ionogramme sanguin, Créatininémie',
    advice: 'Régime hyposodé + marche 30 min/j',
    items: [
      {
        drug_name: 'Amlor',
        dci: 'Amlodipine',
        form_strength: 'Gélule 5 mg',
        dosage: '1 gélule par jour le matin',
        timing: 'Après repas',
        duration: '3 mois',
        quantity: '3 boîtes',
      },
    ],
  });

  assert.equal(rx.doctor_name, 'Dr. Amine Benali');
  assert.equal(rx.doctor_specialty, 'Cardiologie & Maladies Vasculaires');
  assert.equal(rx.items.length, 1);

  const html = prescriptionHtml({ prescription: rx, clinic: profile });
  assert.match(html, /Clinique El Chifa/, 'clinic name on printed prescription');
  assert.match(html, /18 Rue Didouche Mourad/, 'clinic location on printed prescription');
  assert.match(html, /Dr\. Amine Benali/, 'doctor name on printed prescription');
  assert.match(html, /Cardiologie &amp; Maladies Vasculaires/, 'medical specialty on printed prescription');
  assert.match(html, /ORDONNANCE MÉDICALE/, 'bilingual title');
  assert.match(html, /وصـفـة طـبـيـة/, 'Arabic title on prescription');
  assert.match(html, /Amlor/, 'prescribed Algerian medication');
  assert.match(html, /3 mois/, 'treatment duration');
  assert.match(html, /ECG 12 dérivations/, 'requested lab/imaging exams');
});

test('multi-department polyclinic: independent daily queues & WhatsApp department selection in FR and AR', (t) => {
  const ctx = useTempDb();
  t.after(() => ctx.cleanup());

  settings.setMany({
    clinic_name: 'Polyclinique Ibn Sina',
    working_days: '0,1,2,3,4,5,6',
    allow_same_day_booking: '1',
  });

  const cardio = departments.create({
    name_fr: 'Cardiologie',
    name_ar: 'طب القلب والشرايين',
    specialty: 'Cardiologie',
    doctor_name: 'Dr. Benali',
    room: '1er étage - Salle 101',
    consultation_fee: 3000,
    daily_capacity: 10,
    instructions: 'Apporter anciens ECG',
  });
  const ophtalmo = departments.create({
    name_fr: 'Ophtalmologie',
    name_ar: 'طب وجراحة العيون',
    specialty: 'Ophtalmologie',
    doctor_name: 'Dr. Mansouri',
    room: '2e étage - Salle 204',
    consultation_fee: 2500,
    daily_capacity: 12,
    instructions: 'Retirer les lentilles 24h avant',
  });

  // 1. Arabic patient sends their name → bot asks them to choose a department.
  const step1Ar = bot.handle({ phone: '213555100200', text: 'كريم بوزيد' });
  assert.equal(step1Ar.action, 'choose_department');
  assert.match(step1Ar.reply, /طب القلب والشرايين/);
  assert.match(step1Ar.reply, /طب وجراحة العيون/);

  // Patient replies "2" → booked into Ophtalmologie with queue #1!
  const step2Ar = bot.handle({ phone: '213555100200', text: '2' });
  assert.equal(step2Ar.action, 'booked');
  assert.equal(step2Ar.appointment.department_id, ophtalmo.id);
  assert.equal(step2Ar.appointment.queue_number, 1);
  assert.equal(step2Ar.appointment.price, 2500);
  assert.match(step2Ar.reply, /طب وجراحة العيون/);
  assert.match(step2Ar.reply, /Salle 204/);

  // 2. French patient sends their name → picks department 1 (Cardiologie) → ALSO gets queue #1 in Cardiologie!
  const step1Fr = bot.handle({ phone: '213661200300', text: 'Nadia Khelifi' });
  assert.equal(step1Fr.action, 'choose_department');
  assert.match(step1Fr.reply, /Cardiologie/);

  const step2Fr = bot.handle({ phone: '213661200300', text: '1' });
  assert.equal(step2Fr.action, 'booked');
  assert.equal(step2Fr.appointment.department_id, cardio.id);
  assert.equal(step2Fr.appointment.queue_number, 1, 'Cardiology queue starts independently at #1');
  assert.equal(step2Fr.appointment.price, 3000);
  assert.match(step2Fr.reply, /Apporter anciens ECG/);

  // 3. Second Cardiology patient on the same day gets queue #2 in Cardiology, while Ophthalmology stays at 1!
  const bookedDay = step2Fr.appointment.day;
  const p3 = patients.create({ full_name: 'Mourad Saidi', phone: '0770300400' });
  const cardio2 = appointments.create({
    patient_id: p3.id,
    department_id: cardio.id,
    day: bookedDay,
  });
  assert.equal(cardio2.queue_number, 2);

  // Completing Cardiology #1 notifies ONLY Cardiology #2 (never Ophthalmology!).
  const adv = appointments.completeAndAdvance(step2Fr.appointment.id, { today: bookedDay });
  assert.equal(adv.next_patient.id, cardio2.id);
  assert.equal(adv.notifications.length, 1);
  assert.equal(adv.notifications[0].patient_id, p3.id);
});

test('Algerian Nomenclature search, custom drugs, allergy conflict alerts, templates & certificates', (t) => {
  const ctx = useTempDb();
  t.after(() => ctx.cleanup());

  const stats = prescriptions.medicationStats();
  assert.ok(stats.total >= 120, `expected >= 120 Algerian drugs seeded, got ${stats.total}`);

  // Search by brand, DCI, and Arabic keyword.
  assert.ok(prescriptions.searchMedications({ query: 'Augmentin' }).some((m) => m.brand.includes('Augmentin')));
  assert.ok(prescriptions.searchMedications({ query: 'metformine' }).some((m) => m.brand.includes('Glucophage')));
  assert.ok(prescriptions.searchMedications({ query: 'ضغط' }).length >= 3, 'Arabic keyword search works');

  // Doctor can add a custom local drug to the catalog.
  const custom = prescriptions.createMedication({
    brand: 'Bioprazole',
    dci: 'Oméprazole',
    strength: '20 mg',
    form: 'Gélule',
    specialty: 'gastro',
    default_dosage: '1 gélule le matin à jeun',
    default_duration: '14 jours',
  });
  assert.equal(custom.custom, 1);
  assert.ok(prescriptions.searchMedications({ query: 'Bioprazole' }).some((m) => m.id === custom.id));

  // Drug-allergy cross-check catches Penicillin class (Augmentin / Amoxypen) and NSAIDs (Voltarène).
  const penWarnings = prescriptions.checkAllergyWarnings('Allergie Pénicillines', [
    { drug_name: 'Augmentin', dci: 'Amoxicilline + Acide clavulanique' },
    { drug_name: 'Doliprane', dci: 'Paracétamol' },
  ]);
  assert.equal(penWarnings.length, 1);
  assert.equal(penWarnings[0].drug_name, 'Augmentin');

  const nsaidWarnings = prescriptions.checkAllergyWarnings('AINS / Aspirine', [
    { drug_name: 'Voltarène', dci: 'Diclofénac' },
  ]);
  assert.equal(nsaidWarnings.length, 1);

  // Reusable prescription templates (Ordonnances types).
  const initialTemplates = prescriptions.listTemplates();
  assert.ok(initialTemplates.length >= 4, 'starter templates seeded');
  const createdTpl = prescriptions.createTemplate({
    title_fr: 'Protocole Conjonctivite',
    title_ar: 'بروتوكول التهاب الملتحمة',
    specialty: 'ophtalmo',
    items: [{ drug_name: 'Tobrex', dci: 'Tobramycine', dosage: '1 goutte x 4/j', duration: '7 jours' }],
  });
  assert.equal(createdTpl.items.length, 1);

  // Medical certificate generation & printable A4 HTML.
  settings.setMany({
    clinic_name: 'Cabinet Médical El Biar',
    doctor_name: 'Dr. S. Kaci',
    doctor_specialty: 'Médecine Générale',
  });
  const cert = prescriptions.createCertificate({
    patient_name: 'Yacine Brahimi',
    patient_age: '31 ans',
    kind: 'arret_travail',
    rest_days: 5,
  });
  assert.equal(cert.rest_days, 5);
  const certDoc = certificateHtml({ certificate: cert, clinic: reports.clinicProfile() });
  assert.match(certDoc, /CERTIFICAT MÉDICAL/);
  assert.match(certDoc, /5 jour\(s\)/);
  assert.match(certDoc, /Dr\. S\. Kaci/);
});
