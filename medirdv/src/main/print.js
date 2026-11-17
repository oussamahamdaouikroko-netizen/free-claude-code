'use strict';
/**
 * Printing helper for MediRDV: renders medical prescriptions (Ordonnances),
 * medical certificates (Certificats médicaux), payment receipts, and daily
 * reports into clean A4/A5 HTML and sends them to the system printer.
 */

const escapeHtml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const fmtMoney = (value, currency) =>
  `${Number(value || 0).toLocaleString('fr-FR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ${escapeHtml(currency || 'DZD')}`;

const fmtDate = (value) => {
  const raw = String(value || '');
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/);
  if (!m) return escapeHtml(raw);
  return `${m[3]}/${m[2]}/${m[1]}${m[4] ? ` ${m[4]}:${m[5]}` : ''}`;
};

const BASE_STYLE = `
  * { box-sizing: border-box; }
  body {
    font-family: "Segoe UI", "Tahoma", Arial, sans-serif;
    margin: 0; padding: 24px; color: #0f1f33; background: #fff;
  }
  .sheet { max-width: 740px; margin: 0 auto; }
  header { display: flex; justify-content: space-between; align-items: flex-start; gap: 18px;
    border-bottom: 3px solid #0066cc; padding-bottom: 14px; margin-bottom: 18px; }
  .clinic { font-size: 21px; font-weight: 800; color: #0055b3; letter-spacing: -0.01em; }
  .doctor-name { font-size: 16px; font-weight: 700; color: #0f1f33; margin-top: 4px; }
  .specialty { font-size: 13.5px; font-weight: 600; color: #0066cc; margin-top: 2px; }
  .muted { color: #52657a; font-size: 12px; line-height: 1.55; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .ar { direction: rtl; font-family: "Segoe UI", Tahoma, Arial, sans-serif; }
  .doc-title { text-align: right; }
  table { width: 100%; border-collapse: collapse; margin: 16px 0; font-size: 13px; }
  th, td { text-align: left; padding: 8px; border-bottom: 1px solid #e2e8f0; }
  th { background: #f1f6fc; font-weight: 600; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .total { font-size: 20px; font-weight: 700; color: #0055b3; }
  .box { border: 1px solid #d5e2f0; border-radius: 10px; padding: 12px 16px; margin: 12px 0; background: #fafcff; }
  .row { display: flex; justify-content: space-between; padding: 3px 0; font-size: 13px; }
  .rx-banner {
    text-align: center; margin: 14px 0 16px; padding: 8px 14px;
    background: #f0f6ff; border: 1px solid #cce0ff; border-radius: 8px;
  }
  .rx-banner h2 { margin: 0; font-size: 17px; letter-spacing: 0.04em; color: #004c99; }
  .rx-banner .sub { font-size: 14px; font-weight: 700; color: #0055b3; margin-top: 2px; }
  .rx-patient-bar {
    display: flex; flex-wrap: wrap; justify-content: space-between; gap: 10px;
    border: 1px solid #d5e2f0; border-radius: 10px; padding: 10px 14px; margin-bottom: 18px;
    background: #fcfdff; font-size: 13.5px;
  }
  .rx-list { list-style: none; padding: 0; margin: 10px 0 20px; }
  .rx-item {
    padding: 11px 4px 12px; border-bottom: 1px dashed #d8e3ef;
    page-break-inside: avoid;
  }
  .rx-item:last-child { border-bottom: none; }
  .rx-drug-line { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; }
  .rx-num {
    display: inline-flex; width: 22px; height: 22px; border-radius: 50%;
    background: #0066cc; color: #fff; font-size: 12px; font-weight: 700;
    align-items: center; justify-content: center; margin-right: 8px; flex-shrink: 0;
  }
  .rx-drug-title { font-size: 15px; font-weight: 700; color: #0b192c; }
  .rx-dci { font-size: 12px; color: #52657a; font-weight: 400; margin-left: 6px; }
  .rx-duration { font-size: 12.5px; font-weight: 700; color: #0055b3; white-space: nowrap; }
  .rx-posology {
    margin: 5px 0 0 30px; font-size: 13.5px; color: #1e293b; line-height: 1.5;
  }
  .rx-note { margin: 2px 0 0 30px; font-size: 12px; color: #475569; font-style: italic; }
  .rx-section-title {
    font-size: 13px; font-weight: 700; text-transform: uppercase; color: #0055b3;
    margin: 16px 0 6px; letter-spacing: 0.03em;
  }
  .signature-row {
    display: flex; justify-content: space-between; align-items: flex-end;
    margin-top: 38px; page-break-inside: avoid;
  }
  .stamp-box {
    width: 230px; min-height: 92px; border: 1px dashed #94a3b8; border-radius: 10px;
    padding: 8px 12px; text-align: center; font-size: 11.5px; color: #64748b;
  }
  .cert-body {
    font-size: 15px; line-height: 1.9; color: #0f1f33; padding: 18px 8px;
    min-height: 180px;
  }
  footer { margin-top: 28px; padding-top: 10px; border-top: 1px solid #dce6f2;
    font-size: 11px; color: #64748b; display: flex; justify-content: space-between; gap: 12px; }
  @page { margin: 12mm; }
`;

