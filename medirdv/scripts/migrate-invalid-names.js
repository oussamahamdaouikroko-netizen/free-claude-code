#!/usr/bin/env node
'use strict';
/**
 * Migration script for existing patients registered with greeting or invalid names.
 *
 * Modes:
 *   - Dry-run (DEFAULT): inspects the database and prints a detailed report of
 *     affected accounts without modifying any row.
 *       node scripts/migrate-invalid-names.js --dry-run [--db /path/to/medirdv.sqlite]
 *
 *   - Apply (`--apply`): creates a safety `.sqlite` backup file, clears invalid
 *     `patients.full_name` to `''` (preserving the old raw text in `notes` and
 *     keeping `patient.id` + all appointments/payments/prescriptions intact), and
 *     places each affected phone number into persistent `await_full_name` state
 *     in `bot_sessions` so the bot asks for their real full name on next contact.
 *       node scripts/migrate-invalid-names.js --apply [--db /path/to/medirdv.sqlite]
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const intents = require('../src/main/whatsapp/intents');
const { SCHEMA_VERSION, MIGRATIONS } = require('../src/main/db/schema');
const { nowLocal, phoneKey } = require('../src/main/utils/common');

function defaultDbCandidates() {
  const home = os.homedir();
  const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  return [
    path.join(appData, 'MediRDV', 'data', 'medirdv.sqlite'),
    path.join(home, '.config', 'MediRDV', 'data', 'medirdv.sqlite'),
    path.join(home, 'Library', 'Application Support', 'MediRDV', 'data', 'medirdv.sqlite'),
    path.resolve(process.cwd(), 'medirdv.sqlite'),
  ];
}

function resolveDbPath(explicitPath) {
  if (explicitPath) return path.resolve(explicitPath);
  for (const candidate of defaultDbCandidates()) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function classifyPatientName(fullName) {
  const raw = String(fullName ?? '');
  if (!raw.trim()) {
    return { status: 'already_awaiting_name', reason: 'empty_awaiting_name' };
  }
  if (intents.isGreeting(raw)) {
    return { status: 'affected', category: 'greeting_as_name', reason: 'greeting' };
  }
  const check = intents.validatePersonName(raw);
  if (!check.valid) {
    return { status: 'affected', category: 'invalid_name', reason: check.reason };
  }
  return { status: 'valid', formatted: check.name };
}

function ensureBotSessionsTable(db) {
  let current = db.pragma('user_version', { simple: true });
  if (current > 0 && current < SCHEMA_VERSION) {
    for (let v = current + 1; v <= SCHEMA_VERSION; v += 1) {
      if (MIGRATIONS[v]) {
        const tx = db.transaction(() => {
          db.exec(MIGRATIONS[v]);
          db.pragma(`user_version = ${v}`);
        });
        tx();
      }
    }
  } else {
    db.exec(`
      CREATE TABLE IF NOT EXISTS bot_sessions (
        phone_key  TEXT PRIMARY KEY,
        state_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }
}

/**
 * Inspects an open `better-sqlite3` database handle without mutating anything.
 */
function inspectInvalidPatients(db) {
  const rows = db
    .prepare(
      `SELECT p.id, p.full_name, p.phone, p.notes, p.created_at,
              (SELECT COUNT(*) FROM appointments a WHERE a.patient_id = p.id) AS appointments_count
       FROM patients p
       ORDER BY p.id ASC`,
    )
    .all();

  const affected = [];
  const alreadyAwaiting = [];
  let validCount = 0;

  for (const row of rows) {
    const check = classifyPatientName(row.full_name);
    if (check.status === 'valid') {
      validCount += 1;
    } else if (check.status === 'already_awaiting_name') {
      alreadyAwaiting.push({
        id: row.id,
        phone: row.phone,
        appointments_count: row.appointments_count,
      });
    } else {
      affected.push({
        id: row.id,
        old_name: row.full_name,
        phone: row.phone,
        phone_key: phoneKey(row.phone),
        category: check.category,
        reason: check.reason,
        appointments_count: row.appointments_count,
        notes: row.notes || '',
      });
    }
  }

  return {
    total_patients: rows.length,
    valid_count: validCount,
    already_awaiting_count: alreadyAwaiting.length,
    affected_count: affected.length,
    greeting_count: affected.filter((r) => r.category === 'greeting_as_name').length,
    invalid_format_count: affected.filter((r) => r.category === 'invalid_name').length,
    affected,
    already_awaiting: alreadyAwaiting,
  };
}

/**
 * Runs the migration in either dry-run (default) or apply mode.
 *
 * @param {{dbPath?: string, db?: import('better-sqlite3').Database, apply?: boolean, createBackup?: boolean}} options
 */
