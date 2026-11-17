'use strict';
/**
 * Sample clinic data, shared by the browser preview (`npm run demo`) and by the
 * portable DentaRDV-Demo build handed to a prospect during a sales visit.
 *
 * One source of truth: what a dentist sees in the demo is exactly what they
 * will see after buying. Nothing here is imported by the real app unless demo
 * mode is on (see src/main/index.js).
 */

const patients = require('../services/patients');
const appointments = require('../services/appointments');
const treatments = require('../services/treatments');
const payments = require('../services/payments');
const expenses = require('../services/expenses');
const settings = require('../services/settings');
const chat = require('../services/chat');
const { message } = require('../whatsapp/messages');
const { toISODate, addDays } = require('../utils/dates');

const SAMPLE_PATIENTS = [
  ['Mohamed Ben Ali', '0555111001'],
  ['Amina Kaddour', '0661222002'],
  ['Yacine Belkacem', '0770333003'],
  ['Fatima Zohra Saidi', '0555444004'],
  ['Karim Bouziane', '0661555005'],
  ['Nadia Meziane', '0770666006'],
  ['Sofiane Haddad', '0555777007'],
  ['Imane Cherif', '0661888008'],
];

const isSeeded = () => patients.list('', { limit: 1 }).length > 0;

function seedDemoData(options = {}) {
  const clinicName = options.clinicName || 'Cabinet Dentaire El Oued';
  if (isSeeded()) return false;

  settings.set('clinic_name', clinicName);
  settings.set('clinic_phone', '0555 12 34 56');
  settings.set('clinic_address', 'Rue des Martyrs, El Oued');
  settings.set('daily_capacity', '8');

  const catalog = treatments.list();
  const created = SAMPLE_PATIENTS.map(([name, phone]) => patients.create({ full_name: name, phone }));

  const today = toISODate();
  const yesterday = addDays(today, -1);

  // Today: a busy numbered queue, half of it paid.
  created.slice(0, 5).forEach((patient, index) => {
    const treatment = catalog[index % catalog.length];
    const appointment = appointments.create({
      patient_id: patient.id,
      day: today,
      treatment_id: treatment.id,
      price: treatment.default_price,
      source: index % 2 === 0 ? 'whatsapp' : 'manual',
      // Sample data, so it must exist even when "today" is a closed day
      // (Friday): the demo is also a preview used on weekends.
      historical: !settings.isWorkingDay(today),
    });
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

  // Yesterday: completed visits + expenses, so the reports page is not empty.
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

  // Sample appointment confirmations, cancellation and live queue calls so the
  // Mini Chat window showcases the real receptionist flow immediately.
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
