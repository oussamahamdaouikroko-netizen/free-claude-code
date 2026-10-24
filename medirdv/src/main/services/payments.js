'use strict';
/**
 * Payments service.
 *
 * Two ways money comes in:
 *  - linked to an appointment (deposit / payment at the chair);
 *  - a debt payment: the amount is spread automatically over the oldest unpaid
 *    appointments (FIFO), so per-appointment balances stay accurate.
 *
 * Payments are immutable rows; a mistake is fixed by deleting the row, which
 * is logged by the audit trail of SQLite (application log).
 */

const { getDb } = require('../db');
const { AppError, money, cleanText, nowLocal, requireId } = require('../utils/common');
const { toISODate, monthRange } = require('../utils/dates');

const METHODS = ['cash', 'card', 'transfer'];
const PAYMENT_SQL = `
  SELECT pay.*, p.full_name, p.phone, a.day AS appointment_day, a.queue_number
  FROM payments pay
  JOIN patients p ON p.id = pay.patient_id
  LEFT JOIN appointments a ON a.id = pay.appointment_id`;

function decorate(row) {
  return { ...row, amount: money(row.amount) };
}

function assertMethod(method) {
  const value = METHODS.includes(method) ? method : 'cash';
  return value;
}

/**
 * Record a payment.
 * @param {{patient_id:number, appointment_id?:number|null, amount:number,
 *          method?:string, note?:string, paid_at?:string}} input
 */
function add(input = {}) {
  const patientId = requireId(input.patient_id, 'patient_id');
  const amount = money(Number(input.amount));
  if (!Number.isFinite(amount) || amount <= 0) throw new AppError('INVALID_AMOUNT');
  const patient = getDb().prepare('SELECT id FROM patients WHERE id = ?').get(patientId);
  if (!patient) throw new AppError('PATIENT_NOT_FOUND');

  let appointmentId = null;
  if (input.appointment_id) {
    appointmentId = requireId(input.appointment_id, 'appointment_id');
    const appointment = getDb()
      .prepare('SELECT * FROM appointments WHERE id = ? AND patient_id = ?')
      .get(appointmentId, patientId);
    if (!appointment) throw new AppError('APPOINTMENT_NOT_FOUND');
    if (appointment.status === 'cancelled') throw new AppError('APPOINTMENT_CANCELLED');
    const paid = getDb()
      .prepare('SELECT COALESCE(SUM(amount), 0) AS total FROM payments WHERE appointment_id = ?')
      .get(appointmentId).total;
    const remaining = money(appointment.price - paid);
    if (amount > remaining + 0.009) {
      throw new AppError('AMOUNT_TOO_HIGH', 'Amount exceeds the remaining balance', {
        remaining,
      });
    }
  }

  const paidAt = input.paid_at && /^\d{4}-\d{2}-\d{2}/.test(input.paid_at)
    ? `${input.paid_at.slice(0, 10)} ${input.paid_at.slice(11, 19) || '00:00:00'}`
    : nowLocal();

  const info = getDb()
    .prepare(
      `INSERT INTO payments (patient_id, appointment_id, amount, method, note, paid_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      patientId,
      appointmentId,
      amount,
      assertMethod(input.method),
      cleanText(input.note, 300) || null,
      paidAt,
    );
  return get(info.lastInsertRowid);
}

/**
 * Pay an existing debt: allocate the amount to unpaid appointments, oldest
 * first. Returns the created payment rows (one per appointment covered).
 */
function payDebt(input = {}) {
  const patientId = requireId(input.patient_id, 'patient_id');
  let remaining = money(Number(input.amount));
  if (!Number.isFinite(remaining) || remaining <= 0) throw new AppError('INVALID_AMOUNT');

  const open = getDb()
    .prepare(
      `SELECT a.id, a.price,
        COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.appointment_id = a.id), 0) AS paid
       FROM appointments a
       WHERE a.patient_id = ? AND a.status <> 'cancelled'
       ORDER BY a.day ASC, a.id ASC`,
    )
    .all(patientId)
    .map((row) => ({ id: row.id, due: money(row.price - row.paid) }))
    .filter((row) => row.due > 0.009);

  const totalDue = money(open.reduce((sum, row) => sum + row.due, 0));
  if (totalDue <= 0) throw new AppError('NO_DEBT');
  if (remaining > totalDue + 0.009) {
    throw new AppError('AMOUNT_TOO_HIGH', 'Amount exceeds the total debt', { remaining: totalDue });
  }

  const created = [];
  const db = getDb();
  const run = db.transaction(() => {
    for (const row of open) {
      if (remaining <= 0.009) break;
      const part = money(Math.min(remaining, row.due));
      if (part <= 0) continue;
      const info = db
        .prepare(
          `INSERT INTO payments (patient_id, appointment_id, amount, method, note, paid_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          patientId,
          row.id,
          part,
          assertMethod(input.method),
          cleanText(input.note, 300) || null,
          nowLocal(),
        );
      created.push(get(info.lastInsertRowid));
      remaining = money(remaining - part);
    }
  });
  run();
  return created;
}

function get(id) {
  const row = getDb().prepare(`${PAYMENT_SQL} WHERE pay.id = ?`).get(requireId(id));
  if (!row) throw new AppError('PAYMENT_NOT_FOUND');
  return decorate(row);
}

function remove(id) {
  const payment = get(id);
  getDb().prepare('DELETE FROM payments WHERE id = ?').run(payment.id);
  return { ok: true };
}

/** Payments received on a local day (cash basis). */
function byDay(day = toISODate()) {
  return getDb()
    .prepare(`${PAYMENT_SQL} WHERE substr(pay.paid_at, 1, 10) = ? ORDER BY pay.paid_at ASC`)
    .all(day)
    .map(decorate);
}

function byPatient(patientId) {
  return getDb()
    .prepare(`${PAYMENT_SQL} WHERE pay.patient_id = ? ORDER BY pay.paid_at DESC`)
    .all(requireId(patientId, 'patient_id'))
    .map(decorate);
}

function totalBetween(startDay, endDay) {
  const row = getDb()
    .prepare(
      `SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count
       FROM payments WHERE substr(paid_at, 1, 10) BETWEEN ? AND ?`,
    )
    .get(startDay, endDay);
  return { total: money(row.total), count: row.count };
}

function monthTotal(month) {
  const { start, end } = monthRange(month);
  return totalBetween(start, end);
}

module.exports = { METHODS, add, payDebt, get, remove, byDay, byPatient, totalBetween, monthTotal };
