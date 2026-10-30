const test = require('node:test');
const assert = require('node:assert/strict');
const { useTempDb } = require('./helpers');
const { getDb } = require('../src/main/db');
const diagnoses = require('../src/main/services/diagnoses');
const prescriptions = require('../src/main/services/prescriptions');
const patients = require('../src/main/services/patients');
const departments = require('../src/main/services/departments');

test('Phase 4 — ICD-10 (CIM-10) FTS5 search in FR/AR, CSV & JSON importer, and verification', (t) => {
  useTempDb(t);
  const db = getDb();

  const summary0 = diagnoses.icd10Summary(db);
  assert.ok(summary0.total >= 30, 'starter ICD-10 codes seeded');
  assert.ok(summary0.ald_count >= 8, 'chronic ALD codes seeded');
  assert.ok(summary0.notifiable_count >= 6, 'Algerian MDO notifiable codes seeded');
  assert.equal(summary0.verified_count, 0, 'starter codes default to verified = 0');

  // Search by code, French accent-insensitive text, and Arabic text
  const byCode = diagnoses.searchIcd10(db, { query: 'I10' });
  assert.equal(byCode[0].code, 'I10');
  assert.equal(byCode[0].is_chronic_ald, 1);

  const byFr = diagnoses.searchIcd10(db, { query: 'diabete type 2' });
  assert.ok(byFr.some((r) => r.code === 'E11.9'));

  const byAr = diagnoses.searchIcd10(db, { query: 'الحصبة' });
  assert.ok(byAr.some((r) => r.code === 'B05.9' && r.is_notifiable === 1));

  // CSV import
  const csv = [
    'code;libelle_fr;libelle_ar;chapitre;ald;mdo',
    'K80.2;Lithiase vésiculaire sans cholécystite;حصى المرارة;XI - Appareil digestif;non;non',
    'A39.0;Méningite à méningocoques;التهاب السحايا بالمكورات السحائية;I - Maladies infectieuses;non;oui',
  ].join('\n');
  const csvRes = diagnoses.importIcd10(db, { format: 'csv', content: csv, markVerified: true });
  assert.equal(csvRes.inserted, 2);

  // JSON import (updates existing + inserts new)
  const jsonRes = diagnoses.importIcd10(db, {
    format: 'json',
    content: JSON.stringify([
      { code: 'I10', label_fr: 'Hypertension artérielle essentielle validée', is_chronic_ald: 1, is_notifiable: 0, verified: 1 },
      { code: 'E05.9', label_fr: 'Hyperthyroïdie (thyréotoxicose)', label_ar: 'فرط نشاط الغدة الدرقية', is_chronic_ald: 1 },
    ]),
  });
  assert.equal(jsonRes.updated, 1);
  assert.equal(jsonRes.inserted, 1);

  const mdoCheck = diagnoses.searchIcd10(db, { query: 'A39.0' });
  assert.equal(mdoCheck[0].is_notifiable, 1);
  assert.equal(mdoCheck[0].verified, 1);
});

test('Phase 4 — multi-diagnosis prescriptions, ALD 100% & MDO flags, editable protocols, and epidemiology stats', (t) => {
  useTempDb(t);
  const db = getDb();

  const cardio = departments.create({ name_fr: 'Cardiologie', name_ar: 'طب القلب', specialty: 'cardio' });
  const pedia = departments.create({ name_fr: 'Pédiatrie', name_ar: 'طب الأطفال', specialty: 'pediatrie' });

  const currentYear = new Date().getFullYear();
  const senior = patients.create({
    full_name: 'Hadj Brahim',
    phone: '0550112233',
    birth_date: `${currentYear - 68}-05-10`,
    gender: 'm',
  });
  const child = patients.create({
    full_name: 'Ines Khelifi',
    phone: '0550445566',
    birth_date: `${currentYear - 6}-03-15`,
    gender: 'f',
  });

  // Multi-diagnosis prescription with 2 ALD chronic conditions + free-text note
  const rx1 = prescriptions.create({
    patient_id: senior.id,
    department_id: cardio.id,
    day: '2026-10-20',
    diagnosis: 'Déséquilibre glycémique sous monothérapie',
    diagnoses: [{ icd10_code: 'I10' }, { icd10_code: 'E11.9' }],
    items: [
      { drug_name: 'AMLOZEK', dci: 'Amlodipine', dosage: '1 cp/j', duration: 'QSP 3 mois' },
      { drug_name: 'GLUCOPHAGE', dci: 'Metformine', dosage: '1 cp × 2/j', duration: 'QSP 3 mois' },
    ],
  });
  assert.equal(rx1.diagnoses.length, 2);
  assert.equal(rx1.has_chronic_ald, true);
  assert.equal(rx1.has_notifiable_mdo, false);
  assert.match(rx1.diagnosis, /\[I10\]/);
  assert.match(rx1.diagnosis, /\[E11\.9\]/);

  // Pediatric MDO notifiable prescription (Rougeole B05.9)
  const rx2 = prescriptions.create({
    patient_id: child.id,
    department_id: pedia.id,
    day: '2026-10-22',
    diagnoses: [{ icd10_code: 'B05.9' }],
    items: [
      { drug_name: 'DOLIPRANE', dci: 'Paracétamol', dosage: '1 dose poids × 3/j', duration: '5 jours' },
    ],
  });
  assert.equal(rx2.has_notifiable_mdo, true);

  // Starter clinical protocol templates carry verified = 0 and can be edited + verified
  const templates = prescriptions.listTemplates();
  assert.ok(templates.length > 0);
  const starterTpl = templates[0];
  assert.equal(starterTpl.verified, 0);
  assert.equal(starterTpl.source, 'starter');

  const updatedTpl = prescriptions.updateTemplate(starterTpl.id, {
    title_fr: `${starterTpl.title_fr} (Validé Cabinet)`,
    icd10_code: 'J02.9',
    verified: 1,
  });
  assert.equal(updatedTpl.verified, 1);
  assert.equal(updatedTpl.icd10_code, 'J02.9');

  // Epidemiology & Diagnosis statistics by period, age group, and department
  const stats = diagnoses.diagnosisStats(db, { start: '2026-10-01', end: '2026-10-31' });
  assert.equal(stats.totals.total_diagnoses, 3);
  assert.equal(stats.totals.prescriptions_with_diag, 2);
  assert.equal(stats.totals.chronic_ald_cases, 2);
  assert.equal(stats.totals.notifiable_cases, 1);
  assert.equal(stats.notifiable_alerts.length, 1);
  assert.equal(stats.notifiable_alerts[0].icd10_code, 'B05.9');

  const ageMap = Object.fromEntries(stats.by_age_group.map((r) => [r.age_group, r.count]));
  assert.equal(ageMap['65_plus'], 2);
  assert.equal(ageMap['0_14'], 1);

  const cardioOnly = diagnoses.diagnosisStats(db, {
    start: '2026-10-01',
    end: '2026-10-31',
    department_id: cardio.id,
  });
  assert.equal(cardioOnly.totals.total_diagnoses, 2);
  assert.equal(cardioOnly.totals.notifiable_cases, 0);
});