function medicalHeaderHtml(clinic = {}, docOverride = {}) {
  const doctorName = docOverride.doctor_name || clinic.doctor_name || '';
  const specialty = docOverride.doctor_specialty || clinic.doctor_specialty || '';
  const ordre = docOverride.doctor_ordre || clinic.doctor_ordre || '';
  const deptName = docOverride.dept_name || '';
  const deptRoom = docOverride.dept_room || '';

  return `<header>
    <div>
      <div class="clinic">${escapeHtml(clinic.name || 'Cabinet Médical')}</div>
      ${doctorName ? `<div class="doctor-name">${escapeHtml(doctorName)}</div>` : ''}
      ${specialty ? `<div class="specialty">${escapeHtml(specialty)}</div>` : ''}
      ${deptName ? `<div class="muted"><strong>Service / المصلحة :</strong> ${escapeHtml(deptName)}${deptRoom ? ` (${escapeHtml(deptRoom)})` : ''}</div>` : ''}
      ${ordre ? `<div class="muted">N° d'Ordre : ${escapeHtml(ordre)}</div>` : ''}
    </div>
    <div class="doc-title">
      ${clinic.address ? `<div class="muted"><strong>📍 Adresse / الموقع :</strong><br>${escapeHtml(clinic.address)}</div>` : ''}
      ${clinic.wilaya ? `<div class="muted">${escapeHtml(clinic.wilaya)}</div>` : ''}
      ${clinic.phone ? `<div class="muted"><strong>Tél / الهاتف :</strong> ${escapeHtml(clinic.phone)}</div>` : ''}
    </div>
  </header>`;
}

function prescriptionHtml({ prescription, clinic = {} }) {
  const rx = prescription || {};
  const cityLabel = clinic.wilaya || '';
  const dateLine = `${cityLabel ? `${escapeHtml(cityLabel)}, le ` : 'Le '}${fmtDate(rx.day)}`;

  const vitals = [];
  if (rx.vitals_bp) vitals.push(`TA: ${escapeHtml(rx.vitals_bp)}`);
  if (rx.vitals_hr) vitals.push(`FC: ${escapeHtml(rx.vitals_hr)}`);
  if (rx.vitals_temp) vitals.push(`T°: ${escapeHtml(rx.vitals_temp)}`);
  if (rx.vitals_spo2) vitals.push(`SpO₂: ${escapeHtml(rx.vitals_spo2)}`);
  if (rx.vitals_glycemia) vitals.push(`Gly: ${escapeHtml(rx.vitals_glycemia)}`);

  const itemsHtml = (rx.items || [])
    .map((item, idx) => {
      const posologyParts = [item.dosage, item.timing].filter(Boolean).map(escapeHtml);
      const qtyPart = item.quantity ? ` — Qté : ${escapeHtml(item.quantity)}` : '';
      return `<li class="rx-item">
        <div class="rx-drug-line">
          <div>
            <span class="rx-num">${idx + 1}</span>
            <span class="rx-drug-title">${escapeHtml(item.drug_name)}</span>
            ${item.form_strength ? `<span class="rx-dci">(${escapeHtml(item.form_strength)})</span>` : ''}
            ${item.dci ? `<span class="rx-dci">— DCI : ${escapeHtml(item.dci)}</span>` : ''}
          </div>
          ${item.duration ? `<span class="rx-duration">Durée : ${escapeHtml(item.duration)}</span>` : ''}
        </div>
        ${
          posologyParts.length || qtyPart
            ? `<div class="rx-posology">↳ ${posologyParts.join(' · ')}${qtyPart}</div>`
            : ''
        }
        ${item.note ? `<div class="rx-note">Note : ${escapeHtml(item.note)}</div>` : ''}
      </li>`;
    })
    .join('');

  return `<!DOCTYPE html>
<html lang="fr"><head><meta charset="utf-8"><title>Ordonnance #${escapeHtml(rx.id || '')} — ${escapeHtml(rx.patient_name)}</title>
<style>${BASE_STYLE}</style></head>
<body><div class="sheet">
  ${medicalHeaderHtml(clinic, {
    doctor_name: rx.doctor_name,
    doctor_specialty: rx.doctor_specialty,
    doctor_ordre: rx.doctor_ordre,
    dept_name: rx.dept_name_fr || rx.dept_name_ar || '',
    dept_room: rx.dept_room || '',
  })}

  <div style="display:flex;justify-content:space-between;align-items:center;font-size:13px;color:#475569;margin-bottom:8px;">
    <span>N° Ordonnance : <strong>#${escapeHtml(rx.id || '—')}</strong></span>
    <span><strong>${dateLine}</strong></span>
  </div>

  <div class="rx-banner">
    <h2>ORDONNANCE MÉDICALE</h2>
    <div class="sub ar">وصـفـة طـبـيـة</div>
  </div>

  <div class="rx-patient-bar">
    <div><strong>Patient(e) / المريض(ة) :</strong> ${escapeHtml(rx.patient_name)}</div>
    ${rx.patient_age ? `<div><strong>Âge / السن :</strong> ${escapeHtml(rx.patient_age)}</div>` : ''}
    ${rx.patient_weight ? `<div><strong>Poids / الوزن :</strong> ${escapeHtml(rx.patient_weight)}</div>` : ''}
    ${vitals.length ? `<div style="width:100%;font-size:12px;color:#475569;padding-top:4px;border-top:1px solid #e2e8f0;"><strong>Constantes :</strong> ${vitals.join(' · ')}</div>` : ''}
  </div>

  ${itemsHtml ? `<ul class="rx-list">${itemsHtml}</ul>` : ''}

  ${
    rx.exams_requested
      ? `<div class="rx-section-title">Bilan biologique / radiologique demandé · الفحوصات والتحاليل المطلوبة</div>
         <div class="box" style="white-space:pre-line;font-size:13.5px;">${escapeHtml(rx.exams_requested)}</div>`
      : ''
  }

  ${
    rx.advice
      ? `<div class="rx-section-title">Conseils hygiéno-diététiques · نصائح وإرشادات طبية</div>
         <div class="box" style="white-space:pre-line;font-size:13px;">${escapeHtml(rx.advice)}</div>`
      : ''
  }

  <div class="signature-row">
    <div class="muted">
      ${clinic.name ? `<strong>${escapeHtml(clinic.name)}</strong><br>` : ''}
      ${clinic.address ? `${escapeHtml(clinic.address)}<br>` : ''}
      ${clinic.phone ? `Tél : ${escapeHtml(clinic.phone)}` : ''}
    </div>
    <div class="stamp-box">
      Cachet &amp; Signature du Médecin<br>
      <span class="ar">ختم وإمضاء الطبيب</span>
    </div>
  </div>

  <footer>
    <span> Prière de rapporter cette ordonnance à la prochaine consultation · يرجى إحضار هذه الوصفة في الفحص القادم</span>
    <span>MediRDV</span>
  </footer>
</div></body></html>`;
}

function certificateHtml({ certificate, clinic = {} }) {
  const c = certificate || {};
  const doctorName = c.doctor_name || clinic.doctor_name || 'Le Médecin soussigné';
  const cityLabel = clinic.wilaya || '';
  const dateLine = `${cityLabel ? `${escapeHtml(cityLabel)}, le ` : 'Le '}${fmtDate(c.day)}`;

  const titles = {
    arret_travail: ['CERTIFICAT MÉDICAL D’ARRÊT DE TRAVAIL', 'شهادة طبية للتوقف عن العمل (عطلة مرضية)'],
    aptitude: ['CERTIFICAT MÉDICAL D’APTITUDE', 'شهادة اللياقة الطبية'],
    scolaire: ['CERTIFICAT MÉDICAL SCOLAIRE', 'شهادة طبية مدرسية'],
    general: ['CERTIFICAT MÉDICAL', 'شـهـادة طـبـيـة'],
  };
  const [titleFr, titleAr] = titles[c.kind] || titles.general;

  let defaultBody = '';
  if (c.kind === 'arret_travail') {
    defaultBody =
      `Je soussigné(e), ${escapeHtml(doctorName)}, certifie avoir examiné ce jour ` +
      `le/la patient(e) <strong>${escapeHtml(c.patient_name)}</strong>` +
      `${c.patient_age ? ` (${escapeHtml(c.patient_age)})` : ''} ` +
      `et déclare que son état de santé nécessite un repos médical avec arrêt de travail de ` +
      `<strong>${escapeHtml(c.rest_days || 1)} jour(s)</strong>, sauf complications, ` +
      `à compter du <strong>${fmtDate(c.start_day || c.day)}</strong>.`;
  } else if (c.kind === 'aptitude') {
    defaultBody =
      `Je soussigné(e), ${escapeHtml(doctorName)}, certifie avoir examiné ce jour ` +
      `<strong>${escapeHtml(c.patient_name)}</strong>` +
      `${c.patient_age ? ` (${escapeHtml(c.patient_age)})` : ''} ` +
      `et n’avoir constaté aucun signe clinique apparent contre-indiquant l’aptitude physique / professionnelle.`;
  } else {
    defaultBody =
      `Je soussigné(e), ${escapeHtml(doctorName)}, certifie avoir examiné ce jour ` +
      `<strong>${escapeHtml(c.patient_name)}</strong>` +
      `${c.patient_age ? ` (${escapeHtml(c.patient_age)})` : ''}.`;
  }

  return `<!DOCTYPE html>
<html lang="fr"><head><meta charset="utf-8"><title>${titleFr} — ${escapeHtml(c.patient_name)}</title>
<style>${BASE_STYLE}</style></head>
<body><div class="sheet">
  ${medicalHeaderHtml(clinic, {
    doctor_name: c.doctor_name,
    doctor_specialty: c.doctor_specialty,
    doctor_ordre: c.doctor_ordre,
  })}

  <div style="text-align:right;font-size:13px;color:#475569;margin-bottom:10px;">
    <strong>${dateLine}</strong>
  </div>

  <div class="rx-banner">
    <h2>${titleFr}</h2>
    <div class="sub ar">${titleAr}</div>
  </div>

  <div class="cert-body">
    <p>${defaultBody}</p>
    ${c.content ? `<p style="white-space:pre-line;">${escapeHtml(c.content)}</p>` : ''}
    <p style="margin-top:24px;">Certificat délivré en main propre à l’intéressé(e) pour servir et valoir ce que de droit.</p>
  </div>

  <div class="signature-row">
    <div class="muted">
      ${clinic.name ? `<strong>${escapeHtml(clinic.name)}</strong><br>` : ''}
      ${clinic.address ? `${escapeHtml(clinic.address)}<br>` : ''}
      ${clinic.phone ? `Tél : ${escapeHtml(clinic.phone)}` : ''}
    </div>
    <div class="stamp-box">
      Cachet &amp; Signature du Médecin<br>
      <span class="ar">ختم وإمضاء الطبيب</span>
    </div>
  </div>

  <footer>
    <span>Document médical officiel · وثيقة طبية رسمية</span>
    <span>MediRDV</span>
  </footer>
</div></body></html>`;
}

function receiptHtml(receipt) {
  const { clinic, patient, appointment, currency } = receipt;
  return `<!DOCTYPE html>
<html lang="fr"><head><meta charset="utf-8"><title>Reçu ${escapeHtml(receipt.receipt_no)}</title>
<style>${BASE_STYLE}</style></head>
<body><div class="sheet">
  ${medicalHeaderHtml(clinic)}

  <div class="rx-banner">
    <h2>REÇU DE PAIEMENT · وصل دفع</h2>
    <div class="muted">N° ${escapeHtml(receipt.receipt_no)} · ${fmtDate(receipt.date)}</div>
  </div>

  <div class="box">
    <div class="row"><span>Patient</span><strong>${escapeHtml(patient.name)}</strong></div>
    ${patient.phone ? `<div class="row"><span>Téléphone</span><span>${escapeHtml(patient.phone)}</span></div>` : ''}
    ${appointment ? `<div class="row"><span>Rendez-vous</span><span>${fmtDate(appointment.day)} — N° ${escapeHtml(appointment.queue_number)}</span></div>` : ''}
    ${appointment?.department ? `<div class="row"><span>Service / المصلحة</span><span>${escapeHtml(appointment.department)}</span></div>` : ''}
    ${appointment?.treatment ? `<div class="row"><span>Acte médical</span><span>${escapeHtml(appointment.treatment)}</span></div>` : ''}
  </div>

  <table>
    <thead><tr><th>Désignation</th><th class="num">Montant</th></tr></thead>
    <tbody>
      <tr>
        <td>${escapeHtml(appointment?.treatment || 'Consultation médicale')}${
          appointment ? `<div class="muted">Tarif : ${fmtMoney(appointment.price, currency)}</div>` : ''
        }</td>
        <td class="num">${fmtMoney(receipt.amount, currency)}</td>
      </tr>
    </tbody>
  </table>

  <div class="row total"><span>Total payé</span><span>${fmtMoney(receipt.amount, currency)}</span></div>
  <div class="row"><span>Mode de paiement</span><span>${
    receipt.method === 'card' ? 'Carte' : receipt.method === 'transfer' ? 'Virement' : 'Espèces'
  }</span></div>
  <div class="row"><span>Reste à payer (dette)</span><span>${fmtMoney(receipt.remaining_debt, currency)}</span></div>
  ${receipt.note ? `<div class="muted">Note : ${escapeHtml(receipt.note)}</div>` : ''}

  <footer>
    <span>Merci de votre confiance · شكرا لثقتكم</span>
    <span>MediRDV</span>
  </footer>
</div></body></html>`;
}

function reportHtml(report) {
  const { currency } = report;
  const expenseRows = (report.expenses_detail || [])
    .map(
      (row) =>
        `<tr><td>${escapeHtml(row.category_fr)}${row.label ? ` — ${escapeHtml(row.label)}` : ''}</td>` +
        `<td class="num">${fmtMoney(row.amount, currency)}</td></tr>`,
    )
    .join('');
  const paymentRows = (report.payments || [])
    .map(
      (row) =>
        `<tr><td>${escapeHtml(row.full_name)}${row.note ? ` — ${escapeHtml(row.note)}` : ''}</td>` +
        `<td class="num">${fmtMoney(row.amount, currency)}</td></tr>`,
    )
    .join('');

  return `<!DOCTYPE html>
<html lang="fr"><head><meta charset="utf-8"><title>Rapport ${escapeHtml(report.day)}</title>
<style>${BASE_STYLE}</style></head>
<body><div class="sheet">
  <header>
    <div>
      <div class="clinic">${escapeHtml(report.day_label?.fr || report.day)}</div>
      <div class="muted">Rapport journalier · التقرير اليومي</div>
    </div>
    <div class="doc-title muted">MediRDV</div>
  </header>

  <div class="box">
    <div class="row"><span>Recettes encaissées</span><strong>${fmtMoney(report.income, currency)}</strong></div>
    <div class="row"><span>Dépenses</span><strong>${fmtMoney(report.expenses, currency)}</strong></div>
    <div class="row total"><span>Bénéfice net</span><span>${fmtMoney(report.net, currency)}</span></div>
    <div class="row"><span>Dettes non réglées (total)</span><span>${fmtMoney(report.unpaid_debts, currency)}</span></div>
  </div>

  <div class="box">
    <div class="row"><span>Rendez-vous</span><span>${report.appointments.total} (faits : ${report.appointments.done}, absents : ${report.appointments.no_show})</span></div>
    <div class="row"><span>Nouveaux patients</span><span>${report.new_patients}</span></div>
    <div class="row"><span>Paiements</span><span>${report.income_count}</span></div>
  </div>

  <h3>Paiements reçus</h3>
  <table><thead><tr><th>Patient</th><th class="num">Montant</th></tr></thead>
  <tbody>${paymentRows || '<tr><td colspan="2" class="muted">Aucun paiement</td></tr>'}</tbody></table>

  <h3>Dépenses</h3>
  <table><thead><tr><th>Catégorie</th><th class="num">Montant</th></tr></thead>
  <tbody>${expenseRows || '<tr><td colspan="2" class="muted">Aucune dépense</td></tr>'}</tbody></table>

  <footer><span>Document interne · وثيقة داخلية</span><span>MediRDV</span></footer>
</div></body></html>`;
}

/**
 * Render HTML in a hidden window and open the print dialog.
 * @param {object} data
 * @param {'receipt'|'report'|'prescription'|'certificate'} kind
 */
function printDocument(data, kind = 'receipt') {
  const { BrowserWindow } = require('electron');
  return new Promise((resolve, reject) => {
    const html =
      kind === 'report'
        ? reportHtml(data)
        : kind === 'prescription'
          ? prescriptionHtml(data)
          : kind === 'certificate'
            ? certificateHtml(data)
            : receiptHtml(data);

    const win = new BrowserWindow({
      show: false,
      width: 820,
      height: 1050,
      webPreferences: { sandbox: true, contextIsolation: true },
    });

    const done = (error) => {
      if (!win.isDestroyed()) win.destroy();
      if (error) reject(error);
      else resolve({ ok: true });
    };

    win.webContents.once('did-finish-load', () => {
      win.webContents.print({ silent: false, printBackground: true }, (success, failureReason) => {
        if (success) done();
        else done(new Error(failureReason || 'PRINT_CANCELLED'));
      });
    });
    win.webContents.once('did-fail-load', (_event, code, description) => {
      done(new Error(`PRINT_FAILED:${code}:${description}`));
    });
    win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  });
}

module.exports = {
  printDocument,
  receiptHtml,
  reportHtml,
  prescriptionHtml,
  certificateHtml,
};
