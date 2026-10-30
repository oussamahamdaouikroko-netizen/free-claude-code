'use strict';
/**
 * Patients service: CRUD + clinical dental profile + financial balance.
 *
 * Balance = sum of prices of appointments that were not cancelled
 *         − sum of all payments recorded for the patient.
 * A positive balance is a debt (the patient owes the clinic).
 */

const { getDb } = require('../db');
const {
  AppError, money, phoneKey, cleanText, nowLocal, requireId,
} = require('../utils/common');
const { isValidISODate, toISODate, diffDays } = require('../utils/dates');

function rowToPatient(row) {
  if (!row) return null;
  return { ...row, balance: money(row.balance ?? 0) };
}

const BALANCE_SQL = `
  COALESCE((
    SELECT SUM(a.price) FROM appointments a
    WHERE a.patient_id = p.id AND a.status <> 'cancelled'
  ), 0)
  - COALESCE((SELECT SUM(pay.amount) FROM payments pay WHERE pay.patient_id = p.id), 0)`;

/**
 * @param {string} [search] matches name or phone
 * @param {{ limit?: number }} [options]
 */
function list(search = '', options = {}) {
  let effectiveSearch = search;
  let effectiveOptions = options || {};
  if (search && typeof search === 'object') {
    effectiveOptions = search;
    effectiveSearch = search.search ?? '';
  }
  const limit = Math.min(Math.max(Number(effectiveOptions.limit) || 500, 1), 2000);
  const today = effectiveOptions.today || toISODate();
  const term = String(effectiveSearch ?? '').trim();
  const sql = `
    SELECT p.*, ${BALANCE_SQL} AS balance,
      (SELECT MAX(a.day) FROM appointments a
        WHERE a.patient_id = p.id AND a.status <> 'cancelled' AND a.day <= ?) AS last_visit,
      (SELECT MIN(a.day) FROM appointments a
        WHERE a.patient_id = p.id AND a.status = 'booked' AND a.day >= ?) AS next_visit
    FROM patients p
    ${term ? 'WHERE p.full_name LIKE ? OR p.phone LIKE ? OR p.phone_norm LIKE ?' : ''}
    ORDER BY p.full_name COLLATE NOCASE ASC
    LIMIT ?`;
  const params = term
    ? [today, today, `%${term}%`, `%${term}%`, `%${phoneKey(term) || term}%`, limit]
    : [today, today, limit];
  return getDb().prepare(sql).all(...params).map(rowToPatient);
}

function get(id) {
  const patientId = requireId(id, 'patient_id');
  const row = getDb()
    .prepare(`SELECT p.*, ${BALANCE_SQL} AS balance FROM patients p WHERE p.id = ?`)
    .get(patientId);
  if (!row) throw new AppError('PATIENT_NOT_FOUND');
  return rowToPatient(row);
}

function normalizeInput(input, { partial = false } = {}) {
  const out = {};
  if (!partial || input.full_name !== undefined) {
    const name = cleanText(input.full_name, 80);
    if (name.length < 2) throw new AppError('PATIENT_NAME_REQUIRED');
    out.full_name = name;
  }
  if (input.phone !== undefined) {
    const phone = cleanText(input.phone, 30);
    out.phone = phone || null;
    // Store the *key* (last 9 digits): "+213 555 12 34 56" and "0555 12 34 56"
    // must resolve to the same patient.
    out.phone_norm = phone ? phoneKey(phone) || null : null;
  }
  if (input.birth_date !== undefined) {
    const birth = cleanText(input.birth_date, 10);
    if (birth && !/^\d{4}(?:-\d{2}-\d{2})?$/.test(birth)) throw new AppError('INVALID_DATE');
    out.birth_date = birth || null;
  }
  if (input.gender !== undefined) {
    out.gender = input.gender === 'm' || input.gender === 'f' ? input.gender : null;
  }
  if (input.notes !== undefined) out.notes = cleanText(input.notes, 1000) || null;
  if (input.allergies !== undefined) out.allergies = cleanText(input.allergies, 400);
  if (input.chronic_conditions !== undefined) {
    out.chronic_conditions = cleanText(input.chronic_conditions, 400);
  }
  if (input.blood_group !== undefined) {
    out.blood_group = cleanText(input.blood_group, 10).toUpperCase();
  }
  return out;
}

