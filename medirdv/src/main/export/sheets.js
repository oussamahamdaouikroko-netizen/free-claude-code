'use strict';
/**
 * Builds the Google Sheets / Excel workbook from clinic data.
 *
 * Three flavours, all offline:
 *   daily   → one day (the report on screen)
 *   monthly → one month + a per-day series
 *   full    → the whole clinic: patients, debts, appointments, payments,
 *             expenses, treatments (the accountant's file)
 *
 * Every sheet is designed the way a spreadsheet should be: header row in row 1,
 * frozen, auto-filtered, real date and money cells (so Google Sheets can sum,
 * sort and chart immediately), and column widths already set.
 */

const reports = require('../services/reports');
const patientsService = require('../services/patients');
const appointmentsService = require('../services/appointments');
const paymentsService = require('../services/payments');
const expensesService = require('../services/expenses');
const treatmentsService = require('../services/treatments');
const settingsService = require('../services/settings');
const { getDb } = require('../db');
const { buildWorkbook } = require('./xlsx');
const { toISODate, addDays, formatLong } = require('../utils/dates');

const money = (value) => ({ money: Number(value) || 0 });
const date = (value) => ({ date: value });
const header = (label) => ({ text: label, style: 'header' });

/** A row of headers, frozen and filtered — the default shape of every sheet. */
function tableSheet(name, columns, rows, widths) {
  return {
    name,
    widths: widths || columns.map((column) => column.width || 18),
    freezeRow: 1,
    filter: { row: 1 },
    rows: [
      columns.map((column) => header(column.label)),
      ...rows.map((row) => columns.map((column) => column.cell(row))),
    ],
  };
}

/** "Indicateur / Valeur" summary used at the top of daily & monthly workbooks. */
function summarySheet(title, clinic, entries, currency) {
  const rows = [
    [{ text: clinic, style: 'title' }, { text: '' }],
    [{ text: title, style: 'title' }],
    [],
    { cells: [header('Indicateur'), header('Valeur')] },
    ...entries.map(([label, value, kind]) => [
      label,
      kind === 'money' ? money(value) : kind === 'date' ? date(value) : value,
    ]),
    [],
    ['Devise', currency],
    ['Généré le', date(toISODate())],
    ['MediRDV', 'Application hors ligne — données de la clinique uniquement'],
  ];
  return { name: 'Résumé', widths: [34, 46], rows };
}

function patientsSheet() {
  const rows = patientsService.list('', { limit: 2000 });
  return tableSheet(
    'Patients',
    [
      { label: 'Nom complet', cell: (p) => p.full_name, width: 30 },
      { label: 'Téléphone', cell: (p) => p.phone || '', width: 16 },
      { label: 'Solde dû', cell: (p) => money(p.balance), width: 14 },
      { label: 'Dernière visite', cell: (p) => (p.last_visit ? date(p.last_visit) : ''), width: 15 },
      { label: 'Notes', cell: (p) => p.notes || '', width: 40 },
      { label: 'Créé le', cell: (p) => (p.created_at ? date(p.created_at.slice(0, 10)) : ''), width: 13 },
    ],
    rows,
  );
}

function debtsSheet() {
  const rows = patientsService.debtors();
  return tableSheet(
    'Dettes',
    [
      { label: 'Nom complet', cell: (p) => p.full_name, width: 30 },
      { label: 'Téléphone', cell: (p) => p.phone || '', width: 16 },
      { label: 'Montant dû', cell: (p) => money(p.balance), width: 14 },
      { label: 'Dernière visite', cell: (p) => (p.last_visit ? date(p.last_visit) : ''), width: 15 },
    ],
    rows,
  );
}

function appointmentsSheet(start, end) {
  const rows = appointmentsService.listRange(start || addDays(toISODate(), -3650), end || toISODate());
  return tableSheet(
    'Rendez-vous',
    [
      { label: 'Date', cell: (a) => date(a.day), width: 13 },
      { label: 'N°', cell: (a) => a.queue_number, width: 7 },
      { label: 'Patient', cell: (a) => a.patient_name || '', width: 28 },
      { label: 'Téléphone', cell: (a) => a.patient_phone || '', width: 16 },
      { label: 'Soin', cell: (a) => a.treatment_name || '', width: 28 },
      { label: 'Prix', cell: (a) => money(a.price), width: 13 },
      { label: 'Payé', cell: (a) => money(a.paid), width: 13 },
      { label: 'Reste', cell: (a) => money((a.price || 0) - (a.paid || 0)), width: 13 },
      { label: 'Statut', cell: (a) => a.status || '', width: 12 },
      { label: 'Origine', cell: (a) => a.source || '', width: 12 },
    ],
    rows,
  );
}

