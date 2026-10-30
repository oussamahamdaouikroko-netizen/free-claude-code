'use strict';
/**
 * Phase 6 — Billing, CNAS/CASNOS Conventions, Gap-Free Sequential Invoices,
 * Refunds, Daily Z-Report & Insurance Claim Export (CSV / XLSX).
 */

const fs = require('node:fs');
const { getDb } = require('../db');
const patients = require('./patients');
const payments = require('./payments');
const { buildWorkbook } = require('../export/xlsx');
const { AppError, money, cleanText, requireId } = require('../utils/common');
const { toISODate } = require('../utils/dates');

function computeLineSplit({ treatmentId, description, quantity = 1, unitPrice, insuranceType = 'none', insuranceRate }) {
  const db = getDb();
  let tr = null;
  if (treatmentId) {
    tr = db.prepare('SELECT * FROM treatments WHERE id = ?').get(Number(treatmentId));
  }
  const qty = Math.max(1, Number.parseInt(quantity, 10) || 1);
  const isInsured = insuranceType === 'CNAS' || insuranceType === 'CASNOS' || insuranceType === 'other';
  let resolvedUnit = unitPrice !== undefined && unitPrice !== null && unitPrice !== '' ? Number(unitPrice) : null;
  if (resolvedUnit === null) {
    if (tr) {
      resolvedUnit = isInsured
        ? Number(tr.price_insured ?? tr.default_price ?? 0)
        : Number(tr.price_private ?? tr.default_price ?? 0);
    } else {
      resolvedUnit = 0;
    }
  }
  resolvedUnit = money(Math.max(0, resolvedUnit));
  const lineTotal = money(resolvedUnit * qty);

  let rate = 0;
  if (insuranceType === 'free') {
    rate = 100;
  } else if (isInsured) {
    rate =
      insuranceRate !== undefined && insuranceRate !== null && insuranceRate !== ''
        ? Math.min(100, Math.max(0, Number.parseInt(insuranceRate, 10) || 0))
        : tr?.convention_rate ?? 80;
  }

  const insuredShare = insuranceType === 'free' ? 0 : money((lineTotal * rate) / 100);
  const patientShare = insuranceType === 'free' ? 0 : money(lineTotal - insuredShare);

  return {
    treatment_id: tr ? tr.id : null,
    description: cleanText(description || tr?.name_fr || 'Acte médical', 160),
    quantity: qty,
    unit_price: resolvedUnit,
    insured_rate: rate,
    line_total: lineTotal,
    insured_share: insuredShare,
    patient_share: patientShare,
  };
}

function previewCoverage(input = {}) {
  const insType = ['none', 'CNAS', 'CASNOS', 'other', 'free'].includes(input.insurance_type)
    ? input.insurance_type
    : 'none';
  const rawItems = Array.isArray(input.items) && input.items.length > 0
    ? input.items
    : [{ treatment_id: input.treatment_id, description: input.description, quantity: 1, unit_price: input.price }];

  const lines = rawItems.map((it) =>
    computeLineSplit({
      treatmentId: it.treatment_id,
      description: it.description,
      quantity: it.quantity,
      unitPrice: it.unit_price,
      insuranceType: insType,
      insuranceRate: it.insured_rate ?? input.insurance_rate,
    }),
  );

  const subtotal = money(lines.reduce((s, l) => s + l.line_total, 0));
  const discount = money(Math.min(subtotal, Math.max(0, Number(input.discount_amount) || 0)));
  const totalAmount = insType === 'free' ? 0 : money(subtotal - discount);
  const rawInsured = money(lines.reduce((s, l) => s + l.insured_share, 0));
  const insuredShare = insType === 'free' ? 0 : money(Math.min(totalAmount, rawInsured));
  const patientShare = insType === 'free' ? 0 : money(Math.max(0, totalAmount - insuredShare));

  return {
    insurance_type: insType,
    subtotal,
    discount_amount: discount,
    total_amount: totalAmount,
    insured_share: insuredShare,
    patient_share: patientShare,
    items: lines,
  };
}

