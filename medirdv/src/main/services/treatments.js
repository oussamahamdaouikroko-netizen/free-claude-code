'use strict';
/**
 * Treatment catalog. Prices are suggestions only: every appointment keeps its
 * own price copy so a later catalog change never rewrites history.
 */

const { getDb } = require('../db');
const { AppError, money, cleanText, requireId } = require('../utils/common');

function list(includeInactive = false) {
  const rows = getDb()
    .prepare(
      `SELECT * FROM treatments ${includeInactive ? '' : 'WHERE active = 1'}
       ORDER BY name_fr COLLATE NOCASE ASC`,
    )
    .all();
  return rows.map((row) => ({ ...row, default_price: money(row.default_price) }));
}

function get(id) {
  const row = getDb().prepare('SELECT * FROM treatments WHERE id = ?').get(requireId(id));
  if (!row) throw new AppError('TREATMENT_NOT_FOUND');
  return row;
}

function normalize(input, { partial = false } = {}) {
  const out = {};
  if (!partial || input.name_fr !== undefined) {
    const nameFr = cleanText(input.name_fr, 120);
    if (!nameFr) throw new AppError('TREATMENT_NAME_REQUIRED');
    out.name_fr = nameFr;
  }
  if (!partial || input.name_ar !== undefined) {
    out.name_ar = cleanText(input.name_ar, 120) || out.name_fr || '';
  }
  if (!partial || input.default_price !== undefined) {
    const price = Number(input.default_price);
    if (!Number.isFinite(price) || price < 0) throw new AppError('INVALID_PRICE');
    out.default_price = money(price);
  }
  if (input.color !== undefined) {
    const color = String(input.color || '').trim();
    out.color = /^#[0-9a-fA-F]{6}$/.test(color) ? color : '#0066cc';
  }
  if (input.active !== undefined) out.active = input.active ? 1 : 0;
  return out;
}

function create(input = {}) {
  const data = normalize(input);
  const info = getDb()
    .prepare(
      `INSERT INTO treatments (name_fr, name_ar, default_price, color)
       VALUES (@name_fr, @name_ar, @default_price, @color)`,
    )
    .run({
      name_fr: data.name_fr,
      name_ar: data.name_ar || data.name_fr,
      default_price: data.default_price ?? 0,
      color: data.color || '#0066cc',
    });
  return get(info.lastInsertRowid);
}

function update(input = {}) {
  const id = requireId(input.id);
  const current = get(id);
  const data = normalize(input, { partial: true });
  getDb()
    .prepare(
      `UPDATE treatments SET name_fr = ?, name_ar = ?, default_price = ?, color = ?, active = ?
       WHERE id = ?`,
    )
    .run(
      data.name_fr ?? current.name_fr,
      data.name_ar ?? current.name_ar,
      data.default_price ?? current.default_price,
      data.color ?? current.color,
      data.active ?? current.active,
      id,
    );
  const updated = get(id);
  // Keep the label shown on still-booked appointments consistent.
  require('./appointments').syncTreatmentName(id, updated.name_fr);
  return updated;
}

/**
 * Remove a treatment. If it was already used, deactivate it instead so past
 * appointments keep a valid reference.
 */
function remove(id) {
  const treatmentId = requireId(id);
  const used = getDb()
    .prepare('SELECT COUNT(*) AS n FROM appointments WHERE treatment_id = ?')
    .get(treatmentId).n;
  if (used > 0) {
    getDb().prepare('UPDATE treatments SET active = 0 WHERE id = ?').run(treatmentId);
    return { ok: true, deactivated: true };
  }
  getDb().prepare('DELETE FROM treatments WHERE id = ?').run(treatmentId);
  return { ok: true, deactivated: false };
}

module.exports = { list, get, create, update, remove };