function paymentsSheet(start, end) {
  const rows = getDb()
    .prepare(
      `SELECT pay.paid_at, p.full_name, p.phone, pay.amount, pay.method, pay.note
       FROM payments pay LEFT JOIN patients p ON p.id = pay.patient_id
       WHERE substr(pay.paid_at, 1, 10) BETWEEN ? AND ?
       ORDER BY pay.paid_at DESC`,
    )
    .all(start, end);
  return tableSheet(
    'Paiements',
    [
      { label: 'Date', cell: (p) => date(p.paid_at.slice(0, 10)), width: 13 },
      { label: 'Patient', cell: (p) => p.full_name || '', width: 28 },
      { label: 'Téléphone', cell: (p) => p.phone || '', width: 16 },
      { label: 'Montant', cell: (p) => money(p.amount), width: 14 },
      { label: 'Mode', cell: (p) => p.method || '', width: 12 },
      { label: 'Note', cell: (p) => p.note || '', width: 34 },
    ],
    rows,
  );
}

function expensesSheet(start, end) {
  const rows = expensesService.list({ start, end });
  return tableSheet(
    'Dépenses',
    [
      { label: 'Date', cell: (e) => date(e.day), width: 13 },
      { label: 'Catégorie', cell: (e) => e.category_fr || e.category || '', width: 20 },
      { label: 'Libellé', cell: (e) => e.label || '', width: 34 },
      { label: 'Montant', cell: (e) => money(e.amount), width: 14 },
    ],
    rows,
  );
}

function treatmentsSheet(start, end) {
  const rows = treatmentsService.list();
  const performed = getDb()
    .prepare(
      `SELECT treatment_id, COUNT(*) AS times, COALESCE(SUM(price), 0) AS revenue
       FROM appointments
       WHERE day BETWEEN ? AND ? AND status <> 'cancelled' AND treatment_id IS NOT NULL
       GROUP BY treatment_id`,
    )
    .all(start, end);
  const byId = new Map(performed.map((row) => [row.treatment_id, row]));
  return tableSheet(
    'Actes',
    [
      { label: 'Acte médical (FR)', cell: (t) => t.name_fr, width: 30 },
      { label: 'Acte médical (AR)', cell: (t) => t.name_ar || '', width: 26 },
      { label: 'Tarif par défaut', cell: (t) => money(t.default_price), width: 16 },
      { label: 'Réalisés (période)', cell: (t) => byId.get(t.id)?.times || 0, width: 18 },
      { label: 'Chiffre (période)', cell: (t) => money(byId.get(t.id)?.revenue || 0), width: 18 },
    ],
    rows,
  );
}

function seriesSheet(series) {
  return tableSheet(
    'Par jour',
    [
      { label: 'Date', cell: (row) => date(row.day), width: 13 },
      { label: 'Recettes', cell: (row) => money(row.income), width: 14 },
      { label: 'Dépenses', cell: (row) => money(row.expenses), width: 14 },
      { label: 'Net', cell: (row) => money(row.net), width: 14 },
    ],
    series,
  );
}

function expenseCategoriesSheet(rows) {
  return tableSheet(
    'Dépenses par catégorie',
    [
      { label: 'Catégorie', cell: (row) => row.category_fr || row.category || '', width: 24 },
      { label: 'Montant', cell: (row) => money(row.total), width: 16 },
    ],
    rows,
  );
}

/** Daily workbook: summary + payments + expenses + treatments of that day. */
function dailyWorkbook(day) {
  const report = reports.daily(day);
  const clinic = settingsService.get('clinic_name') || 'Cabinet';
  const currency = report.currency;
  const label = formatLong(report.day, 'fr');

  const summary = summarySheet(
    `Rapport du ${label}`,
    clinic,
    [
      ['Recettes encaissées', report.income, 'money'],
      ['Nombre de paiements', report.income_count],
      ['Dépenses', report.expenses, 'money'],
      ['Bénéfice net', report.net, 'money'],
      ['Dettes non réglées', report.unpaid_debts, 'money'],
      ['Rendez-vous du jour', report.appointments.total],
      ['Terminés', report.appointments.done],
      ['Absents', report.appointments.no_show],
      ['Nouveaux patients', report.new_patients],
    ],
    currency,
  );

  const sheets = [
    summary,
    tableSheet(
      'Paiements',
      [
        { label: 'Patient', cell: (row) => row.full_name || '', width: 28 },
        { label: 'Note', cell: (row) => row.note || '', width: 30 },
        { label: 'Montant', cell: (row) => money(row.amount), width: 14 },
      ],
      report.payments || [],
    ),
    expensesSheet(report.day, report.day),
    treatmentsSheet(report.day, report.day),
  ];
  return {
    buffer: buildWorkbook(sheets, { title: `MediRDV — ${label}`, creator: clinic }),
    filename: `MediRDV-${report.day}.xlsx`,
    label,
    sheets: sheets.map((sheet) => sheet.name),
  };
}

