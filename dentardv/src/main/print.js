'use strict';
/**
 * Printing helper: renders receipt / report HTML into a hidden window and
 * sends it to the default printer (or the print dialog). No extra dependency.
 */

const { BrowserWindow } = require('electron');

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
 * Render HTML in a hidden window and open the print dialog.
 * @param {object} data receipt or daily report
 * @param {'receipt'|'report'} kind
 */
function printDocument(data, kind = 'receipt') {
  return new Promise((resolve, reject) => {
    const html = kind === 'report' ? reportHtml(data) : receiptHtml(data);
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

module.exports = { printDocument, receiptHtml, reportHtml };
