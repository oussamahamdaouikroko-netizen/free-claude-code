'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { useTempDb } = require('./helpers');
const safety = require('../src/main/services/safety');
const prescriptions = require('../src/main/services/prescriptions');
const patients = require('../src/main/services/patients');
const intake = require('../src/main/services/intake');

test('Phase 2 — pediatric mg/kg & syrup ml/dose calculator with ceiling cap and formula', (t) => {
  const ctx = useTempDb();
  t.after(() => ctx.cleanup());

  // 14 kg child, Paracetamol syrup 2.4% (24 mg/ml): 14 * 15 = 210 mg -> 210 / 24 = 8.8 ml
  const calc = safety.calculatePediatricDose({
    dci: 'Paracétamol',
    form_strength: 'Sirop 2,4%',
    weight_kg: '14 kg',
    age_months: 36,
  });
  assert.equal(calc.matched, true);
  assert.equal(calc.single_dose_mg, 210);
  assert.equal(calc.daily_dose_mg, 840);
  assert.equal(calc.ml_per_dose, 8.8);
  assert.equal(calc.exceeds_max_daily, false);
  assert.equal(calc.verified, false, 'starter rules ship as verified=0');
  assert.equal(calc.source, 'starter');
  assert.match(calc.formula_fr, /14 kg/);
  assert.match(calc.formula_ar, /14 كغ/);

  // Amoxicilline 250 mg / 5 ml (= 50 mg/ml) for 15 kg child: 80 mg/kg/d = 1200 mg/d -> 600 mg x 2 = 12 ml/dose
  const amox = safety.calculatePediatricDose({
    dci: 'Amoxicilline',
    form_strength: 'Suspension 250 mg / 5 ml',
    weight_kg: 15,
  });
  assert.equal(amox.concentration_mg_per_ml, 50);
  assert.equal(amox.single_dose_mg, 600);
  assert.equal(amox.ml_per_dose, 12);

  // Heavy adolescent 85 kg -> capped at max_single_dose_mg (1000 mg) & max_daily_dose_mg (4000 mg)
  const capped = safety.calculatePediatricDose({
    dci: 'Paracétamol',
    weight_kg: 85,
  });
  assert.equal(capped.exceeds_max_single, true);
  assert.equal(capped.exceeds_max_daily, true);
  assert.equal(capped.single_dose_mg, 1000);
  assert.equal(capped.daily_dose_mg, 4000);
});

test('Phase 2 — duplicate therapy, Rx × current_medications interaction, class allergies, contraindications & controlled flags', (t) => {
  const ctx = useTempDb();
  t.after(() => ctx.cleanup());

  const p = patients.create({
    full_name: 'Kamelia Ouali',
    phone: '0553112233',
    gender: 'f',
    birth_date: '1994-02-14',
    allergies: 'Sulfamides',
    chronic_conditions: 'Asthme, Déficit G6PD',
  });

  // Confirmed intake brings pregnancy = 1 and current_medications = Acénocoumarol
  const draft = intake.create({
    patient_id: p.id,
    consent: true,
    is_pregnant: 1,
    current_medications: 'Acénocoumarol 4 mg',
    weight_kg: 63,
  });
  intake.confirmAndApply(draft.id, { reviewed_by: 'Dr. Kaci' });

  const ev = safety.evaluatePrescription({
    patient_id: p.id,
    items: [
      { drug_name: 'Doliprane', dci: 'Paracétamol', duration: '5 jours' },
      { drug_name: 'Paralgan', dci: 'Paracétamol', duration: '5 jours' }, // duplicate DCI!
      { drug_name: 'Brufen', dci: 'Ibuprofène', duration: '5 jours' }, // pregnancy contraindicated + Acénocoumarol interaction!
      { drug_name: 'Bactrim', dci: 'Sulfaméthoxazole + Triméthoprime', duration: '7 jours' }, // sulfonamide allergy + G6PD!
      { drug_name: 'Avlocardyl', dci: 'Propranolol', duration: '30 jours' }, // asthma contraindication!
      { drug_name: 'Tramadol LP', dci: 'Tramadol', duration: '45 jours' }, // controlled psychotrope + > 28 days!
    ],
  });

  assert.equal(ev.blocking, true);
  assert.equal(ev.duplicate_dci.length, 1);
  assert.equal(ev.duplicate_dci[0].dci, 'paracetamol');
  assert.ok(ev.interactions.some((i) => i.with_current_med && i.severity === 'contraindicated'));
  assert.ok(ev.allergy_alerts.some((a) => a.drug_name === 'Bactrim'));
  assert.ok(ev.contraindications.some((c) => c.condition_type === 'pregnancy' && c.dci === 'ibuprofene'));
  assert.ok(ev.contraindications.some((c) => c.condition_type === 'asthma' && c.dci === 'propranolol'));
  assert.ok(ev.contraindications.some((c) => c.condition_type === 'g6pd' && c.dci === 'sulfamethoxazole'));
  assert.ok(ev.controlled_flags.some((f) => f.dci === 'tramadol' && f.exceeded_duration === true));
});