function nextInvoiceNumber(db, year) {
  db.prepare('INSERT INTO invoice_counters (year, last_seq) VALUES (?, 0) ON CONFLICT(year) DO NOTHING').run(year);
  db.prepare('UPDATE invoice_counters SET last_seq = last_seq + 1 WHERE year = ?').run(year);
  const seq = db.prepare('SELECT last_seq FROM invoice_counters WHERE year = ?').get(year).last_seq;
  return {
    year,
    seq,
    invoice_number: `FAC-${year}-${String(seq).padStart(5, '0')}`,
  };
}

function getInvoice(id) {
  const invId = requireId(id);
  const row = getDb().prepare('SELECT * FROM invoices WHERE id = ?').get(invId);
  if (!row) throw new AppError('NOT_FOUND', 'Invoice not found.');
  const items = getDb()
    .prepare('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY id ASC')
    .all(invId);
  const refunds = getDb()
    .prepare('SELECT * FROM payment_refunds WHERE invoice_id = ? ORDER BY id ASC')
    .all(invId);
  const net_paid = money(Math.max(0, row.paid_amount - row.refunded_amount));
  const remaining_patient_due = money(Math.max(0, row.patient_share - net_paid));
  return { ...row, items, refunds, net_paid, remaining_patient_due };
}

function createInvoice(input = {}) {
  const db = getDb();
  let patient = null;
  if (input.patient_id) {
    patient = patients.get(input.patient_id);
  }
  const patientName = cleanText(input.patient_name || patient?.full_name, 120);
  if (!patientName) throw new AppError('PATIENT_NAME_REQUIRED');

  const day = cleanText(input.day, 10) || toISODate();
  const year = Number.parseInt(day.slice(0, 4), 10) || new Date().getFullYear();
  const insType = input.insurance_type || patient?.insurance_type || 'none';
  const insRate = input.insurance_rate ?? patient?.insurance_rate;

  const calc = previewCoverage({
    insurance_type: insType,
    insurance_rate: insRate,
    discount_amount: input.discount_amount,
    items: input.items,
    treatment_id: input.treatment_id,
    description: input.description,
    price: input.price,
  });

  const paidNow = money(Math.max(0, Number(input.paid_amount) || 0));
  const method = ['cash', 'card', 'transfer'].includes(input.method) ? input.method : 'cash';

  let status = 'issued';
  if (calc.patient_share === 0 || paidNow >= calc.patient_share) status = 'paid';
  else if (paidNow > 0) status = 'partial';

  const tx = db.transaction(() => {
    const seqInfo = nextInvoiceNumber(db, year);
    const info = db
      .prepare(
        `INSERT INTO invoices
          (invoice_number, year, seq, patient_id, appointment_id, day,
           patient_name, insurance_type, chifa_number, nss,
           subtotal, discount_amount, discount_reason, total_amount,
           insured_share, patient_share, paid_amount, refunded_amount, status, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      )
      .run(
        seqInfo.invoice_number,
        seqInfo.year,
        seqInfo.seq,
        patient ? patient.id : null,
        input.appointment_id ? Number(input.appointment_id) || null : null,
        day,
        patientName,
        calc.insurance_type,
        cleanText(input.chifa_number ?? patient?.chifa_number, 40),
        cleanText(input.nss ?? patient?.nss, 40),
        calc.subtotal,
        calc.discount_amount,
        cleanText(input.discount_reason, 200),
        calc.total_amount,
        calc.insured_share,
        calc.patient_share,
        paidNow,
        status,
        cleanText(input.notes, 500),
      );
    const invId = info.lastInsertRowid;

    const insItem = db.prepare(
      `INSERT INTO invoice_items
        (invoice_id, treatment_id, description, quantity, unit_price, insured_rate, line_total, insured_share, patient_share)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const line of calc.items) {
      insItem.run(
        invId,
        line.treatment_id,
        line.description,
        line.quantity,
        line.unit_price,
        line.insured_rate,
        line.line_total,
        line.insured_share,
        line.patient_share,
      );
    }

    if (paidNow > 0 && patient && input.record_payment !== false) {
      payments.add({
        patient_id: patient.id,
        appointment_id: input.appointment_id || null,
        amount: paidNow,
        method,
        note: `${seqInfo.invoice_number}`,
      });
    }
    return invId;
  });

  return getInvoice(tx());
}

