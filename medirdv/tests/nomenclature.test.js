'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { useTempDb } = require('./helpers');
const nomenclature = require('../src/main/services/nomenclature');
const prescriptions = require('../src/main/services/prescriptions');
const reports = require('../src/main/services/reports');
const { buildWorkbook } = require('../src/main/export/xlsx');
const { prescriptionHtml } = require('../src/main/print');

test('Phase 3 — CSV & XLSX Nomenclature importer, generic substitution & CNAS reimbursement', (t) => {
  const ctx = useTempDb();
  t.after(() => ctx.cleanup());

  // 1. Semicolon-delimited French MIPH CSV import
  const csv = [
    "Numéro d'enregistrement;Nom de marque;DCI;Dosage;Forme;Laboratoire;Pays;Générique;PPA;Tarif de référence;Remboursable;Taux;Liste;Commercialisé",
    '101/05A012/20;Clamoxyl;Amoxicilline;1 g;Comprimé dispersible;GSK;France;Non;420;310;Oui;80;Liste I;Oui',
    '102/05A099/22;Biopamox;Amoxicilline;1 g;Comprimé dispersible;Biopharm;Algérie;Oui;295;310;Oui;80;Liste I;Oui',
    '103/05A140/23;Saidamox;Amoxicilline;1 g;Comprimé dispersible;Saidal;Algérie;Oui;260;310;Oui;80;Liste I;Oui',
  ].join('\n');

  const csvRes = nomenclature.importNomenclature({
    format: 'csv',
    content: csv,
    mark_verified: true,
  });
  assert.ok(csvRes.imported + csvRes.updated >= 3);

  const biopamox = prescriptions.searchMedications({ query: 'Biopamox' })[0];
  assert.ok(biopamox);
  assert.equal(biopamox.is_generic, 1);
  assert.equal(biopamox.reimbursable, 1);
  assert.equal(biopamox.reimbursement_rate, 80);
  assert.equal(biopamox.ppa, 295);
  assert.equal(biopamox.reference_price, 310);
  assert.equal(biopamox.verified, 1);

  // Generic substitution lookup returns Clamoxyl & Saidamox for Biopamox (sorted by reimbursable, generic, PPA)
  const subs = nomenclature.findSubstitutes({ medication_id: biopamox.id });
  assert.ok(subs.substitutes.some((m) => m.brand === 'Saidamox'));
  assert.ok(subs.substitutes.some((m) => m.brand === 'Clamoxyl'));
  assert.equal(subs.substitutes[0].brand, 'Saidamox', 'lowest-PPA generic reimbursable comes first');

  // 2. Real .xlsx workbook import (offline ZIP + XML parser)
  const xlsxBuf = buildWorkbook([
    {
      name: 'Nomenclature',
      rows: [
        ['registration_number', 'brand', 'dci', 'strength', 'form', 'laboratory', 'is_generic', 'ppa', 'reimbursable', 'reimbursement_rate', 'schedule'],
        ['204/12B088/24', 'Rivotril', 'Clonazépam', '2 mg', 'Comprimé sécable', 'Roche', '0', '380', '1', '80', 'Psychotrope'],
      ],
    },
  ]);

  const xlsxRes = nomenclature.importNomenclature({
    format: 'xlsx',
    xlsxBase64: xlsxBuf.toString('base64'),
    mark_verified: true,
  });
  assert.equal(xlsxRes.imported + xlsxRes.updated, 1);
  const rivotril = prescriptions.searchMedications({ query: 'Rivotril' })[0];
  assert.ok(rivotril);
  assert.equal(rivotril.schedule, 'psychotrope');
});