test('Phase 2 — prescriptions.create blocks contraindicated Rx unless override_reason is logged to audit trail', (t) => {
  const ctx = useTempDb();
  t.after(() => ctx.cleanup());

  const p = patients.create({
    full_name: 'Meriem Saadi',
    phone: '0554998877',
    gender: 'f',
    birth_date: '1995-08-19',
    allergies: 'Pénicilline',
  });

  // Prescribing Cefixime / Amoxicilline to Penicillin-allergic patient without override_reason -> blocked!
  assert.throws(
    () =>
      prescriptions.create({
        patient_id: p.id,
        items: [{ drug_name: 'Amoxypen', dci: 'Amoxicilline', dosage: '1g x 2/j', duration: '7 jours' }],
      }),
    (err) => err.code === 'SAFETY_OVERRIDE_REQUIRED',
  );

  // With explicit clinical override_reason -> succeeds AND logs prescription_safety_audits!
  const rx = prescriptions.create({
    patient_id: p.id,
    patient_weight: '62 kg',
    safety_override_reason: 'Test cutané allergologique négatif documenté le 10/09/2026',
    items: [{ drug_name: 'Amoxypen', dci: 'Amoxicilline', dosage: '1g x 2/j', duration: '7 jours' }],
  });

  assert.ok(rx.safety_audit);
  assert.equal(rx.safety_audit.patient_weight_kg, 62);
  assert.match(rx.safety_audit.override_reason, /allergologique/);
  assert.ok(rx.safety_audit.warnings_shown.length >= 1);
  assert.ok(rx.safety_audit.overrides.length >= 1);
});

test('Phase 2 — CSV & JSON clinical rules importer and practitioner rule verification', (t) => {
  const ctx = useTempDb();
  t.after(() => ctx.cleanup());

  const csv = [
    'dci_a,dci_b,severity,mechanism_fr,mechanism_ar,action_fr,action_ar',
    'spironolactone,potassium,contraindicated,"Hyperkaliémie sévère","فرط بوتاسيوم الدم الخطير","Contre-indiqué","ممنوع الجمع"',
  ].join('\n');

  const resCsv = safety.importRules({
    table: 'interaction_pairs',
    format: 'csv',
    content: csv,
    mark_verified: false,
  });
  assert.equal(resCsv.imported, 1);

  const list = safety.listRules({ table: 'interaction_pairs' });
  const importedRow = list.find((r) => r.dci_a === 'spironolactone' && r.dci_b === 'potassium');
  assert.ok(importedRow);
  assert.equal(importedRow.source, 'import');
  assert.equal(importedRow.verified, 0);

  const verifiedRow = safety.verifyRule({
    table: 'interaction_pairs',
    id: importedRow.id,
    verified: true,
  });
  assert.equal(verifiedRow.verified, 1);
});
