'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { useTempDb, today } = require('./helpers');
const db = require('../src/main/db');
const patients = require('../src/main/services/patients');
const prescriptions = require('../src/main/services/prescriptions');
const nomenclature = require('../src/main/services/nomenclature');
const safety = require('../src/main/services/safety');
const intake = require('../src/main/services/intake');
const { prescriptionHtml, certificateHtml } = require('../src/main/print');
const { DENTAL_SPECIALTIES } = require('../src/main/db/dental-drugs');

let ctx;
test.beforeEach(() => {
  ctx = useTempDb();
});
test.afterEach(() => ctx.cleanup());

test('medications catalog is 100% dedicated to dentists and excludes non-dental specialties', () => {
  const stats = prescriptions.medicationStats();
  assert.ok(stats.total >= 600, `expected >= 600 dental medications, got ${stats.total}`);

  // Every single medication in SQLite must have a dental_* specialty
  const allowed = new Set(DENTAL_SPECIALTIES);
  const allRows = db.getDb().prepare('SELECT brand, dci, form, specialty FROM medications').all();
  for (const row of allRows) {
    assert.ok(
      allowed.has(row.specialty),
      `non-dental specialty leaked into DentaRDV: ${row.brand} (${row.specialty})`,
    );
  }

  // Non-dental chronic / hospital / ophthalmic / rectal / pulmonary drugs must return 0 matches
  const nonDentalQueries = [
    'Tahor',
    'Atorvastatine',
    'Glucophage',
    'Metformine',
    'Ventoline',
    'Salbutamol',
    'Lasilix',
    'Furosémide',
    'Levothyrox',
    'Collyre',
    'Suppositoire',
    'Ovule',
  ];
  for (const q of nonDentalQueries) {
    const hits = prescriptions.searchMedications({ query: q, limit: 10 });
    assert.equal(hits.length, 0, `expected 0 matches for non-dental query "${q}", got ${hits.length}`);
  }

  // Essential Algerian dental drugs must be searchable in both French and Arabic
  const dentalMustHave = [
    'Augmentin',
    'Birodogyl',
    'Rodogyl',
    'Amoxicilline',
    'Clindamycine',
    'Eludril',
    'Paroex',
    'Pansoral',
    'Doliprane',
    'Surgam',
    'Solupred',
    'Mycostatine',
    'Exacyl',
    'أوجمنتين',
    'بيرودوجيل',
    'غسول',
  ];
  for (const q of dentalMustHave) {
    const hits = prescriptions.searchMedications({ query: q, limit: 10 });
    assert.ok(hits.length > 0, `expected dental matches for "${q}"`);
  }
});

test('clinical safety engine catches penicillin allergy, duplicate NSAIDs and calculates pediatric doses', () => {
  const p = patients.create({
    full_name: 'Karim Test',
    phone: '0555123456',
    allergies: 'Pénicilline',
    chronic_conditions: 'Ulcère gastrique',
  });

  const evalRes = safety.evaluatePrescription({
    patient_id: p.id,
    items: [
      { drug_name: 'Augmentin Adulte', dci: 'Amoxicilline + Acide clavulanique' },
      { drug_name: 'Brufen', dci: 'Ibuprofène' },
      { drug_name: 'Profénid', dci: 'Kétoprofène' },
    ],
  });
  assert.equal(evalRes.blocking, true);
  assert.equal(evalRes.requires_override, true);
  assert.ok(evalRes.alerts.some((a) => a.kind === 'allergy' && a.severity === 'contraindicated'));
  assert.ok(evalRes.alerts.some((a) => a.kind === 'interaction'));
  assert.ok(evalRes.alerts.some((a) => a.kind === 'contraindication'));

  // Saving without override reason throws SAFETY_OVERRIDE_REQUIRED
  assert.throws(
    () =>
      prescriptions.create({
        patient_id: p.id,
        patient_name: p.full_name,
        items: [{ drug_name: 'Augmentin Adulte', dci: 'Amoxicilline + Acide clavulanique' }],
      }),
    (err) => err.code === 'SAFETY_OVERRIDE_REQUIRED',
  );

  // Saving with explicit dentist override reason succeeds and records audit trail
  const saved = prescriptions.create({
    patient_id: p.id,
    patient_name: p.full_name,
    tooth_ref: '46',
    safety_override_reason: 'Test allergologique négatif documenté',
    items: [{ drug_name: 'Augmentin Adulte', dci: 'Amoxicilline + Acide clavulanique', dosage: '1g x 2/j', duration: '6 jours' }],
  });
  assert.equal(saved.tooth_ref, '46');
  assert.match(saved.safety_audit.override_reason, /négatif/);

  // Pediatric suspension calculator (Amoxicillin 50 mg/kg/day for 20 kg child = 1000 mg/day)
  const ped = safety.calculatePediatricDose({
    dci: 'Amoxicilline',
    form_strength: 'Suspension buvable 250 mg / 5 ml',
    weight_kg: 20,
    patient_age: '6 ans',
  });
  assert.equal(ped.matched, true);
  assert.equal(ped.daily_dose_mg, 1000);
  assert.ok(ped.ml_per_dose > 0);
});

