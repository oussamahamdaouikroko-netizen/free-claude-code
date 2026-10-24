'use strict';
/**
 * Phase 8 — Advanced Scheduling, Algerian Holidays/Closures, Waiting-Room Board,
 * Medical Inventory (stock, expiry, auto-consumption per act), Rooms/Equipment,
 * and Staff / Attendance / Payroll (-> Expenses).
 */

const { getDb } = require('../db');
const departments = require('./departments');
const expenses = require('./expenses');
const { AppError, cleanText, money, nowLocal, requireId } = require('../utils/common');
const { isValidISODate, toISODate, diffDays } = require('../utils/dates');

const ALGERIAN_FIXED_HOLIDAYS = [
  { mmdd: '01-01', label_fr: 'Jour de l’An', label_ar: 'رأس السنة الميلادية' },
  { mmdd: '01-12', label_fr: 'Yennayer (Nouvel An Amazigh)', label_ar: 'يناير — رأس السنة الأمازيغية' },
  { mmdd: '05-01', label_fr: 'Fête du Travail', label_ar: 'عيد العمال' },
  { mmdd: '07-05', label_fr: 'Fête de l’Indépendance et de la Jeunesse', label_ar: 'عيد الاستقلال والشباب' },
  { mmdd: '11-01', label_fr: 'Anniversaire de la Révolution du 1er Novembre', label_ar: 'اندلاع ثورة أول نوفمبر' },
];

/* ---------------------- Closures & Algerian Holidays ---------------------- */

