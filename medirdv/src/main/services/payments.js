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
const settings = require('./settings');
const security = require('./security');
const { AppError, money, cleanText, nowLocal, requireId } = require('../utils/common');
const { toISODate, monthRange } = require('../utils/dates');

const METHODS = ['cash', 'card', 'transfer'];
const COMMON_AMOUNTS_DZD = [1000, 1500, 2000, 2500, 3000];
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

  if (appointmentId) {
    const apptRow = getDb().prepare('SELECT price, is_paid FROM appointments WHERE id = ?').get(appointmentId);
    const totalPaid = getDb()
      .prepare('SELECT COALESCE(SUM(amount), 0) AS total FROM payments WHERE appointment_id = ?')
      .get(appointmentId).total;
    if (apptRow && apptRow.price > 0 && totalPaid >= apptRow.price - 0.009 && !apptRow.is_paid) {
      getDb()
        .prepare(
          'UPDATE appointments SET is_paid = 1, paid_at = COALESCE(paid_at, ?), paid_by = COALESCE(paid_by, ?) WHERE id = ?',
        )
        .run(paidAt, cleanText(input.actor_name, 80) || 'staff', appointmentId);
    }
  }

  return get(info.lastInsertRowid);
}

/**
 * One-click payment confirmation for secretary / admin on today's agenda.
 *
 * - Strictly enforces `actor.role` in `['admin', 'secretary']` inside the handler itself.
 * - Uses atomic conditional update (`UPDATE appointments ... WHERE id = ? AND is_paid = 0`)
 *   inside a transaction so double-clicks or two secretaries never record twice.
 * - Inserts directly into the existing `payments` table so daily & monthly
 *   income reports immediately reflect the receipt without altering report logic.
 * - If no consultation/treatment price is stored (`price === 0` and no configured
 *   department/default consultation fee), throws `AMOUNT_REQUIRED` with `common_amounts`
 *   instead of guessing an amount.
 */
