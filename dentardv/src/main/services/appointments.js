'use strict';
/**
 * Appointments + booking engine.
 *
 * Business rules (all configurable in Settings):
 *  - a day is bookable only if its weekday is in `working_days`;
 *  - a day holds at most `daily_capacity` active appointments
 *    (cancelled / no_show rows do not consume a slot);
 *  - the queue number is the first free number of the day, so numbers stay
 *    compact and an existing patient never sees their number change;
 *  - WhatsApp bookings take the *first free day* inside the booking horizon.
 */

const { getDb } = require('../db');
const settings = require('./settings');
const { AppError, money, cleanText, nowLocal, requireId } = require('../utils/common');
const { isValidISODate, addDays, toISODate, diffDays, formatLong } = require('../utils/dates');

const ACTIVE_STATUSES = ['booked', 'done', 'no_show'];

const AGENDA_SQL = `
  SELECT a.*, p.full_name, p.phone, p.phone_norm,
    COALESCE((SELECT SUM(pay.amount) FROM payments pay WHERE pay.appointment_id = a.id), 0) AS paid
  FROM appointments a
  JOIN patients p ON p.id = a.patient_id`;

function decorate(row) {
  if (!row) return null;
  const paid = money(row.paid ?? 0);
  return { ...row, paid, balance: money(row.price - paid) };
}

