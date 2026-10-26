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
const { toISODate } = require('../utils/dates');

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
  const limit = Math.min(Math.max(Number(options.limit) || 500, 1), 2000);
  const term = String(search ?? '').trim();
  const sql = `
    SELECT p.*, ${BALANCE_SQL} AS balance,
      (SELECT MAX(a.day) FROM appointments a
        WHERE a.patient_id = p.id AND a.status <> 'cancelled') AS last_visit
    FROM patients p
    ${term ? 'WHERE p.full_name LIKE ? OR p.phone LIKE ? OR p.phone_norm LIKE ?' : ''}
    ORDER BY p.full_name COLLATE NOCASE ASC
    LIMIT ?`;
  const params = term
    ? [`%${term}%`, `%${term}%`, `%${phoneKey(term) || term}%`, limit]
    : [limit];
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

module.exports = {
  list,
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