function addClosure(input = {}) {
  const startDay = cleanText(input.start_day, 10);
  const endDay = cleanText(input.end_day || startDay, 10);
  if (!isValidISODate(startDay) || !isValidISODate(endDay) || diffDays(startDay, endDay) < 0) {
    throw new AppError('INVALID_DATE');
  }
  const kind = ['holiday_national', 'holiday_lunar', 'closure', 'leave'].includes(input.kind)
    ? input.kind
    : 'closure';
  const labelFr = cleanText(input.label_fr, 140);
  const labelAr = cleanText(input.label_ar, 140) || labelFr;
  if (!labelFr) throw new AppError('EMPTY_DESCRIPTION');
  const deptId = input.department_id ? requireId(input.department_id, 'department_id') : null;

  const info = getDb()
    .prepare(
      `INSERT INTO clinic_closures (start_day, end_day, kind, label_fr, label_ar, department_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(startDay, endDay, kind, labelFr, labelAr, deptId, nowLocal());
  return getDb().prepare('SELECT * FROM clinic_closures WHERE id = ?').get(info.lastInsertRowid);
}

function seedAlgerianHolidays(yearInput) {
  const year = Number.parseInt(yearInput, 10) || Number(toISODate().slice(0, 4));
  const db = getDb();
  let inserted = 0;
  const tx = db.transaction(() => {
    for (const h of ALGERIAN_FIXED_HOLIDAYS) {
      const day = `${year}-${h.mmdd}`;
      const exists = db
        .prepare(
          `SELECT id FROM clinic_closures
           WHERE start_day = ? AND end_day = ? AND kind = 'holiday_national' AND department_id IS NULL`,
        )
        .get(day, day);
      if (!exists) {
        db.prepare(
          `INSERT INTO clinic_closures (start_day, end_day, kind, label_fr, label_ar, department_id, created_at)
           VALUES (?, ?, 'holiday_national', ?, ?, NULL, ?)`,
        ).run(day, day, h.label_fr, h.label_ar, nowLocal());
        inserted += 1;
      }
    }
  });
  tx();
  return { year, inserted, holidays: listClosures({ year }) };
}

function listClosures({ year = null } = {}) {
  if (year) {
    const y = String(year);
    return getDb()
      .prepare('SELECT * FROM clinic_closures WHERE start_day <= ? AND end_day >= ? ORDER BY start_day ASC')
      .all(`${y}-12-31`, `${y}-01-01`);
  }
  return getDb().prepare('SELECT * FROM clinic_closures ORDER BY start_day ASC').all();
}

function deleteClosure(id) {
  getDb().prepare('DELETE FROM clinic_closures WHERE id = ?').run(requireId(id));
  return { ok: true };
}

function isClosedDay(isoDate, departmentId = null) {
  if (!isoDate) return false;
  const dId = departmentId ? Number.parseInt(departmentId, 10) : null;
  const row = getDb()
    .prepare(
      `SELECT id, label_fr, label_ar, kind FROM clinic_closures
       WHERE start_day <= ? AND end_day >= ?
         AND (department_id IS NULL OR (? IS NOT NULL AND department_id = ?))
       LIMIT 1`,
    )
    .get(isoDate, isoDate, dId, dId);
  return row || null;
}

/* ------------------------- Per-Department Time Slots ---------------------- */

function parseMinutes(hhmm, fallback) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return fallback;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return fallback;
  return h * 60 + min;
}

function fmtMinutes(total) {
  const h = String(Math.floor(total / 60)).padStart(2, '0');
  const m = String(total % 60).padStart(2, '0');
  return `${h}:${m}`;
}

function generateTimeSlots(dept) {
  const start = parseMinutes(dept?.slot_start_time, 8 * 60 + 30);
  const end = parseMinutes(dept?.slot_end_time, 16 * 60 + 30);
  const step = Math.max(5, Math.min(180, Number.parseInt(dept?.slot_duration_min, 10) || 20));
  const out = [];
  for (let t = start; t + step <= end; t += step) {
    out.push(fmtMinutes(t));
  }
  return out;
}

function availableSlots(day, departmentId) {
  if (!isValidISODate(day)) throw new AppError('INVALID_DATE');
  const dept = departments.getOptional(departmentId);
  const mode = dept?.scheduling_mode || 'queue';
  const slots = generateTimeSlots(dept);
  const dKey = dept ? dept.id : 0;
  const active = getDb()
    .prepare(
      `SELECT id, slot_time, queue_number, priority FROM appointments
       WHERE day = ? AND COALESCE(department_id, 0) = ?
         AND status IN ('booked', 'done', 'no_show')`,
    )
    .all(day, dKey);
  const byTime = new Map();
  for (const r of active) {
    if (r.slot_time) byTime.set(r.slot_time, r.id);
  }
  return {
    day,
    department_id: dept ? dept.id : null,
    mode,
    slots: slots.map((time) => ({
      time,
      booked: byTime.has(time),
      appointment_id: byTime.get(time) || null,
    })),
  };
}

function nextFreeSlot(day, departmentId) {
  const info = availableSlots(day, departmentId);
  if (info.mode !== 'slots') return '';
  const free = info.slots.find((s) => !s.booked);
  return free ? free.time : '';
}

/* ------------------ No-Show Stats & Waiting-Room Display ------------------ */

function noShowStats({ start, end, department_id = null } = {}) {
  const endDay = isValidISODate(end) ? end : toISODate();
  const startDay = isValidISODate(start) ? start : `${endDay.slice(0, 7)}-01`;
  const params = [startDay, endDay];
  let whereDept = '';
  if (department_id) {
    whereDept = ' AND department_id = ?';
    params.push(requireId(department_id, 'department_id'));
  }
  const rows = getDb()
    .prepare(
      `SELECT status, confirmation_status, COUNT(*) AS n
       FROM appointments
       WHERE day BETWEEN ? AND ?${whereDept}
       GROUP BY status, confirmation_status`,
    )
    .all(...params);

  let total = 0;
  let booked = 0;
  let done = 0;
  let noShow = 0;
  let cancelled = 0;
  let confirmed = 0;
  for (const r of rows) {
    total += r.n;
    if (r.status === 'booked') booked += r.n;
    if (r.status === 'done') done += r.n;
    if (r.status === 'no_show') noShow += r.n;
    if (r.status === 'cancelled') cancelled += r.n;
    if (r.confirmation_status === 'confirmed') confirmed += r.n;
  }
  const nonCancelled = done + noShow + booked;
  return {
    start: startDay,
    end: endDay,
    total,
    booked,
    done,
    no_show: noShow,
    cancelled,
    confirmed,
    no_show_rate_pct: nonCancelled > 0 ? Math.round((noShow / nonCancelled) * 1000) / 10 : 0,
    confirmation_rate_pct: total > 0 ? Math.round((confirmed / total) * 1000) / 10 : 0,
  };
}

function maskPatientInitials(fullName) {
  const parts = String(fullName || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return '—';
  return parts.map((p) => `${p[0].toUpperCase()}.`).join(' ');
}

function waitingRoomBoard(day = toISODate(), departmentId = null) {
  if (!isValidISODate(day)) throw new AppError('INVALID_DATE');
  const params = [day];
  let deptClause = '';
  if (departmentId) {
    deptClause = ' AND COALESCE(a.department_id, 0) = ?';
    params.push(requireId(departmentId, 'department_id'));
  }
  const rows = getDb()
    .prepare(
      `SELECT a.id, a.queue_number, a.slot_time, a.priority, a.status, a.department_id,
              p.full_name, d.name_fr AS dept_name_fr, d.name_ar AS dept_name_ar,
              d.room AS dept_room, d.slot_duration_min
       FROM appointments a
       JOIN patients p ON p.id = a.patient_id
       LEFT JOIN departments d ON d.id = a.department_id
       WHERE a.day = ? AND a.status = 'booked'${deptClause}
       ORDER BY CASE a.priority WHEN 'urgent' THEN 0 WHEN 'walk_in' THEN 1 ELSE 2 END ASC,
                CASE WHEN a.slot_time <> '' THEN a.slot_time ELSE '99:99' END ASC,
                a.queue_number ASC`,
    )
    .all(...params);

  return rows.map((r, idx) => {
    const avgMin = Number(r.slot_duration_min) || 15;
    return {
      appointment_id: r.id,
      queue_number: r.queue_number,
      initials: maskPatientInitials(r.full_name),
      slot_time: r.slot_time || '',
      priority: r.priority || 'normal',
      room: r.dept_room || '',
      dept_name_fr: r.dept_name_fr || '',
      dept_name_ar: r.dept_name_ar || '',
      position: idx + 1,
      estimated_wait_min: idx * avgMin,
    };
  });
}

/* --------------------- Medical Consumables & Inventory -------------------- */

function listInventory() {
  return getDb().prepare('SELECT * FROM inventory_items ORDER BY name_fr ASC').all();
}

function upsertInventoryItem(input = {}) {
  const nameFr = cleanText(input.name_fr, 140);
  if (!nameFr) throw new AppError('EMPTY_DESCRIPTION');
  const db = getDb();
  const payload = {
    sku: cleanText(input.sku, 60),
    name_fr: nameFr,
    name_ar: cleanText(input.name_ar, 140) || nameFr,
    category: cleanText(input.category, 60) || 'consommable',
    unit: cleanText(input.unit, 30) || 'unité',
    quantity: Math.max(0, Number(input.quantity) || 0),
    min_threshold: Math.max(0, Number(input.min_threshold ?? 5) || 0),
    expiry_day: isValidISODate(input.expiry_day) ? input.expiry_day : '',
    unit_cost: money(Math.max(0, Number(input.unit_cost) || 0)),
    supplier_name: cleanText(input.supplier_name, 120),
    supplier_phone: cleanText(input.supplier_phone, 40),
    updated_at: nowLocal(),
  };
  if (input.id) {
    const id = requireId(input.id);
    db.prepare(
      `UPDATE inventory_items
       SET sku=@sku, name_fr=@name_fr, name_ar=@name_ar, category=@category, unit=@unit,
           quantity=@quantity, min_threshold=@min_threshold, expiry_day=@expiry_day,
           unit_cost=@unit_cost, supplier_name=@supplier_name, supplier_phone=@supplier_phone,
           updated_at=@updated_at
       WHERE id = @id`,
    ).run({ ...payload, id });
    return db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(id);
  }
  const info = db
    .prepare(
      `INSERT INTO inventory_items
        (sku, name_fr, name_ar, category, unit, quantity, min_threshold, expiry_day,
         unit_cost, supplier_name, supplier_phone, updated_at)
       VALUES
        (@sku, @name_fr, @name_ar, @category, @unit, @quantity, @min_threshold, @expiry_day,
         @unit_cost, @supplier_name, @supplier_phone, @updated_at)`,
    )
    .run(payload);
  return db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(info.lastInsertRowid);
}

function recordMovement({ item_id, direction, quantity, reason = '', appointment_id = null } = {}) {
  const itemId = requireId(item_id, 'item_id');
  const dir = direction === 'in' ? 'in' : 'out';
  const qty = Number(quantity);
  if (!Number.isFinite(qty) || qty <= 0) throw new AppError('INVALID_AMOUNT');

  const db = getDb();
  const tx = db.transaction(() => {
    const item = db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(itemId);
    if (!item) throw new AppError('NOT_FOUND');
    const nextQty = dir === 'in' ? item.quantity + qty : Math.max(0, item.quantity - qty);
    db.prepare('UPDATE inventory_items SET quantity = ?, updated_at = ? WHERE id = ?').run(
      nextQty,
      nowLocal(),
      itemId,
    );
    db.prepare(
      `INSERT INTO inventory_movements (item_id, direction, quantity, reason, appointment_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(itemId, dir, qty, cleanText(reason, 200), appointment_id || null, nowLocal());
    return db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(itemId);
  });
  return tx();
}

