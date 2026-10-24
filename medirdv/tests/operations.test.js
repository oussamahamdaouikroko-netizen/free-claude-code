const test = require('node:test');
const assert = require('node:assert/strict');
const { useTempDb } = require('./helpers');
const settings = require('../src/main/services/settings');
const departments = require('../src/main/services/departments');
const patients = require('../src/main/services/patients');
const treatments = require('../src/main/services/treatments');
const appointments = require('../src/main/services/appointments');
const operations = require('../src/main/services/operations');
const expenses = require('../src/main/services/expenses');
const bot = require('../src/main/whatsapp/bot');
const dates = require('../src/main/utils/dates');

test('Phase 8 — per-department time-slot mode alongside queue mode & Algerian fixed + lunar holidays', (t) => {
  useTempDb(t);
  settings.setMany({ working_days: '0,1,2,3,4,5,6', booking_horizon_days: '30' });

  const cardioSlots = departments.create({
    name_fr: 'Cardiologie (Créneaux)',
    name_ar: 'طب القلب',
    scheduling_mode: 'slots',
    slot_start_time: '09:00',
    slot_end_time: '10:30',
    slot_duration_min: 30,
    daily_capacity: 10,
    working_days: '0,1,2,3,4,5,6',
    equipment_list: 'ECG 12 dérivations, Écho-Doppler',
  });
  const genQueue = departments.create({
    name_fr: 'Médecine Générale (File)',
    name_ar: 'طب عام',
    scheduling_mode: 'queue',
    daily_capacity: 10,
    working_days: '0,1,2,3,4,5,6',
  });

  const day = dates.addDays(dates.toISODate(), 2);
  const avail0 = operations.availableSlots(day, cardioSlots.id);
  assert.equal(avail0.mode, 'slots');
  assert.deepEqual(
    avail0.slots.map((s) => s.time),
    ['09:00', '09:30', '10:00'],
  );

  const p1 = patients.create({ full_name: 'Amine Benali', phone: '0550111222' });
  const p2 = patients.create({ full_name: 'Nadia Cherif', phone: '0661222333' });
  const p3 = patients.create({ full_name: 'Samir Kaci', phone: '0772333444' });

  const a1 = appointments.create({ patient_id: p1.id, day, department_id: cardioSlots.id });
  const a2 = appointments.create({ patient_id: p2.id, day, department_id: cardioSlots.id });
  assert.equal(a1.slot_time, '09:00');
  assert.equal(a2.slot_time, '09:30');

  assert.throws(
    () => appointments.create({ patient_id: p3.id, day, department_id: cardioSlots.id, slot_time: '09:00' }),
    (e) => e.code === 'SLOT_TAKEN',
  );

  // Queue mode department stays pure queue without slot_time
  const qAppt = appointments.create({ patient_id: p1.id, day, department_id: genQueue.id });
  assert.equal(qAppt.slot_time, '');
  assert.equal(qAppt.queue_number, 1);

  // Algerian fixed national holidays + admin-set lunar holiday (Aïd El-Fitr)
  const seeded = operations.seedAlgerianHolidays(2027);
  assert.equal(seeded.inserted, 5);
  assert.equal(departments.isWorkingDay(genQueue.id, '2027-01-12'), false); // Yennayer
  assert.equal(departments.isWorkingDay(genQueue.id, '2027-11-01'), false); // 1er Novembre

  const closedTomorrow = dates.addDays(dates.toISODate(), 1);
  operations.addClosure({
    start_day: closedTomorrow,
    end_day: closedTomorrow,
    kind: 'holiday_lunar',
    label_fr: 'Aïd El-Fitr',
    label_ar: 'عيد الفطر المبارك',
  });
  assert.throws(
    () => appointments.create({ patient_id: p3.id, day: closedTomorrow, department_id: genQueue.id }),
    (e) => e.code === 'NOT_WORKING_DAY',
  );
  // findNextFreeDay automatically skips closedTomorrow and lands on `day` (+2)
  assert.equal(appointments.findNextFreeDay({ allowSameDay: false, departmentId: genQueue.id }), day);
});

