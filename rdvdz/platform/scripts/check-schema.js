#!/usr/bin/env node
/**
 * Vérifie que le schéma SQL contient bien TRIX les objets attendus par le code.
 *
 * Objectif : détecter tôt une divergence entre `packages/db/migrations` et les
 * requêtes des services (une colonne renommée ne doit pas être découverte en
 * production par une erreur 500).
 *
 * Usage : npm run test:schema
 * Sortie : code 0 si tout est présent, code 1 avec la liste des manques.
 */

import '../tests/env.js';
import { closeDatabase, migrate, openDatabase, schemaVersion } from '../src/db.js';
import { seedTemplates } from '../src/modules/notifications/service.js';
import { db } from '../src/db.js';

/** Colonnes obligatoires par table (sous-ensemble critique utilisé par le code). */
const REQUIRED = {
  users: ['id', 'role', 'full_name', 'phone', 'password_hash', 'password_salt', 'status', 'locale', 'failed_logins', 'locked_until'],
  sessions: ['id', 'user_id', 'token_hash', 'csrf_token', 'expires_at', 'revoked_at'],
  patients: ['id', 'user_id', 'full_name', 'phone', 'wilaya_code', 'consent_at'],
  doctors: ['id', 'user_id', 'clinic_id', 'primary_specialty_code', 'consultation_fee', 'teleconsult_fee', 'teleconsult_enabled', 'slot_minutes', 'verified_at', 'rejected_at'],
  clinics: ['id', 'name_fr', 'name_ar', 'kind', 'wilaya_code', 'verified_at'],
  doctor_slots: ['id', 'doctor_id', 'starts_at', 'ends_at', 'mode', 'status', 'hold_expires_at'],
  appointments: ['id', 'reference', 'slot_id', 'patient_id', 'doctor_id', 'clinic_id', 'branch_id', 'status', 'mode', 'price', 'service_fee', 'confirmed_at', 'desktop_uuid', 'idempotency_key'],
  booking_holds: ['id', 'slot_id', 'patient_id', 'expires_at', 'released_at'],
  consultations: ['id', 'reference', 'patient_id', 'doctor_id', 'kind', 'status', 'price', 'consent_at', 'emergency_ack_at', 'doctor_answer', 'refusal_reason', 'video_room'],
  consultation_messages: ['id', 'consultation_id', 'author_user_id', 'author_role', 'body'],
  medical_documents: ['id', 'consultation_id', 'patient_id', 'doctor_id', 'storage_key', 'filename', 'mime', 'size_bytes', 'sha256', 'deleted_at'],
  payments: ['id', 'purpose', 'appointment_id', 'consultation_id', 'patient_id', 'provider', 'provider_ref', 'amount', 'currency', 'status', 'livemode', 'idempotency_key', 'paid_at'],
  payment_events: ['id', 'provider', 'provider_event_id', 'signature_valid', 'payload', 'processed_at'],
  refunds: ['id', 'payment_id', 'amount', 'reason', 'status', 'processed_at'],
  commission_rules: ['id', 'scope', 'branch_id', 'platform_pct', 'branch_pct', 'operator_pct', 'psp_fixed', 'doctor_pct', 'active'],
  commissions: ['id', 'source_type', 'source_id', 'payment_id', 'rule_id', 'beneficiary_type', 'beneficiary_id', 'amount', 'status', 'settlement_id'],
  settlements: ['id', 'beneficiary_type', 'beneficiary_id', 'period_start', 'period_end', 'gross', 'fees', 'net', 'status'],
  branches: ['id', 'code', 'name', 'wilaya_code', 'commission_pct', 'status', 'manager_user_id'],
  branch_operators: ['branch_id', 'user_id'],
  doctor_branches: ['doctor_id', 'branch_id', 'commission_pct'],
  user_scopes: ['user_id', 'branch_id', 'wilaya_code'],
  desktop_devices: ['id', 'clinic_id', 'doctor_id', 'product', 'token_hash', 'secret', 'revoked_at', 'last_cursor'],
  desktop_inbox: ['id', 'device_id', 'kind', 'remote_id', 'payload', 'status'],
  desktop_sync_log: ['id', 'device_id', 'direction', 'entity', 'operation', 'status', 'detail'],
  desktop_conflicts: ['id', 'device_id', 'remote_id', 'local_id', 'reason', 'resolution', 'resolved_at'],
  notification_templates: ['code', 'channel', 'locale', 'subject', 'body', 'whatsapp_template_name', 'active'],
  notifications: ['id', 'user_id', 'patient_id', 'channel', 'template_code', 'locale', 'payload', 'body', 'status', 'dedupe_key', 'read_at'],
  notification_preferences: ['user_id', 'event_code', 'channel', 'enabled'],
  wa_messages: ['id', 'to_phone', 'template_name', 'locale', 'body', 'mode', 'status'],
  audit_logs: ['id', 'actor_user_id', 'action', 'entity', 'entity_id', 'details', 'created_at'],
  reviews: ['id', 'doctor_id', 'patient_id', 'appointment_id', 'rating', 'comment', 'status'],
  system_settings: ['key', 'value'],
};

