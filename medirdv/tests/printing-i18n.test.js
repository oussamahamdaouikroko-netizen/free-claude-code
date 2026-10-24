const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { useTempDb } = require('./helpers');
const settings = require('../src/main/services/settings');
const patients = require('../src/main/services/patients');
const emr = require('../src/main/services/emr');
const documents = require('../src/main/services/documents');
const { prescriptionHtml } = require('../src/main/print');
const { buildVerificationToken, qrSvg } = require('../src/main/utils/qr');
const bot = require('../src/main/whatsapp/bot');

test('Phase 9 — A4/A5 templates, letterhead toggle, zero-medical-content verification QR, signature & RTL <bdi> accuracy', (t) => {
  useTempDb(t);

  const token = buildVerificationToken('RX', 42, '2026-10-25|2');
  assert.match(token, /^MRDV:RX:42:[0-9A-F]{10}$/);
  const svg = qrSvg(token);
  assert.match(svg, /^<svg /);
  assert.ok(!svg.includes('Amoxicilline'));
  // Attempting to embed spaces or long clinical text in QR is strictly rejected
  assert.throws(() => qrSvg('Patient: Karim Benali — Amoxicilline 1g'));

  const sampleSig = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  settings.setMany({
    print_paper_size: 'A5',
    print_letterhead: '0',
    doctor_signature_data: sampleSig,
  });

  const htmlA5 = prescriptionHtml({
    prescription: {
      id: 42,
      lang: 'ar',
      day: '2026-10-25',
      patient_name: 'كريم بن علي',
      items: [
        {
          drug_name: 'AUGMENTIN',
          dci: 'Amoxicilline + Acide clavulanique',
          form_strength: '1g/125mg',
          dosage: '1 sachet x 2/j',
          duration: '7 jours',
        },
      ],
    },
    clinic: {
      name: 'Cabinet El Chifa',
      paper_size: 'A5',
      letterhead: false,
      signature_data: sampleSig,
    },
  });

  assert.match(htmlA5, /size:\s*A5/);
  assert.match(htmlA5, /dir="rtl"/);
  assert.match(htmlA5, /data-letterhead="off"/);
  assert.match(htmlA5, /<bdi dir="ltr">AUGMENTIN<\/bdi>/);
  assert.match(htmlA5, /class="sig-img"/);
  // QR aria-label contains ONLY the MRDV verification token — never patient or drug name
  const qrMatch = htmlA5.match(/aria-label="([^"]+)"/);
  assert.ok(qrMatch);
  assert.match(qrMatch[1], /^MRDV:RX:42:/);
  assert.ok(!qrMatch[1].includes('كريم'));
  assert.ok(!qrMatch[1].includes('AUGMENTIN'));
});

test('Phase 9 — referral letter, medical report, sports/school/vaccination certificates & lab/imaging printouts', (t) => {
  useTempDb(t);
  const p = patients.create({ full_name: 'Yasmine Khelifi', phone: '0552334455', birth_date: '2014-05-10' });

  const ref = documents.createDocument({
    patient_id: p.id,
    doc_type: 'referral',
    recipient_doctor: 'Pr. M.Zerrouki',
    specialty_target: 'Cardiologie pédiatrique',
    clinical_summary: 'Souffle systolique 2/6 découvert lors d’un examen systématique.',
  });
  assert.match(documents.renderDocumentHtml(ref.id), /LETTRE D’ORIENTATION CONFRATERNELLE/);

  const rep = documents.createDocument({
    patient_id: p.id,
    doc_type: 'medical_report',
    clinical_summary: 'Suivi asthme léger intermittent',
    findings: 'Auscultation pulmonaire libre, SpO2 99%',
    conclusion: 'Équilibre respiratoire satisfaisant.',
  });
  assert.match(documents.renderDocumentHtml(rep.id), /COMPTE-RENDU MÉDICAL/);

  for (const [docType, expectedBanner] of [
    ['cert_fitness_sports', 'PRATIQUE SPORTIVE'],
    ['cert_school', 'CERTIFICAT MÉDICAL SCOLAIRE'],
    ['cert_vaccination', 'CERTIFICAT DE VACCINATION'],
  ]) {
    const cert = documents.createDocument({ patient_id: p.id, doc_type: docType });
    assert.ok(documents.renderDocumentHtml(cert.id).includes(expectedBanner));
  }

  const lab = emr.createLabOrder({ patient_id: p.id, panel_text: 'FNS, Ferritine, TSHus', notes: 'Bilan asthénie' });
  assert.match(documents.renderLabOrderHtml(lab.id), /DEMANDE DE BILAN BIOLOGIQUE/);

  const img = emr.createImagingOrder({ patient_id: p.id, modality: 'RX', body_part: 'Thorax face', indication: 'Toux' });
  assert.match(documents.renderImagingOrderHtml(img.id), /DEMANDE D’EXAMEN RADIOLOGIQUE/);
});

test('Phase 9 — strict FR/AR {placeholder} parity & optional Algerian Darija WhatsApp toggle', (t) => {
  useTempDb(t);
  settings.setMany({ working_days: '0,1,2,3,4,5,6' });

  // Strict {placeholder} parity across every single FR/AR key
  const src = fs
    .readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'js', 'i18n.js'), 'utf8')
    .replace('  window.I18N = {', '  window.__DICT = DICT;\n  window.I18N = {');
  const ctx = {
    window: {},
    localStorage: { getItem: () => null, setItem: () => {} },
    document: { documentElement: { style: {} }, addEventListener() {}, dispatchEvent() {} },
    CustomEvent: class {},
    Intl,
    console,
  };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  const { fr, ar } = ctx.window.__DICT;
  const extractVars = (str) =>
    [...String(str).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

  const mismatches = [];
  for (const key of Object.keys(fr)) {
    if (extractVars(fr[key]) !== extractVars(ar[key])) {
      mismatches.push(`${key}: fr(${extractVars(fr[key])}) vs ar(${extractVars(ar[key])})`);
    }
  }
  assert.deepEqual(mismatches, [], `Placeholder mismatch: ${mismatches.join('; ')}`);

  // Optional Algerian Darija WhatsApp toggle
  settings.setMany({ bot_darija_mode: '1' });
  const djReply = bot.handle({ phone: '0554998877', text: 'كريم منصوري', delivery: 'local' });
  assert.equal(djReply.action, 'booked');
  assert.match(djReply.reply, /نيميرو الدور/);
});