test('Phase 8 — urgent priority, privacy-safe waiting-room board, WhatsApp CONFIRMER/تأكيد & no-show stats', (t) => {
  useTempDb(t);
  settings.setMany({ working_days: '0,1,2,3,4,5,6' });
  const day = dates.addDays(dates.toISODate(), 1);

  const pNormal = patients.create({ full_name: 'Karim Mansouri', phone: '0551000111' });
  const pUrgent = patients.create({ full_name: 'Leila Boudiaf', phone: '0551000222' });
  const pNoShow = patients.create({ full_name: 'Yacine Saadi', phone: '0551000333' });

  const ap1 = appointments.create({ patient_id: pNormal.id, day, priority: 'normal' });
  const ap2 = appointments.create({ patient_id: pUrgent.id, day, priority: 'urgent' });
  const ap3 = appointments.create({ patient_id: pNoShow.id, day, priority: 'walk_in' });

  // Queue numbers stay compact & never renumbered, while urgent moves to position 1 on waiting-room board
  assert.equal(ap1.queue_number, 1);
  assert.equal(ap2.queue_number, 2);

  const board = operations.waitingRoomBoard(day);
  assert.equal(board[0].appointment_id, ap2.id);
  assert.equal(board[0].priority, 'urgent');
  assert.equal(board[0].initials, 'L. B.'); // Law 18-07 privacy-safe initials (no full name)

  // WhatsApp Arabic confirmation reply ("تأكيد") marks appointment confirmed
  const waConfirm = bot.handle({ phone: '0551000111', text: 'تأكيد', delivery: 'local' });
  assert.equal(waConfirm.action, 'confirmed');
  assert.equal(appointments.get(ap1.id).confirmation_status, 'confirmed');

  // Mark ap3 as no_show and verify no-show statistics
  appointments.setStatus(ap3.id, 'no_show');
  const stats = operations.noShowStats({ start: day, end: day });
  assert.equal(stats.total, 3);
  assert.equal(stats.no_show, 1);
  assert.equal(stats.confirmed, 1);
  assert.equal(stats.no_show_rate_pct, 33.3);
});

test('Phase 8 — medical inventory alerts, auto-consumption per act, rooms/equipment & HR payroll -> expenses', (t) => {
  useTempDb(t);
  settings.setMany({ working_days: '0,1,2,3,4,5,6' });
  const today = dates.toISODate();

  // Rooms & equipment
  const room = operations.upsertRoom({
    name: 'Salle d’échographie 2',
    equipment: 'Sonde convexe 3.5MHz, Imprimante thermique',
    status: 'available',
  });
  assert.equal(operations.listRooms().length, 1);
  assert.equal(room.status, 'available');

  // Inventory + expiry & low-stock alerts + auto-deduction when appointment completed
  const syringes = operations.upsertInventoryItem({
    sku: 'SYR-5ML',
    name_fr: 'Seringues stériles 5ml',
    name_ar: 'حقن معقمة 5 مل',
    unit: 'pièce',
    quantity: 6,
    min_threshold: 5,
    expiry_day: dates.addDays(today, 10),
    supplier_name: 'Biopharm Dispositifs',
  });
  const act = treatments.create({ name_fr: 'Injection IM', name_ar: 'حقن عضلي', default_price: 500 });
  operations.setTreatmentConsumables(act.id, [{ item_id: syringes.id, qty_per_act: 2 }]);

  const pat = patients.create({ full_name: 'Farid Toumi', phone: '0559887766' });
  const appt = appointments.create({ patient_id: pat.id, day: dates.addDays(today, 1), treatment_id: act.id });
  appointments.setStatus(appt.id, 'done');

  const alerts = operations.inventoryAlerts(today);
  assert.equal(alerts.low_stock.length, 1); // 6 - 2 = 4 <= min_threshold (5)
  assert.equal(alerts.low_stock[0].quantity, 4);
  assert.equal(alerts.expiring.length, 1); // expires in 10 days (<= 30)

  // Staff + attendance + payroll -> creates linked 'salaries' expense
  const nurse = operations.upsertStaff({
    full_name: 'Amina Bouzid',
    role_title: 'Infirmière diplômée',
    monthly_salary: 48000,
    hire_day: '2025-01-15',
  });
  operations.recordAttendance({ staff_id: nurse.id, day: today, status: 'present', check_in: '08:05' });
  assert.equal(operations.listAttendance(today).length, 1);

  const pay = operations.runPayroll({
    staff_id: nurse.id,
    period_month: today.slice(0, 7),
    bonus: 2000,
    deductions: 0,
    paid_day: today,
  });
  assert.equal(pay.net_paid, 50000);
  assert.ok(pay.expense_id > 0);

  const dayExpenses = expenses.list({ start: today, end: today });
  const salaryExp = dayExpenses.find((e) => e.id === pay.expense_id);
  assert.ok(salaryExp);
  assert.equal(salaryExp.category_key, 'salaries');
  assert.equal(salaryExp.amount, 50000);
});
