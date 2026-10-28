'use strict';
/**
 * SQLite schema + migrations.
 *
 * The app is offline-first: a single SQLite file holds everything. Schema
 * versions are tracked with PRAGMA user_version, so an upgrade from an older
 * clinic install only runs the missing migrations and never drops data.
 *
 * IMPORTANT: Shipped migrations (MIGRATION_1 and MIGRATION_2) are NEVER modified.
 * New schema additions are strictly additive in MIGRATION_3+.
 */

const SCHEMA_VERSION = 4;

/** v1 - initial clinic schema. */
const MIGRATION_1 = `
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS patients (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name   TEXT NOT NULL,
  phone       TEXT,
  phone_norm  TEXT,          -- last 9 digits, used to match WhatsApp senders
  birth_date  TEXT,
  gender      TEXT CHECK (gender IN ('m', 'f') OR gender IS NULL),
  notes       TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_patients_name  ON patients(full_name);
CREATE INDEX IF NOT EXISTS idx_patients_phone ON patients(phone);
CREATE UNIQUE INDEX IF NOT EXISTS idx_patients_phone_norm
  ON patients(phone_norm) WHERE phone_norm IS NOT NULL;

CREATE TABLE IF NOT EXISTS treatments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name_fr       TEXT NOT NULL,
  name_ar       TEXT NOT NULL,
  default_price REAL NOT NULL DEFAULT 0 CHECK (default_price >= 0),
  color         TEXT NOT NULL DEFAULT '#2b7a78',
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per appointment. day is YYYY-MM-DD, queue_number is the order
-- inside that day (1..daily_capacity). Status:
--   booked | done | cancelled | no_show
CREATE TABLE IF NOT EXISTS appointments (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id     INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  day            TEXT NOT NULL,
  queue_number   INTEGER NOT NULL,
  status         TEXT NOT NULL DEFAULT 'booked'
                 CHECK (status IN ('booked', 'done', 'cancelled', 'no_show')),
  source         TEXT NOT NULL DEFAULT 'manual'
                 CHECK (source IN ('manual', 'whatsapp', 'waiting')),
  treatment_id   INTEGER REFERENCES treatments(id) ON DELETE SET NULL,
  treatment_name TEXT,
  price          REAL NOT NULL DEFAULT 0 CHECK (price >= 0),
  notes          TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
-- A cancelled appointment frees its queue number, so uniqueness only applies
-- to active rows (partial index).
CREATE UNIQUE INDEX IF NOT EXISTS idx_appt_day_queue_active
  ON appointments(day, queue_number) WHERE status <> 'cancelled';
CREATE INDEX IF NOT EXISTS idx_appt_day     ON appointments(day);
CREATE INDEX IF NOT EXISTS idx_appt_patient ON appointments(patient_id);

-- Money movements for an appointment, or a direct patient payment.
-- Payments are append-only: debts are derived from the sum of payments, which
-- keeps the history auditable (no silent overwrites).
CREATE TABLE IF NOT EXISTS payments (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id     INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  appointment_id INTEGER REFERENCES appointments(id) ON DELETE SET NULL,
  amount         REAL NOT NULL CHECK (amount <> 0),
  method         TEXT NOT NULL DEFAULT 'cash' CHECK (method IN ('cash', 'card', 'transfer')),
  note           TEXT,
  paid_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_payments_patient ON payments(patient_id);
CREATE INDEX IF NOT EXISTS idx_payments_appt    ON payments(appointment_id);
CREATE INDEX IF NOT EXISTS idx_payments_date    ON payments(paid_at);

CREATE TABLE IF NOT EXISTS expense_categories (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  key     TEXT NOT NULL UNIQUE,
  name_fr TEXT NOT NULL,
  name_ar TEXT NOT NULL,
  active  INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS expenses (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id INTEGER NOT NULL REFERENCES expense_categories(id),
  amount      REAL NOT NULL CHECK (amount > 0),
  day         TEXT NOT NULL,
  label       TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_expenses_day ON expenses(day);

-- Waiting list: patients who asked for a slot but the day was full.
CREATE TABLE IF NOT EXISTS waiting_list (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name  TEXT NOT NULL,
  phone      TEXT NOT NULL,
  note       TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  handled    INTEGER NOT NULL DEFAULT 0
);

-- Outgoing WhatsApp reminder log (prevents double reminders).
CREATE TABLE IF NOT EXISTS reminders (
  appointment_id INTEGER PRIMARY KEY REFERENCES appointments(id) ON DELETE CASCADE,
  sent_at        TEXT NOT NULL DEFAULT (datetime('now')),
  status         TEXT NOT NULL DEFAULT 'sent'
);

-- Audit trail of bot conversations (one row per message).
CREATE TABLE IF NOT EXISTS bot_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  phone      TEXT NOT NULL,
  direction  TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_bot_phone ON bot_messages(phone);
`;

