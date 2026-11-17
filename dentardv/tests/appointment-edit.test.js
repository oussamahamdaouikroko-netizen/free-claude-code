'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { useTempDb } = require('./helpers');
const settings = require('../src/main/services/settings');
const patients = require('../src/main/services/patients');
const appointments = require('../src/main/services/appointments');
const payments = require('../src/main/services/payments');
const treatments = require('../src/main/services/treatments');
const dates = require('../src/main/utils/dates');

function fresh() {
  const ctx = useTempDb();
  settings.setMany({ working_days: '0,1,2,3,4,5,6', daily_capacity: '10', booking_horizon_days: '30' });
  return ctx;
}

test('the price of an appointment can be adjusted after booking', (t) => {
  const ctx = fresh();
  t.after(() => ctx.cleanup());

  const catalog = treatments.list();
  const p = patients.create({ full_name: 'Edit Price', phone: '0555333001' });
  const appointment = appointments.create({
    patient_id: p.id,
    day: dates.addDays(dates.toISODate(), 1),
    treatment_id: catalog[0].id,
  });
  assert.equal(appointment.price, catalog[0].default_price);

  const updated = appointments.updateDetails({ id: appointment.id, price: 7500 });
  assert.equal(updated.price, 7500);
  assert.equal(updated.treatment_name, catalog[0].name_fr, 'treatment name is preserved');

  // Changing the treatment without a price picks the new default price.
  const switched = appointments.updateDetails({
    id: appointment.id,
    treatment_id: catalog[2].id,
  });
  assert.equal(switched.price, catalog[2].default_price);
  assert.equal(switched.treatment_name, catalog[2].name_fr);
});

test('the price cannot drop below what was already collected', (t) => {
  const ctx = fresh();
  t.after(() => ctx.cleanup());

  const p = patients.create({ full_name: 'Paid Patient', phone: '0555333002' });
  const appointment = appointments.create({
    patient_id: p.id,
    day: dates.addDays(dates.toISODate(), 2),
    price: 6000,
  });
  payments.add({ patient_id: p.id, appointment_id: appointment.id, amount: 4000 });

  assert.throws(
    () => appointments.updateDetails({ id: appointment.id, price: 3000 }),
    (error) => error.code === 'PRICE_BELOW_PAID',
  );
  assert.equal(appointments.updateDetails({ id: appointment.id, price: 4000 }).price, 4000);
});

test('waiting-list entries are created and can be handled', (t) => {
  const ctx = fresh();
  t.after(() => ctx.cleanup());

  appointments.addToWaitingList({ full_name: 'Waiting One', phone: '0555333003', note: 'matin' });
  appointments.addToWaitingList({ full_name: 'Waiting Two', phone: '0555333004' });
  assert.equal(appointments.waitingList().length, 2);

  appointments.markWaitingHandled(appointments.waitingList()[0].id);
  assert.equal(appointments.waitingList().length, 1);
  assert.equal(appointments.waitingList()[0].full_name, 'Waiting Two');
});
