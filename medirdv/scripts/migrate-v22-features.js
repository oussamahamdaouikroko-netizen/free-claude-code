#!/usr/bin/env node
'use strict';
/**
 * Idempotent database migration script for MediRDV v2.2 features:
 *   - patients.blocked_until (UTC cooldown timestamp after self-cancellation)
 *   - appointments.is_paid, appointments.paid_at, appointments.paid_by
 *   - bot_sessions table & index
 *
 * Safe to run multiple times without error or data loss.
 * Usage:
 *   node scripts/migrate-v22-features.js --db /path/to/medirdv.sqlite
 */

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { migrate, ensureIdempotentColumns, SCHEMA_VERSION } = require('../src/main/db/schema');

function runSchemaMigration(dbPath) {
  const resolved = path.resolve(dbPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Database file not found: ${resolved}`);
  }
  const db = new Database(resolved);
  try {
    migrate(db);
    ensureIdempotentColumns(db);
    return {
      ok: true,
      dbPath: resolved,
      schemaVersion: db.pragma('user_version', { simple: true }),
      expectedVersion: SCHEMA_VERSION,
    };
  } finally {
    db.close();
  }
}

if (require.main === module) {
  const idx = process.argv.indexOf('--db');
  const target = idx >= 0 ? process.argv[idx + 1] : process.argv[2];
  if (!target) {
    console.log('Usage: node scripts/migrate-v22-features.js --db "/path/to/medirdv.sqlite"');
    process.exit(0);
  }
  const res = runSchemaMigration(target);
  console.log('[migrate-v22-features] Success:', JSON.stringify(res));
}

module.exports = { runSchemaMigration };