function inventoryAlerts(referenceDay = toISODate()) {
  const items = listInventory();
  const lowStock = [];
  const expiring = [];
  for (const it of items) {
    if (it.quantity <= it.min_threshold) lowStock.push(it);
    if (it.expiry_day && isValidISODate(it.expiry_day)) {
      const daysLeft = diffDays(referenceDay, it.expiry_day);
      if (daysLeft <= 30) {
        expiring.push({ ...it, days_left: daysLeft, expired: daysLeft < 0 });
      }
    }
  }
  return { low_stock: lowStock, expiring };
}

function setTreatmentConsumables(treatmentId, links = []) {
  const tId = requireId(treatmentId, 'treatment_id');
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM treatment_consumables WHERE treatment_id = ?').run(tId);
    const ins = db.prepare(
      'INSERT INTO treatment_consumables (treatment_id, item_id, qty_per_act) VALUES (?, ?, ?)',
    );
    for (const l of links) {
      const itemId = requireId(l.item_id, 'item_id');
      const qty = Math.max(0.01, Number(l.qty_per_act) || 1);
      ins.run(tId, itemId, qty);
    }
  });
  tx();
  return db
    .prepare(
      `SELECT tc.*, i.name_fr, i.name_ar, i.unit
       FROM treatment_consumables tc
       JOIN inventory_items i ON i.id = tc.item_id
       WHERE tc.treatment_id = ?`,
    )
    .all(tId);
}