function listInvoices({ patient_id, start, end, insurance_type, limit = 100 } = {}) {
  const clauses = ['1 = 1'];
  const params = [];
  if (patient_id) {
    clauses.push('patient_id = ?');
    params.push(Number(patient_id));
  }
  if (start) {
    clauses.push('day >= ?');
    params.push(cleanText(start, 10));
  }
  if (end) {
    clauses.push('day <= ?');
    params.push(cleanText(end, 10));
  }
  if (insurance_type) {
    clauses.push('insurance_type = ?');
    params.push(cleanText(insurance_type, 20));
  }
  params.push(Math.min(500, Math.max(1, Number(limit) || 100)));
  return getDb()
    .prepare(`SELECT * FROM invoices WHERE ${clauses.join(' AND ')} ORDER BY id DESC LIMIT ?`)
    .all(...params);
}

function recordRefund(input = {}) {
  const db = getDb();
  const amount = money(Number(input.amount) || 0);
  if (amount <= 0) throw new AppError('INVALID_AMOUNT');
  const method = ['cash', 'card', 'transfer'].includes(input.method) ? input.method : 'cash';
  const day = cleanText(input.day, 10) || toISODate();
  const reason = cleanText(input.reason, 240);

  let inv = null;
  if (input.invoice_id) {
    inv = getInvoice(input.invoice_id);
    if (amount > inv.net_paid + 0.009) {
      throw new AppError('INVALID_AMOUNT', 'Refund exceeds net paid amount.');
    }
  }

  const tx = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO payment_refunds (payment_id, invoice_id, patient_id, amount, method, reason, day)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.payment_id ? Number(input.payment_id) || null : null,
        inv ? inv.id : null,
        input.patient_id ? Number(input.patient_id) : inv?.patient_id || null,
        amount,
        method,
        reason,
        day,
      );

    if (inv) {
      const newRefunded = money(inv.refunded_amount + amount);
      const netRemaining = money(inv.paid_amount - newRefunded);
      const newStatus = netRemaining <= 0.009 ? 'refunded' : netRemaining < inv.patient_share ? 'partial' : 'paid';
      db.prepare('UPDATE invoices SET refunded_amount = ?, status = ? WHERE id = ?').run(
        newRefunded,
        newStatus,
        inv.id,
      );
    }
    return info.lastInsertRowid;
  });

  const refundId = tx();
  return db.prepare('SELECT * FROM payment_refunds WHERE id = ?').get(refundId);
}

function dailyZReport(day = toISODate()) {
  const db = getDb();
  const targetDay = cleanText(day, 10) || toISODate();

  const payRows = db
    .prepare(
      `SELECT method, COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count
       FROM payments WHERE substr(paid_at, 1, 10) = ?
       GROUP BY method`,
    )
    .all(targetDay);

  const refRows = db
    .prepare(
      `SELECT method, COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count
       FROM payment_refunds WHERE day = ?
       GROUP BY method`,
    )
    .all(targetDay);

  const byMethod = {
    cash: { gross: 0, refunds: 0, net: 0, count: 0 },
    card: { gross: 0, refunds: 0, net: 0, count: 0 },
    transfer: { gross: 0, refunds: 0, net: 0, count: 0 },
  };
  for (const r of payRows) {
    if (byMethod[r.method]) {
      byMethod[r.method].gross = money(r.total);
      byMethod[r.method].count = r.count;
    }
  }
  for (const r of refRows) {
    if (byMethod[r.method]) {
      byMethod[r.method].refunds = money(r.total);
    }
  }
  for (const k of Object.keys(byMethod)) {
    byMethod[k].net = money(byMethod[k].gross - byMethod[k].refunds);
  }

  const invAgg = db
    .prepare(
      `SELECT
         COUNT(*) AS invoices_count,
         COALESCE(SUM(subtotal), 0) AS subtotal,
         COALESCE(SUM(discount_amount), 0) AS discounts,
         COALESCE(SUM(total_amount), 0) AS billed_total,
         COALESCE(SUM(insured_share), 0) AS insured_receivable,
         COALESCE(SUM(patient_share), 0) AS patient_billed
       FROM invoices WHERE day = ? AND status != 'cancelled'`,
    )
    .get(targetDay);

  const grossCollected = money(byMethod.cash.gross + byMethod.card.gross + byMethod.transfer.gross);
  const totalRefunds = money(byMethod.cash.refunds + byMethod.card.refunds + byMethod.transfer.refunds);
  const netCollected = money(grossCollected - totalRefunds);

  return {
    day: targetDay,
    gross_collected: grossCollected,
    total_refunds: totalRefunds,
    net_collected: netCollected,
    by_method: byMethod,
    invoices: {
      count: invAgg.invoices_count,
      subtotal: money(invAgg.subtotal),
      discounts: money(invAgg.discounts),
      billed_total: money(invAgg.billed_total),
      insured_receivable: money(invAgg.insured_receivable),
      patient_billed: money(invAgg.patient_billed),
    },
    unpaid_patient_debts: patients.totalDebt(),
  };
}

