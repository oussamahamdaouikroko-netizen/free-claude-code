'use strict';
/** Append-only audit trail for critical operations (Part 10/12). */
const { getDb, utcNow } = require('../db');

function logAudit({ userId = null, action, entity = '', entityId = '', detail = '' }) {
  getDb()
    .prepare(
      `INSERT INTO audit_logs (user_id, action, entity, entity_id, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(userId, String(action).slice(0, 80), String(entity).slice(0, 60), String(entityId).slice(0, 60), String(detail).slice(0, 1000), utcNow());
}

function listAudit({ limit = 100 } = {}) {
  const n = Math.min(500, Math.max(1, Number(limit) || 100));
  return getDb()
    .prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT ?')
    .all(n);
}

module.exports = { logAudit, listAudit };