function consumeForTreatment(treatmentId, appointmentId = null) {
  if (!treatmentId) return [];
  const links = getDb()
    .prepare('SELECT * FROM treatment_consumables WHERE treatment_id = ?')
    .all(Number(treatmentId));
  const updated = [];
  for (const l of links) {
    updated.push(
      recordMovement({
        item_id: l.item_id,
        direction: 'out',
        quantity: l.qty_per_act,
        reason: `Acte #${treatmentId}`,
        appointment_id: appointmentId,
      }),
    );
  }
  return updated;
}

/* -------------------- Staff, Attendance & Payroll -> Expenses ------------- */

function listStaff(includeInactive = false) {
  return getDb()
    .prepare(`SELECT * FROM staff_members ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY id ASC`)
    .all();
}

function upsertStaff(input = {}) {
  const fullName = cleanText(input.full_name, 120);
  if (!fullName) throw new AppError('INVALID_NAME');
  const db = getDb();
  const salary = money(Math.max(0, Number(input.monthly_salary) || 0));
  const roleTitle = cleanText(input.role_title, 80);
  const phone = cleanText(input.phone, 40);
  const hireDay = isValidISODate(input.hire_day) ? input.hire_day : '';
  const active = input.active === false || input.active === 0 ? 0 : 1;

  if (input.id) {
    const id = requireId(input.id);
    db.prepare(
      `UPDATE staff_members
       SET full_name=?, role_title=?, phone=?, monthly_salary=?, hire_day=?, active=?
       WHERE id=?`,
    ).run(fullName, roleTitle, phone, salary, hireDay, active, id);
    return db.prepare('SELECT * FROM staff_members WHERE id = ?').get(id);
  }
  const info = db
    .prepare(
      `INSERT INTO staff_members (full_name, role_title, phone, monthly_salary, hire_day, active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(fullName, roleTitle, phone, salary, hireDay, active, nowLocal());
  return db.prepare('SELECT * FROM staff_members WHERE id = ?').get(info.lastInsertRowid);
}

function recordAttendance(input = {}) {
  const staffId = requireId(input.staff_id, 'staff_id');
  const day = isValidISODate(input.day) ? input.day : toISODate();
  const status = ['present', 'absent', 'late', 'leave'].includes(input.status) ? input.status : 'present';
  getDb()
    .prepare(
      `INSERT INTO staff_attendance (staff_id, day, status, check_in, check_out, notes)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(staff_id, day) DO UPDATE SET
         status=excluded.status, check_in=excluded.check_in,
         check_out=excluded.check_out, notes=excluded.notes`,
    )
    .run(
      staffId,
      day,
      status,
      cleanText(input.check_in, 10),
      cleanText(input.check_out, 10),
      cleanText(input.notes, 200),
    );
  return getDb()
    .prepare('SELECT * FROM staff_attendance WHERE staff_id = ? AND day = ?')
    .get(staffId, day);
}

function listAttendance(day = toISODate()) {
  return getDb()
    .prepare(
      `SELECT sa.*, sm.full_name, sm.role_title
       FROM staff_attendance sa
       JOIN staff_members sm ON sm.id = sa.staff_id
       WHERE sa.day = ?
       ORDER BY sm.full_name ASC`,
    )
    .all(day);
}

function runPayroll(input = {}) {
  const staffId = requireId(input.staff_id, 'staff_id');
  const db = getDb();
  const staff = db.prepare('SELECT * FROM staff_members WHERE id = ?').get(staffId);
  if (!staff) throw new AppError('NOT_FOUND');

  const paidDay = isValidISODate(input.paid_day) ? input.paid_day : toISODate();
  const periodMonth = cleanText(input.period_month, 7) || paidDay.slice(0, 7);
  const baseSalary = money(
    input.base_salary !== undefined ? Math.max(0, Number(input.base_salary) || 0) : staff.monthly_salary,
  );
  const bonus = money(Math.max(0, Number(input.bonus) || 0));
  const deductions = money(Math.max(0, Number(input.deductions) || 0));
  const netPaid = money(Math.max(0, baseSalary + bonus - deductions));
  if (netPaid <= 0) throw new AppError('INVALID_AMOUNT');

  const tx = db.transaction(() => {
    const salCat =
      db.prepare("SELECT id FROM expense_categories WHERE key = 'salaries' LIMIT 1").get() ||
      db.prepare('SELECT id FROM expense_categories ORDER BY id ASC LIMIT 1').get();
    const exp = expenses.create({
      day: paidDay,
      category_id: salCat.id,
      amount: netPaid,
      label: `Salaire ${staff.full_name} (${periodMonth})`,
    });
    const info = db
      .prepare(
        `INSERT INTO staff_payroll
          (staff_id, period_month, base_salary, bonus, deductions, net_paid, paid_day, expense_id, notes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        staffId,
        periodMonth,
        baseSalary,
        bonus,
        deductions,
        netPaid,
        paidDay,
        exp.id,
        cleanText(input.notes, 200),
        nowLocal(),
      );
    return db.prepare('SELECT * FROM staff_payroll WHERE id = ?').get(info.lastInsertRowid);
  });
  return tx();
}

