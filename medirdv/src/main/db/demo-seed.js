'use strict';
/**
 * Sample multi-specialty clinic data, shared by the browser preview
 * (`npm run demo`) and by the portable MediRDV-Demo build.
 */

const patients = require('../services/patients');
const departments = require('../services/departments');
const appointments = require('../services/appointments');
const treatments = require('../services/treatments');
const prescriptions = require('../services/prescriptions');
const payments = require('../services/payments');
const expenses = require('../services/expenses');
const settings = require('../services/settings');
const chat = require('../services/chat');
const { message } = require('../whatsapp/messages');
const { toISODate, addDays } = require('../utils/dates');

const SAMPLE_PATIENTS = [
  ['Mohamed Ben Ali', '0555111001', '1968-04-12', 'm', 'O+', 'Pénicilline', 'HTA, Diabète type 2'],
  ['Amina Kaddour', '0661222002', '1984-09-23', 'f', 'A+', '', ' Sécheresse oculaire'],
  ['Yacine Belkacem', '0770333003', '1979-11-05', 'm', 'B+', 'Aspirine / AINS', 'Lombosciatique chronique'],
  ['Fatima Zohra Saidi', '0555444004', '1962-02-18', 'f', 'A-', '', 'HTA, Dyslipidémie'],
  ['Karim Bouziane', '0661555005', '1991-07-30', 'm', 'O-', '', 'Asthme allergique'],
  ['Nadia Meziane', '0770666006', '1988-12-10', 'f', 'AB+', '', 'Hypothyroïdie'],
  ['Sofiane Haddad', '0555777007', '1975-06-14', 'm', 'B-', '', ''],
  ['Imane Cherif', '0661888008', '1995-03-21', 'f', 'O+', '', 'Anémie ferriprive'],
];

const isSeeded = () => patients.list('', { limit: 1 }).length > 0;

