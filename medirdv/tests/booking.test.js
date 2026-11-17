'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { useTempDb } = require('./helpers');
const settings = require('../src/main/services/settings');
const patients = require('../src/main/services/patients');
const appointments = require('../src/main/services/appointments');
const treatments = require('../src/main/services/treatments');
const dates = require('../src/main/utils/dates');

const ctx = useTempDb();
const expectCode = (fn, code) => {
  assert.throws(fn, (error) => {
    assert.equal(error.code, code, `expected ${code}, got ${error.code}`);
    return true;
  });
};
test.after(() => ctx.cleanup());

// Open every day, small capacity: deterministic whatever the real date is.
settings.setMany({ working_days: '0,1,2,3,4,5,6', daily_capacity: '3', booking_horizon_days: '10' });
const today = dates.toISODate();
const tomorrow = dates.addDays(today, 1);

function patient(name, phone) {
  return patients.create({ full_name: name, phone });
}

test('books the first free day and assigns compact queue numbers', () => {
  const day = appointments.findNextFreeDay({ allowSameDay: false });
  assert.equal(day, tomorrow);

  const p1 = patient('Patient One', '0555000001');
  const p2 = patient('Patient Two', '0555000002');
  const a1 = appointments.create({ patient_id: p1.id });
  const a2 = appointments.create({ patient_id: p2.id });

  assert.equal(a1.day, tomorrow);
  assert.equal(a1.queue_number, 1);
  assert.equal(a2.queue_number, 2);
});

test('rejects a full day and skips it when looking for the next slot', () => {
  const p3 = patient('Patient Three', '0555000003');
  appointments.create({ patient_id: p3.id }); // third slot of tomorrow
  expectCode(() => {
    const p4 = patient('Patient Four', '0555000004');
    appointments.create({ patient_id: p4.id, day: tomorrow });
  }, 'DAY_FULL');

  const next = appointments.findNextFreeDay({ allowSameDay: false });
  assert.equal(next, dates.addDays(today, 2));
});

test('cancelling frees the queue number and the slot', () => {
  const agenda = appointments.agenda(tomorrow);
  const second = agenda.find((row) => row.queue_number === 2);
  appointments.cancel(second.id);

  assert.equal(appointments.nextQueueNumber(tomorrow), 2);
  assert.equal(appointments.dayInfo(tomorrow).left, 1);
});

test('prevents double booking the same patient on the same day', () => {
  const p = patient('Patient Double', '0555000005');
  const day = dates.addDays(today, 3);
  appointments.create({ patient_id: p.id, day });
  expectCode(() => appointments.create({ patient_id: p.id, day }), 'ALREADY_BOOKED');
});

test('refuses past dates and non-working days', () => {
  const p = patient('Patient Past', '0555000006');
  expectCode(
    () => appointments.create({ patient_id: p.id, day: dates.addDays(today, -1) }),
    'DATE_IN_PAST',
  );

  settings.setMany({ working_days: '0' }); // Sundays only
  // Find a day that is not a Sunday.
  let probe = dates.addDays(today, 1);
  while (dates.weekday(probe) === 0) probe = dates.addDays(probe, 1);
  expectCode(() => appointments.create({ patient_id: p.id, day: probe }), 'NOT_WORKING_DAY');
  settings.setMany({ working_days: '0,1,2,3,4,5,6' });
});

test('reports HORIZON_REACHED when every bookable day is full', () => {
  settings.setMany({ daily_capacity: '1', booking_horizon_days: '1', allow_same_day_booking: '0' });
  const dayA = dates.addDays(today, 1);
  const dayB = dates.addDays(today, 2);
  // Clear previous bookings that could interfere.
  for (const appt of appointments.listRange(dayA, dayB)) appointments.cancel(appt.id);
  const p1 = patient('Horizon A', '0555000007');
  const p2 = patient('Horizon B', '0555000008');
  appointments.create({ patient_id: p1.id, day: dayA });
  appointments.create({ patient_id: p2.id, day: dayB });
  assert.equal(appointments.findNextFreeDay({ allowSameDay: false }), null);
  const p3 = patient('Horizon C', '0555000009');
  expectCode(() => appointments.create({ patient_id: p3.id }), 'HORIZON_REACHED');
  settings.setMany({ daily_capacity: '8', booking_horizon_days: '30' });
});

test('applies the catalog price and keeps a per-appointment price copy', () => {
  const catalog = treatments.list();
  const treatment = catalog[0];
  const p = patient('Patient Price', '0555000010');
  const day = dates.addDays(today, 4);
  const appointment = appointments.create({ patient_id: p.id, day, treatment_id: treatment.id });
  assert.equal(appointment.price, treatment.default_price);

  const custom = appointments.create({
    patient_id: patient('Patient Custom', '0555000011').id,
    day,
    treatment_id: treatment.id,
    price: 1234,
  });
  assert.equal(custom.price, 1234);

  treatments.update({ id: treatment.id, name_fr: treatment.name_fr, name_ar: treatment.name_ar, default_price: 99999 });
  assert.equal(appointments.get(custom.id).price, 1234, 'history must not change');
});

test('reschedule moves the patient and re-assigns the queue', () => {
  const p = patient('Patient Move', '0555000012');
  const from = dates.addDays(today, 5);
  const to = dates.addDays(today, 6);
  const appointment = appointments.create({ patient_id: p.id, day: from });
  const moved = appointments.reschedule({ id: appointment.id, day: to });
  assert.equal(moved.day, to);
  assert.equal(moved.queue_number, 1);
  assert.equal(appointments.agenda(from).length, 0);
});

test('history is a historical import and ignores capacity', () => {
  const p = patient('Patient History', '0555000013');
  const oldDay = dates.addDays(today, -30);
  const appointment = appointments.create({ patient_id: p.id, day: oldDay, historical: true, price: 3000 });
  appointments.setStatus(appointment.id, 'done');
  assert.equal(patients.history(p.id).length, 1);
  assert.equal(patients.history(p.id)[0].balance, 3000);
});
