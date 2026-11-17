'use strict';
/**
 * Expenses service: materials, rent, salaries, lab, etc.
 * Categories are seeded and can be extended from the UI.
 */

const { getDb } = require('../db');
const { AppError, money, cleanText, nowLocal, requireId } = require('../utils/common');
const { isValidISODate, toISODate, monthRange } = require('../utils/dates');

function categories() {
  return getDb()
    .prepare('SELECT * FROM expense_categories WHERE active = 1 ORDER BY id ASC')
    .all();
}

const EXPENSE_SQL = `
  SELECT e.*, c.key AS category_key, c.name_fr AS category_fr, c.name_ar AS category_ar
  FROM expenses e JOIN expense_categories c ON c.id = e.category_id`;

function decorate(row) {
  return { ...row, amount: money(row.amount) };
}

/** @param {{start?:string,end?:string,category_id?:number}} filter */
function list(filter = {}) {
  const start = isValidISODate(filter.start) ? filter.start : monthRange(toISODate().slice(0, 7)).start;
  const end = isValidISODate(filter.end) ? filter.end : toISODate();
  const params = [start, end];
  let sql = `${EXPENSE_SQL} WHERE e.day BETWEEN ? AND ?`;
  if (filter.category_id) {
    sql += ' AND e.category_id = ?';
    params.push(requireId(filter.category_id));
  }
  sql += ' ORDER BY e.day DESC, e.id DESC';
  return getDb().prepare(sql).all(...params).map(decorate);
}

function create(input = {}) {
  const amount = money(Number(input.amount));
  if (!Number.isFinite(amount) || amount <= 0) throw new AppError('INVALID_AMOUNT');
  const categoryId = requireId(input.category_id, 'category_id');
  const category = getDb()
    .prepare('SELECT id FROM expense_categories WHERE id = ?')
    .get(categoryId);
  if (!category) throw new AppError('CATEGORY_NOT_FOUND');
  const day = isValidISODate(input.day) ? input.day : toISODate();

  const info = getDb()
    .prepare(
      `INSERT INTO expenses (category_id, amount, day, label, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(categoryId, amount, day, cleanText(input.label, 200) || null, nowLocal());
  return get(info.lastInsertRowid);
}

function get(id) {
  const row = getDb().prepare(`${EXPENSE_SQL} WHERE e.id = ?`).get(requireId(id));
  if (!row) throw new AppError('EXPENSE_NOT_FOUND');
  return decorate(row);
}

function update(input = {}) {
  const current = get(input.id);
  const amount =
    input.amount !== undefined ? money(Number(input.amount)) : current.amount;
  if (!Number.isFinite(amount) || amount <= 0) throw new AppError('INVALID_AMOUNT');
  const categoryId = input.category_id ? requireId(input.category_id) : current.category_id;
  const day = isValidISODate(input.day) ? input.day : current.day;
  getDb()
    .prepare('UPDATE expenses SET category_id = ?, amount = ?, day = ?, label = ? WHERE id = ?')
    .run(
      categoryId,
      amount,
      day,
      input.label !== undefined ? cleanText(input.label, 200) || null : current.label,
      current.id,
    );
  return get(current.id);
}

function remove(id) {
  const expense = get(id);
  getDb().prepare('DELETE FROM expenses WHERE id = ?').run(expense.id);
  return { ok: true };
}

function totalBetween(startDay, endDay) {
  const row = getDb()
    .prepare('SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count FROM expenses WHERE day BETWEEN ? AND ?')
    .get(startDay, endDay);
  return { total: money(row.total), count: row.count };
}

function byCategory(startDay, endDay) {
  return getDb()
    .prepare(
      `SELECT c.id, c.key, c.name_fr, c.name_ar, COALESCE(SUM(e.amount), 0) AS total, COUNT(e.id) AS count
       FROM expense_categories c
       LEFT JOIN expenses e ON e.category_id = c.id AND e.day BETWEEN ? AND ?
       GROUP BY c.id
       HAVING total > 0
       ORDER BY total DESC`,
    )
    .all(startDay, endDay)
    .map((row) => ({ ...row, total: money(row.total) }));
}

function createCategory({ name_fr, name_ar }) {
  const nameFr = cleanText(name_fr, 60);
  if (!nameFr) throw new AppError('CATEGORY_NAME_REQUIRED');
  const key = nameFr
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 30) || `cat_${Date.now()}`;
  const info = getDb()
    .prepare(
      `INSERT INTO expense_categories (key, name_fr, name_ar)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET name_fr = excluded.name_fr, name_ar = excluded.name_ar`,
    )
    .run(key, nameFr, cleanText(name_ar, 60) || nameFr);
  return { id: info.lastInsertRowid, key };
}

module.exports = { categories, list, create, get, update, remove, totalBetween, byCategory, createCategory };
