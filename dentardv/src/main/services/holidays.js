'use strict';
/**
 * Doctor holidays, sick-leave & exceptional off-days service (`clinic_holidays`).
 *
 * Allows the dentist to mark single days or date ranges as non-working
 * (vacation, illness/sick leave, or exceptional closure). Those dates are:
 *   1. Blocked from booking everywhere (WhatsApp & desktop).
 *   2. Surfaced to patients on WhatsApp with a polite holiday notice
 *      (never exposing private medical details when internal reason is `sick`).
 */

const { getDb } = require('../db');
const settings = require('./settings');
const { AppError, cleanText, requireId } = require('../utils/common');
const { isValidISODate, toISODate, addDays, diffDays } = require('../utils/dates');

const VALID_REASONS = new Set(['vacation', 'sick', 'other']);

function decorateHoliday(row) {
  if (!row) return null;
  const conflicts = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM appointments
       WHERE day >= ? AND day <= ? AND status = 'booked'`,
    )
    .get(row.start_day, row.end_day).n;

  return {
    id: row.id,
    start_day: row.start_day,
    end_day: row.end_day,
    is_single_day: row.start_day === row.end_day,
    reason_type: row.reason_type || 'vacation',
    label: row.label || '',
    block_all_wa: Boolean(row.block_all_wa),
    booked_conflicts: Number(conflicts) || 0,
    created_at: row.created_at,
  };
}

/**
 * List configured doctor off-days / holiday periods.
 * @param {{ includePast?: boolean, today?: string }} [options]
 */
function list(options = {}) {
  const today = options.today && isValidISODate(options.today) ? options.today : toISODate();
  const includePast = Boolean(options.includePast);
  const rows = includePast
    ? getDb()
        .prepare('SELECT * FROM clinic_holidays ORDER BY start_day ASC, id ASC')
        .all()
    : getDb()
        .prepare('SELECT * FROM clinic_holidays WHERE end_day >= ? ORDER BY start_day ASC, id ASC')
        .all(today);
  return rows.map(decorateHoliday);
}

/**
 * Return the holiday/off-day record covering `day`, or null if working/normal.
 * @param {string} day ISO date YYYY-MM-DD
 */
function getForDay(day) {
  if (!isValidISODate(day)) return null;
  const row = getDb()
    .prepare(
      `SELECT * FROM clinic_holidays
       WHERE start_day <= ? AND end_day >= ?
       ORDER BY block_all_wa DESC, end_day DESC, id DESC
       LIMIT 1`,
    )
    .get(day, day);
  return row ? decorateHoliday(row) : null;
}

function isHoliday(day) {
  return Boolean(getForDay(day));
}

/**
 * Find the first open working day strictly after `endDay` (skipping weekends & other holidays).
 */
function nextResumeDay(endDay) {
  if (!isValidISODate(endDay)) return null;
  for (let i = 1; i <= 365; i += 1) {
    const candidate = addDays(endDay, i);
    if (!settings.isWorkingDay(candidate)) continue;
    if (getForDay(candidate)) continue;
    return candidate;
  }
  return addDays(endDay, 1);
}

/**
 * Compute active or upcoming holiday context for WhatsApp replies.
 * @param {string} [today]
 * @param {number} [lookaheadDays]
 */
function getWhatsAppHolidayContext(today = toISODate(), lookaheadDays = 7) {
  const active = getForDay(today);
  if (active) {
    // Merge contiguous/overlapping holidays when computing resume day
    const resumeDay = nextResumeDay(active.end_day);
    return {
      activeToday: true,
      blockAllBookings: Boolean(active.block_all_wa),
      holiday: active,
      resumeDay,
    };
  }

  const maxStart = addDays(today, Math.max(1, Number(lookaheadDays) || 7));
  const upcomingRow = getDb()
    .prepare(
      `SELECT * FROM clinic_holidays
       WHERE start_day > ? AND start_day <= ?
       ORDER BY start_day ASC, id ASC
       LIMIT 1`,
    )
    .get(today, maxStart);

  if (upcomingRow) {
    const holiday = decorateHoliday(upcomingRow);
    return {
      activeToday: false,
      blockAllBookings: false,
      holiday,
      resumeDay: nextResumeDay(holiday.end_day),
    };
  }

  return null;
}

/**
 * Create a new off-day or multi-day leave period.
 */
function create(input = {}) {
  const startDay = String(input.start_day ?? input.day ?? '').trim();
  const endDay = String(input.end_day || startDay).trim();

  if (!isValidISODate(startDay) || !isValidISODate(endDay)) {
    throw new AppError('INVALID_DATE');
  }
  if (diffDays(startDay, endDay) < 0) {
    throw new AppError('HOLIDAY_END_BEFORE_START');
  }

  const reasonType = VALID_REASONS.has(input.reason_type) ? input.reason_type : 'vacation';
  const label = cleanText(input.label, 120);
  const blockAllWa = input.block_all_wa === true || String(input.block_all_wa) === '1' ? 1 : 0;

  const info = getDb()
    .prepare(
      `INSERT INTO clinic_holidays (start_day, end_day, reason_type, label, block_all_wa)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(startDay, endDay, reasonType, label || '', blockAllWa);

  const row = getDb()
    .prepare('SELECT * FROM clinic_holidays WHERE id = ?')
    .get(info.lastInsertRowid);
  return decorateHoliday(row);
}

/**
 * Remove an off-day / holiday period so bookings reopen on those dates.
 */
function remove(id) {
  const holidayId = requireId(id);
  const info = getDb().prepare('DELETE FROM clinic_holidays WHERE id = ?').run(holidayId);
  if (info.changes === 0) throw new AppError('HOLIDAY_NOT_FOUND');
  return { ok: true, id: holidayId };
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
