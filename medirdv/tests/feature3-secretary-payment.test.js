'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const { JSDOM } = require('jsdom');
const { useTempDb } = require('./helpers');

const bot = require('../src/main/whatsapp/bot');
const auth = require('../src/main/services/auth');
const security = require('../src/main/services/security');
const patients = require('../src/main/services/patients');
const departments = require('../src/main/services/departments');
const appointments = require('../src/main/services/appointments');
const payments = require('../src/main/services/payments');
const reports = require('../src/main/services/reports');
const { createHandlers } = require('../src/main/handlers');
const { toISODate, monthKey } = require('../src/main/utils/dates');

test('Feature 3 — Secretary one-click payment confirmation, double-click safety, RBAC & WhatsApp callback rejection, daily/monthly income math & UI button state', async () => {
  const ctx = useTempDb();
  try {
    const today = toISODate();
    const thisMonth = monthKey(today);

    // Setup clinic admin + create secretary, doctor, and nurse users
    auth.setup({ password: 'adminPassword123', confirm: 'adminPassword123' });
    const secUser = security.createUser({
      username: 'sec_amina',
      full_name: 'Amina Secrétaire',
      role: 'secretary',
      password: 'secPassword123',
    });
    const docUser = security.createUser({
      username: 'dr_karim',
      full_name: 'Dr Karim',
      role: 'doctor',
      password: 'docPassword123',
    });
    const nurseUser = security.createUser({
      username: 'inf_sara',
      full_name: 'Sara Infirmière',
      role: 'nurse',
      password: 'nursePassword123',
    });

    const handlers = createHandlers({ version: '2.1.1', dataDir: os.tmpdir(), wa: null, demo: false });

    const deptCardio = departments.create({
      name_fr: 'Cardiologie',
      name_ar: 'طب القلب',
      specialty: 'Cardiologie',
      consultation_fee: 2500,
      daily_capacity: 20,
    });

    const p1 = patients.create({ full_name: 'أحمد بن علي', phone: '0558100001' });
    const p2 = patients.create({ full_name: 'سميرة لعريبي', phone: '0558100002' });
    const p3 = patients.create({ full_name: 'رشيد حمدان', phone: '0558100003' });
    const p4 = patients.create({ full_name: 'مريم بوعلام', phone: '0558100004' });

    // Appointment 1: explicit price = 2000 DA
    const a1 = appointments.create({ patient_id: p1.id, day: today, price: 2000 });
    // Appointment 2: department fee = 2500 DA
    const a2 = appointments.create({ patient_id: p2.id, department_id: deptCardio.id, day: today });
    // Appointment 3: price = 0 (unpriced solo booking -> must ask once, never guess!)
    const a3 = appointments.create({ patient_id: p3.id, day: today, price: 0 });
    // Appointment 4: already paid previously via classic payments.add (1500 DA)
    const a4 = appointments.create({ patient_id: p4.id, day: today, price: 1500 });
    payments.add({ patient_id: p4.id, appointment_id: a4.id, amount: 1500, method: 'cash' });
    assert.equal(appointments.get(a4.id).is_paid, 1, 'Previously settled appointment already marked is_paid=1');

    // 1. Forged WhatsApp callback from a patient (`sec_paid:<a1.id>`) -> REJECTED!
    const forgedBotCb = bot.handle({
      phone: '213558100001',
      text: `sec_paid:${a1.id}`,
      callbackData: `sec_paid:${a1.id}`,
      delivery: 'local',
    });
    assert.equal(forgedBotCb.action, 'forbidden');
    assert.equal(appointments.get(a1.id).is_paid, 0);

    // 2. Unauthorized staff roles (doctor, nurse) or patient role -> REJECTED inside handler & RBAC!
    auth.loginUser({ username: docUser.username, password: 'docPassword123' });
    assert.throws(
      () => auth.requireUnlocked('secretary:confirm-payment'),
      (err) => err.code === 'FORBIDDEN',
    );
    assert.throws(
      () => payments.confirmAppointmentPayment({ appointment_id: a1.id, actor: auth.currentUser() }),
      (err) => err.code === 'FORBIDDEN',
    );

    auth.loginUser({ username: nurseUser.username, password: 'nursePassword123' });
    assert.throws(
      () => payments.confirmAppointmentPayment({ appointment_id: a1.id, actor: auth.currentUser() }),
      (err) => err.code === 'FORBIDDEN',
    );

    // 3. Log in as Secretary (`sec_amina`) -> one-click confirm on `a1` (2000 DA)
    auth.loginUser({ username: secUser.username, password: 'secPassword123' });
    assert.equal(auth.requireUnlocked('secretary:confirm-payment'), true);

    const conf1 = handlers['secretary:confirm-payment']({ appointment_id: a1.id });
    assert.equal(conf1.already_paid, false);
    assert.equal(conf1.payment.amount, 2000);
    assert.equal(conf1.appointment.is_paid, 1);
    assert.equal(conf1.appointment.paid_by, 'sec_amina');
    assert.ok(conf1.appointment.paid_at, 'paid_at timestamp recorded');

    // 4. Double-click / second secretary click on `a1` -> idempotent, ONLY ONE payment recorded!
    const conf1Duplicate = handlers['secretary:confirm-payment']({ appointment_id: a1.id });
    assert.equal(conf1Duplicate.already_paid, true);
    const a1Payments = payments.byPatient(p1.id).filter((row) => row.appointment_id === a1.id);
    assert.equal(a1Payments.length, 1, 'Double-click must never duplicate payment rows');

    // 5. Confirm `a2` (department consultation fee = 2500 DA) in one click
    const conf2 = handlers['secretary:confirm-payment']({ appointment_id: a2.id });
    assert.equal(conf2.already_paid, false);
    assert.equal(conf2.payment.amount, 2500);

    // 6. Unpriced appointment `a3` (price = 0) -> refuses to guess (`AMOUNT_REQUIRED` with `common_amounts`), then records chosen amount (1500 DA)
    assert.throws(
      () => handlers['secretary:confirm-payment']({ appointment_id: a3.id }),
      (err) => err.code === 'AMOUNT_REQUIRED' && Array.isArray(err.details?.common_amounts),
    );
    const conf3 = handlers['secretary:confirm-payment']({ appointment_id: a3.id, amount: 1500 });
    assert.equal(conf3.already_paid, false);
    assert.equal(conf3.payment.amount, 1500);
    assert.equal(appointments.get(a3.id).price, 1500);
    assert.equal(appointments.get(a3.id).is_paid, 1);

    // 7. Verify mathematical exactness in Daily Report, Monthly Report, and Dashboard KPIs:
    //    1500 (a4) + 2000 (a1) + 2500 (a2) + 1500 (a3) = 7500 DA across 4 payments!
    const dailyRep = reports.daily(today);
    assert.equal(dailyRep.income, 7500);
    assert.equal(dailyRep.income_count, 4);

    const monthlyRep = reports.monthly(thisMonth);
    assert.equal(monthlyRep.income, 7500);
    assert.equal(monthlyRep.income_count, 4);

    const dash = handlers['dashboard:today']({ day: today });
    assert.equal(dash.money.income, 7500);

    // 8. Cancelling a paid appointment does NOT delete its income record automatically
    appointments.cancel(a1.id);
    assert.equal(reports.daily(today).income, 7500, 'Income record preserved when a paid appointment is cancelled');

    // 9. Verify UI button rendering & 1-click transition in JSDOM: unpaid shows "✅ تم الدفع", click -> disabled "💰 مدفوع"
    const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
    global.window = dom.window;
    global.document = dom.window.document;
    global.Node = dom.window.Node;
    global.localStorage = dom.window.localStorage;
    global.CustomEvent = dom.window.CustomEvent;
    delete require.cache[require.resolve('../src/renderer/js/i18n')];
    delete require.cache[require.resolve('../src/renderer/js/ui')];
    delete require.cache[require.resolve('../src/renderer/js/components')];
    require('../src/renderer/js/i18n');
    require('../src/renderer/js/ui');
    dom.window.I18N.setLanguage('ar');
    dom.window.API = {
      invoke: async (method, payload) => handlers[method](payload),
    };
    dom.window.App = {
      settings: { currency: 'DZD' },
      bootInfo: { auth: { user: { role: 'secretary', username: 'sec_amina' } } },
    };
    require('../src/renderer/js/components');

    const p5 = patients.create({ full_name: 'وليد قاسي', phone: '0558100005' });
    const unpaidAppt = appointments.create({ patient_id: p5.id, day: today, price: 2000 });
    const unpaidBtn = dom.window.Components.confirmPaymentButton(unpaidAppt, () => {});
    assert.ok(unpaidBtn, 'Unpaid appointment shows button to secretary');
    assert.equal(unpaidBtn.disabled, false);
    assert.match(unpaidBtn.textContent, /✅\s*تم الدفع/);

    // Click the button once -> records 2000 DA (7500 + 2000 = 9500 DA) and changes button to disabled "💰 مدفوع"!
    unpaidBtn.click();
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(unpaidBtn.disabled, true);
    assert.match(unpaidBtn.textContent, /💰\s*مدفوع/);
    assert.equal(reports.daily(today).income, 9500);

    const paidAppt = appointments.get(a2.id);
    const paidBtn = dom.window.Components.confirmPaymentButton(paidAppt, () => {});
    assert.ok(paidBtn);
    assert.equal(paidBtn.disabled, true, 'Already-paid appointment button is disabled (💰 مدفوع)');
    assert.match(paidBtn.textContent, /💰\s*مدفوع/);

    // Doctor role in UI sees NO payment button (`null`)
    dom.window.App.bootInfo.auth.user.role = 'doctor';
    assert.equal(dom.window.Components.confirmPaymentButton(unpaidAppt, () => {}), null);

    delete global.window;
    delete global.document;
    delete global.Node;
    delete global.localStorage;
    delete global.CustomEvent;
  } finally {
    ctx.cleanup();
  }
});