const MIGRATION_2 = `
-- v2 - live appointment & queue chat feed (confirmations, cancellations,
-- "your turn" calls and queue wait-time alerts).
CREATE TABLE IF NOT EXISTS chat_events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  kind           TEXT NOT NULL
                 CHECK (kind IN ('booked', 'cancelled', 'turn_now', 'queue_ahead', 'incoming')),
  direction      TEXT NOT NULL DEFAULT 'out'
                 CHECK (direction IN ('in', 'out')),
  patient_id     INTEGER REFERENCES patients(id) ON DELETE SET NULL,
  appointment_id INTEGER REFERENCES appointments(id) ON DELETE SET NULL,
  patient_name   TEXT,
  phone          TEXT,
  day            TEXT,
  queue_number   INTEGER,
  ahead_count    INTEGER,
  eta_minutes    INTEGER,
  body           TEXT NOT NULL,
  delivery       TEXT NOT NULL DEFAULT 'local'
                 CHECK (delivery IN ('local', 'queued', 'sent', 'failed')),
  read_at        TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_chat_events_created ON chat_events(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_chat_events_kind    ON chat_events(kind);
`;

/**
 * v3 — DentaRDV v2.0.0 additive upgrade:
 *   - Patient clinical profile (`allergies`, `chronic_conditions`, `blood_group`, `blocked_until`)
 *   - Appointment confirmation & priority columns (`slot_time`, `priority`, `confirmation_status`)
 *   - Persistent WhatsApp bot conversation sessions (`bot_sessions`)
 *   - Law 18-07 pre-visit intake & weight history (`patient_intake`, `patient_weight_history`)
 *   - Dental-only Algerian Nomenclature medications + FTS5 (`medications`, `medications_fts`)
 *   - Dental prescriptions, templates & medical certificates (`prescriptions`, `prescription_items`,
 *     `prescription_templates`, `medical_certificates`)
 *   - Smart dental safety decision-support (`dose_rules`, `interaction_pairs`,
 *     `contraindications`, `allergy_class_rules`, `controlled_rules`, `prescription_safety_audits`)
 */