test('Phase 3 — FTS5 search stays fast (< 60 ms) on 5,200+ Nomenclature rows', (t) => {
  const ctx = useTempDb();
  t.after(() => ctx.cleanup());

  const bulkRows = [];
  for (let i = 1; i <= 5100; i += 1) {
    bulkRows.push({
      registration_number: `ALG-${String(i).padStart(5, '0')}`,
      brand: `Algémed-${i}`,
      dci: i % 2 === 0 ? 'Atorvastatine' : 'Losartan',
      strength: i % 3 === 0 ? '50 mg' : '20 mg',
      form: 'Comprimé pelliculé',
      laboratory: 'Saidal Algérie',
      is_generic: 1,
      ppa: 450,
      reimbursable: 1,
      reimbursement_rate: 80,
    });
  }
  const res = nomenclature.importNomenclature({ format: 'json', content: bulkRows, mark_verified: true });
  assert.equal(res.imported, 5100);

  const summary = nomenclature.nomenclatureSummary();
  assert.ok(summary.total >= 5200);

  const t0 = performance.now();
  const hits = prescriptions.searchMedications({ query: 'Algemed 4999', limit: 15 });
  const elapsedMs = performance.now() - t0;

  assert.ok(hits.some((m) => m.brand === 'Algémed-4999'));
  assert.ok(elapsedMs < 80, `expected FTS5 search < 80ms on 5.2k drugs, took ${elapsedMs.toFixed(1)}ms`);
});

test('Phase 3 — print modes (brand / dci / both, non-substitutable) & controlled-substance regulatory print format', (t) => {
  const ctx = useTempDb();
  t.after(() => ctx.cleanup());

  const dciOnlyRx = prescriptions.create({
    patient_name: 'Rachid Bensalem',
    print_mode: 'dci',
    items: [
      {
        drug_name: 'Tahor',
        dci: 'Atorvastatine',
        form_strength: 'Comprimé 20 mg',
        dosage: '1 comprimé le soir',
        duration: '30 jours',
        substitutable: 0,
      },
    ],
  });
  const dciHtml = prescriptionHtml({ prescription: dciOnlyRx, clinic: reports.clinicProfile() });
  assert.match(dciHtml, /Atorvastatine/);
  assert.doesNotMatch(dciHtml, /Tahor/);
  assert.match(dciHtml, /\[Non substituable\]/);

  // Controlled psychotropic prescription -> regulatory banner + numbers in words
  const ctrlRx = prescriptions.create({
    patient_name: 'Kamelia Ziane',
    doctor_ordre: 'CNOM-16-9912',
    items: [
      {
        drug_name: 'Tramadol LP',
        dci: 'Tramadol',
        form_strength: 'Gélule 50 mg',
        dosage: '2 gélules par jour',
        duration: '14 jours',
        quantity: '1 boîte',
        schedule: 'psychotrope',
      },
    ],
  });
  assert.equal(ctrlRx.controlled_rx, 1);
  const ctrlHtml = prescriptionHtml({ prescription: ctrlRx, clinic: reports.clinicProfile() });
  assert.match(ctrlHtml, /ORDONNANCE RÉGLEMENTÉE — SUBSTANCES PSYCHOTROPES/);
  assert.match(ctrlHtml, /2 \(deux\)/);
  assert.match(ctrlHtml, /14 \(quatorze\)/);
  assert.match(ctrlHtml, /CNOM-16-9912/);

  // CLI script smoke test against a temp SQLite DB & CSV file
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'medirdv-nom-cli-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const csvFile = path.join(tmpDir, 'sample-nom.csv');
  const cliDb = path.join(tmpDir, 'cli-test.sqlite');
  fs.writeFileSync(
    csvFile,
    'brand,dci,strength,form,laboratory,is_generic,ppa,reimbursable\nCardioAlg,Bisoprolol,5 mg,Comprimé,Biopharm,1,390,1\n',
    'utf8',
  );
  const out = execFileSync(
    process.execPath,
    [path.join(__dirname, '..', 'scripts', 'import-nomenclature.js'), csvFile, '--db', cliDb, '--verified'],
    { encoding: 'utf8' },
  );
  assert.match(out, /imported: 1/);
});
