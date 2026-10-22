'use strict';
/**
 * Reports: daily and monthly income, expenses, net profit, unpaid debts.
 * Income is cash-basis (money actually received), which is how a small clinic
 * balances its cash box every evening.
 */

const { getDb } = require('../db');
const payments = require('./payments');
const expenses = require('./expenses');
const patients = require('./patients');
const settings = require('./settings');
const { money } = require('../utils/common');
const {
  isValidISODate, toISODate, monthRange, formatLong, monthKey, addDays,
} = require('../utils/dates');

function appointmentCounters(startDay, endDay) {
  return getDb()
    .prepare(
      `SELECT
        SUM(CASE WHEN status = 'booked'    THEN 1 ELSE 0 END) AS booked,
        SUM(CASE WHEN status = 'done'      THEN 1 ELSE 0 END) AS done,
        SUM(CASE WHEN status = 'no_show'   THEN 1 ELSE 0 END) AS no_show,
        SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
        COUNT(*) AS total
       FROM appointments WHERE day BETWEEN ? AND ?`,
    )
    .get(startDay, endDay);
}

function treatmentsPerformed(startDay, endDay) {
  return getDb()
    .prepare(
      `SELECT COALESCE(a.treatment_name, '—') AS name, COUNT(*) AS count,
              COALESCE(SUM(a.price), 0) AS revenue
       FROM appointments a
       WHERE a.day BETWEEN ? AND ? AND a.status = 'done'
       GROUP BY COALESCE(a.treatment_name, '—')
       ORDER BY revenue DESC, count DESC`,
    )
    .all(startDay, endDay)
    .map((row) => ({ ...row, revenue: money(row.revenue) }));
}

/** Daily report (cash box of the day). */
function daily(day = toISODate()) {
  const reportDay = isValidISODate(day) ? day : toISODate();
  const income = payments.totalBetween(reportDay, reportDay);
  const spending = expenses.totalBetween(reportDay, reportDay);
  const counters = appointmentCounters(reportDay, reportDay);
  const unpaid = patients.totalDebt();
  const currency = settings.get('currency');
  const incomeByMethod = getDb()
    .prepare(
      `SELECT method, COALESCE(SUM(amount), 0) AS total FROM payments
       WHERE substr(paid_at, 1, 10) = ? GROUP BY method`,
    )
    .all(reportDay)
    .map((row) => ({ ...row, total: money(row.total) }));

  return {
    day: reportDay,
    day_label: { fr: formatLong(reportDay, 'fr'), ar: formatLong(reportDay, 'ar') },
    currency,
    income: income.total,
    income_count: income.count,
    income_by_method: incomeByMethod,
    expenses: spending.total,
    expenses_count: spending.count,
    net: money(income.total - spending.total),
    unpaid_debts: unpaid,
    appointments: {
      total: counters.total || 0,
      booked: counters.booked || 0,
      done: counters.done || 0,
      no_show: counters.no_show || 0,
      cancelled: counters.cancelled || 0,
    },
    new_patients: patients.newToday(reportDay),
    payments: payments.byDay(reportDay),
    expenses_detail: expenses.list({ start: reportDay, end: reportDay }),
    treatments: treatmentsPerformed(reportDay, reportDay),
  };
}

/** Monthly report with a per-day series for a small chart. */
function monthly(month = monthKey(toISODate())) {
  const parsed = /^\d{4}-\d{2}$/.test(String(month)) ? month : monthKey(toISODate());
  const { start, end } = monthRange(parsed);
  const income = payments.totalBetween(start, end);
  const spending = expenses.totalBetween(start, end);
  const counters = appointmentCounters(start, end);
  const currency = settings.get('currency');

  const days = getDb()
    .prepare("SELECT DISTINCT day FROM appointments WHERE day BETWEEN ? AND ? ORDER BY day")
    .all(start, end)
    .map((row) => row.day);
  // Fill the gaps so the chart always has one point per calendar day.
  for (let day = start; day <= end; day = addDays(day, 1)) {
    if (!days.includes(day)) days.push(day);
  }
  days.sort();

  const series = days.map((day) => {
    const dayIncome = getDb()
      .prepare('SELECT COALESCE(SUM(amount), 0) AS total FROM payments WHERE substr(paid_at, 1, 10) = ?')
      .get(day).total;
    const dayExpense = getDb()
      .prepare('SELECT COALESCE(SUM(amount), 0) AS total FROM expenses WHERE day = ?')
      .get(day).total;
    return { day, income: money(dayIncome), expenses: money(dayExpense), net: money(dayIncome - dayExpense) };
  });

  const bestDay = series.reduce(
    (best, row) => (row.income > (best?.income ?? -1) ? row : best),
    null,
  );

  return {
    month: parsed,
    start,
    end,
    currency,
    income: income.total,
    income_count: income.count,
    expenses: spending.total,
    expenses_count: spending.count,
    net: money(income.total - spending.total),
    unpaid_debts: patients.totalDebt(),
    appointments: {
      total: counters.total || 0,
      done: counters.done || 0,
      no_show: counters.no_show || 0,
      cancelled: counters.cancelled || 0,
    },
    new_patients: getDb()
      .prepare('SELECT COUNT(*) AS n FROM patients WHERE substr(created_at, 1, 10) BETWEEN ? AND ?')
      .get(start, end).n,
    series,
    best_day: bestDay,
    expenses_by_category: expenses.byCategory(start, end),
    treatments: treatmentsPerformed(start, end),
    average_income_per_day: money(income.total / Math.max(1, series.length)),
  };
}

/** Everything needed to print a payment receipt. */
function receipt(paymentId) {
  const payment = payments.get(paymentId);
  const appointment = payment.appointment_id
    ? getDb().prepare('SELECT * FROM appointments WHERE id = ?').get(payment.appointment_id)
    : null;
  const patient = patients.get(payment.patient_id);
  const totalPaid = getDb()
    .prepare('SELECT COALESCE(SUM(amount), 0) AS total FROM payments WHERE patient_id = ?')
    .get(payment.patient_id).total;

  return {
    receipt_no: String(payment.id).padStart(6, '0'),
    date: payment.paid_at,
    clinic: {
      name: settings.get('clinic_name'),
      phone: settings.get('clinic_phone'),
      address: settings.get('clinic_address'),
    },
    currency: settings.get('currency'),
    patient: { name: patient.full_name, phone: patient.phone },
    appointment: appointment
      ? {
          day: appointment.day,
          queue_number: appointment.queue_number,
          treatment: appointment.treatment_name,
          price: money(appointment.price),
        }
      : null,
    amount: money(payment.amount),
    method: payment.method,
    note: payment.note,
    total_paid_by_patient: money(totalPaid),
    remaining_debt: money(Math.max(0, patient.balance)),
  };
}

module.exports = { daily, monthly, receipt, appointmentCounters, treatmentsPerformed };