function create(input = {}) {
  const data = normalizeInput(input);
  if (data.phone_norm) {
    const existing = findByPhone(data.phone_norm);
    if (existing) throw new AppError('PATIENT_PHONE_EXISTS', 'Phone already used', { id: existing.id });
  }
  const info = getDb()
    .prepare(
      `INSERT INTO patients
         (full_name, phone, phone_norm, birth_date, gender, notes,
          allergies, chronic_conditions, blood_group, created_at, updated_at)
       VALUES
         (@full_name, @phone, @phone_norm, @birth_date, @gender, @notes,
          @allergies, @chronic_conditions, @blood_group, @now, @now)`,
    )
    .run({
      full_name: data.full_name,
      phone: data.phone ?? null,
      phone_norm: data.phone_norm ?? null,
      birth_date: data.birth_date ?? null,
      gender: data.gender ?? null,
      notes: data.notes ?? null,
      allergies: data.allergies ?? '',
      chronic_conditions: data.chronic_conditions ?? '',
      blood_group: data.blood_group ?? '',
      now: nowLocal(),
    });
  return get(info.lastInsertRowid);
}

function update(input = {}) {
  const id = requireId(input.id, 'patient_id');
  const current = get(id);
  const data = normalizeInput(input, { partial: true });
  if (data.phone_norm) {
    const dupe = findByPhone(data.phone_norm);
    if (dupe && dupe.id !== id) throw new AppError('PATIENT_PHONE_EXISTS', 'Phone already used', { id: dupe.id });
  }
  getDb()
    .prepare(
      `UPDATE patients SET
        full_name = COALESCE(@full_name, full_name),
        phone = @phone,
        phone_norm = @phone_norm,
        birth_date = @birth_date,
        gender = @gender,
        notes = @notes,
        allergies = @allergies,
        chronic_conditions = @chronic_conditions,
        blood_group = @blood_group,
        updated_at = datetime('now')
       WHERE id = @id`,
    )
    .run({
      id,
      full_name: data.full_name ?? null,
      phone: data.phone !== undefined ? data.phone : current.phone,
      phone_norm: data.phone !== undefined ? data.phone_norm : current.phone_norm,
      birth_date: data.birth_date !== undefined ? data.birth_date : current.birth_date,
      gender: data.gender !== undefined ? data.gender : current.gender,
      notes: data.notes !== undefined ? data.notes : current.notes,
      allergies: data.allergies !== undefined ? data.allergies : (current.allergies || ''),
      chronic_conditions:
        data.chronic_conditions !== undefined
          ? data.chronic_conditions
          : (current.chronic_conditions || ''),
      blood_group:
        data.blood_group !== undefined ? data.blood_group : (current.blood_group || ''),
    });
  return get(id);
}

/** Find by any phone representation (WhatsApp JID, +213…, 0555…). */
function findByPhone(phone) {
  const key = phoneKey(phone);
  if (!key) return null;
  const row = getDb()
    .prepare(`SELECT p.*, ${BALANCE_SQL} AS balance FROM patients p WHERE p.phone_norm = ?`)
    .get(key);
  return row ? rowToPatient(row) : null;
}

/** Create the patient if the phone is unknown, otherwise reuse the file. */
function upsertFromWhatsApp({ name, phone }) {
  const existing = findByPhone(phone);
  if (existing) {
    const cleanName = cleanText(name, 80);
    if (cleanName && cleanName.length >= 2 && existing.full_name !== cleanName) {
      return { patient: update({ id: existing.id, full_name: cleanName }), created: false };
    }
    return { patient: existing, created: false };
  }
  const patient = create({ full_name: name, phone });
  return { patient, created: true };
}

function remove(id) {
  const patientId = requireId(id);
  const info = getDb().prepare('DELETE FROM patients WHERE id = ?').run(patientId);
  if (info.changes === 0) throw new AppError('PATIENT_NOT_FOUND');
  return { ok: true };
}