function confirmAppointmentPayment(input = {}) {
  const actor = input.actor || null;
  if (!actor || !['admin', 'secretary'].includes(actor.role)) {
    throw new AppError('FORBIDDEN', 'Only secretary or admin can confirm appointment payment.');
  }

  const appointmentId = requireId(input.appointment_id ?? input.id, 'appointment_id');
  const db = getDb();
  const appointment = db.prepare('SELECT * FROM appointments WHERE id = ?').get(appointmentId);
  if (!appointment) throw new AppError('APPOINTMENT_NOT_FOUND');
  if (appointment.status === 'cancelled') throw new AppError('APPOINTMENT_CANCELLED');

  const alreadyPaidSum = money(
    db.prepare('SELECT COALESCE(SUM(amount), 0) AS total FROM payments WHERE appointment_id = ?')
      .get(appointmentId).total,
  );
  const currentPrice = money(appointment.price || 0);

  if (appointment.is_paid || (currentPrice > 0 && alreadyPaidSum >= currentPrice - 0.009)) {
    const existingPayment = db
      .prepare('SELECT id FROM payments WHERE appointment_id = ? ORDER BY id DESC LIMIT 1')
      .get(appointmentId);
    return {
      already_paid: true,
      appointment: db.prepare('SELECT * FROM appointments WHERE id = ?').get(appointmentId),
      payment: existingPayment ? get(existingPayment.id) : null,
    };
  }

  // Resolve known fee without guessing:
  //  1. Explicit amount entered by secretary (when prompted once)
  //  2. Remaining due on the appointment itself (`appointment.price - alreadyPaidSum`)
  //  3. Department's configured `consultation_fee`
  //  4. Global `default_consultation_fee` setting
  let resolvedAmount = 0;
  if (input.amount !== undefined && input.amount !== null && input.amount !== '') {
    resolvedAmount = money(Number(input.amount));
    if (!Number.isFinite(resolvedAmount) || resolvedAmount <= 0) {
      throw new AppError('INVALID_AMOUNT');
    }
  } else if (currentPrice > 0 && currentPrice - alreadyPaidSum > 0.009) {
    resolvedAmount = money(currentPrice - alreadyPaidSum);
  } else {
    let deptFee = 0;
    if (appointment.department_id) {
      const dept = db
        .prepare('SELECT consultation_fee FROM departments WHERE id = ?')
        .get(appointment.department_id);
      deptFee = money(dept?.consultation_fee || 0);
    }
    const defaultFee = money(Number(settings.get('default_consultation_fee')) || 0);
    resolvedAmount = deptFee > 0 ? deptFee : defaultFee;
  }

  if (!Number.isFinite(resolvedAmount) || resolvedAmount <= 0) {
    throw new AppError('AMOUNT_REQUIRED', 'Consultation fee is not set for this appointment.', {
      appointment_id: appointmentId,
      common_amounts: COMMON_AMOUNTS_DZD,
    });
  }

  if (currentPrice > 0 && alreadyPaidSum + resolvedAmount > currentPrice + 0.009 && input.amount === undefined) {
    resolvedAmount = money(currentPrice - alreadyPaidSum);
  }

  const paidAt =
    input.paid_at && /^\d{4}-\d{2}-\d{2}/.test(input.paid_at)
      ? `${input.paid_at.slice(0, 10)} ${input.paid_at.slice(11, 19) || '00:00:00'}`
      : nowLocal();
  const paidBy = cleanText(actor.username || actor.full_name || actor.role, 80) || 'secretary';
  const method = assertMethod(input.method || 'cash');
  const note = cleanText(input.note, 300) || null;
  const nextPrice = Math.max(currentPrice, money(alreadyPaidSum + resolvedAmount));

  const tx = db.transaction(() => {
    const upd = db
      .prepare(
        `UPDATE appointments
         SET is_paid = 1, paid_at = ?, paid_by = ?, price = ?, updated_at = ?
         WHERE id = ? AND is_paid = 0`,
      )
      .run(paidAt, paidBy, nextPrice, paidAt, appointmentId);

    if (upd.changes !== 1) {
      return { already_paid: true, paymentId: null };
    }

    const payInfo = db
      .prepare(
        `INSERT INTO payments (patient_id, appointment_id, amount, method, note, paid_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(appointment.patient_id, appointmentId, resolvedAmount, method, note, paidAt);

    return { already_paid: false, paymentId: payInfo.lastInsertRowid };
  });

  const outcome = tx();
  if (outcome.already_paid) {
    const existingPayment = db
      .prepare('SELECT id FROM payments WHERE appointment_id = ? ORDER BY id DESC LIMIT 1')
      .get(appointmentId);
    return {
      already_paid: true,
      appointment: db.prepare('SELECT * FROM appointments WHERE id = ?').get(appointmentId),
      payment: existingPayment ? get(existingPayment.id) : null,
    };
  }

  try {
    security.appendAudit({
      user_id: actor.id || null,
      username: paidBy,
      role: actor.role,
      action: 'payment.confirm_appointment',
      entity_type: 'appointment',
      entity_id: String(appointmentId),
      summary: `amount=${resolvedAmount} method=${method}`,
    });
  } catch (_err) {
    // Best-effort audit entry
  }

  return {
    already_paid: false,
    appointment: db.prepare('SELECT * FROM appointments WHERE id = ?').get(appointmentId),
    payment: get(outcome.paymentId),
  };
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
  const db = getDb();
  db.prepare('DELETE FROM payments WHERE id = ?').run(payment.id);
  if (payment.appointment_id) {
    const appt = db.prepare('SELECT price FROM appointments WHERE id = ?').get(payment.appointment_id);
    const totalLeft = db
      .prepare('SELECT COALESCE(SUM(amount), 0) AS total FROM payments WHERE appointment_id = ?')
      .get(payment.appointment_id).total;
    if (!appt || appt.price <= 0 || totalLeft < appt.price - 0.009) {
      db.prepare('UPDATE appointments SET is_paid = 0, paid_at = NULL, paid_by = NULL WHERE id = ?').run(
        payment.appointment_id,
      );
    }
  }
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

module.exports = {
  METHODS,
  COMMON_AMOUNTS_DZD,
  add,
  confirmAppointmentPayment,
  payDebt,
  get,
  remove,
  byDay,
  byPatient,
  totalBetween,
  monthTotal,
};