/** How many active patients a day already holds. */
function usedCapacity(day) {
  return getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM appointments
       WHERE day = ? AND status IN ('booked', 'done', 'no_show')`,
    )
    .get(day).n;
}

/** @returns {{day: string, capacity: number, used: number, left: number, working: boolean}} */
function dayInfo(day) {
  if (!isValidISODate(day)) throw new AppError('INVALID_DATE');
  const capacity = settings.getInt('daily_capacity');
  const used = usedCapacity(day);
  return {
    day,
    capacity,
    used,
    left: Math.max(0, capacity - used),
    working: settings.isWorkingDay(day),
  };
}

/** First queue number not used by an active appointment of that day. */
function nextQueueNumber(day) {
  const rows = getDb()
    .prepare(
      `SELECT queue_number FROM appointments
       WHERE day = ? AND status IN ('booked', 'done', 'no_show')`,
    )
    .all(day);
  const taken = new Set(rows.map((r) => r.queue_number));
  const capacity = settings.getInt('daily_capacity');
  for (let n = 1; n <= capacity; n += 1) if (!taken.has(n)) return n;
  // Defensive: capacity was reduced below the number of bookings.
  return capacity + 1;
}

/**
 * First day with a free slot, starting today (if allowed) or tomorrow.
 * @returns {string|null} ISO day or null when the horizon is full
 */
function findNextFreeDay(options = {}) {
  const today = options.fromDate || toISODate();
  const allowSameDay =
    options.allowSameDay !== undefined
      ? Boolean(options.allowSameDay)
      : settings.getBool('allow_same_day_booking');
  const horizon = options.horizonDays || settings.getInt('booking_horizon_days');
  const start = allowSameDay ? today : addDays(today, 1);

  for (let offset = 0; offset <= horizon; offset += 1) {
    const day = addDays(start, offset);
    if (!settings.isWorkingDay(day)) continue;
    if (usedCapacity(day) < settings.getInt('daily_capacity')) return day;
  }
  return null;
}

function assertBookableDay(day) {
  if (!isValidISODate(day)) throw new AppError('INVALID_DATE');
  const today = toISODate();
  if (diffDays(today, day) < 0) throw new AppError('DATE_IN_PAST');
  if (!settings.isWorkingDay(day)) throw new AppError('NOT_WORKING_DAY', 'Clinic closed', { day });
  if (dayInfo(day).left <= 0) throw new AppError('DAY_FULL', 'Day is full', { day });
}

function get(id) {
  const row = getDb().prepare(`${AGENDA_SQL} WHERE a.id = ?`).get(requireId(id));
  if (!row) throw new AppError('APPOINTMENT_NOT_FOUND');
  return decorate(row);
}

/**
 * Book an appointment.
 * @param {{patient_id:number, day?:string, treatment_id?:number|null,
 *          price?:number, notes?:string, source?:string}} input
 */
function create(input = {}) {
  const patientId = requireId(input.patient_id, 'patient_id');
  const patient = getDb().prepare('SELECT id FROM patients WHERE id = ?').get(patientId);
  if (!patient) throw new AppError('PATIENT_NOT_FOUND');

  // When no day is given (WhatsApp booking) we look for the first free slot
  // starting tomorrow: replying "come today" at 6 pm would be worse than a
  // clear next-day slot. The desk can still book same-day by passing `day`
  // (the setting `allow_same_day_booking` drives the date picker).
  const day = input.day || findNextFreeDay({ allowSameDay: false });
  if (!day) throw new AppError('HORIZON_REACHED');
  // `historical` is used to import old visits (patients' history) without
  // touching today's capacity.
  if (input.historical === true) {
    if (!isValidISODate(day)) throw new AppError('INVALID_DATE');
  } else {
    assertBookableDay(day);
  }

  const db = getDb();
  const duplicate = db
    .prepare(
      `SELECT * FROM appointments
       WHERE patient_id = ? AND day = ? AND status IN ('booked', 'done') LIMIT 1`,
    )
    .get(patientId, day);
  if (duplicate) {
    throw new AppError('ALREADY_BOOKED', 'Already booked', { id: duplicate.id, day });
  }

  let treatmentName = null;
  let price = input.price;
  let treatmentId = input.treatment_id ?? null;
  if (treatmentId) {
    const treatment = db.prepare('SELECT * FROM treatments WHERE id = ?').get(treatmentId);
    if (!treatment) throw new AppError('TREATMENT_NOT_FOUND');
    treatmentName = treatment.name_fr;
    if (price === undefined || price === null || price === '') price = treatment.default_price;
  }
  price = money(Math.max(0, Number(price) || 0));

  const queue = nextQueueNumber(day);
  const now = nowLocal();
  const info = db
    .prepare(
      `INSERT INTO appointments
        (patient_id, day, queue_number, status, source, treatment_id, treatment_name,
         price, notes, created_at, updated_at)
       VALUES (@patient_id, @day, @queue, 'booked', @source, @treatment_id, @treatment_name,
         @price, @notes, @now, @now)`,
    )
    .run({
      patient_id: patientId,
      day,
      queue,
      source: input.source === 'whatsapp' || input.source === 'waiting' ? input.source : 'manual',
      treatment_id: treatmentId,
      treatment_name: treatmentName,
      price,
      notes: cleanText(input.notes, 500) || null,
      now,
    });
  return get(info.lastInsertRowid);
}

/** Change the day of an appointment (keeps the patient, re-assigns the queue). */
function reschedule(input = {}) {
  const appointment = get(input.id);
  const day = input.day;
  if (!day) throw new AppError('INVALID_DATE');
  if (day === appointment.day) return appointment;
  assertBookableDay(day);
  const now = nowLocal();
  getDb()
    .prepare('UPDATE appointments SET day = ?, queue_number = ?, updated_at = ? WHERE id = ?')
    .run(day, nextQueueNumber(day), now, appointment.id);
  return get(appointment.id);
}

/** Update treatment/price/notes of an appointment. */
function updateDetails(input = {}) {
  const appointment = get(input.id);
  const db = getDb();
  let treatmentId = appointment.treatment_id;
  let treatmentName = appointment.treatment_name;
  let price = appointment.price;

  if (input.treatment_id !== undefined) {
    treatmentId = input.treatment_id || null;
    if (treatmentId) {
      const treatment = db.prepare('SELECT * FROM treatments WHERE id = ?').get(treatmentId);
      if (!treatment) throw new AppError('TREATMENT_NOT_FOUND');
      treatmentName = treatment.name_fr;
      if (input.price === undefined) price = treatment.default_price;
    } else {
      treatmentName = cleanText(input.treatment_name, 120) || null;
    }
  }
  if (input.price !== undefined) price = money(Math.max(0, Number(input.price) || 0));

  // Never let the price drop below what was already collected: the balance
  // would go negative and the cash box would no longer reconcile.
  const paid = money(
    db.prepare('SELECT COALESCE(SUM(amount), 0) AS total FROM payments WHERE appointment_id = ?')
      .get(appointment.id).total,
  );
  if (price < paid - 0.009) {
    throw new AppError('PRICE_BELOW_PAID', 'Price below paid amount', { paid, price });
  }

  db.prepare(
    `UPDATE appointments SET treatment_id = ?, treatment_name = ?, price = ?, notes = ?,
      updated_at = ? WHERE id = ?`,
  ).run(
    treatmentId,
    treatmentName,
    price,
    input.notes !== undefined ? cleanText(input.notes, 500) || null : appointment.notes,
    nowLocal(),
    appointment.id,
  );
  return get(appointment.id);
}

/** Keep the displayed name in sync when the catalog entry gets renamed. */
function syncTreatmentName(treatmentId, nameFr) {
  getDb()
    .prepare(
      `UPDATE appointments SET treatment_name = ? WHERE treatment_id = ? AND status = 'booked'`,
    )
    .run(nameFr, treatmentId);
}

function setStatus(id, status) {
  if (!['booked', 'done', 'cancelled', 'no_show'].includes(status)) {
    throw new AppError('INVALID_STATUS');
  }
  const appointment = get(id);
  getDb()
    .prepare('UPDATE appointments SET status = ?, updated_at = ? WHERE id = ?')
    .run(status, nowLocal(), appointment.id);
  return get(appointment.id);
}

const cancel = (id) => setStatus(id, 'cancelled');

/** Agenda of one day, ordered by queue number. */
function agenda(day = toISODate()) {
  if (!isValidISODate(day)) throw new AppError('INVALID_DATE');
  return getDb()
    .prepare(
      `${AGENDA_SQL}
       WHERE a.day = ? AND a.status <> 'cancelled'
       ORDER BY a.queue_number ASC`,
    )
    .all(day)
    .map(decorate);
}

/** Next appointment of a patient from a given day (used by the bot). */
function upcomingForPatient(patientId, fromDay = toISODate()) {
  const row = getDb()
    .prepare(
      `${AGENDA_SQL}
       WHERE a.patient_id = ? AND a.day >= ? AND a.status IN ('booked', 'done')
       ORDER BY CASE WHEN a.status = 'booked' THEN 0 ELSE 1 END, a.day ASC, a.queue_number ASC
       LIMIT 1`,
    )
    .get(requireId(patientId, 'patient_id'), fromDay);
  return row ? decorate(row) : null;
}

function listRange(startDay, endDay) {
  if (!isValidISODate(startDay) || !isValidISODate(endDay)) throw new AppError('INVALID_DATE');
  return getDb()
    .prepare(
      `${AGENDA_SQL}
       WHERE a.day BETWEEN ? AND ? AND a.status <> 'cancelled'
       ORDER BY a.day ASC, a.queue_number ASC`,
    )
    .all(startDay, endDay)
    .map(decorate);
}

/** Dashboard counters for one day. */
function dayStats(day = toISODate()) {
  const row = getDb()
    .prepare(
      `SELECT
        SUM(CASE WHEN status = 'booked'   THEN 1 ELSE 0 END) AS booked,
        SUM(CASE WHEN status = 'done'     THEN 1 ELSE 0 END) AS done,
        SUM(CASE WHEN status = 'no_show'  THEN 1 ELSE 0 END) AS no_show,
        COUNT(*) AS total
       FROM appointments WHERE day = ? AND status <> 'cancelled'`,
    )
    .get(day);
  const info = dayInfo(day);
  return {
    day,
    day_label: { fr: formatLong(day, 'fr'), ar: formatLong(day, 'ar') },
    total: row.total || 0,
    booked: row.booked || 0,
    done: row.done || 0,
    no_show: row.no_show || 0,
    capacity: info.capacity,
    left: info.left,
    working: info.working,
  };
}

/* ------------------------------ waiting list ----------------------------- */

function addToWaitingList({ full_name, phone, note }) {
  const name = cleanText(full_name, 80);
  if (name.length < 2) throw new AppError('PATIENT_NAME_REQUIRED');
  const info = getDb()
    .prepare(
      `INSERT INTO waiting_list (full_name, phone, note, created_at) VALUES (?, ?, ?, ?)`,
    )
    .run(name, cleanText(phone, 30), cleanText(note, 200) || null, nowLocal());
  return { id: info.lastInsertRowid };
}

function waitingList(onlyPending = true) {
  return getDb()
    .prepare(`SELECT * FROM waiting_list ${onlyPending ? 'WHERE handled = 0' : ''} ORDER BY id ASC`)
    .all();
}

function markWaitingHandled(id) {
  getDb().prepare('UPDATE waiting_list SET handled = 1 WHERE id = ?').run(requireId(id));
  return { ok: true };
}

module.exports = {
  dayInfo,
  usedCapacity,
  nextQueueNumber,
  findNextFreeDay,
  create,
  get,
  reschedule,
  updateDetails,
  syncTreatmentName,
  setStatus,
  cancel,
  agenda,
  upcomingForPatient,
  listRange,
  dayStats,
  addToWaitingList,
  waitingList,
  markWaitingHandled,
};