/** Visit history, newest first, with paid amount and remaining balance. */
function history(id) {
  const patientId = requireId(id, 'patient_id');
  return getDb()
    .prepare(
      `SELECT a.*, t.name_fr, t.name_ar,
        COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.appointment_id = a.id), 0) AS paid
       FROM appointments a
       LEFT JOIN treatments t ON t.id = a.treatment_id
       WHERE a.patient_id = ?
       ORDER BY a.day DESC, a.queue_number DESC`,
    )
    .all(patientId)
    .map((row) => ({ ...row, paid: money(row.paid), balance: money(row.price - row.paid) }));
}

/** Total outstanding debt across all patients (unpaid balances only). */
function totalDebt() {
  const row = getDb()
    .prepare(
      `SELECT COALESCE(SUM(
          CASE WHEN a.status <> 'cancelled' THEN a.price ELSE 0 END
          - (SELECT COALESCE(SUM(p.amount), 0) FROM payments p WHERE p.appointment_id = a.id)
        ), 0) AS total
       FROM appointments a`,
    )
    .get();
  return money(Math.max(0, row.total));
}

/** Patients who owe money, largest debt first. */
function debtors() {
  return getDb()
    .prepare(
      `SELECT p.id, p.full_name, p.phone, p.notes, p.created_at, ${BALANCE_SQL} AS balance,
         (SELECT MAX(a.day) FROM appointments a
           WHERE a.patient_id = p.id AND a.status <> 'cancelled') AS last_visit
       FROM patients p
       WHERE balance > 0.009
       ORDER BY balance DESC`,
    )
    .all()
    .map(rowToPatient);
}

/** Count of patients created on a given local day (dashboard KPI). */
function newToday(day = toISODate()) {
  return getDb()
    .prepare("SELECT COUNT(*) AS n FROM patients WHERE substr(created_at, 1, 10) = ?")
    .get(day).n;
}

/**
 * Patients organized strictly by appointment day & date, with accurate
 * per-day queue turn tracking (`is_current_turn`, `can_complete`,
 * `can_mark_no_show`, `blocking_queue_number`, `blocking_patient_name`).
 *
 * Turn order is computed BEFORE applying `search` so searching for a patient
 * never hides the fact that an earlier patient is still ahead in today's queue.
 */