function runMigration3(db) {
  const safeAddColumn = (table, column, definition) => {
    const cols = db.pragma(`table_info(${table})`).map((c) => c.name);
    if (!cols.includes(column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
    }
  };

  safeAddColumn('patients', 'allergies', "TEXT NOT NULL DEFAULT ''");
  safeAddColumn('patients', 'chronic_conditions', "TEXT NOT NULL DEFAULT ''");
  safeAddColumn('patients', 'blood_group', "TEXT NOT NULL DEFAULT ''");
  safeAddColumn('patients', 'blocked_until', 'TEXT');

  safeAddColumn('appointments', 'slot_time', "TEXT NOT NULL DEFAULT ''");
  safeAddColumn('appointments', 'priority', "TEXT NOT NULL DEFAULT 'normal'");
  safeAddColumn('appointments', 'confirmation_status', "TEXT NOT NULL DEFAULT 'pending'");

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_patients_blocked_until
      ON patients(blocked_until) WHERE blocked_until IS NOT NULL;

    CREATE TABLE IF NOT EXISTS bot_sessions (
      phone_key  TEXT PRIMARY KEY,
      state_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS patient_intake (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      patient_id           INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
      appointment_id       INTEGER REFERENCES appointments(id) ON DELETE SET NULL,
      created_at           TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at           TEXT NOT NULL DEFAULT (datetime('now')),
      source               TEXT NOT NULL DEFAULT 'whatsapp' CHECK (source IN ('whatsapp', 'manual')),
      weight_kg            REAL,
      height_cm            REAL,
      age_years            REAL,
      is_child_intake      INTEGER NOT NULL DEFAULT 0,
      chief_complaint      TEXT NOT NULL DEFAULT '',
      symptom_duration     TEXT NOT NULL DEFAULT '',
      current_medications  TEXT NOT NULL DEFAULT '',
      known_allergies      TEXT NOT NULL DEFAULT '',
      chronic_conditions   TEXT NOT NULL DEFAULT '',
      is_pregnant          INTEGER,
      is_breastfeeding     INTEGER,
      smoker               INTEGER,
      last_blood_pressure  TEXT NOT NULL DEFAULT '',
      last_glycemia        TEXT NOT NULL DEFAULT '',
      consent_at           TEXT NOT NULL,
      reviewed_by          TEXT NOT NULL DEFAULT '',
      reviewed_at          TEXT,
      status               TEXT NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending', 'reviewed', 'applied', 'rejected'))
    );
    CREATE INDEX IF NOT EXISTS idx_intake_patient ON patient_intake(patient_id, id DESC);
    CREATE INDEX IF NOT EXISTS idx_intake_appt    ON patient_intake(appointment_id);
    CREATE INDEX IF NOT EXISTS idx_intake_status  ON patient_intake(status);

    CREATE TABLE IF NOT EXISTS patient_weight_history (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      patient_id     INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
      appointment_id INTEGER REFERENCES appointments(id) ON DELETE SET NULL,
      intake_id      INTEGER REFERENCES patient_intake(id) ON DELETE SET NULL,
      weight_kg      REAL NOT NULL,
      height_cm      REAL,
      recorded_at    TEXT NOT NULL DEFAULT (datetime('now')),
      source         TEXT NOT NULL DEFAULT 'doctor'
    );
    CREATE INDEX IF NOT EXISTS idx_weight_hist_patient ON patient_weight_history(patient_id, recorded_at DESC);

    CREATE TABLE IF NOT EXISTS medications (
      id                     INTEGER PRIMARY KEY AUTOINCREMENT,
      brand                  TEXT NOT NULL,
      dci                    TEXT NOT NULL DEFAULT '',
      strength               TEXT NOT NULL DEFAULT '',
      form                   TEXT NOT NULL DEFAULT '',
      specialty              TEXT NOT NULL DEFAULT 'stomato',
      keywords_ar            TEXT NOT NULL DEFAULT '',
      default_dosage         TEXT NOT NULL DEFAULT '',
      default_duration       TEXT NOT NULL DEFAULT '',
      registration_number    TEXT NOT NULL DEFAULT '',
      laboratory             TEXT NOT NULL DEFAULT '',
      country                TEXT NOT NULL DEFAULT '',
      is_generic             INTEGER NOT NULL DEFAULT 0,
      reference_dci_group    TEXT NOT NULL DEFAULT '',
      ppa                    REAL,
      reference_price        REAL,
      reimbursable           INTEGER NOT NULL DEFAULT 0,
      reimbursement_rate     INTEGER NOT NULL DEFAULT 0,
      schedule               TEXT NOT NULL DEFAULT '',
      marketed               INTEGER NOT NULL DEFAULT 1,
      expiry_of_registration TEXT NOT NULL DEFAULT '',
      source                 TEXT NOT NULL DEFAULT 'starter',
      verified               INTEGER NOT NULL DEFAULT 0,
      last_updated           TEXT NOT NULL DEFAULT '',
      name_normalized        TEXT NOT NULL DEFAULT '',
      folded_search          TEXT NOT NULL DEFAULT '',
      custom                 INTEGER NOT NULL DEFAULT 0,
      active                 INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_medications_brand     ON medications(brand);
    CREATE INDEX IF NOT EXISTS idx_medications_dci       ON medications(dci);
    CREATE INDEX IF NOT EXISTS idx_medications_specialty ON medications(specialty);
    CREATE INDEX IF NOT EXISTS idx_medications_group     ON medications(reference_dci_group);
    CREATE INDEX IF NOT EXISTS idx_medications_norm      ON medications(name_normalized);
    CREATE INDEX IF NOT EXISTS idx_medications_folded    ON medications(folded_search);

    CREATE VIRTUAL TABLE IF NOT EXISTS medications_fts USING fts5(
      brand, dci, strength, form, laboratory, keywords_ar, folded_search,
      content='medications', content_rowid='id', tokenize='unicode61 remove_diacritics 2'
    );

    CREATE TRIGGER IF NOT EXISTS trg_medications_ai AFTER INSERT ON medications BEGIN
      INSERT INTO medications_fts(rowid, brand, dci, strength, form, laboratory, keywords_ar, folded_search)
      VALUES (new.id, new.brand, new.dci, new.strength, new.form, new.laboratory, new.keywords_ar, new.folded_search);
    END;
    CREATE TRIGGER IF NOT EXISTS trg_medications_ad AFTER DELETE ON medications BEGIN
      INSERT INTO medications_fts(medications_fts, rowid, brand, dci, strength, form, laboratory, keywords_ar, folded_search)
      VALUES ('delete', old.id, old.brand, old.dci, old.strength, old.form, old.laboratory, old.keywords_ar, old.folded_search);
    END;
    CREATE TRIGGER IF NOT EXISTS trg_medications_au AFTER UPDATE ON medications BEGIN
      INSERT INTO medications_fts(medications_fts, rowid, brand, dci, strength, form, laboratory, keywords_ar, folded_search)
      VALUES ('delete', old.id, old.brand, old.dci, old.strength, old.form, old.laboratory, old.keywords_ar, old.folded_search);
      INSERT INTO medications_fts(rowid, brand, dci, strength, form, laboratory, keywords_ar, folded_search)
      VALUES (new.id, new.brand, new.dci, new.strength, new.form, new.laboratory, new.keywords_ar, new.folded_search);
    END;

    CREATE TABLE IF NOT EXISTS prescriptions (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      patient_id      INTEGER REFERENCES patients(id) ON DELETE SET NULL,
      appointment_id  INTEGER REFERENCES appointments(id) ON DELETE SET NULL,
      day             TEXT NOT NULL,
      patient_name    TEXT NOT NULL,
      patient_age     TEXT NOT NULL DEFAULT '',
      patient_weight  TEXT NOT NULL DEFAULT '',
      doctor_name     TEXT NOT NULL DEFAULT '',
      doctor_specialty TEXT NOT NULL DEFAULT '',
      doctor_ordre    TEXT NOT NULL DEFAULT '',
      diagnosis       TEXT NOT NULL DEFAULT '',
      tooth_ref       TEXT NOT NULL DEFAULT '',
      exams_requested TEXT NOT NULL DEFAULT '',
      advice          TEXT NOT NULL DEFAULT '',
      print_mode      TEXT NOT NULL DEFAULT 'both'
                      CHECK (print_mode IN ('brand', 'dci', 'both')),
      controlled_rx   INTEGER NOT NULL DEFAULT 0,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_prescriptions_patient ON prescriptions(patient_id);
    CREATE INDEX IF NOT EXISTS idx_prescriptions_day     ON prescriptions(day DESC, id DESC);

    CREATE TABLE IF NOT EXISTS prescription_items (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      prescription_id INTEGER NOT NULL REFERENCES prescriptions(id) ON DELETE CASCADE,
      medication_id   INTEGER REFERENCES medications(id) ON DELETE SET NULL,
      drug_name       TEXT NOT NULL,
      dci             TEXT NOT NULL DEFAULT '',
      form_strength   TEXT NOT NULL DEFAULT '',
      dosage          TEXT NOT NULL DEFAULT '',
      timing          TEXT NOT NULL DEFAULT '',
      duration        TEXT NOT NULL DEFAULT '',
      quantity        TEXT NOT NULL DEFAULT '',
      note            TEXT NOT NULL DEFAULT '',
      substitutable   INTEGER NOT NULL DEFAULT 1,
      schedule        TEXT NOT NULL DEFAULT '',
      sort_order      INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_rx_items_rx ON prescription_items(prescription_id, sort_order);

    CREATE TABLE IF NOT EXISTS prescription_templates (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      title_fr        TEXT NOT NULL,
      title_ar        TEXT NOT NULL,
      specialty       TEXT NOT NULL DEFAULT 'Chirurgie Dentaire',
      items_json      TEXT NOT NULL DEFAULT '[]',
      exams_requested TEXT NOT NULL DEFAULT '',
      advice          TEXT NOT NULL DEFAULT '',
      source          TEXT NOT NULL DEFAULT 'starter',
      verified        INTEGER NOT NULL DEFAULT 1,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS medical_certificates (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      patient_id      INTEGER REFERENCES patients(id) ON DELETE SET NULL,
      day             TEXT NOT NULL,
      patient_name    TEXT NOT NULL,
      patient_age     TEXT NOT NULL DEFAULT '',
      doctor_name     TEXT NOT NULL DEFAULT '',
      doctor_specialty TEXT NOT NULL DEFAULT '',
      doctor_ordre    TEXT NOT NULL DEFAULT '',
      kind            TEXT NOT NULL DEFAULT 'arret_travail'
                      CHECK (kind IN ('arret_travail', 'aptitude', 'scolaire', 'general')),
      rest_days       INTEGER NOT NULL DEFAULT 0,
      start_day       TEXT NOT NULL DEFAULT '',
      content         TEXT NOT NULL DEFAULT '',
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_med_cert_patient ON medical_certificates(patient_id);

    CREATE TABLE IF NOT EXISTS dose_rules (
      id                      INTEGER PRIMARY KEY AUTOINCREMENT,
      dci                     TEXT NOT NULL,
      form                    TEXT NOT NULL DEFAULT '',
      concentration_mg_per_ml REAL,
      min_age_months          INTEGER NOT NULL DEFAULT 0,
      max_age_months          INTEGER NOT NULL DEFAULT 1560,
      mg_per_kg_per_day       REAL,
      mg_per_kg_per_dose      REAL,
      doses_per_day           INTEGER NOT NULL DEFAULT 3,
      max_single_dose_mg      REAL,
      max_daily_dose_mg       REAL,
      max_duration_days       INTEGER,
      notes_fr                TEXT NOT NULL DEFAULT '',
      notes_ar                TEXT NOT NULL DEFAULT '',
      source                  TEXT NOT NULL DEFAULT 'starter',
      verified                INTEGER NOT NULL DEFAULT 0,
      updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_dose_rules_dci ON dose_rules(dci);

    CREATE TABLE IF NOT EXISTS interaction_pairs (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      dci_a        TEXT NOT NULL,
      dci_b        TEXT NOT NULL,
      severity     TEXT NOT NULL CHECK (severity IN ('contraindicated', 'avoid', 'caution', 'monitor')),
      mechanism_fr TEXT NOT NULL DEFAULT '',
      mechanism_ar TEXT NOT NULL DEFAULT '',
      action_fr    TEXT NOT NULL DEFAULT '',
      action_ar    TEXT NOT NULL DEFAULT '',
      source       TEXT NOT NULL DEFAULT 'starter',
      verified     INTEGER NOT NULL DEFAULT 0,
      updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_inter_a ON interaction_pairs(dci_a);
    CREATE INDEX IF NOT EXISTS idx_inter_b ON interaction_pairs(dci_b);

    CREATE TABLE IF NOT EXISTS contraindications (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      dci             TEXT NOT NULL,
      condition_type  TEXT NOT NULL CHECK (condition_type IN (
                        'pregnancy', 'breastfeeding', 'renal', 'hepatic',
                        'asthma', 'ulcer', 'g6pd', 'min_age_months', 'max_age_years', 'chronic'
                      )),
      condition_match TEXT NOT NULL DEFAULT '',
      severity        TEXT NOT NULL DEFAULT 'contraindicated'
                      CHECK (severity IN ('contraindicated', 'avoid', 'caution')),
      message_fr      TEXT NOT NULL,
      message_ar      TEXT NOT NULL DEFAULT '',
      source          TEXT NOT NULL DEFAULT 'starter',
      verified        INTEGER NOT NULL DEFAULT 0,
      updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_contra_dci ON contraindications(dci);

    CREATE TABLE IF NOT EXISTS allergy_class_rules (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      class_code      TEXT NOT NULL UNIQUE,
      class_name_fr   TEXT NOT NULL,
      class_name_ar   TEXT NOT NULL,
      trigger_terms   TEXT NOT NULL,
      cross_dci_terms TEXT NOT NULL,
      severity        TEXT NOT NULL DEFAULT 'contraindicated'
                      CHECK (severity IN ('contraindicated', 'avoid', 'caution')),
      source          TEXT NOT NULL DEFAULT 'starter',
      verified        INTEGER NOT NULL DEFAULT 0,
      updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS controlled_rules (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      dci                TEXT NOT NULL UNIQUE,
      schedule           TEXT NOT NULL DEFAULT 'psychotrope',
      max_duration_days  INTEGER,
      requires_secure_rx INTEGER NOT NULL DEFAULT 1,
      notes_fr           TEXT NOT NULL DEFAULT '',
      notes_ar           TEXT NOT NULL DEFAULT '',
      source             TEXT NOT NULL DEFAULT 'starter',
      verified           INTEGER NOT NULL DEFAULT 0,
      updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS prescription_safety_audits (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      prescription_id      INTEGER NOT NULL REFERENCES prescriptions(id) ON DELETE CASCADE,
      created_at           TEXT NOT NULL DEFAULT (datetime('now')),
      patient_weight_kg    REAL,
      warnings_shown_json  TEXT NOT NULL DEFAULT '[]',
      overrides_json       TEXT NOT NULL DEFAULT '[]',
      override_reason      TEXT NOT NULL DEFAULT '',
      prescriber_name      TEXT NOT NULL DEFAULT '',
      has_unverified_rules INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_rx_safety_audit_rx ON prescription_safety_audits(prescription_id);
  `);
}

/**
 * v4 — DentaRDV v2.2.0 additive upgrade:
 *   - Doctor holidays, sick-leave & exceptional off-days (`clinic_holidays`)
 */
function runMigration4(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS clinic_holidays (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      start_day    TEXT NOT NULL,
      end_day      TEXT NOT NULL,
      reason_type  TEXT NOT NULL DEFAULT 'vacation'
                   CHECK (reason_type IN ('vacation', 'sick', 'other')),
      label        TEXT NOT NULL DEFAULT '',
      block_all_wa INTEGER NOT NULL DEFAULT 0,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_clinic_holidays_range
      ON clinic_holidays(start_day, end_day);
  `);
}

const MIGRATIONS = [
  (db) => db.exec(MIGRATION_1),
  (db) => db.exec(MIGRATION_2),
  runMigration3,
  runMigration4,
];

/**
 * Run pending migrations on a better-sqlite3 connection.
 * @param {import('better-sqlite3').Database} db
 * @returns {number} the schema version after migration
 */
function migrate(db) {
  const current = db.pragma('user_version', { simple: true });
  if (current >= SCHEMA_VERSION) return current;

  const run = db.transaction(() => {
    for (let version = current; version < SCHEMA_VERSION; version += 1) {
      MIGRATIONS[version](db);
    }
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  });
  run();
  return SCHEMA_VERSION;
}

module.exports = { SCHEMA_VERSION, migrate };