/** Vues attendues. */
const REQUIRED_VIEWS = ['v_revenue_daily'];

/** Index uniques dont dépend l'intégrité (course sur créneaux, rejeu). */
const REQUIRED_INDEXES = [
  ['appointments', 'uq_appointments_slot'],
  ['payments', 'uq_payments_idem'],
  ['payment_events', 'uq_payment_events'],
  ['desktop_inbox', 'uq_inbox_device_remote'],
  ['notifications', 'uq_notifications_dedupe'],
];

let failures = 0;
function fail(message) {
  failures += 1;
  console.error(`  ✗ ${message}`);
}
function ok(message) {
  console.log(`  ✓ ${message}`);
}

async function main() {
  await openDatabase({ driver: 'pglite', pgliteDir: ':memory:' });
  await migrate();
  await seedTemplates();
  console.log(`[check-schema] version: ${await schemaVersion()}`);

  const columns = await db().query(
    `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'`,
  );
  const byTable = new Map();
  for (const row of columns.rows) {
    if (!byTable.has(row.table_name)) byTable.set(row.table_name, new Set());
    byTable.get(row.table_name).add(row.column_name);
  }

  console.log('[check-schema] tables et colonnes');
  for (const [table, expected] of Object.entries(REQUIRED)) {
    const actual = byTable.get(table);
    if (!actual) {
      fail(`table manquante: ${table}`);
      continue;
    }
    const missing = expected.filter((column) => !actual.has(column));
    if (missing.length) fail(`${table}: colonnes manquantes ${missing.join(', ')}`);
    else ok(`${table} (${expected.length} colonnes vérifiées)`);
  }

  console.log('[check-schema] vues');
  const views = await db().query(`SELECT table_name FROM information_schema.views WHERE table_schema = 'public'`);
  const viewNames = new Set(views.rows.map((row) => row.table_name));
  for (const view of REQUIRED_VIEWS) {
    if (viewNames.has(view)) ok(view);
    else fail(`vue manquante: ${view}`);
  }

  console.log('[check-schema] index uniques');
  const indexes = await db().query(`SELECT tablename, indexname FROM pg_indexes WHERE schemaname = 'public'`);
  const indexKeys = new Set(indexes.rows.map((row) => `${row.tablename}:${row.indexname}`));
  for (const [table, index] of REQUIRED_INDEXES) {
    if (indexKeys.has(`${table}:${index}`)) ok(`${table}.${index}`);
    else fail(`index manquant: ${table}.${index}`);
  }

  console.log('[check-schema] données de référence');
  const reference = await Promise.all([
    db().query('SELECT count(*)::int AS n FROM wilayas'),
    db().query('SELECT count(*)::int AS n FROM specialties'),
    db().query(`SELECT count(*)::int AS n FROM system_settings WHERE key LIKE 'public.%'`),
    db().query(`SELECT count(*)::int AS n FROM notification_templates`),
  ]);
  const [wilayas, specialties, settings, templates] = reference.map((r) => r.rows[0].n);
  if (wilayas >= 58) ok(`wilayas: ${wilayas}`);
  else fail(`wilayas: ${wilayas} (58 attendues)`);
  if (specialties >= 10) ok(`spécialités: ${specialties}`);
  else fail(`spécialités: ${specialties} (au moins 10)`);
  if (settings >= 3) ok(`réglages publics: ${settings}`);
  else fail(`réglages publics: ${settings} (au moins 3)`);
  if (templates >= 10) ok(`modèles de notification: ${templates}`);
  else fail(`modèles de notification: ${templates} (au moins 10)`);

  await closeDatabase();
  if (failures) {
    console.error(`[check-schema] ÉCHEC: ${failures} problème(s)`);
    process.exit(1);
  }
  console.log('[check-schema] schéma conforme');
}

main().catch((error) => {
  console.error('[check-schema] erreur:', error);
  process.exit(1);
});