function byDayGroups(options = {}) {
  const today = options.today && isValidISODate(options.today) ? options.today : toISODate();
  const filterDay = options.day && isValidISODate(options.day) ? options.day : '';
  const scope = options.scope === 'today' ? 'today' : 'all';
  const term = String(options.search ?? '').trim();
  const termLower = term.toLowerCase();
  const termPhone = term ? phoneKey(term) : '';

  let whereSql = "WHERE a.status <> 'cancelled'";
  const whereParams = [];
  if (scope === 'today') {
    whereSql += ' AND a.day = ?';
    whereParams.push(today);
  } else if (filterDay) {
    whereSql += ' AND a.day = ?';
    whereParams.push(filterDay);
  } else if (options.includePast === false) {
    whereSql += ' AND a.day >= ?';
    whereParams.push(today);
  }

  const rawRows = getDb()
    .prepare(
      `SELECT a.*,
         p.full_name, p.phone, p.phone_norm, p.birth_date, p.gender,
         p.blood_group, p.allergies, p.chronic_conditions,
         (${BALANCE_SQL}) AS patient_balance,
         t.name_fr AS treatment_fr, t.name_ar AS treatment_ar,
         COALESCE((SELECT SUM(pay.amount) FROM payments pay WHERE pay.appointment_id = a.id), 0) AS paid
       FROM appointments a
       JOIN patients p ON p.id = a.patient_id
       LEFT JOIN treatments t ON t.id = a.treatment_id
       ${whereSql}
       ORDER BY a.day ASC,
                CASE WHEN a.status = 'booked' AND a.priority = 'urgent' THEN 0 ELSE 1 END ASC,
                CASE WHEN a.slot_time <> '' THEN a.slot_time ELSE '99:99' END ASC,
                a.queue_number ASC`,
    )
    .all(...whereParams);

  // Compute true turn order on the unfiltered queue per day.
  const firstBookedByDay = new Map();
  const aheadCounterByDay = new Map();

  const decorated = rawRows.map((row) => {
    const delta = diffDays(today, row.day);
    const dayRelation = delta === 0 ? 'today' : delta > 0 ? 'future' : 'past';
    const paid = money(row.paid);
    const price = money(row.price);

    let aheadCount = null;
    let isCurrentTurn = false;
    let blockingQueue = null;
    let blockingName = null;

    if (row.status === 'booked') {
      aheadCount = aheadCounterByDay.get(row.day) || 0;
      aheadCounterByDay.set(row.day, aheadCount + 1);
      if (aheadCount === 0) {
        firstBookedByDay.set(row.day, {
          id: row.id,
          queue_number: row.queue_number,
          full_name: row.full_name,
        });
        isCurrentTurn = dayRelation === 'today';
      } else {
        const leader = firstBookedByDay.get(row.day);
        if (leader) {
          blockingQueue = leader.queue_number;
          blockingName = leader.full_name;
        }
      }
    }

    const canComplete =
      row.status === 'booked' &&
      (dayRelation === 'past' || (dayRelation === 'today' && aheadCount === 0));
    const canMarkNoShow = row.status === 'booked' && dayRelation !== 'future';

    return {
      ...row,
      treatment_name: row.treatment_name || row.treatment_fr || row.treatment_ar || '',
      price,
      paid,
      balance: money(price - paid),
      patient_balance: money(row.patient_balance ?? 0),
      day_relation: dayRelation,
      days_from_today: delta,
      ahead_count: aheadCount,
      is_current_turn: isCurrentTurn,
      can_complete: canComplete,
      can_mark_no_show: canMarkNoShow,
      blocking_queue_number: blockingQueue,
      blocking_patient_name: blockingName,
      blocking_patient:
        blockingQueue !== null
          ? { queue_number: blockingQueue, full_name: blockingName }
          : null,
    };
  });

  const matchesSearch = (item) => {
    if (!termLower) return true;
    const hay = [
      item.full_name,
      item.phone,
      item.phone_norm,
      item.day,
      item.treatment_name,
      item.treatment_fr,
      item.treatment_ar,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    if (hay.includes(termLower)) return true;
    if (termPhone && item.phone_norm && String(item.phone_norm).includes(termPhone)) return true;
    return false;
  };

  const filtered = termLower ? decorated.filter(matchesSearch) : decorated;

  const groupMap = new Map();
  for (const item of filtered) {
    let group = groupMap.get(item.day);
    if (!group) {
      group = {
        day: item.day,
        today,
        isToday: item.day_relation === 'today',
        isFuture: item.day_relation === 'future',
        isPast: item.day_relation === 'past',
        day_relation: item.day_relation,
        days_from_today: item.days_from_today,
        total_count: 0,
        booked_count: 0,
        done_count: 0,
        no_show_count: 0,
        items: [],
      };
      groupMap.set(item.day, group);
    }
    group.items.push(item);
    group.total_count += 1;
    if (item.status === 'booked') group.booked_count += 1;
    else if (item.status === 'done') group.done_count += 1;
    else if (item.status === 'no_show') group.no_show_count += 1;
  }

  // Sort groups: today & upcoming chronologically ASC first, then past days newest-first.
  const groups = Array.from(groupMap.values()).sort((a, b) => {
    const aUpcoming = a.days_from_today >= 0;
    const bUpcoming = b.days_from_today >= 0;
    if (aUpcoming && !bUpcoming) return -1;
    if (!aUpcoming && bUpcoming) return 1;
    if (aUpcoming && bUpcoming) return a.day.localeCompare(b.day);
    return b.day.localeCompare(a.day);
  });

  let unscheduled = [];
  if (scope === 'all' && !filterDay) {
    const unschedRows = getDb()
      .prepare(
        `SELECT p.*, ${BALANCE_SQL} AS balance
         FROM patients p
         WHERE NOT EXISTS (
           SELECT 1 FROM appointments a
           WHERE a.patient_id = p.id AND a.status <> 'cancelled'
         )
         ORDER BY p.full_name COLLATE NOCASE ASC`,
      )
      .all()
      .map(rowToPatient);
    unscheduled = termLower ? unschedRows.filter(matchesSearch) : unschedRows;
  }

  return {
    today,
    groups,
    unscheduled,
  };
}

module.exports = {
  list,
  byDayGroups,
  get,
  create,
  update,
  remove,
  findByPhone,
  upsertFromWhatsApp,
  history,
  totalDebt,
  debtors,
  newToday,
};