function runMigration({ dbPath, db: externalDb, apply = false, createBackup = true } = {}) {
  const ownsDb = !externalDb;
  const resolvedPath = externalDb ? null : resolveDbPath(dbPath);
  if (ownsDb && (!resolvedPath || !fs.existsSync(resolvedPath))) {
    return {
      ok: false,
      mode: apply ? 'apply' : 'dry-run',
      dbPath: resolvedPath || dbPath || null,
      error: 'DATABASE_NOT_FOUND',
      candidates: defaultDbCandidates(),
    };
  }

  const db = externalDb || new Database(resolvedPath, { readonly: !apply });
  try {
    const plan = inspectInvalidPatients(db);
    if (!apply) {
      return {
        ok: true,
        mode: 'dry-run',
        dbPath: resolvedPath,
        backupPath: null,
        migrated_count: 0,
        sessions_flagged: 0,
        ...plan,
      };
    }

    let backupPath = null;
    if (createBackup && resolvedPath) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      backupPath = `${resolvedPath}.backup-before-name-migration-${stamp}`;
      fs.copyFileSync(resolvedPath, backupPath);
    }

    ensureBotSessionsTable(db);

    const nowTs = Date.now();
    const nowIso = nowLocal();
    const updatePatient = db.prepare(
      'UPDATE patients SET full_name = ?, notes = ?, updated_at = ? WHERE id = ?',
    );
    const upsertSession = db.prepare(
      `INSERT INTO bot_sessions (phone_key, state_json, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(phone_key) DO UPDATE SET
         state_json = excluded.state_json,
         updated_at = excluded.updated_at`,
    );

    let migratedCount = 0;
    let sessionsFlagged = 0;

    const tx = db.transaction(() => {
      for (const item of plan.affected) {
        const auditTag = `[Migration nom invalide: "${item.old_name}"]`;
        const nextNotes = item.notes.includes(auditTag)
          ? item.notes
          : item.notes
            ? `${item.notes}\n${auditTag}`
            : auditTag;
        updatePatient.run('', nextNotes, nowIso, item.id);
        migratedCount += 1;

        if (item.phone_key) {
          const lang = /[\u0600-\u06FF]/.test(item.old_name) ? 'ar' : 'fr';
          upsertSession.run(
            item.phone_key,
            JSON.stringify({ step: 'await_full_name', lang, migratedFromId: item.id }),
            nowTs,
          );
          sessionsFlagged += 1;
        }
      }
    });
    tx();

    return {
      ok: true,
      mode: 'apply',
      dbPath: resolvedPath,
      backupPath,
      migrated_count: migratedCount,
      sessions_flagged: sessionsFlagged,
      ...plan,
    };
  } finally {
    if (ownsDb) db.close();
  }
}

function parseCliArgs(argv) {
  let apply = false;
  let dbPath = '';
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') apply = true;
    else if (arg === '--dry-run') apply = false;
    else if (arg === '--db' && argv[i + 1]) {
      dbPath = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--db=')) {
      dbPath = arg.slice('--db='.length);
    }
  }
  return { apply, dbPath };
}

if (require.main === module) {
  const { apply, dbPath } = parseCliArgs(process.argv.slice(2));
  const res = runMigration({ dbPath, apply });

  if (!res.ok) {
    console.log('[migrate-invalid-names] Mode:', res.mode);
    console.log('[migrate-invalid-names] Aucune base SQLite trouvée automatiquement.');
    console.log('Emplacements vérifiés :');
    for (const c of res.candidates) console.log(`  - ${c}`);
    console.log('\nUtilisation :');
    console.log('  node scripts/migrate-invalid-names.js --dry-run --db "/chemin/vers/medirdv.sqlite"');
    console.log('  node scripts/migrate-invalid-names.js --apply   --db "/chemin/vers/medirdv.sqlite"');
    process.exit(0);
  }

  console.log('==============================================================');
  console.log(` Migration des noms invalides — Mode : ${res.mode.toUpperCase()}`);
  console.log('==============================================================');
  console.log(`Base de données           : ${res.dbPath}`);
  console.log(`Total patients            : ${res.total_patients}`);
  console.log(`Noms valides (inchangés)  : ${res.valid_count}`);
  console.log(`Déjà en attente de nom    : ${res.already_awaiting_count}`);
  console.log(`Comptes affectés          : ${res.affected_count}`);
  console.log(`  ├─ Salutations comme nom: ${res.greeting_count}`);
  console.log(`  └─ Format non valide    : ${res.invalid_format_count}`);

  if (res.affected.length > 0) {
    console.log('\nDétail des comptes affectés :');
    for (const item of res.affected) {
      console.log(
        `  - #${item.id} | "${item.old_name}" | tél: ${item.phone || '-'} | motif: ${item.reason} | RDV liés: ${item.appointments_count}`,
      );
    }
  }

  if (res.mode === 'dry-run') {
    console.log('\n[DRY-RUN] Aucune modification appliquée. Relancez avec --apply pour exécuter.');
  } else {
    if (res.backupPath) console.log(`\nSauvegarde créée          : ${res.backupPath}`);
    console.log(`Patients mis à jour       : ${res.migrated_count}`);
    console.log(`Sessions WhatsApp marquées: ${res.sessions_flagged} (await_full_name)`);
  }
}

module.exports = {
  classifyPatientName,
  inspectInvalidPatients,
  runMigration,
};
