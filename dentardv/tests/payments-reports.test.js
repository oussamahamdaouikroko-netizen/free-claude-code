'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { useTempDb } = require('./helpers');
const settings = require('../src/main/services/settings');
const patients = require('../src/main/services/patients');
const appointments = require('../src/main/services/appointments');
const payments = require('../src/main/services/payments');
const expenses = require('../src/main/services/expenses');
const reports = require('../src/main/services/reports');
const dates = require('../src/main/utils/dates');

function fresh() {
  const ctx = useTempDb();
  settings.setMany({ working_days: '0,1,2,3,4,5,6', daily_capacity: '20', booking_horizon_days: '30' });
  return ctx;
}

function expectCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.equal(error.code, code, `expected ${code}, got ${error.code} (${error.message})`);
    return true;
  });
}

test('partial payments reduce the balance, overpayment is refused', (t) => {
  const ctx = fresh();
  t.after(() => ctx.cleanup());

  const day = dates.addDays(dates.toISODate(), 1);
  const p = patients.create({ full_name: 'Pay Patient', phone: '0555111000' });
  const appointment = appointments.create({ patient_id: p.id, day, price: 10000 });

  payments.add({ patient_id: p.id, appointment_id: appointment.id, amount: 4000, method: 'cash' });
  assert.equal(patients.get(p.id).balance, 6000);

  expectCode(
    () => payments.add({ patient_id: p.id, appointment_id: appointment.id, amount: 7000 }),
    'AMOUNT_TOO_HIGH',
  );

  payments.add({ patient_id: p.id, appointment_id: appointment.id, amount: 6000, method: 'card' });
  assert.equal(patients.get(p.id).balance, 0);
  assert.equal(patients.totalDebt(), 0);
});

test('paying a debt spreads the amount over the oldest visits first', (t) => {
  const ctx = fresh();
  t.after(() => ctx.cleanup());

  const today = dates.toISODate();
  const p = patients.create({ full_name: 'Debt Patient', phone: '0555111001' });
  const first = appointments.create({ patient_id: p.id, day: dates.addDays(today, -10), price: 5000, historical: true });
  appointments.setStatus(first.id, 'done');
  const second = appointments.create({ patient_id: p.id, day: dates.addDays(today, -5), price: 5000, historical: true });
  appointments.setStatus(second.id, 'done');

  assert.equal(patients.get(p.id).balance, 10000);
  payments.payDebt({ patient_id: p.id, amount: 7000, method: 'cash' });

  const history = patients.history(p.id);
  const paidFirst = history.find((row) => row.id === first.id);
  const paidSecond = history.find((row) => row.id === second.id);
  assert.equal(paidFirst.paid, 5000);
  assert.equal(paidSecond.paid, 2000);
  assert.equal(patients.get(p.id).balance, 3000);

  expectCode(() => payments.payDebt({ patient_id: p.id, amount: 99999 }), 'AMOUNT_TOO_HIGH');
  payments.payDebt({ patient_id: p.id, amount: 3000 });
  expectCode(() => payments.payDebt({ patient_id: p.id, amount: 100 }), 'NO_DEBT');
});

test('the debtors list carries the balance and the last visit', (t) => {
  const ctx = fresh();
  t.after(() => ctx.cleanup());

  const today = dates.toISODate();
  const owes = patients.create({ full_name: 'Ahmed Owes', phone: '0555222002' });
  const clear = patients.create({ full_name: 'Zohra Paid', phone: '0555333003' });

  const visit = appointments.create({ patient_id: owes.id, day: today, price: 6000 });
  appointments.setStatus(visit.id, 'done');
  payments.add({ patient_id: owes.id, appointment_id: visit.id, amount: 2000, method: 'cash' });

  const paidVisit = appointments.create({ patient_id: clear.id, day: today, price: 3000 });
  appointments.setStatus(paidVisit.id, 'done');
  payments.add({ patient_id: clear.id, appointment_id: paidVisit.id, amount: 3000, method: 'cash' });

  const rows = patients.debtors();
  assert.equal(rows.length, 1, 'only the patient who still owes money is listed');
  assert.equal(rows[0].id, owes.id);
  assert.equal(rows[0].balance, 4000);
  assert.equal(rows[0].full_name, 'Ahmed Owes');
  assert.equal(rows[0].last_visit, today, 'the list shows when the patient was last seen');
});

