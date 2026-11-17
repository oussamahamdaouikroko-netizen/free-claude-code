'use strict';
/**
 * Medirdv Central — relational schema + append-only migrations.
 *
 * Design rules (Part 9):
 *  - normalized tables, FKs, unique constraints, indexes;
 *  - migrations only ADD (never DROP/DELETE existing records);
 *  - timestamps stored as UTC ISO-8601; Africa/Algiers is display-only;
 *  - secrets stored encrypted (see crypto.js), never plaintext;
 *  - no unnecessary medical data: bookings carry identity + logistics only.
 *
 * SQLite via node:sqlite (built-in, zero native dependencies).
 */

const SCHEMA_VERSION = 1;

const MIGRATION_1 = `
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------- users ---
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  full_name     TEXT NOT NULL DEFAULT '',
  role          TEXT NOT NULL DEFAULT 'support'
                CHECK (role IN ('super_admin','admin','payment_verifier','support','doctor','patient')),
  doctor_id     INTEGER,
  patient_id    INTEGER,
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at    TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ip            TEXT,
  user_agent    TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- ------------------------------------------------------------- patients ---
CREATE TABLE IF NOT EXISTS patients (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name   TEXT NOT NULL,
  phone       TEXT,
  phone_norm  TEXT,
  email       TEXT,
  birth_date  TEXT,
  gender      TEXT CHECK (gender IN ('m','f') OR gender IS NULL),
  preferred_lang TEXT NOT NULL DEFAULT 'fr' CHECK (preferred_lang IN ('fr','ar','en')),
  is_guest    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_patients_phone ON patients(phone);
CREATE UNIQUE INDEX IF NOT EXISTS idx_patients_phone_norm
  ON patients(phone_norm) WHERE phone_norm IS NOT NULL;

-- ----------------------------------------------------------- specialties ---
CREATE TABLE IF NOT EXISTS specialties (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  slug      TEXT NOT NULL UNIQUE,
  name_fr   TEXT NOT NULL,
  name_ar   TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1
);

-- -------------------------------------------------------------- doctors ---
CREATE TABLE IF NOT EXISTS doctors (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  public_ref          TEXT NOT NULL UNIQUE,
  full_name           TEXT NOT NULL,
  specialty_id        INTEGER REFERENCES specialties(id) ON DELETE SET NULL,
  specialty_text      TEXT NOT NULL DEFAULT '',
  phone               TEXT,
  phone_norm          TEXT,
  whatsapp_number     TEXT,
  whatsapp_number_norm TEXT,
  email               TEXT,
  photo_path          TEXT,
  ordre_number        TEXT NOT NULL DEFAULT '',
  status              TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('active','pending','suspended','inactive')),
  consultation_fee    REAL NOT NULL DEFAULT 0 CHECK (consultation_fee >= 0),
  appointment_minutes INTEGER NOT NULL DEFAULT 15 CHECK (appointment_minutes BETWEEN 5 AND 180),
  max_daily           INTEGER NOT NULL DEFAULT 30 CHECK (max_daily BETWEEN 1 AND 500),
  booking_lead_hours  INTEGER NOT NULL DEFAULT 0 CHECK (booking_lead_hours >= 0),
  cancel_deadline_hours INTEGER NOT NULL DEFAULT 0 CHECK (cancel_deadline_hours >= 0),
  auto_confirm        INTEGER NOT NULL DEFAULT 0,
  response_deadline_hours INTEGER NOT NULL DEFAULT 24 CHECK (response_deadline_hours BETWEEN 1 AND 168),
  payment_mode        TEXT NOT NULL DEFAULT 'baridimob_manual'
                      CHECK (payment_mode IN ('baridimob_manual','cash_at_clinic','free','none')),
  baridimob_name      TEXT NOT NULL DEFAULT '',
  baridimob_rib       TEXT NOT NULL DEFAULT '',
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_doctors_status ON doctors(status);
CREATE INDEX IF NOT EXISTS idx_doctors_specialty ON doctors(specialty_id);

-- -------------------------------------------------------------- clinics ---
CREATE TABLE IF NOT EXISTS clinics (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  public_ref    TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  address       TEXT NOT NULL DEFAULT '',
  wilaya        TEXT NOT NULL DEFAULT '',
  city          TEXT NOT NULL DEFAULT '',
  phone         TEXT,
  lat           REAL,
  lng           REAL,
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_clinics_wilaya ON clinics(wilaya);

CREATE TABLE IF NOT EXISTS doctor_clinics (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  doctor_id     INTEGER NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
  clinic_id     INTEGER NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  UNIQUE (doctor_id, clinic_id)
);

-- ------------------------------------------------------- schedules/slots ---
CREATE TABLE IF NOT EXISTS doctor_schedules (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  doctor_id       INTEGER NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
  clinic_id       INTEGER REFERENCES clinics(id) ON DELETE CASCADE,
  weekday         INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_time      TEXT NOT NULL,
  end_time        TEXT NOT NULL,
  is_active       INTEGER NOT NULL DEFAULT 1,
  UNIQUE (doctor_id, clinic_id, weekday, start_time, end_time)
);
CREATE INDEX IF NOT EXISTS idx_schedules_doctor ON doctor_schedules(doctor_id);

CREATE TABLE IF NOT EXISTS blocked_dates (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  doctor_id INTEGER NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
  clinic_id INTEGER REFERENCES clinics(id) ON DELETE CASCADE,
  day       TEXT NOT NULL,
  reason    TEXT NOT NULL DEFAULT '',
  UNIQUE (doctor_id, clinic_id, day)
);

-- ----------------------------------------------------------- appointments ---
CREATE TABLE IF NOT EXISTS appointments (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  public_ref          TEXT NOT NULL UNIQUE,
  idempotency_key     TEXT UNIQUE,
  patient_id          INTEGER REFERENCES patients(id) ON DELETE SET NULL,
  patient_name        TEXT NOT NULL,
  patient_phone       TEXT NOT NULL,
  patient_phone_norm  TEXT NOT NULL,
  doctor_id           INTEGER NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
  clinic_id           INTEGER REFERENCES clinics(id) ON DELETE SET NULL,
  day                 TEXT NOT NULL,
  time                TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending_payment'
                      CHECK (status IN (
                        'draft','pending_payment','payment_verification',
                        'pending_doctor_approval','confirmed','rejected',
                        'rescheduling_requested','cancelled','completed','expired')),
  source              TEXT NOT NULL DEFAULT 'web' CHECK (source IN ('web','android','whatsapp','connector','admin')),
  consultation_fee    REAL NOT NULL DEFAULT 0,
  service_fee         REAL NOT NULL DEFAULT 0,
  doctor_response     TEXT CHECK (doctor_response IN ('accepted','rejected','reschedule') OR doctor_response IS NULL),
  doctor_responded_at TEXT,
  proposed_day        TEXT,
  proposed_time       TEXT,
  expires_at          TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_appt_doctor_day ON appointments(doctor_id, day);
CREATE INDEX IF NOT EXISTS idx_appt_status ON appointments(status);
CREATE INDEX IF NOT EXISTS idx_appt_patient ON appointments(patient_id);
CREATE INDEX IF NOT EXISTS idx_appt_created ON appointments(created_at DESC);
-- Double-booking guard: one active appointment per doctor+day+time.
CREATE UNIQUE INDEX IF NOT EXISTS idx_appt_no_double
  ON appointments(doctor_id, day, time)
  WHERE status NOT IN ('cancelled','rejected','expired');

CREATE TABLE IF NOT EXISTS appointment_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  appointment_id INTEGER NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,
  from_status   TEXT,
  to_status     TEXT,
  actor         TEXT NOT NULL DEFAULT 'system',
  note          TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_appt_events ON appointment_events(appointment_id, id);

-- -------------------------------------------------------------- whatsapp ---
CREATE TABLE IF NOT EXISTS whatsapp_accounts (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  doctor_id           INTEGER NOT NULL UNIQUE REFERENCES doctors(id) ON DELETE CASCADE,
  mode                TEXT NOT NULL DEFAULT 'none' CHECK (mode IN ('cloud_api','click_to_chat','none')),
  display_number      TEXT,
  waba_id             TEXT,
  phone_number_id     TEXT,
  access_token_enc    TEXT,
  token_expires_at    TEXT,
  status              TEXT NOT NULL DEFAULT 'disconnected'
                      CHECK (status IN ('connected','pending','disconnected','error')),
  last_error          TEXT NOT NULL DEFAULT '',
  last_checked_at     TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS whatsapp_messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  doctor_id       INTEGER REFERENCES doctors(id) ON DELETE SET NULL,
  appointment_id  INTEGER REFERENCES appointments(id) ON DELETE SET NULL,
  direction       TEXT NOT NULL CHECK (direction IN ('in','out')),
  to_phone        TEXT,
  from_phone      TEXT,
  template_name   TEXT,
  body            TEXT NOT NULL DEFAULT '',
  wa_message_id   TEXT,
  status          TEXT NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued','sent','delivered','read','failed','received')),
  error           TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_wa_msg_doctor ON whatsapp_messages(doctor_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_wa_msg_appt ON whatsapp_messages(appointment_id);
CREATE INDEX IF NOT EXISTS idx_wa_msg_wa_id ON whatsapp_messages(wa_message_id);

CREATE TABLE IF NOT EXISTS whatsapp_webhook_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  phone_number_id TEXT,
  wa_message_id TEXT UNIQUE,
  payload_hash  TEXT NOT NULL,
  processed     INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- --------------------------------------------------------------- payments ---
CREATE TABLE IF NOT EXISTS payment_methods (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  slug      TEXT NOT NULL UNIQUE,
  name_fr   TEXT NOT NULL,
  name_ar   TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS payments (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  public_ref          TEXT NOT NULL UNIQUE,
  appointment_id      INTEGER NOT NULL UNIQUE REFERENCES appointments(id) ON DELETE CASCADE,
  method              TEXT NOT NULL DEFAULT 'baridimob' CHECK (method IN ('baridimob','cash','free')),
  amount              REAL NOT NULL CHECK (amount >= 0),
  currency            TEXT NOT NULL DEFAULT 'DZD',
  status              TEXT NOT NULL DEFAULT 'awaiting_payment'
                      CHECK (status IN ('awaiting_payment','submitted','under_verification','paid','rejected','expired','refunded')),
  transaction_ref     TEXT,
  receipt_path        TEXT,
  submitted_at        TEXT,
  verified_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  verified_at         TEXT,
  verification_note   TEXT NOT NULL DEFAULT '',
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_txref
  ON payments(transaction_ref) WHERE transaction_ref IS NOT NULL AND transaction_ref <> '';

CREATE TABLE IF NOT EXISTS payment_audit_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id  INTEGER NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  actor       TEXT NOT NULL,
  action      TEXT NOT NULL,
  from_status TEXT,
  to_status   TEXT,
  note        TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_payment_audit ON payment_audit_logs(payment_id, id);

-- ----------------------------------------------------------- notifications ---
CREATE TABLE IF NOT EXISTS notifications (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER REFERENCES users(id) ON DELETE CASCADE,
  patient_id    INTEGER REFERENCES patients(id) ON DELETE CASCADE,
  appointment_id INTEGER REFERENCES appointments(id) ON DELETE CASCADE,
  channel       TEXT NOT NULL DEFAULT 'in_app' CHECK (channel IN ('in_app','whatsapp','email','sms')),
  title         TEXT NOT NULL,
  body          TEXT NOT NULL DEFAULT '',
  is_read       INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_notif_patient ON notifications(patient_id, id DESC);

-- -------------------------------------------------------------- connector ---
CREATE TABLE IF NOT EXISTS device_connections (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  clinic_id       INTEGER NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  device_name     TEXT NOT NULL DEFAULT '',
  api_key_hash    TEXT NOT NULL UNIQUE,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  last_seen_at    TEXT,
  last_sync_at    TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_device_clinic ON device_connections(clinic_id);

CREATE TABLE IF NOT EXISTS integration_logs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id     INTEGER REFERENCES device_connections(id) ON DELETE SET NULL,
  kind          TEXT NOT NULL,
  ok            INTEGER NOT NULL DEFAULT 1,
  detail        TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_integration_logs ON integration_logs(id DESC);

-- ----------------------------------------------------------------- misc ---
CREATE TABLE IF NOT EXISTS audit_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action      TEXT NOT NULL,
  entity      TEXT NOT NULL DEFAULT '',
  entity_id   TEXT NOT NULL DEFAULT '',
  detail      TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(id DESC);

CREATE TABLE IF NOT EXISTS system_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version     INTEGER PRIMARY KEY,
  applied_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
`;

const MIGRATIONS = [{ version: 1, sql: MIGRATION_1 }];

function migrate(db) {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version INTEGER PRIMARY KEY,
       applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     )`
  );
  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version)
  );
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(migration.version);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  return SCHEMA_VERSION;
}

module.exports = { SCHEMA_VERSION, MIGRATIONS, migrate };
