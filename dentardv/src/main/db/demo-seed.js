'use strict';
/**
 * Sample clinic data, shared by the browser preview (`npm run demo`) and by the
 * portable DentaRDV-Demo build handed to a dentist during a sales visit.
 */

const patients = require('../services/patients');
const appointments = require('../services/appointments');
const treatments = require('../services/treatments');
const payments = require('../services/payments');
const expenses = require('../services/expenses');
const prescriptions = require('../services/prescriptions');
const intake = require('../services/intake');
const settings = require('../services/settings');
const chat = require('../services/chat');
const { message } = require('../whatsapp/messages');
const { toISODate, addDays } = require('../utils/dates');

const SAMPLE_PATIENTS = [
  ['Mohamed Ben Ali', '0555111001', 'Pénicilline', 'HTA'],
  ['Amina Kaddour', '0661222002', '', ''],
  ['Yacine Belkacem', '0770333003', '', 'Diabète type 2'],
  ['Fatima Zohra Saidi', '0555444004', '', ''],
  ['Karim Bouziane', '0661555005', '', ''],
  ['Nadia Meziane', '0770666006', '', ''],
  ['Sofiane Haddad', '0555777007', '', ''],
  ['Imane Cherif', '0661888008', '', ''],
];

const isSeeded = () => patients.list('', { limit: 1 }).length > 0;

function seedDemoData(options = {}) {
  const clinicName = options.clinicName || 'Cabinet Dentaire El Oued';
  if (isSeeded()) return false;

  settings.set('clinic_name', clinicName);
  settings.set('clinic_phone', '0555 12 34 56');
  settings.set('clinic_address', 'Rue des Martyrs, El Oued');
  settings.set('doctor_name', 'Dr. Amine Bensalem');
  settings.set('doctor_specialty', 'Chirurgien-Dentiste');
  settings.set('doctor_ordre', 'OMD-39-1420');
  settings.set('daily_capacity', '8');

  const catalog = treatments.list();
  const created = SAMPLE_PATIENTS.map(([name, phone, allergies, chronic]) =>
    patients.create({ full_name: name, phone, allergies, chronic_conditions: chronic }),
  );

  const today = toISODate();
  const yesterday = addDays(today, -1);

  const todayAppointments = [];
  created.slice(0, 5).forEach((patient, index) => {
    const treatment = catalog[index % catalog.length];
    const appointment = appointments.create({
      patient_id: patient.id,
      day: today,
      treatment_id: treatment.id,
      price: treatment.default_price,
      source: index % 2 === 0 ? 'whatsapp' : 'manual',
      historical: !settings.isWorkingDay(today),
    });
    todayAppointments.push(appointment);
    if (index < 3) {
      payments.add({
        patient_id: patient.id,
        appointment_id: appointment.id,
        amount: Math.round(treatment.default_price * (index === 0 ? 1 : 0.5)),
        method: 'cash',
        note: 'Acompte',
      });
      if (index < 2) appointments.setStatus(appointment.id, 'done');
    }
  });

  // Add a sample pre-visit WhatsApp intake on the active waiting patient
  if (todayAppointments[2]) {
    intake.create({
      patient_id: todayAppointments[2].patient_id,
      appointment_id: todayAppointments[2].id,
      source: 'whatsapp',
      consent: true,
      age_years: 34,
      weight_kg: 76,
      chief_complaint: 'Douleur aiguë molaire inférieure droite (46) sensible au froid',
    });
  }

  // Add a sample dental prescription
  if (created[1]) {
    prescriptions.create({
      patient_id: created[1].id,
      day: today,
      patient_name: created[1].full_name,
      patient_age: '29 ans',
      patient_weight: '64 kg',
      tooth_ref: '38 (Dent de sagesse)',
      diagnosis: 'Post-extraction chirurgicale dent 38',
      items: [
        {
          drug_name: 'Augmentin Adulte',
          dci: 'Amoxicilline + Acide clavulanique',
          form_strength: 'Sachet-dose 1 g / 125 mg',
          dosage: '1 sachet matin et soir',
          timing: 'Au début des repas',
          duration: '6 jours',
          quantity: '1 boîte',
        },
        {
          drug_name: 'Solupred',
          dci: 'Prednisolone',
          form_strength: 'Comprimé orodispersible 20 mg',
          dosage: '2 comprimés en 1 prise le matin',
          timing: 'Au petit-déjeuner',
          duration: '3 jours',
          quantity: '1 boîte',
        },
        {
          drug_name: 'Doliprane',
          dci: 'Paracétamol',
          form_strength: 'Comprimé 1000 mg',
          dosage: '1 comprimé toutes les 6 à 8 h si douleur',
          timing: 'Max 3 g/jour',
          duration: '5 jours',
          quantity: '1 boîte',
        },
        {
          drug_name: 'Paroex (GUM)',
          dci: 'Chlorhexidine digluconate',
          form_strength: 'Bain de bouche 0,12%',
          dosage: '1 bain de bouche passif × 2 / jour',
          timing: 'À débuter 24 h après extraction',
          duration: '10 jours',
          quantity: '1 flacon',
        },
      ],
      advice: 'Vessie de glace sur la joue · Alimentation tiède/froide 48 h · Ne pas cracher ni fumer pendant 24 h.',
    });
  }

  created.slice(5).forEach((patient, index) => {
    const treatment = catalog[(index + 2) % catalog.length];
    const appointment = appointments.create({
      patient_id: patient.id,
      day: yesterday,
      treatment_id: treatment.id,
      price: treatment.default_price,
      historical: true,
    });
    appointments.setStatus(appointment.id, 'done');
    if (index === 0) {
      payments.add({
        patient_id: patient.id,
        appointment_id: appointment.id,
        amount: treatment.default_price,
        method: 'cash',
      });
    }
  });

  const categories = expenses.categories();
  const spend = [
    [0, 12000, 'Gants, masques, composites'],
    [3, 8000, 'Prothèse patient Ben Ali'],
    [1, 35000, 'Loyer du mois'],
    [4, 4500, 'Facture Sonelgaz'],
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
  const third = todayAgenda[2];
  const fourth = todayAgenda[3];
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
      eta_minutes: 20,
      body: message('ar', 'queueAhead', chat.clinicSettings(), {
        name: fourth.full_name,
        queue: fourth.queue_number,
        ahead: 1,
        etaMinutes: 20,
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
      queue_number: 6,
      body: message('ar', 'cancelled', chat.clinicSettings(), { day: today }),
      delivery: 'sent',
      read: false,
    });
  }

  console.log('[demo] sample clinic data created');
  return true;
}

module.exports = { seedDemoData, isSeeded, SAMPLE_PATIENTS };
