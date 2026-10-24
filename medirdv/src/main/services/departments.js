'use strict';
/**
 * Multi-department clinic service (عيادة متعددة المصالح).
 *
 * Allows polyclinics and group practices to configure independent medical
 * departments — each with its own Arabic/French name, specialty, doctor name,
 * room/floor, consultation fee, daily queue capacity, working days, and
 * patient preparation instructions (shown automatically on WhatsApp).
 */

const { getDb } = require('../db');
const settings = require('./settings');
const { weekday } = require('../utils/dates');
const { AppError, money, cleanText, requireId } = require('../utils/common');

function parseWorkingDays(str) {
  const days = String(str ?? '')
    .split(',')
    .map((d) => Number.parseInt(d, 10))
    .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
  const unique = [...new Set(days)].sort();
  return unique.length > 0 ? unique : settings.getWorkingDays();
}

function hydrate(row) {
  if (!row) return null;
  return {
    ...row,
    consultation_fee: money(row.consultation_fee),
    daily_capacity: Math.max(1, Number.parseInt(row.daily_capacity, 10) || 15),
    working_days_list: parseWorkingDays(row.working_days),
  };
}

function list(includeInactive = false) {
  const rows = getDb()
    .prepare(
      `SELECT * FROM departments ${includeInactive ? '' : 'WHERE active = 1'}
       ORDER BY id ASC`,
    )
    .all();
  return rows.map(hydrate);
}

function listActive() {
  return list(false);
}

function get(id) {
  const row = getDb().prepare('SELECT * FROM departments WHERE id = ?').get(requireId(id));
  if (!row) throw new AppError('DEPARTMENT_NOT_FOUND');
  return hydrate(row);
}

function getOptional(id) {
  if (!id) return null;
  const num = Number.parseInt(id, 10);
  if (!Number.isInteger(num) || num <= 0) return null;
  const row = getDb().prepare('SELECT * FROM departments WHERE id = ?').get(num);
  return hydrate(row);
}

function normalize(input = {}, { partial = false } = {}) {
  const out = {};
  if (!partial || input.name_fr !== undefined || input.name_ar !== undefined) {
    const rawFr = cleanText(input.name_fr, 120);
    const rawAr = cleanText(input.name_ar, 120);
    if (!partial && !rawFr && !rawAr) throw new AppError('DEPARTMENT_NAME_REQUIRED');
    if (input.name_fr !== undefined || !partial) out.name_fr = rawFr || rawAr;
    if (input.name_ar !== undefined || !partial) out.name_ar = rawAr || rawFr;
  }
  if (!partial || input.specialty !== undefined) {
    out.specialty = cleanText(input.specialty, 120);
  }
  if (!partial || input.doctor_name !== undefined) {
    out.doctor_name = cleanText(input.doctor_name, 100);
  }
  if (!partial || input.room !== undefined) {
    out.room = cleanText(input.room, 80);
  }
  if (!partial || input.consultation_fee !== undefined) {
    const fee = Number(input.consultation_fee ?? 0);
    if (!Number.isFinite(fee) || fee < 0) throw new AppError('INVALID_PRICE');
    out.consultation_fee = money(fee);
  }
  if (!partial || input.daily_capacity !== undefined) {
    const cap = Number.parseInt(input.daily_capacity, 10);
    out.daily_capacity = Number.isFinite(cap)
      ? Math.min(200, Math.max(1, cap))
      : settings.getInt('daily_capacity') || 15;
  }
  if (!partial || input.working_days !== undefined) {
    const raw = Array.isArray(input.working_days)
      ? input.working_days.join(',')
      : String(input.working_days ?? settings.get('working_days'));
    const parsed = parseWorkingDays(raw);
    out.working_days = parsed.join(',');
  }
  if (!partial || input.instructions !== undefined) {
    out.instructions = cleanText(input.instructions, 300);
  }
  if (!partial || input.scheduling_mode !== undefined) {
    out.scheduling_mode = input.scheduling_mode === 'slots' ? 'slots' : 'queue';
  }
  if (!partial || input.slot_start_time !== undefined) {
    out.slot_start_time = cleanText(input.slot_start_time, 8) || '08:30';
  }
  if (!partial || input.slot_end_time !== undefined) {
    out.slot_end_time = cleanText(input.slot_end_time, 8) || '16:30';
  }
  if (!partial || input.slot_duration_min !== undefined) {
    const dur = Number.parseInt(input.slot_duration_min, 10);
    out.slot_duration_min = Number.isFinite(dur) ? Math.min(180, Math.max(5, dur)) : 20;
  }
  if (!partial || input.equipment_list !== undefined) {
    out.equipment_list = cleanText(input.equipment_list, 400);
  }
  if (input.active !== undefined) {
    out.active = input.active ? 1 : 0;
  }
  return out;
}

