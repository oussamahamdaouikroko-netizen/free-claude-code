'use strict';
/**
 * Append-only audit log.
 *
 * Rules:
 *  - rows are never updated or deleted by the application (only pruned by age);
 *  - `details` is a short technical text, **never** a customer name, phone
 *    number or address. Store the internal ID and let the UI resolve it.
 */

const db = require('../db');
const { AppError, cleanText, nowLocal } = require('../utils/common');

const SEVERITIES = ['info', 'warning', 'critical'];

/**
 * @param {string} action e.g. 'backup.restore', 'stock.adjust'
 * @param {{entity?: string, entityId?: number|null, severity?: 'info'|'warning'|'critical', details?: string}} [options]
 */
function log(action, options = {}) {
  const name = cleanText(action, 60);
  if (!name) throw new AppError('INVALID_AUDIT_ACTION');
  const severity = SEVERITIES.includes(options.severity) ? options.severity : 'info';
  const entity = options.entity ? cleanText(options.entity, 40) : null;
  const entityId = Number.isInteger(options.entityId) ? options.entityId : null;
  const details = options.details ? cleanText(options.details, 500) : null;

  db.getDb()
    .prepare(
      `INSERT INTO audit_log (at, action, entity, entity_id, severity, details)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(nowLocal(), name, entity, entityId, severity, details);

  return { action: name, severity };
}

/** Newest entries first. */
function list(options = {}) {
  const limit = Math.min(Math.max(Number(options.limit) || 50, 1), 500);
  const rows = db
    .getDb()
    .prepare(
      `SELECT id, at, action, entity, entity_id AS entityId, severity, details
       FROM audit_log ORDER BY id DESC LIMIT ?`,
    )
    .all(limit);
  return rows;
}

/** Delete entries older than `keepDays`. Returns how many rows were removed. */
function prune(keepDays) {
  const days = Math.max(Number(keepDays) || 0, 30);
  const result = db
    .getDb()
    .prepare("DELETE FROM audit_log WHERE at < datetime('now', ?)")
    .run(`-${days} days`);
  return result.changes;
}

module.exports = { SEVERITIES, log, list, prune };
