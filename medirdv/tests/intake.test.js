'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { useTempDb } = require('./helpers');
const intake = require('../src/main/services/intake');
const patients = require('../src/main/services/patients');
const appointments = require('../src/main/services/appointments');
const settings = require('../src/main/services/settings');
const bot = require('../src/main/whatsapp/bot');
const { createHandlers } = require('../src/main/handlers');

function setupClinic() {
  const ctx = useTempDb();
  settings.setMany({
    clinic_name: 'Clinique El Chifa',
    working_days: '0,1,2,3,4,5,6',
    daily_capacity: '20',
    booking_horizon_days: '14',
  });
  return ctx;
}

test('Phase 1 — weight and height parsers handle Arabic numerals, commas, units and range bounds', () => {
  assert.deepEqual(intake.parseWeightKg('72'), { ok: true, value: 72 });
  assert.deepEqual(intake.parseWeightKg('72kg'), { ok: true, value: 72 });
  assert.deepEqual(intake.parseWeightKg('72,5 kg'), { ok: true, value: 72.5 });
  assert.deepEqual(intake.parseWeightKg('٧٢'), { ok: true, value: 72 });
  assert.deepEqual(intake.parseWeightKg('٧٢٫٥ كغ'), { ok: true, value: 72.5 });
  assert.deepEqual(intake.parseWeightKg('0.35'), { ok: true, value: 0.35 });

  assert.equal(intake.parseWeightKg('0.1').ok, false);
  assert.equal(intake.parseWeightKg('450').ok, false);
  assert.equal(intake.parseWeightKg('-12').ok, false);
  assert.equal(intake.parseWeightKg('beaucoup').ok, false);

  assert.deepEqual(intake.parseHeightCm('170 cm'), { ok: true, value: 170 });
  assert.deepEqual(intake.parseHeightCm('١٦٥ سم'), { ok: true, value: 165 });
  assert.deepEqual(intake.parseHeightCm('1,72 m'), { ok: true, value: 172 });
  assert.equal(intake.parseHeightCm('20').ok, false);
  assert.equal(intake.parseHeightCm('290').ok, false);

  assert.equal(intake.computeBmi(72, 170), 24.9);
});

test('Phase 1 — Law 18-07 consent required & unverified data never touches patient file until Confirm & apply', (t) => {
  const ctx = setupClinic();
  t.after(() => ctx.cleanup());

  const p = patients.create({
    full_name: 'Nadia Benali',
    phone: '0551223344',
    gender: 'f',
    birth_date: '1992-05-10',
    allergies: 'Aspirine',
    chronic_conditions: 'HTA',
  });
  const appt = appointments.create({ patient_id: p.id, notes: 'Consultation générale' });

  // Missing consent must throw INTAKE_CONSENT_REQUIRED
  assert.throws(
    () => intake.create({ patient_id: p.id, weight_kg: 68 }),
    (err) => err.code === 'INTAKE_CONSENT_REQUIRED',
  );

  // Create pending intake with explicit consent
  const draft = intake.create({
    patient_id: p.id,
    appointment_id: appt.id,
    source: 'manual',
    consent: true,
    weight_kg: 68,
    height_cm: 164,
    chief_complaint: 'Toux sèche persistante',
    symptom_duration: '5 jours',
    known_allergies: 'Pénicilline',
    chronic_conditions: 'Insuffisance rénale modérée',
    is_pregnant: 1,
  });

  assert.equal(draft.status, 'pending');
  assert.equal(draft.unverified, true);
  assert.equal(draft.bmi, 25.3);
  const alertCodes = draft.alerts.map((a) => a.code);
  assert.ok(alertCodes.includes('REPORTED_ALLERGY'));
  assert.ok(alertCodes.includes('PREGNANCY'));
  assert.ok(alertCodes.includes('CHRONIC_KIDNEY_DISEASE'));

  // Patient file MUST still hold ONLY the doctor's original verified values
  const untouched = patients.get(p.id);
  assert.equal(untouched.allergies, 'Aspirine');
  assert.equal(untouched.chronic_conditions, 'HTA');
  assert.equal(intake.weightHistory(p.id).length, 0);

  // Agenda row exposes intake badge summary
  const agendaRows = appointments.agenda(appt.day);
  const row = agendaRows.find((r) => r.id === appt.id);
  assert.equal(row.intake_id, draft.id);
  assert.equal(row.intake_status, 'pending');
  assert.equal(row.intake_weight_kg, 68);

  // Doctor clicks "Confirm & apply" -> merges (never overwrites!) & records weight history
  const confirmed = intake.confirmAndApply(draft.id, { reviewed_by: 'Dr Amrani' });
  assert.equal(confirmed.intake.status, 'applied');
  assert.equal(confirmed.intake.unverified, false);
  assert.match(confirmed.patient.allergies, /Aspirine/);
  assert.match(confirmed.patient.allergies, /Pénicilline/);
  assert.match(confirmed.patient.chronic_conditions, /HTA/);
  assert.match(confirmed.patient.chronic_conditions, /Insuffisance rénale modérée/);

  const wh = intake.weightHistory(p.id);
  assert.equal(wh.length, 1);
  assert.equal(wh[0].weight_kg, 68);

  const updatedAppt = appointments.get(appt.id);
  assert.match(updatedAppt.notes, /Consultation générale/);
  assert.match(updatedAppt.notes, /Toux sèche persistante/);
});

