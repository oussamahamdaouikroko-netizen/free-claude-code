'use strict';
/**
 * Printing helper for DentaRDV v2.0.0:
 *  - Payment receipts (`receiptHtml`)
 *  - Daily financial reports (`reportHtml`)
 *  - Dental prescriptions (`prescriptionHtml` — A4 / A5, Brand/DCI/Both, QR-verified)
 *  - Dental medical certificates (`certificateHtml` — QR-verified)
 */

const { buildDocumentQr } = require('./utils/qr');

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
    margin: 0; padding: 24px; color: #12262b; background: #fff;
  }
  .sheet { max-width: 720px; margin: 0 auto; }
  header { display: flex; justify-content: space-between; gap: 16px;
    border-bottom: 3px solid #1f6f6b; padding-bottom: 12px; margin-bottom: 20px; }
  .clinic { font-size: 20px; font-weight: 700; color: #1f6f6b; }
  .muted { color: #5b6f74; font-size: 12px; line-height: 1.5; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .ar { direction: rtl; font-family: "Segoe UI", Tahoma, Arial, sans-serif; }
  .doc-title { text-align: right; }
  table { width: 100%; border-collapse: collapse; margin: 16px 0; font-size: 13px; }
  th, td { text-align: left; padding: 8px; border-bottom: 1px solid #e3eceb; }
  th { background: #f2f7f6; font-weight: 600; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .total { font-size: 20px; font-weight: 700; color: #1f6f6b; }
  .box { border: 1px solid #d7e4e2; border-radius: 10px; padding: 14px 16px; margin: 12px 0; }
  .row { display: flex; justify-content: space-between; padding: 3px 0; font-size: 13px; }
  footer { margin-top: 28px; padding-top: 10px; border-top: 1px dashed #cbd9d7;
    font-size: 11px; color: #6b7d81; display: flex; justify-content: space-between; }
  @page { margin: 12mm; }
`;

function receiptHtml(receipt) {
  const { clinic, patient, appointment, currency } = receipt;
  return `<!DOCTYPE html>
<html lang="fr"><head><meta charset="utf-8"><title>Reçu ${escapeHtml(receipt.receipt_no)}</title>
<style>${BASE_STYLE}</style></head>
<body><div class="sheet">
  <header>
    <div>
      <div class="clinic">${escapeHtml(clinic.name)}</div>
      <div class="muted">${escapeHtml(clinic.address || '')}<br>${clinic.phone ? `Tél : ${escapeHtml(clinic.phone)}` : ''}</div>
    </div>
    <div class="doc-title">
      <h1>REÇU DE PAIEMENT</h1>
      <div class="ar">وصل دفع</div>
      <div class="muted">N° ${escapeHtml(receipt.receipt_no)} · ${fmtDate(receipt.date)}</div>
    </div>
  </header>

  <div class="box">
    <div class="row"><span>Patient</span><strong>${escapeHtml(patient.name)}</strong></div>
    ${patient.phone ? `<div class="row"><span>Téléphone</span><span>${escapeHtml(patient.phone)}</span></div>` : ''}
    ${appointment ? `<div class="row"><span>Rendez-vous</span><span>${fmtDate(appointment.day)} — N° ${escapeHtml(appointment.queue_number)}</span></div>` : ''}
    ${appointment?.treatment ? `<div class="row"><span>Soin</span><span>${escapeHtml(appointment.treatment)}</span></div>` : ''}
  </div>

  <table>
    <thead><tr><th>Désignation</th><th class="num">Montant</th></tr></thead>
    <tbody>
      <tr>
        <td>${escapeHtml(appointment?.treatment || 'Soins dentaires')}${
          appointment ? `<div class="muted">Tarif du soin : ${fmtMoney(appointment.price, currency)}</div>` : ''
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
    <span>DentaRDV</span>
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
    <div class="doc-title muted">DentaRDV</div>
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

  <footer><span>Document interne · وثيقة داخلية</span><span>DentaRDV</span></footer>
</div></body></html>`;
}

/**
 * Render an Algerian Dental Prescription (`Ordonnance Dentaire` — A4 or A5).
 */
async function prescriptionHtml(rx, options = {}) {
  const clinic = rx.clinic || {};
  const isA5 = String(options.format || rx.format || 'A4').toUpperCase() === 'A5';
  const printMode = ['brand', 'dci', 'both'].includes(options.print_mode || rx.print_mode)
    ? (options.print_mode || rx.print_mode)
    : 'both';

  let qrInfo = null;
  try {
    qrInfo = await buildDocumentQr({
      kind: 'RX',
      id: rx.id || 0,
      day: rx.day || '',
      patientName: rx.patient_name || '',
      doctorOrdre: rx.doctor_ordre || '',
    });
  } catch (_e) {
    qrInfo = null;
  }

  const itemsHtml = (rx.items || [])
    .map((item, idx) => {
      let titleLabel = escapeHtml(item.drug_name);
      let dciSub = '';
      if (printMode === 'dci' && item.dci) {
        titleLabel = escapeHtml(item.dci);
        dciSub = item.drug_name ? `<span class="rx-dci">(Réf : ${escapeHtml(item.drug_name)})</span>` : '';
      } else if (printMode === 'brand') {
        titleLabel = escapeHtml(item.drug_name);
      } else if (item.dci) {
        dciSub = `<span class="rx-dci">(DCI : ${escapeHtml(item.dci)})</span>`;
      }
      const nonSubst = item.substitutable === 0
        ? '<span class="rx-ns">Non substituable</span>'
        : '';
      const posologyParts = [
        item.dosage ? `<strong>${escapeHtml(item.dosage)}</strong>` : '',
        item.timing ? escapeHtml(item.timing) : '',
        item.duration ? `pendant <strong>${escapeHtml(item.duration)}</strong>` : '',
      ].filter(Boolean);

      return `<div class="rx-item">
        <div class="rx-drug-row">
          <span class="rx-num">${idx + 1}.</span>
          <div class="rx-drug-main">
            <span class="rx-brand">${titleLabel}</span>
            ${item.form_strength ? `<span class="rx-form">${escapeHtml(item.form_strength)}</span>` : ''}
            ${dciSub}
            ${nonSubst}
          </div>
          ${item.quantity ? `<span class="rx-qty">${escapeHtml(item.quantity)}</span>` : ''}
        </div>
        ${posologyParts.length ? `<div class="rx-posology">↳ ${posologyParts.join(' · ')}</div>` : ''}
        ${item.note ? `<div class="rx-note">Note : ${escapeHtml(item.note)}</div>` : ''}
      </div>`;
    })
    .join('');

  const patientMeta = [
    rx.patient_age ? `Âge : ${escapeHtml(rx.patient_age)}` : '',
    rx.patient_weight ? `Poids : ${escapeHtml(rx.patient_weight)}` : '',
    rx.tooth_ref ? `Dent(s) / Secteur : ${escapeHtml(rx.tooth_ref)}` : '',
  ].filter(Boolean);

  return `<!DOCTYPE html>
<html lang="fr"><head><meta charset="utf-8"><title>Ordonnance Dentaire N° ${escapeHtml(rx.id)}</title>
<style>
  * { box-sizing: border-box; }
  body {
    font-family: "Segoe UI", "Tahoma", Arial, sans-serif;
    margin: 0; padding: ${isA5 ? '14px' : '24px'}; color: #12262b; background: #fff;
  }
  .sheet {
    max-width: ${isA5 ? '520px' : '740px'};
    min-height: ${isA5 ? '680px' : '940px'};
    margin: 0 auto; display: flex; flex-direction: column; justify-content: space-between;
  }
  .rx-header {
    display: flex; justify-content: space-between; align-items: flex-start; gap: 16px;
    border-bottom: 3px double #1f6f6b; padding-bottom: 12px; margin-bottom: 14px;
  }
  .rx-doc-left { max-width: 56%; }
  .rx-clinic { font-size: ${isA5 ? '16px' : '19px'}; font-weight: 800; color: #1f6f6b; }
  .rx-doctor { font-size: ${isA5 ? '13px' : '15px'}; font-weight: 700; margin-top: 2px; }
  .rx-spec { font-size: 12px; color: #2b7a78; font-weight: 600; }
  .rx-muted { color: #5b6f74; font-size: 11.5px; line-height: 1.45; margin-top: 3px; }
  .rx-doc-right { text-align: right; }
  .rx-title-fr { font-size: ${isA5 ? '16px' : '20px'}; font-weight: 800; letter-spacing: 0.05em; color: #1f6f6b; }
  .rx-title-ar { font-size: ${isA5 ? '15px' : '18px'}; font-weight: 700; direction: rtl; color: #12262b; }
  .rx-patient-bar {
    display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;
    background: #f2f7f6; border: 1px solid #d5e5e3; border-radius: 8px;
    padding: 9px 14px; margin-bottom: 16px; font-size: 13px;
  }
  .rx-controlled-banner {
    border: 1.5px solid #b42318; background: #fef3f2; color: #912018;
    border-radius: 6px; padding: 6px 12px; margin-bottom: 12px; font-size: 11.5px; font-weight: 700;
    display: flex; justify-content: space-between;
  }
  .rx-body { flex: 1; padding: 4px 2px; }
  .rx-symbol { font-size: 20px; font-weight: 800; color: #1f6f6b; font-family: Georgia, serif; margin-bottom: 8px; }
  .rx-item {
    padding: 9px 4px; border-bottom: 1px dashed #e1ecea;
  }
  .rx-drug-row { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
  .rx-num { font-weight: 800; color: #1f6f6b; min-width: 20px; font-size: 14px; }
  .rx-drug-main { flex: 1; }
  .rx-brand { font-weight: 700; font-size: ${isA5 ? '13.5px' : '15px'}; color: #12262b; }
  .rx-form { font-size: 12.5px; color: #365257; margin-left: 6px; font-weight: 600; }
  .rx-dci { font-size: 11.5px; color: #5b6f74; margin-left: 6px; font-style: italic; }
  .rx-ns { font-size: 10px; font-weight: 700; color: #b42318; border: 1px solid #fecdca; background: #fef3f2; border-radius: 4px; padding: 1px 5px; margin-left: 6px; text-transform: uppercase; }
  .rx-qty {
    font-size: 12px; font-weight: 700; color: #1f6f6b;
    background: #eef6f5; padding: 2px 8px; border-radius: 99px; white-space: nowrap;
  }
  .rx-posology { margin: 4px 0 0 22px; font-size: ${isA5 ? '12.5px' : '13.5px'}; color: #1d353b; }
  .rx-note { margin: 2px 0 0 22px; font-size: 11.5px; color: #6b7d81; }
  .rx-section {
    margin-top: 14px; padding: 10px 12px; border-left: 3px solid #1f6f6b;
    background: #f9fbfb; border-radius: 0 8px 8px 0; font-size: 12.5px; line-height: 1.5;
  }
  .rx-section strong { display: block; color: #1f6f6b; margin-bottom: 3px; font-size: 12px; text-transform: uppercase; }
  .rx-footer {
    margin-top: 24px; padding-top: 12px; border-top: 1px solid #d5e5e3;
    display: flex; justify-content: space-between; align-items: flex-end; font-size: 11.5px; color: #5b6f74;
  }
  .rx-qr-box { display: flex; align-items: center; gap: 8px; }
  .rx-qr-box img { width: 64px; height: 64px; border: 1px solid #d5e5e3; border-radius: 6px; padding: 2px; }
  .rx-stamp {
    width: 195px; height: 78px; border: 1px dashed #9fb8b5; border-radius: 8px;
    display: flex; align-items: center; justify-content: center; color: #87a09d; font-size: 11px;
    text-align: center;
  }
  @page { size: ${isA5 ? 'A5 portrait' : 'A4 portrait'}; margin: ${isA5 ? '8mm' : '12mm'}; }
</style></head>
<body><div class="sheet">
  <div>
    <div class="rx-header">
      <div class="rx-doc-left">
        <div class="rx-clinic">🦷 ${escapeHtml(clinic.name || 'Cabinet Dentaire')}</div>
        ${rx.doctor_name ? `<div class="rx-doctor">${escapeHtml(rx.doctor_name)}</div>` : ''}
        <div class="rx-spec">${escapeHtml(rx.doctor_specialty || 'Chirurgien-Dentiste · جراح أسنان')}</div>
        ${rx.doctor_ordre ? `<div class="rx-muted">N° Ordre des Médecins Dentistes : ${escapeHtml(rx.doctor_ordre)}</div>` : ''}
        <div class="rx-muted">
          ${clinic.address ? `${escapeHtml(clinic.address)}<br>` : ''}
          ${clinic.phone ? `Tél : ${escapeHtml(clinic.phone)}` : ''}
        </div>
      </div>
      <div class="rx-doc-right">
        <div class="rx-title-fr">ORDONNANCE</div>
        <div class="rx-title-ar">وصفة طبية لطب الأسنان</div>
        <div class="rx-muted">N° ${String(rx.id || 1).padStart(5, '0')} · Le ${fmtDate(rx.day)}</div>
      </div>
    </div>

    <div class="rx-patient-bar">
      <div><strong>Patient(e) :</strong> ${escapeHtml(rx.patient_name)}</div>
      <div>${patientMeta.join(' &nbsp;·&nbsp; ')}</div>
    </div>

    ${rx.controlled_rx ? `<div class="rx-controlled-banner">
      <span>SUBSTANCE SOUMISE À RÉGLEMENTATION — Durée &amp; identité vérifiées</span>
      <span dir="rtl">دواء خاضع للرقابة الخاصة</span>
    </div>` : ''}

    <div class="rx-body">
      ${itemsHtml ? `<div class="rx-symbol">℞</div>${itemsHtml}` : ''}

      ${rx.exams_requested ? `<div class="rx-section">
        <strong>Radiographies / Examens complémentaires · أشعة وفحوصات مطلوبة</strong>
        ${escapeHtml(rx.exams_requested).replace(/\n/g, '<br>')}
      </div>` : ''}

      ${rx.advice ? `<div class="rx-section">
        <strong>Conseils post-opératoires &amp; hygiène bucco-dentaire · إرشادات ونصائح ما بعد العلاج</strong>
        ${escapeHtml(rx.advice).replace(/\n/g, '<br>')}
      </div>` : ''}
    </div>
  </div>

  <div class="rx-footer">
    <div class="rx-qr-box">
      ${qrInfo?.dataUrl ? `<img src="${qrInfo.dataUrl}" alt="QR">` : ''}
      <div>
        <div>Ordonnance strictement personnelle · تحفظ بعيدا عن متناول الأطفال</div>
        <div style="margin-top:3px">Réf : ${escapeHtml(qrInfo?.shortHmac ? `DRDV-${rx.id}-${qrInfo.shortHmac}` : `DRDV-${rx.id || ''}`)}</div>
      </div>
    </div>
    <div class="rx-stamp">Cachet &amp; Signature du Chirurgien-Dentiste<br>الختم والإمضاء</div>
  </div>
</div></body></html>`;
}

const CERT_TITLES = {
  arret_travail: { fr: "CERTIFICAT D'ARRÊT DE TRAVAIL", ar: 'شهادة توقف عن العمل' },
  aptitude: { fr: 'CERTIFICAT BUCCO-DENTAIRE', ar: 'شهادة فحص الفم والأسنان' },
  scolaire: { fr: 'CERTIFICAT DENTAIRE SCOLAIRE', ar: 'شهادة طبية مدرسية لطب الأسنان' },
  general: { fr: 'CERTIFICAT MÉDICAL DENTAIRE', ar: 'شهادة طبية لطب الأسنان' },
};

async function certificateHtml(cert) {
  const clinic = cert.clinic || {};
  const titles = CERT_TITLES[cert.kind] || CERT_TITLES.general;
  const docName = cert.doctor_name || 'le Chirurgien-Dentiste soussigné';

  let qrInfo = null;
  try {
    qrInfo = await buildDocumentQr({
      kind: 'CERT',
      id: cert.id || 0,
      day: cert.day || '',
      patientName: cert.patient_name || '',
      doctorOrdre: cert.doctor_ordre || '',
    });
  } catch (_e) {
    qrInfo = null;
  }

  let defaultBody = '';
  if (cert.kind === 'arret_travail') {
    defaultBody =
      `Je soussigné(e), <strong>${escapeHtml(docName)}</strong>, Chirurgien-Dentiste, certifie avoir examiné et soigné ce jour ` +
      `le/la patient(e) <strong>${escapeHtml(cert.patient_name)}</strong>` +
      (cert.patient_age ? ` (${escapeHtml(cert.patient_age)})` : '') +
      ` et déclare que son état de santé bucco-dentaire nécessite un repos avec arrêt de travail de ` +
      `<strong>${escapeHtml(cert.rest_days || 1)} jour(s)</strong>, sauf complications, ` +
      `à compter du <strong>${fmtDate(cert.start_day || cert.day)}</strong>.`;
  } else if (cert.kind === 'aptitude') {
    defaultBody =
      `Je soussigné(e), <strong>${escapeHtml(docName)}</strong>, Chirurgien-Dentiste, certifie avoir examiné ce jour ` +
      `le/la patient(e) <strong>${escapeHtml(cert.patient_name)}</strong>` +
      (cert.patient_age ? ` (${escapeHtml(cert.patient_age)})` : '') +
      ` et atteste de la remise en état / absence de foyer infectieux bucco-dentaire évolutif ce jour.`;
  } else if (cert.kind === 'scolaire') {
    defaultBody =
      `Je soussigné(e), <strong>${escapeHtml(docName)}</strong>, Chirurgien-Dentiste, certifie avoir reçu en consultation dentaire ce jour ` +
      `l'élève <strong>${escapeHtml(cert.patient_name)}</strong>` +
      (cert.patient_age ? ` (${escapeHtml(cert.patient_age)})` : '') +
      (cert.rest_days > 0
        ? ` et que son état nécessite une éviction scolaire de <strong>${escapeHtml(cert.rest_days)} jour(s)</strong> à compter du <strong>${fmtDate(cert.start_day || cert.day)}</strong>.`
        : ` pour soins bucco-dentaires au cabinet.`);
  } else {
    defaultBody =
      `Je soussigné(e), <strong>${escapeHtml(docName)}</strong>, Chirurgien-Dentiste, certifie avoir examiné ce jour ` +
      `<strong>${escapeHtml(cert.patient_name)}</strong>` +
      (cert.patient_age ? ` (${escapeHtml(cert.patient_age)})` : '') +
      `.`;
  }

  return `<!DOCTYPE html>
<html lang="fr"><head><meta charset="utf-8"><title>${escapeHtml(titles.fr)}</title>
<style>
  ${BASE_STYLE}
  .cert-body {
    margin: 28px 0; padding: 22px 24px; border: 1px solid #d7e4e2; border-radius: 12px;
    font-size: 15px; line-height: 1.85; color: #12262b; background: #fcfefe;
  }
  .cert-custom { margin-top: 14px; white-space: pre-wrap; }
  .cert-sign {
    margin-top: 40px; display: flex; justify-content: space-between; align-items: flex-end;
  }
  .cert-qr { display: flex; align-items: center; gap: 8px; }
  .cert-qr img { width: 64px; height: 64px; border: 1px solid #d7e4e2; border-radius: 6px; padding: 2px; }
  .cert-stamp {
    width: 210px; height: 90px; border: 1px dashed #9fb8b5; border-radius: 8px;
    display: flex; align-items: center; justify-content: center; color: #87a09d; font-size: 11.5px;
    text-align: center;
  }
</style></head>
<body><div class="sheet">
  <header>
    <div>
      <div class="clinic">🦷 ${escapeHtml(clinic.name || 'Cabinet Dentaire')}</div>
      ${cert.doctor_name ? `<div><strong>${escapeHtml(cert.doctor_name)}</strong> — ${escapeHtml(cert.doctor_specialty || 'Chirurgien-Dentiste')}</div>` : ''}
      <div class="muted">
        ${cert.doctor_ordre ? `N° Ordre : ${escapeHtml(cert.doctor_ordre)}<br>` : ''}
        ${escapeHtml(clinic.address || '')}${clinic.phone ? ` · Tél : ${escapeHtml(clinic.phone)}` : ''}
      </div>
    </div>
    <div class="doc-title">
      <h1>${escapeHtml(titles.fr)}</h1>
      <div class="ar">${escapeHtml(titles.ar)}</div>
      <div class="muted">N° ${String(cert.id || 1).padStart(5, '0')} · Le ${fmtDate(cert.day)}</div>
    </div>
  </header>

  <div class="cert-body">
    <div>${defaultBody}</div>
    ${cert.content ? `<div class="cert-custom">${escapeHtml(cert.content)}</div>` : ''}
    <div style="margin-top:18px" class="muted">
      Certificat délivré en main propre à l'intéressé(e) pour servir et valoir ce que de droit.
    </div>
  </div>

  <div class="cert-sign">
    <div class="cert-qr">
      ${qrInfo?.dataUrl ? `<img src="${qrInfo.dataUrl}" alt="QR">` : ''}
      <div class="muted">
        Fait le ${fmtDate(cert.day)}<br>
        ${qrInfo?.shortHmac ? `Réf : DRDV-C${cert.id}-${qrInfo.shortHmac}` : ''}
      </div>
    </div>
    <div class="cert-stamp">Cachet &amp; Signature du Chirurgien-Dentiste<br>الختم والإمضاء</div>
  </div>
</div></body></html>`;
}

/**
 * Render HTML in a hidden window and open the print dialog.
 * @param {object} data
 * @param {'receipt'|'report'|'prescription'|'certificate'} kind
 * @param {{ format?: 'A4'|'A5', print_mode?: 'brand'|'dci'|'both' }} [options]
 */
async function printDocument(data, kind = 'receipt', options = {}) {
  const { BrowserWindow } = require('electron');
  let html;
  if (kind === 'report') html = reportHtml(data);
  else if (kind === 'prescription') html = await prescriptionHtml(data, options);
  else if (kind === 'certificate') html = await certificateHtml(data);
  else html = receiptHtml(data);

  return new Promise((resolve, reject) => {
    const win = new BrowserWindow({
      show: false,
      width: 820,
      height: 1000,
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