function seedDemoData(options = {}) {
  const clinicName = options.clinicName || 'Polyclinique Médicale El-Chifa';
  if (isSeeded()) return false;

  settings.set('clinic_name', clinicName);
  settings.set('clinic_wilaya', 'Alger');
  settings.set('clinic_phone', '0555 12 34 56');
  settings.set('clinic_address', '14 Rue Didouche Mourad, Alger Centre');
  settings.set('doctor_name', 'Dr. Benali Ahmed');
  settings.set('doctor_specialty', 'Médecine Générale & Cardiologie');
  settings.set('doctor_ordre', 'ALG-24819');
  settings.set('daily_capacity', '15');

  const deptCardio = departments.create({
    name_fr: 'Cardiologie',
    name_ar: 'مصلحة أمراض القلب والشرايين',
    specialty: 'Cardiologie & Écho-Doppler',
    doctor_name: 'Dr. Benali Ahmed',
    room: 'Étage 1 — Salle 102',
    consultation_fee: 3000,
    daily_capacity: 10,
    working_days: '0,1,2,3,4',
    instructions: 'يرجى إحضار تخطيط القلب والتحاليل السابقة · Apporter vos anciens ECG et bilans',
  });
  const deptOphtalmo = departments.create({
    name_fr: 'Ophtalmologie',
    name_ar: 'مصلحة طب وجراحة العيون',
    specialty: 'Ophtalmologie',
    doctor_name: 'Dr. Saidi Amina',
    room: 'Étage 2 — Salle 204',
    consultation_fee: 2500,
    daily_capacity: 12,
    working_days: '0,1,2,3,4',
    instructions: 'تجنب العدسات اللاصقة 24 سا قبل الفحص · Éviter les lentilles 24h avant',
  });
  const deptOrtho = departments.create({
    name_fr: 'Orthopédie & Rhumatologie',
    name_ar: 'مصلحة جراحة العظام والمفاصل',
    specialty: 'Orthopédie & Traumatologie',
    doctor_name: 'Dr. Bouziane Karim',
    room: 'RDC — Salle 03',
    consultation_fee: 2500,
    daily_capacity: 10,
    working_days: '0,1,2,3,4',
    instructions: 'يرجى إحضار صور الأشعة · Apporter vos radiographies récentes',
  });
  const activeDepts = [deptCardio, deptOphtalmo, deptOrtho];

  const catalog = treatments.list();
  const created = SAMPLE_PATIENTS.map(
    ([full_name, phone, birth_date, gender, blood_group, allergies, chronic_conditions]) =>
      patients.create({
        full_name,
        phone,
        birth_date,
        gender,
        blood_group,
        allergies,
        chronic_conditions: chronic_conditions.trim(),
      }),
  );

  const today = toISODate();
  const yesterday = addDays(today, -1);

  created.slice(0, 7).forEach((patient, index) => {
    const dept = activeDepts[index % activeDepts.length];
    const treatment = catalog[index % catalog.length];
    const appointment = appointments.create({
      patient_id: patient.id,
      department_id: dept.id,
      day: today,
      treatment_id: treatment.id,
      price: dept.consultation_fee || treatment.default_price,
      source: index % 2 === 0 ? 'whatsapp' : 'manual',
      historical: !departments.isWorkingDay(dept.id, today),
    });
    if (index < 3) {
      payments.add({
        patient_id: patient.id,
        appointment_id: appointment.id,
        amount: Math.round(appointment.price * (index === 0 ? 1 : 0.5)),
        method: 'cash',
        note: 'Consultation',
      });
      if (index < 2) appointments.setStatus(appointment.id, 'done');
    }
  });

  created.slice(5).forEach((patient, index) => {
    const dept = activeDepts[(index + 1) % activeDepts.length];
    const treatment = catalog[(index + 2) % catalog.length];
    const appointment = appointments.create({
      patient_id: patient.id,
      department_id: dept.id,
      day: yesterday,
      treatment_id: treatment.id,
      price: dept.consultation_fee || treatment.default_price,
      historical: true,
    });
    appointments.setStatus(appointment.id, 'done');
    if (index === 0) {
      payments.add({
        patient_id: patient.id,
        appointment_id: appointment.id,
        amount: appointment.price,
        method: 'cash',
      });
    }
  });

  // Sample prescriptions (Ordonnances) + certificate
  prescriptions.create({
    patient_id: created[0].id,
    department_id: deptCardio.id,
    day: today,
    diagnosis: 'HTA équilibrée + Diabète type 2',
    vitals_bp: '138/84 mmHg',
    vitals_hr: '74 bpm',
    vitals_glycemia: '1,26 g/L',
    exams_requested: 'HbA1c · Bilan lipidique complet · Créatininémie + Kaliémie · ECG de contrôle',
    advice: 'Régime hyposodé, marche quotidienne 30 min, automesure tensionnelle.',
    items: [
      { drug_name: 'Exforge', dci: 'Amlodipine + Valsartan', form_strength: 'Comprimé · 5 mg / 160 mg', dosage: '1 comprimé / jour', timing: 'Le matin', duration: 'QSP 3 mois' },
      { drug_name: 'Kardégic', dci: 'Acide acétylsalicylique', form_strength: 'Sachet · 75 mg', dosage: '1 sachet / jour', timing: 'Au milieu du déjeuner', duration: 'QSP 3 mois' },
      { drug_name: 'Glucophage', dci: 'Metformine', form_strength: 'Comprimé · 1000 mg', dosage: '1 comprimé matin et soir', timing: 'À la fin des repas', duration: 'QSP 3 mois' },
      { drug_name: 'Tahor', dci: 'Atorvastatine', form_strength: 'Comprimé · 20 mg', dosage: '1 comprimé / jour', timing: 'Le soir', duration: 'QSP 3 mois' },
    ],
  });

  prescriptions.create({
    patient_id: created[1].id,
    department_id: deptOphtalmo.id,
    day: today,
    diagnosis: 'Conjonctivite aiguë + Syndrome d’œil sec',
    advice: 'Lavage oculaire au sérum physiologique avant chaque collyre. Serviette individuelle.',
    items: [
      { drug_name: 'Tobradex Collyre', dci: 'Tobramycine + Dexaméthasone', form_strength: 'Collyre · 0,3% / 0,1%', dosage: '1 goutte × 4 / jour', timing: 'Matin, midi, après-midi, soir', duration: '7 jours' },
      { drug_name: 'Hyabak', dci: 'Hyaluronate de sodium', form_strength: 'Collyre hydratant · 0,15%', dosage: '1 goutte × 4 / jour', timing: 'À 15 min d’intervalle', duration: '1 mois' },
    ],
  });

  prescriptions.createCertificate({
    patient_id: created[2].id,
    department_id: deptOrtho.id,
    day: today,
    kind: 'arret_travail',
    rest_days: 5,
    start_day: today,
    content: 'Repos lombaire strict, éviter le port de charges lourdes.',
  });

  const categories = expenses.categories();
  const spend = [
    [0, 14000, 'Gants stériles, draps d’examen, gel échographie'],
    [3, 9500, 'Étalonnage ECG & consommables'],
    [1, 45000, 'Loyer mensuel de la clinique'],
    [4, 5200, 'Facture Sonelgaz & Fibre'],
  ];
  spend.forEach(([index, amount, label], offset) => {
    expenses.create({
      category_id: categories[index % categories.length].id,
      amount,
      day: offset < 2 ? today : addDays(today, -offset),
      label,
    });
  });

  const todayAgenda = appointments.agenda(today);
  const third = todayAgenda.find((a) => a.status === 'booked');
  const fourth = todayAgenda.filter((a) => a.status === 'booked')[1];
  if (third) {
    chat.recordBooked(third, { delivery: 'sent', read: true });
    chat.record({
      kind: 'turn_now',
      direction: 'out',
      patient_id: third.patient_id,
      appointment_id: third.id,
      patient_name: third.full_name,
      phone: third.phone,
      day: today,
      queue_number: third.queue_number,
      ahead_count: 0,
      eta_minutes: 0,
      body: message('ar', 'turnNow', chat.clinicSettings(), {
        name: third.full_name,
        queue: third.queue_number,
        department: third.dept_name_ar || '',
        room: third.dept_room || '',
      }),
      delivery: 'sent',
      read: false,
    });
  }
  if (fourth) {
    chat.record({
      kind: 'queue_ahead',
      direction: 'out',
      patient_id: fourth.patient_id,
      appointment_id: fourth.id,
      patient_name: fourth.full_name,
      phone: fourth.phone,
      day: today,
      queue_number: fourth.queue_number,
      ahead_count: 1,
      eta_minutes: 15,
      body: message('ar', 'queueAhead', chat.clinicSettings(), {
        name: fourth.full_name,
        queue: fourth.queue_number,
        ahead: 1,
        etaMinutes: 15,
        department: fourth.dept_name_ar || '',
      }),
      delivery: 'sent',
      read: false,
    });
  }
  if (created[7]) {
    chat.record({
      kind: 'cancelled',
      direction: 'out',
      patient_id: created[7].id,
      patient_name: created[7].full_name,
      phone: created[7].phone,
      day: today,
      queue_number: 4,
      body: message('ar', 'cancelled', chat.clinicSettings(), { day: today }),
      delivery: 'sent',
      read: false,
    });
  }

  console.log('[demo] sample multi-specialty clinic data created');
  return true;
}

module.exports = { seedDemoData, isSeeded, SAMPLE_PATIENTS };