test('deleting a payment restores the debt', (t) => {
  const ctx = fresh();
  t.after(() => ctx.cleanup());

  const p = patients.create({ full_name: 'Delete Patient', phone: '0555111002' });
  const appointment = appointments.create({ patient_id: p.id, day: dates.addDays(dates.toISODate(), 2), price: 4000 });
  const payment = payments.add({ patient_id: p.id, appointment_id: appointment.id, amount: 1500 });
  assert.equal(patients.get(p.id).balance, 2500);
  payments.remove(payment.id);
  assert.equal(patients.get(p.id).balance, 4000);
});

test('receipt contains clinic, patient and remaining debt', (t) => {
  const ctx = fresh();
  t.after(() => ctx.cleanup());
  settings.setMany({ clinic_name: 'Clinique Sourire', currency: 'DZD' });

  const p = patients.create({ full_name: 'Receipt Patient', phone: '0555111003' });
  const appointment = appointments.create({ patient_id: p.id, day: dates.addDays(dates.toISODate(), 3), price: 6000, notes: 'Contrôle' });
  appointments.updateDetails({ id: appointment.id, treatment_name: 'Détartrage' });
  const payment = payments.add({ patient_id: p.id, appointment_id: appointment.id, amount: 2000 });

  const receipt = reports.receipt(payment.id);
  assert.equal(receipt.clinic.name, 'Clinique Sourire');
  assert.equal(receipt.patient.name, 'Receipt Patient');
  assert.equal(receipt.amount, 2000);
  assert.equal(receipt.remaining_debt, 4000);
  assert.match(receipt.receipt_no, /^\d{6}$/);
});

test('daily report computes income, expenses, net and debts', (t) => {
  const ctx = fresh();
  t.after(() => ctx.cleanup());

  const today = dates.toISODate();
  const p = patients.create({ full_name: 'Report Patient', phone: '0555111004' });
  const appointment = appointments.create({ patient_id: p.id, day: today, price: 8000 });
  payments.add({ patient_id: p.id, appointment_id: appointment.id, amount: 5000 });

  const categories = expenses.categories();
  expenses.create({ category_id: categories[0].id, amount: 1200, day: today, label: 'Gants' });
  expenses.create({ category_id: categories[1].id, amount: 3000, day: today, label: 'Loyer' });

  const report = reports.daily(today);
  assert.equal(report.income, 5000);
  assert.equal(report.expenses, 4200);
  assert.equal(report.net, 800);
  assert.equal(report.unpaid_debts, 3000);
  assert.equal(report.appointments.total, 1);
  assert.equal(report.payments.length, 1);
  assert.equal(report.expenses_detail.length, 2);
  assert.equal(report.expenses_by_category, undefined);

  // A future appointment is not "new patient today" noise.
  assert.equal(report.new_patients, 1);
});

test('monthly report aggregates the series and categories', (t) => {
  const ctx = fresh();
  t.after(() => ctx.cleanup());

  const today = dates.toISODate();
  const month = dates.monthKey(today);
  const p = patients.create({ full_name: 'Month Patient', phone: '0555111005' });
  const appointment = appointments.create({ patient_id: p.id, day: today, price: 9000 });
  payments.add({ patient_id: p.id, appointment_id: appointment.id, amount: 4000 });

  const categories = expenses.categories();
  expenses.create({ category_id: categories[0].id, amount: 2500, day: today });

  const report = reports.monthly(month);
  assert.equal(report.month, month);
  assert.equal(report.income, 4000);
  assert.equal(report.expenses, 2500);
  assert.equal(report.net, 1500);
  assert.ok(report.series.length >= 28);
  assert.equal(report.expenses_by_category.length, 1);
  assert.equal(report.appointments.total, 1);
  const point = report.series.find((row) => row.day === today);
  assert.equal(point.income, 4000);
});
