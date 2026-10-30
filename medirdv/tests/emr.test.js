const test = require('node:test');
const assert = require('node:assert/strict');
const { useTempDb } = require('./helpers');
const patients = require('../src/main/services/patients');
const prescriptions = require('../src/main/services/prescriptions');
const emr = require('../src/main/services/emr');

test('Phase 5 — extended Algerian patient demographics, consultations, vitals trends & secure documents', (t) => {
  useTempDb(t);

  const p = patients.create({
    full_name: 'Khadidja Mansouri',
    phone: '0551223344',
    birth_date: '1988-06-15',
    gender: 'f',
    blood_group: 'A+',
    rh_factor: '+',
    chifa_number: 'CHIFA-160098765',
    nss: '880615016442',
    wilaya: 'Alger',
    commune: 'Hydra',
    occupation: 'Enseignante',
    marital_status: 'Mariée',
    emergency_contact_name: 'Karim Mansouri',
    emergency_contact_phone: '0551998877',
  });
  assert.equal(p.chifa_number, 'CHIFA-160098765');
  assert.equal(p.wilaya, 'Alger');

  // Search by Chifa number
  const byChifa = patients.list('160098765');
  assert.equal(byChifa.length, 1);
  assert.equal(byChifa[0].id, p.id);

  // Structured consultation with auto-BMI and BP parsing
  const c1 = emr.createConsultation({
    patient_id: p.id,
    day: '2026-10-01',
    chief_complaint: 'Céphalées occipitales',
    physical_exam: 'Bruits du cœur réguliers',
    assessment: 'HTA grade 1',
    plan: 'Mesures hygiéno-diététiques + contrôle',
    vitals_bp: '150/95',
    vitals_glycemia: 1.18,
    weight_kg: 72,
    height_cm: 165,
  });
  assert.equal(c1.vitals_bp_sys, 150);
  assert.equal(c1.vitals_bp_dia, 95);
  assert.equal(c1.bmi, 26.4);

  prescriptions.create({
    patient_id: p.id,
    day: '2026-10-15',
    vitals_bp: '132/84',
    vitals_glycemia: '1,02',
    items: [{ drug_name: 'AMLOZEK', dci: 'Amlodipine', dosage: '1 cp/j', duration: '1 mois' }],
  });

  const trends = emr.vitalsTrends(p.id);
  assert.equal(trends.bp.length, 2);
  assert.equal(trends.bp[0].sys, 150);
  assert.equal(trends.bp[1].sys, 132);
  assert.equal(trends.glycemia.length, 2);

  // Secure document attachment: block dangerous extensions, allow PDF
  assert.throws(
    () =>
      emr.attachDocument({
        patient_id: p.id,
        filename: 'malware.exe',
        data_base64: Buffer.from('MZ').toString('base64'),
      }),
    (err) => err.code === 'UNSUPPORTED_FILE_TYPE',
  );

  const pdfPayload = Buffer.from('%PDF-1.4 sample lab report').toString('base64');
  const doc = emr.attachDocument({
    patient_id: p.id,
    category: 'lab',
    title: 'Bilan rénal Octobre',
    filename: 'bilan.pdf',
    data_base64: pdfPayload,
  });
  assert.equal(doc.mime_type, 'application/pdf');
  const readBack = emr.readDocument(doc.id);
  assert.match(readBack.data_url, /^data:application\/pdf;base64,/);

  emr.removeDocument(doc.id);
  assert.equal(emr.listDocuments(p.id).length, 0);
});

test('Phase 5 — labs abnormal flags & trends, imaging, Algerian PEV vaccines, pregnancy DDR->DPA, WHO growth & timeline', (t) => {
  useTempDb(t);

  const mother = patients.create({
    full_name: 'Amina Boudiaf',
    phone: '0552334455',
    birth_date: '1995-02-20',
    gender: 'f',
  });

  // Lab order & longitudinal HbA1c trend with abnormal flag
  const order = emr.createLabOrder({
    patient_id: mother.id,
    day: '2026-08-10',
    fasting_required: true,
    requested_tests: 'HbA1c + Glycémie',
    results: [
      { analyte_code: 'HBA1C', analyte_label: 'HbA1c', value_num: 8.2, unit: '%', ref_min: 4.0, ref_max: 6.5 },
    ],
  });
  assert.equal(order.status, 'completed');
  assert.equal(order.results[0].abnormal_flag, 'high');

  emr.addLabResult({
    patient_id: mother.id,
    day: '2026-10-20',
    analyte_code: 'HBA1C',
    analyte_label: 'HbA1c',
    value_num: 6.3,
    unit: '%',
    ref_min: 4.0,
    ref_max: 6.5,
  });

  const labs = emr.listLabs(mother.id);
  assert.equal(labs.trends.length, 1);
  assert.equal(labs.trends[0].points.length, 2);
  assert.equal(labs.trends[0].points[0].abnormal_flag, 'high');
  assert.equal(labs.trends[0].points[1].abnormal_flag, '');

  // Imaging order
  const img = emr.createImagingOrder({
    patient_id: mother.id,
    day: '2026-10-21',
    modality: 'echo',
    body_region: 'Pelvienne obstétricale',
    findings: 'Grossesse évolutive monofœtale',
  });
  assert.equal(img.status, 'completed');

  // Pregnancy follow-up (DDR -> DPA +280 days & gestational weeks)
  const preg = emr.createPregnancyEpisode({
    patient_id: mother.id,
    ddr: '2026-06-01',
    gravida: 2,
    para: 1,
  });
  assert.equal(preg.dpa, '2027-03-08');

  const visit = emr.addPregnancyVisit({
    episode_id: preg.id,
    day: '2026-09-14', // 105 days = 15.0 SA
    weight_kg: 66.5,
    bp: '115/75',
    fetal_hr: 146,
  });
  assert.equal(visit.gestational_weeks, 15);

  // Pediatric patient: Algerian PEV vaccination schedule + WHO growth percentiles
  const baby = patients.create({
    full_name: 'Rayan Boudiaf',
    birth_date: '2025-10-15',
    gender: 'm',
    legal_guardian_name: 'Amina Boudiaf',
    legal_guardian_phone: '0552334455',
  });

  const vacBefore = emr.listVaccinations(baby.id);
  assert.ok(vacBefore.due.some((v) => v.vaccine_code === 'BCG_HB0'));

  emr.recordVaccination({
    patient_id: baby.id,
    vaccine_code: 'BCG_HB0',
    vaccine_name: 'BCG + Hépatite B (naissance)',
    administered_day: '2025-10-16',
    lot_number: 'LOT-DZ-01',
  });
  const vacAfter = emr.listVaccinations(baby.id);
  assert.ok(!vacAfter.due.some((v) => v.vaccine_code === 'BCG_HB0'));

  const who = emr.computeWhoGrowth({ gender: 'm', age_months: 12, weight_kg: 9.6, height_cm: 75.7 });
  assert.equal(who.weight_z, 0);
  assert.equal(who.weight_percentile, 50);
  assert.equal(who.weight_alert, 'normal');

  // Unified chronological timeline
  const timeline = emr.patientTimeline(mother.id);
  assert.ok(timeline.some((e) => e.kind === 'lab'));
  assert.ok(timeline.some((e) => e.kind === 'imaging'));
});
