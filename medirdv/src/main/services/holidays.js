'use strict';
/**
 * Doctor off-days / holidays / sick-leave service (`clinic_holidays`) for MediRDV.
 *
 * Allows solo physicians or polyclinics to mark single days or date ranges when
 * the doctor (or a specific department) does not work due to vacation (`عطلة`),
 * illness (`مرض`), or exceptional closure (`غلق استثنائي`).
 *
 * Privacy guarantee:
 *  - Internally in the desktop app, clinic staff see the exact `reason_type`
 *    (`vacation`, `sick`, `other`) and internal note (`label`).
 *  - Externally on WhatsApp, patients only see a polite notice that the doctor
 *    is on holiday/leave (`الطبيب في عطلة` / `en congé`) + next resume date.
 */

const { getDb } = require('../db');
const departments = require('./departments');
const { AppError, cleanText, nowLocal, requireId } = require('../utils/common');
const { isValidISODate, toISODate, addDays, diffDays } = require('../utils/dates');

const VALID_REASONS = new Set(['vacation', 'sick', 'other']);

function normalizeDeptId(departmentId) {
  const num = Number.parseInt(departmentId, 10);
  return Number.isInteger(num) && num > 0 ? num : null;
}

function decorate(row) {
  if (!row) return null;
  let bookedConflicts = 0;
  try {
    if (row.department_id) {
      bookedConflicts =
        getDb()
          .prepare(
            `SELECT COUNT(*) AS n FROM appointments
             WHERE day >= ? AND day <= ? AND department_id = ? AND status = 'booked'`,
          )
          .get(row.start_day, row.end_day, row.department_id)?.n || 0;
    } else {
      bookedConflicts =
        getDb()
          .prepare(
            `SELECT COUNT(*) AS n FROM appointments
             WHERE day >= ? AND day <= ? AND status = 'booked'`,
          )
          .get(row.start_day, row.end_day)?.n || 0;
    }
  } catch (_err) {
    bookedConflicts = 0;
  }
  const dept = row.department_id ? departments.getOptional(row.department_id) : null;
  return {
    ...row,
    department_id: row.department_id || null,
    department_name_fr: dept ? dept.name_fr : null,
    department_name_ar: dept ? dept.name_ar : null,
    block_all_wa: Boolean(row.block_all_wa),
    is_single_day: row.start_day === row.end_day,
    booked_conflicts: bookedConflicts,
  };
}

function list({ includePast = false, fromDay = null, departmentId = null } = {}) {
  const minDay = fromDay || toISODate();
  const dId = normalizeDeptId(departmentId);
  let rows;
  if (includePast) {
    rows = dId
      ? getDb()
          .prepare(
            `SELECT * FROM clinic_holidays
             WHERE department_id IS NULL OR department_id = ?
             ORDER BY start_day DESC, id DESC`,
          )
          .all(dId)
      : getDb().prepare('SELECT * FROM clinic_holidays ORDER BY start_day DESC, id DESC').all();
  } else {
    rows = dId
      ? getDb()
          .prepare(
            `SELECT * FROM clinic_holidays
             WHERE end_day >= ? AND (department_id IS NULL OR department_id = ?)
             ORDER BY start_day ASC, id ASC`,
          )
          .all(minDay, dId)
      : getDb()
          .prepare('SELECT * FROM clinic_holidays WHERE end_day >= ? ORDER BY start_day ASC, id ASC')
          .all(minDay);
  }
  return rows.map(decorate);
}

function getForDay(day, departmentId = null) {
  if (!isValidISODate(day)) return null;
  const dId = normalizeDeptId(departmentId);
  const row = getDb()
    .prepare(
      `SELECT * FROM clinic_holidays
       WHERE start_day <= ? AND end_day >= ?
         AND (department_id IS NULL OR (? IS NOT NULL AND department_id = ?))
       ORDER BY block_all_wa DESC, department_id IS NOT NULL DESC, end_day DESC, id DESC
       LIMIT 1`,
    )
    .get(day, day, dId, dId);
  return row ? decorate(row) : null;
}

function isHoliday(day, departmentId = null) {
  return Boolean(getForDay(day, departmentId));
}

function nextResumeDay(afterDay, departmentId = null, maxLookahead = 180) {
  if (!isValidISODate(afterDay)) return null;
  const dId = normalizeDeptId(departmentId);
  for (let i = 1; i <= maxLookahead; i += 1) {
    const candidate = addDays(afterDay, i);
    if (departments.isWorkingDay(dId, candidate) && !isHoliday(candidate, dId)) {
      return candidate;
    }
  }
  return null;
}

function getWhatsAppHolidayContext(today = toISODate(), departmentId = null, horizonDays = 14) {
  const dId = normalizeDeptId(departmentId);
  const activeToday = getForDay(today, dId);
  if (activeToday) {
    return {
      holiday: activeToday,
      activeToday: true,
      blockAllBookings: Boolean(activeToday.block_all_wa),
      resumeDay: nextResumeDay(activeToday.end_day, dId),
    };
  }

  const maxDay = addDays(today, Math.max(1, Number(horizonDays) || 14));
  const upcomingRow = getDb()
    .prepare(
      `SELECT * FROM clinic_holidays
       WHERE start_day > ? AND start_day <= ?
         AND (department_id IS NULL OR (? IS NOT NULL AND department_id = ?))
       ORDER BY start_day ASC, id ASC
       LIMIT 1`,
    )
    .get(today, maxDay, dId, dId);

  if (!upcomingRow) return null;
  const upcoming = decorate(upcomingRow);
  return {
    holiday: upcoming,
    activeToday: false,
    blockAllBookings: false,
    resumeDay: nextResumeDay(upcoming.end_day, dId),
  };
}

function create(input = {}) {
  const startDay = String(input.start_day || input.day || '').trim();
  const endDay = String(input.end_day || startDay).trim();
  if (!isValidISODate(startDay)) throw new AppError('INVALID_DATE');
  if (!isValidISODate(endDay)) throw new AppError('INVALID_DATE');
  if (diffDays(startDay, endDay) < 0) {
    throw new AppError('HOLIDAY_END_BEFORE_START');
  }

  const reasonType = VALID_REASONS.has(input.reason_type) ? input.reason_type : 'vacation';
  const label = cleanText(input.label, 160) || '';
  const dId = input.department_id ? departments.get(input.department_id).id : null;
  const blockAllWa = input.block_all_wa === true || String(input.block_all_wa) === '1' ? 1 : 0;

  const info = getDb()
    .prepare(
      `INSERT INTO clinic_holidays
        (start_day, end_day, reason_type, label, department_id, block_all_wa, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(startDay, endDay, reasonType, label, dId, blockAllWa, nowLocal());

  const row = getDb().prepare('SELECT * FROM clinic_holidays WHERE id = ?').get(info.lastInsertRowid);
  return decorate(row);
}

function remove(id) {
  const targetId = requireId(id);
  const existing = getDb().prepare('SELECT * FROM clinic_holidays WHERE id = ?').get(targetId);
  if (!existing) throw new AppError('HOLIDAY_NOT_FOUND');
  getDb().prepare('DELETE FROM clinic_holidays WHERE id = ?').run(targetId);
  return { id: targetId, removed: true };
}

module.exports = {
  list,
  getForDay,
  isHoliday,
  nextResumeDay,
  getWhatsAppHolidayContext,
  create,
  remove,
};