/** Monthly workbook: summary + day series + categories + all movements. */
function monthlyWorkbook(month) {
  const report = reports.monthly(month);
  const clinic = settingsService.get('clinic_name') || 'Cabinet';
  const currency = report.currency;
  const label = `${report.start} → ${report.end}`;

  const summary = summarySheet(
    `Rapport du ${label}`,
    clinic,
    [
      ['Recettes encaissées', report.income, 'money'],
      ['Nombre de paiements', report.income_count],
      ['Dépenses', report.expenses, 'money'],
      ['Bénéfice net', report.net, 'money'],
      ['Dettes non réglées', report.unpaid_debts, 'money'],
      ['Rendez-vous', report.appointments.total],
      ['Terminés', report.appointments.done],
      ['Absents', report.appointments.no_show],
      ['Nouveaux patients', report.new_patients],
      ['Recette moyenne / jour', report.average_income_per_day, 'money'],
      ['Meilleur jour', report.best_day ? report.best_day.day : '', 'date'],
    ],
    currency,
  );

  const sheets = [
    summary,
    seriesSheet(report.series || []),
    expenseCategoriesSheet(report.expenses_by_category || []),
    paymentsSheet(report.start, report.end),
    expensesSheet(report.start, report.end),
    treatmentsSheet(report.start, report.end),
  ];
  return {
    buffer: buildWorkbook(sheets, { title: `MediRDV — ${label}`, creator: clinic }),
    filename: `MediRDV-${report.month}.xlsx`,
    label,
    sheets: sheets.map((sheet) => sheet.name),
  };
}

/** Everything, for the accountant or a full backup in a readable format. */
function fullWorkbook() {
  const clinic = settingsService.get('clinic_name') || 'Cabinet';
  const currency = settingsService.get('currency') || 'DZD';
  const today = toISODate();
  const start = addDays(today, -3650);
  const monthly = reports.monthly(today.slice(0, 7));

  const summary = summarySheet(
    'Export complet du cabinet',
    clinic,
    [
      ['Dette totale des patients', patientsService.totalDebt(), 'money'],
      ['Recettes du mois en cours', monthly.income, 'money'],
      ['Dépenses du mois en cours', monthly.expenses, 'money'],
      ['Rendez-vous du mois', monthly.appointments.total],
      ['Patients enregistrés', patientsService.list('', { limit: 2000 }).length],
    ],
    currency,
  );

  const sheets = [
    summary,
    patientsSheet(),
    debtsSheet(),
    appointmentsSheet(start, today),
    paymentsSheet(start, today),
    expensesSheet(start, today),
    treatmentsSheet(start, today),
  ];
  return {
    buffer: buildWorkbook(sheets, { title: `MediRDV — ${clinic}`, creator: clinic }),
    filename: `MediRDV-complet-${today}.xlsx`,
    label: today,
    sheets: sheets.map((sheet) => sheet.name),
  };
}

/**
 * Tab-separated text of one table: the user selects it in Google Sheets and
 * pastes with Ctrl+V. Works with zero dialogs and zero files.
 */
function tsv(rows) {
  return rows
    .map((row) =>
      row
        .map((value) => String(value ?? '').replace(/\t/g, ' ').replace(/\r?\n/g, ' '))
        .join('\t'),
    )
    .join('\n');
}

/** Clipboard-ready table for the daily or monthly report. */
function clipboardTable(kind, arg) {
  if (kind === 'monthly') {
    const report = reports.monthly(arg);
    return tsv([
      ['Date', 'Recettes', 'Dépenses', 'Net'],
      ...(report.series || []).map((row) => [row.day, row.income, row.expenses, row.net]),
      ['TOTAL', report.income, report.expenses, report.net],
    ]);
  }
  const report = reports.daily(arg);
  return tsv([
    ['Indicateur', 'Valeur'],
    ['Recettes encaissées', report.income],
    ['Dépenses', report.expenses],
    ['Bénéfice net', report.net],
    ['Dettes non réglées', report.unpaid_debts],
    ['Rendez-vous', report.appointments.total],
    ['Absents', report.appointments.no_show],
    ['Nouveaux patients', report.new_patients],
  ]);
}

function build(kind, arg) {
  if (kind === 'monthly') return monthlyWorkbook(arg);
  if (kind === 'full') return fullWorkbook();
  return dailyWorkbook(arg);
}

module.exports = {
  build,
  dailyWorkbook,
  monthlyWorkbook,
  fullWorkbook,
  clipboardTable,
  tsv,
};