function listPayroll(periodMonth = null) {
  if (periodMonth) {
    return getDb()
      .prepare(
        `SELECT sp.*, sm.full_name, sm.role_title
         FROM staff_payroll sp JOIN staff_members sm ON sm.id = sp.staff_id
         WHERE sp.period_month = ? ORDER BY sp.id DESC`,
      )
      .all(String(periodMonth));
  }
  return getDb()
    .prepare(
      `SELECT sp.*, sm.full_name, sm.role_title
       FROM staff_payroll sp JOIN staff_members sm ON sm.id = sp.staff_id
       ORDER BY sp.id DESC LIMIT 100`,
    )
    .all();
}

/* -------------------------- Clinic Rooms & Equipment ---------------------- */

function listRooms() {
  return getDb()
    .prepare(
      `SELECT r.*, d.name_fr AS dept_name_fr, d.name_ar AS dept_name_ar
       FROM clinic_rooms r
       LEFT JOIN departments d ON d.id = r.department_id
       ORDER BY r.id ASC`,
    )
    .all();
}

function upsertRoom(input = {}) {
  const name = cleanText(input.name, 100);
  if (!name) throw new AppError('EMPTY_DESCRIPTION');
  const deptId = input.department_id ? requireId(input.department_id, 'department_id') : null;
  const equipment = cleanText(input.equipment, 400);
  const status = input.status === 'maintenance' ? 'maintenance' : 'available';
  const notes = cleanText(input.notes, 200);
  const db = getDb();
  if (input.id) {
    const id = requireId(input.id);
    db.prepare(
      'UPDATE clinic_rooms SET name=?, department_id=?, equipment=?, status=?, notes=? WHERE id=?',
    ).run(name, deptId, equipment, status, notes, id);
    return db.prepare('SELECT * FROM clinic_rooms WHERE id = ?').get(id);
  }
  const info = db
    .prepare(
      'INSERT INTO clinic_rooms (name, department_id, equipment, status, notes, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(name, deptId, equipment, status, notes, nowLocal());
  return db.prepare('SELECT * FROM clinic_rooms WHERE id = ?').get(info.lastInsertRowid);
}

function deleteRoom(id) {
  getDb().prepare('DELETE FROM clinic_rooms WHERE id = ?').run(requireId(id));
  return { ok: true };
}

module.exports = {
  ALGERIAN_FIXED_HOLIDAYS,
  addClosure,
  seedAlgerianHolidays,
  listClosures,
  deleteClosure,
  isClosedDay,
  generateTimeSlots,
  availableSlots,
  nextFreeSlot,
  noShowStats,
  waitingRoomBoard,
  listInventory,
  upsertInventoryItem,
  recordMovement,
  inventoryAlerts,
  setTreatmentConsumables,
  consumeForTreatment,
  listStaff,
  upsertStaff,
  recordAttendance,
  listAttendance,
  runPayroll,
  listPayroll,
  listRooms,
  upsertRoom,
  deleteRoom,
};