function exportInsuranceClaims({ start, end, insurance_type, format = 'csv', filePath } = {}) {
  const clauses = ["insurance_type IN ('CNAS', 'CASNOS', 'other')", "status != 'cancelled'"];
  const params = [];
  if (start) {
    clauses.push('day >= ?');
    params.push(cleanText(start, 10));
  }
  if (end) {
    clauses.push('day <= ?');
    params.push(cleanText(end, 10));
  }
  if (insurance_type && insurance_type !== 'all') {
    clauses.push('insurance_type = ?');
    params.push(cleanText(insurance_type, 20));
  }

  const rows = getDb()
    .prepare(
      `SELECT invoice_number, day, patient_name, insurance_type, chifa_number, nss,
              total_amount, insured_share, patient_share
       FROM invoices
       WHERE ${clauses.join(' AND ')}
       ORDER BY day ASC, id ASC`,
    )
    .all(...params);

  const headers = [
    'N° Facture',
    'Date',
    'Assuré / Patient',
    'Caisse',
    'N° Chifa',
    'NSS',
    'Montant Total (DA)',
    'Part Caisse (DA)',
    'Ticket Modérateur (DA)',
  ];

  if (String(format).toLowerCase() === 'xlsx') {
    const sheetRows = [
      headers.map((text) => ({ text, style: 'header' })),
      ...rows.map((r) => [
        r.invoice_number,
        { date: r.day },
        r.patient_name,
        r.insurance_type,
        r.chifa_number || '',
        r.nss || '',
        { money: r.total_amount },
        { money: r.insured_share },
        { money: r.patient_share },
      ]),
    ];
    const buffer = buildWorkbook(
      [{ name: 'Bordereau Tiers-Payant', rows: sheetRows, widths: [18, 13, 28, 12, 18, 18, 16, 16, 18] }],
      { title: 'Bordereau CNAS / CASNOS' },
    );
    if (filePath) fs.writeFileSync(filePath, buffer);
    return { format: 'xlsx', count: rows.length, buffer_base64: buffer.toString('base64'), file: filePath || null };
  }

  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csvLines = [
    headers.join(';'),
    ...rows.map((r) =>
      [
        esc(r.invoice_number),
        esc(r.day),
        esc(r.patient_name),
        esc(r.insurance_type),
        esc(r.chifa_number),
        esc(r.nss),
        r.total_amount,
        r.insured_share,
        r.patient_share,
      ].join(';'),
    ),
  ];
  const csv = csvLines.join('\n');
  if (filePath) fs.writeFileSync(filePath, csv, 'utf8');
  return { format: 'csv', count: rows.length, csv, file: filePath || null };
}

module.exports = {
  previewCoverage,
  createInvoice,
  getInvoice,
  listInvoices,
  recordRefund,
  dailyZReport,
  exportInsuranceClaims,
};