test('Phase 1 — Reject leaves verified patient medical record untouched', (t) => {
  const ctx = setupClinic();
  t.after(() => ctx.cleanup());

  const p = patients.create({ full_name: 'Farid Toumi', phone: '0552110099', allergies: '' });
  const draft = intake.create({
    patient_id: p.id,
    consent: true,
    known_allergies: 'Erreur test',
    weight_kg: 81,
  });
  const rej = intake.reject(draft.id, { reviewed_by: 'Dr Amrani' });
  assert.equal(rej.status, 'rejected');
  assert.equal(patients.get(p.id).allergies, '');
  assert.equal(intake.weightHistory(p.id).length, 0);
});

test('Phase 1 — French WhatsApp streamlined intake: Age + Weight + Optional Symptoms only (no height/allergies)', (t) => {
  const ctx = setupClinic();
  t.after(() => ctx.cleanup());

  const phone = '213556001122';
  const booked = bot.handle({ phone, text: 'Sami Meziane' });
  assert.equal(booked.action, 'booked');
  assert.match(booked.reply, /Loi 18-07/);
  assert.doesNotMatch(booked.reply, /allergie|pénicilline|taille/i);

  // Consent OUI -> creates pending row and asks Age (1/3)
  const q1 = bot.handle({ phone, text: 'OUI' });
  assert.equal(q1.action, 'intake_started');
  assert.match(q1.reply, /âge/i);

  // Invalid age -> gentle retry once
  const retryAge = bot.handle({ phone, text: 'abc' });
  assert.equal(retryAge.action, 'intake_retry_age');

  // Valid age -> asks Weight (2/3)
  const q2 = bot.handle({ phone, text: '34 ans' });
  assert.equal(q2.action, 'intake_ask_weight');
  assert.match(q2.reply, /poids/i);

  // Invalid weight -> gentle retry once
  const retryWeight = bot.handle({ phone, text: 'abc' });
  assert.equal(retryWeight.action, 'intake_retry_weight');

  // Valid comma weight -> asks Optional Symptoms (3/3) — NO height question!
  const q3 = bot.handle({ phone, text: '74,5 kg' });
  assert.equal(q3.action, 'intake_ask_complaint');
  assert.doesNotMatch(q3.reply, /taille|cm|pénicilline|allergie/i);

  // CORRIGER restarts cleanly at Age
  const restarted = bot.handle({ phone, text: 'CORRIGER' });
  assert.equal(restarted.action, 'intake_restarted');
  bot.handle({ phone, text: '35' });
  bot.handle({ phone, text: '75' });

  // Optional symptoms -> finishes immediately without extra duration/meds/allergies/chronic/pregnancy questions!
  const done = bot.handle({ phone, text: 'Fièvre et maux de gorge' });
  assert.equal(done.action, 'intake_completed');
  assert.equal(done.intake.age_years, 35);
  assert.equal(done.intake.weight_kg, 75);
  assert.equal(done.intake.height_cm, null);
  assert.equal(done.intake.chief_complaint, 'Fièvre et maux de gorge');
  assert.equal(done.intake.status, 'pending');
  assert.match(done.reply, /35 ans/);
  assert.match(done.reply, /75 kg/);
});

