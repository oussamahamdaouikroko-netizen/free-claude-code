const test = require('node:test');
const assert = require('node:assert/strict');
const { useTempDb } = require('./helpers');
const treatments = require('../src/main/services/treatments');
const patients = require('../src/main/services/patients');
const billing = require('../src/main/services/billing');
const settings = require('../src/main/services/settings');
const reports = require('../src/main/services/reports');
const { invoiceHtml } = require('../src/main/print');

test('Phase 6 — CNAS / CASNOS / private / free coverage split, gap-free sequential invoices & legal FR/AR HTML', (t) => {
  useTempDb(t);

  settings.setMany({
    clinic_name: 'Clinique El Chifa',
    clinic_rc: '16/00-1234567B20',
    clinic_nif: '002016012345678',
    clinic_nis: '199916010123456',
    clinic_ai: '16018765432',
  });

  const echo = treatments.create({
    name_fr: 'Échographie Doppler',
    name_ar: 'إيكوغرافيا دوبلر',
    default_price: 4500,
    price_private: 4500,
    price_insured: 4000,
    convention_rate: 80,
  });

  const cnasPatient = patients.create({
    full_name: 'Nabil Benali',
    phone: '0554112233',
    insurance_type: 'CNAS',
    insurance_rate: 80,
    chifa_number: 'CHIFA-998877',
    nss: '820412016991',
  });

  // CNAS insured: uses convention tariff 4000 DA -> 80% CNAS (3200 DA) + 20% patient (800 DA)
  const inv1 = billing.createInvoice({
    patient_id: cnasPatient.id,
    day: '2026-10-24',
    treatment_id: echo.id,
    paid_amount: 800,
    method: 'cash',
  });
  assert.equal(inv1.invoice_number, 'FAC-2026-00001');
  assert.equal(inv1.total_amount, 4000);
  assert.equal(inv1.insured_share, 3200);
  assert.equal(inv1.patient_share, 800);
  assert.equal(inv1.status, 'paid');

  // Private walk-in with 500 DA discount: 4500 - 500 = 4000 DA patient share
  const inv2 = billing.createInvoice({
    patient_name: 'Karim Privé',
    day: '2026-10-24',
    insurance_type: 'none',
    treatment_id: echo.id,
    discount_amount: 500,
    discount_reason: 'Remise famille',
    paid_amount: 2000,
    method: 'card',
  });
  assert.equal(inv2.invoice_number, 'FAC-2026-00002');
  assert.equal(inv2.total_amount, 4000);
  assert.equal(inv2.insured_share, 0);
  assert.equal(inv2.patient_share, 4000);
  assert.equal(inv2.status, 'partial');
  assert.equal(inv2.remaining_patient_due, 2000);

  // Free social case -> 0 DA patient share
  const inv3 = billing.createInvoice({
    patient_name: 'Cas Social',
    day: '2026-10-24',
    insurance_type: 'free',
    treatment_id: echo.id,
  });
  assert.equal(inv3.invoice_number, 'FAC-2026-00003');
  assert.equal(inv3.patient_share, 0);
  assert.equal(inv3.status, 'paid');

  // Next calendar year resets annual sequence cleanly without gaps
  const invNextYear = billing.createInvoice({
    patient_id: cnasPatient.id,
    day: '2027-01-03',
    treatment_id: echo.id,
  });
  assert.equal(invNextYear.invoice_number, 'FAC-2027-00001');

  // Bilingual legal invoice HTML contains RC/NIF/NIS/AI + Chifa + NSS
  const html = invoiceHtml({ invoice: inv1, clinic: reports.clinicProfile() });
  assert.match(html, /16\/00-1234567B20/);
  assert.match(html, /002016012345678/);
  assert.match(html, /CHIFA-998877/);
  assert.match(html, /FAC-2026-00001/);
});

test('Phase 6 — refunds, daily Z-Report cash-box reconciliation & CNAS/CASNOS CSV/XLSX bordereau export', (t) => {
  useTempDb(t);
  const today = '2026-10-24';

  const act = treatments.create({
    name_fr: 'Consultation spécialisée',
    default_price: 2500,
    price_private: 2500,
    price_insured: 2000,
    convention_rate: 80,
  });

  const p1 = patients.create({
    full_name: 'Sofiane CASNOS',
    phone: '0556778899',
    insurance_type: 'CASNOS',
    chifa_number: 'CAS-774411',
    nss: '790101016222',
  });

  // 2000 DA convention -> 1600 CASNOS + 400 patient paid in cash
  const inv = billing.createInvoice({
    patient_id: p1.id,
    day: today,
    treatment_id: act.id,
    paid_amount: 400,
    method: 'cash',
    record_payment: false, // test explicit refund & Z-report reconciliation
  });

  // Refund 150 DA on inv (gap-free invoice remains FAC-2026-00001!)
  billing.recordRefund({
    invoice_id: inv.id,
    amount: 150,
    method: 'cash',
    day: today,
    reason: 'Ajustement tarifaire',
  });
  const updatedInv = billing.getInvoice(inv.id);
  assert.equal(updatedInv.refunded_amount, 150);
  assert.equal(updatedInv.net_paid, 250);
  assert.equal(updatedInv.status, 'partial');

  // Z-Report
  const z = billing.dailyZReport(today);
  assert.equal(z.total_refunds, 150);
  assert.equal(z.invoices.count, 1);
  assert.equal(z.invoices.insured_receivable, 1600);

  // Export CNAS/CASNOS claims bordereau in CSV and real XLSX
  const csvClaim = billing.exportInsuranceClaims({ start: today, end: today, format: 'csv' });
  assert.equal(csvClaim.count, 1);
  assert.match(csvClaim.csv, /CAS-774411/);
  assert.match(csvClaim.csv, /1600/);

  const xlsxClaim = billing.exportInsuranceClaims({ start: today, end: today, format: 'xlsx' });
  assert.equal(xlsxClaim.count, 1);
  const buf = Buffer.from(xlsxClaim.buffer_base64, 'base64');
  assert.equal(buf[0], 0x50); // 'P'
  assert.equal(buf[1], 0x4b); // 'K' (valid ZIP/XLSX magic bytes)
});