function create(input = {}) {
  const data = normalize(input);
  const info = getDb()
    .prepare(
      `INSERT INTO departments
        (name_fr, name_ar, specialty, doctor_name, room, consultation_fee,
         daily_capacity, working_days, instructions,
         scheduling_mode, slot_start_time, slot_end_time, slot_duration_min, equipment_list, active)
       VALUES
        (@name_fr, @name_ar, @specialty, @doctor_name, @room, @consultation_fee,
         @daily_capacity, @working_days, @instructions,
         @scheduling_mode, @slot_start_time, @slot_end_time, @slot_duration_min, @equipment_list, 1)`,
    )
    .run({
      name_fr: data.name_fr,
      name_ar: data.name_ar || data.name_fr,
      specialty: data.specialty || '',
      doctor_name: data.doctor_name || '',
      room: data.room || '',
      consultation_fee: data.consultation_fee ?? 0,
      daily_capacity: data.daily_capacity ?? 15,
      working_days: data.working_days || settings.get('working_days'),
      instructions: data.instructions || '',
      scheduling_mode: data.scheduling_mode || 'queue',
      slot_start_time: data.slot_start_time || '08:30',
      slot_end_time: data.slot_end_time || '16:30',
      slot_duration_min: data.slot_duration_min || 20,
      equipment_list: data.equipment_list || '',
    });
  return get(info.lastInsertRowid);
}

function update(input = {}) {
  const id = requireId(input.id);
  const current = get(id);
  const data = normalize(input, { partial: true });
  const nextFr = data.name_fr || current.name_fr;
  const nextAr = data.name_ar || current.name_ar || nextFr;
  getDb()
    .prepare(
      `UPDATE departments SET
         name_fr = ?, name_ar = ?, specialty = ?, doctor_name = ?, room = ?,
         consultation_fee = ?, daily_capacity = ?, working_days = ?,
         instructions = ?, scheduling_mode = ?, slot_start_time = ?,
         slot_end_time = ?, slot_duration_min = ?, equipment_list = ?, active = ?
       WHERE id = ?`,
    )
    .run(
      nextFr,
      nextAr,
      data.specialty ?? current.specialty,
      data.doctor_name ?? current.doctor_name,
      data.room ?? current.room,
      data.consultation_fee ?? current.consultation_fee,
      data.daily_capacity ?? current.daily_capacity,
      data.working_days ?? current.working_days,
      data.instructions ?? current.instructions,
      data.scheduling_mode ?? current.scheduling_mode ?? 'queue',
      data.slot_start_time ?? current.slot_start_time ?? '08:30',
      data.slot_end_time ?? current.slot_end_time ?? '16:30',
      data.slot_duration_min ?? current.slot_duration_min ?? 20,
      data.equipment_list ?? current.equipment_list ?? '',
      data.active ?? current.active,
      id,
    );
  const updated = get(id);
  getDb()
    .prepare(
      `UPDATE appointments SET department_name = ?
       WHERE department_id = ? AND status = 'booked'`,
    )
    .run(updated.name_fr, id);
  return updated;
}

function remove(id) {
  const deptId = requireId(id);
  get(deptId);
  const usedAppt = getDb()
    .prepare('SELECT COUNT(*) AS n FROM appointments WHERE department_id = ?')
    .get(deptId).n;
  const usedRx = getDb()
    .prepare('SELECT COUNT(*) AS n FROM prescriptions WHERE department_id = ?')
    .get(deptId).n;
  if (usedAppt + usedRx > 0) {
    getDb().prepare('UPDATE departments SET active = 0 WHERE id = ?').run(deptId);
    return { ok: true, deactivated: true };
  }
  getDb().prepare('DELETE FROM departments WHERE id = ?').run(deptId);
  return { ok: true, deactivated: false };
}

function isWorkingDay(departmentId, isoDate) {
  const dId = departmentId ? Number.parseInt(departmentId, 10) : null;
  const closed = getDb()
    .prepare(
      `SELECT id FROM clinic_closures
       WHERE start_day <= ? AND end_day >= ?
         AND (department_id IS NULL OR (? IS NOT NULL AND department_id = ?))
       LIMIT 1`,
    )
    .get(isoDate, isoDate, dId, dId);
  if (closed) return false;
  const dept = getOptional(departmentId);
  if (!dept) return settings.isWorkingDay(isoDate);
  return dept.working_days_list.includes(weekday(isoDate));
}

function capacityFor(departmentId) {
  const dept = getOptional(departmentId);
  if (!dept) return settings.getInt('daily_capacity') || 15;
  return dept.daily_capacity;
}

function labelFor(dept, lang = 'fr') {
  if (!dept) return '';
  return lang === 'ar' ? dept.name_ar || dept.name_fr : dept.name_fr || dept.name_ar;
}

module.exports = {
  list,
  listActive,
  get,
  getOptional,
  create,
  update,
  remove,
  isWorkingDay,
  capacityFor,
  labelFor,
};