test('Phase 1 — Arabic WhatsApp streamlined intake (direct age fast-path, skip symptoms, child alert & 30-min timeout)', (t) => {
  const ctx = setupClinic();
  t.after(() => ctx.cleanup());

  // 1. Arabic patient books and replies directly with Age ("٢٩ سنة"), Weight, and skips optional symptoms ("لا")
  const phoneF = '213661112233';
  const bookedAr = bot.handle({ phone: phoneF, text: 'سارة بوعلام' });
  assert.equal(bookedAr.action, 'booked');
  assert.doesNotMatch(bookedAr.reply, /البنسلين|حساسية|الطول/);

  const askWeight = bot.handle({ phone: phoneF, text: '٢٩ سنة' });
  assert.equal(askWeight.action, 'intake_ask_weight');
  assert.match(askWeight.reply, /وزن/);

  const askSymptoms = bot.handle({ phone: phoneF, text: '٦٤٫٥ كغ' });
  assert.equal(askSymptoms.action, 'intake_ask_complaint');
  assert.doesNotMatch(askSymptoms.reply, /الطول|البنسلين|حساسية/);

  const finAr = bot.handle({ phone: phoneF, text: 'لا' });
  assert.equal(finAr.action, 'intake_completed');
  assert.equal(finAr.intake.age_years, 29);
  assert.equal(finAr.intake.weight_kg, 64.5);
  assert.equal(finAr.intake.chief_complaint, '');

  // Confirm & apply writes approximate birth year & pre-fills prescription age + weight
  const applied = intake.confirmAndApply(finAr.intake.id, { reviewed_by: 'Dr Amrani' });
  assert.ok(applied.patient.birth_date, 'approximate birth year stored on confirm');
  assert.equal(applied.prescription_prefill.patient_age, '29 ans');
  assert.equal(applied.prescription_prefill.patient_weight, '64.5 kg');

  // 2. Child (< 15 yrs, birth_date overrides reported age) & partial persistence on 30-min timeout
  const child = patients.create({
    full_name: 'Yanis Khelifi',
    phone: '0771223344',
    gender: 'f',
    birth_date: '2021-06-01', // ~5 years old -> child wording
  });
  assert.equal(intake.shouldAskPregnancy(child, 25), false, 'birth_date age overrides reported age');

  appointments.create({ patient_id: child.id });
  const phoneC = '213771223344';
  bot.handle({ phone: phoneC, text: 'fiche' });
  const startChild = bot.handle({ phone: phoneC, text: 'oui' });
  assert.match(startChild.reply, /enfant/i);
  bot.handle({ phone: phoneC, text: '5 ans' });
  bot.handle({ phone: phoneC, text: '13.8 kg' }); // < 15 kg -> triggers CHILD_UNDER_15KG alert!

  // Simulate 30-minute timeout mid-flow -> partial answer (5 ans, 13.8 kg) still persisted!
  bot.expirePendingForTest(phoneC);
  const savedPartial = intake.latestPendingForPatient(child.id);
  assert.ok(savedPartial);
  assert.equal(savedPartial.age_years, 5);
  assert.equal(savedPartial.weight_kg, 13.8);
  assert.ok(savedPartial.alerts.some((a) => a.code === 'CHILD_UNDER_15KG'));

  // IPC handler round-trip check
  const handlers = createHandlers({ version: '2.1.0', dataDir: ctx.dir });
  const viaIpc = handlers['intake:get']({ id: savedPartial.id });
  assert.equal(viaIpc.weight_kg, 13.8);
});