test('dental prescriptions, A4/A5 QR HTML preview, generic substitutes, templates and certificates work end-to-end', async () => {
  const templates = prescriptions.listTemplates();
  assert.equal(templates.length, 7);

  // Generic substitution on Amoxicilline
  const amox = prescriptions.searchMedications({ query: 'Amoxicilline', limit: 5 })[0];
  assert.ok(amox);
  const subs = nomenclature.findSubstitutes({ medication_id: amox.id });
  assert.ok(subs.substitutes.length >= 2);

  // Create dental prescription with tooth_ref and render A4 + A5 QR-signed HTML
  const rx = prescriptions.create({
    patient_name: 'Nadia Meziane',
    patient_age: '28 ans',
    patient_weight: '62 kg',
    tooth_ref: '38 (Dent de sagesse)',
    day: today(),
    diagnosis: 'Péricoronarite aiguë 38',
    items: templates[0].items,
    advice: templates[0].advice,
  });

  const htmlA4 = await prescriptionHtml({ ...rx, clinic: { name: 'Cabinet Dentaire Test' } }, { format: 'A4', print_mode: 'both' });
  assert.match(htmlA4, /ORDONNANCE/);
  assert.match(htmlA4, /وصفة طبية لطب الأسنان/);
  assert.match(htmlA4, /38 \(Dent de sagesse\)/);
  assert.match(htmlA4, /data:image\/svg\+xml/);
  assert.match(htmlA4, /DRDV-1-[A-F0-9]{10}/);

  const htmlA5 = await prescriptionHtml({ ...rx, clinic: { name: 'Cabinet Dentaire Test' } }, { format: 'A5', print_mode: 'dci' });
  assert.match(htmlA5, /A5 portrait/);

  // Dental medical certificate + QR HTML
  const cert = prescriptions.createCertificate({
    patient_name: 'Nadia Meziane',
    patient_age: '28 ans',
    kind: 'arret_travail',
    rest_days: 3,
    day: today(),
    content: 'Extraction chirurgicale dent de sagesse incluse 38.',
  });
  const certHtml = await certificateHtml({ ...cert, clinic: { name: 'Cabinet Dentaire Test' } });
  assert.match(certHtml, /CERTIFICAT D'ARRÊT DE TRAVAIL/);
  assert.match(certHtml, /Chirurgien-Dentiste/);
  assert.match(certHtml, /3 jour\(s\)/);

  // Law 18-07 intake confirmation workflow
  const pat = patients.create({ full_name: 'Yacine Intake', phone: '0770999888' });
  const rec = intake.create({
    patient_id: pat.id,
    source: 'whatsapp',
    consent: true,
    age_years: 25,
    weight_kg: 72,
    chief_complaint: 'Douleur canine 13',
  });
  assert.equal(rec.status, 'pending');
  const confirmed = intake.confirmAndApply(rec.id, { reviewed_by: 'Dr. Test' });
  assert.equal(confirmed.intake.status, 'applied');
  assert.equal(confirmed.prescription_prefill.patient_weight, '72 kg');
});
