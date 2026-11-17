'use strict';
/**
 * SQLite schema + migrations for MediRDV (all medical specialties & polyclinics).
 *
 * Offline-first: a single SQLite file holds settings, multi-specialty
 * departments, patients (with allergies & chronic conditions), appointments,
 * payments, expenses, WhatsApp bot logs, live Mini Chat events, the Algerian
 * Nomenclature medications database, prescriptions (ordonnances), templates,
 * and medical certificates.
 */

const SCHEMA_VERSION = 1;

const MIGRATION_1 = `
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Medical departments / services (Cardiology, Ophthalmology, Orthopedics…).
CREATE TABLE IF NOT EXISTS departments (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  name_fr             TEXT NOT NULL,
  name_ar             TEXT NOT NULL,
  specialty           TEXT NOT NULL DEFAULT '',
  doctor_name         TEXT NOT NULL DEFAULT '',
  room                TEXT NOT NULL DEFAULT '',
  instructions        TEXT NOT NULL DEFAULT '',
  consultation_fee    REAL NOT NULL DEFAULT 2000 CHECK (consultation_fee >= 0),
  daily_capacity      INTEGER NOT NULL DEFAULT 15 CHECK (daily_capacity >= 1),
  avg_session_minutes INTEGER NOT NULL DEFAULT 20 CHECK (avg_session_minutes >= 5),
  working_days        TEXT NOT NULL DEFAULT '0,1,2,3,4',
  color               TEXT NOT NULL DEFAULT '#0066cc',
  active              INTEGER NOT NULL DEFAULT 1,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS patients (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name          TEXT NOT NULL,
  phone              TEXT,
  phone_norm         TEXT,
  birth_date         TEXT,
  gender             TEXT CHECK (gender IN ('m', 'f') OR gender IS NULL),
  blood_group        TEXT,
  allergies          TEXT,
  chronic_conditions TEXT,
  notes              TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_patients_name  ON patients(full_name);
CREATE INDEX IF NOT EXISTS idx_patients_phone ON patients(phone);
CREATE UNIQUE INDEX IF NOT EXISTS idx_patients_phone_norm
  ON patients(phone_norm) WHERE phone_norm IS NOT NULL;

-- Medical acts / consultations (Consultation, ECG, Échographie, Fond d'œil…).
CREATE TABLE IF NOT EXISTS treatments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name_fr       TEXT NOT NULL,
  name_ar       TEXT NOT NULL,
  department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL,
  default_price REAL NOT NULL DEFAULT 0 CHECK (default_price >= 0),
  color         TEXT NOT NULL DEFAULT '#0066cc',
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS appointments (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id      INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  department_id   INTEGER REFERENCES departments(id) ON DELETE SET NULL,
  department_name TEXT,
  day             TEXT NOT NULL,
  queue_number    INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'booked'
                  CHECK (status IN ('booked', 'done', 'cancelled', 'no_show')),
  source          TEXT NOT NULL DEFAULT 'manual'
                  CHECK (source IN ('manual', 'whatsapp', 'waiting')),
  treatment_id    INTEGER REFERENCES treatments(id) ON DELETE SET NULL,
  treatment_name  TEXT,
  price           REAL NOT NULL DEFAULT 0 CHECK (price >= 0),
  vitals          TEXT,
  notes           TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Each department keeps its own independent active queue per day.
CREATE UNIQUE INDEX IF NOT EXISTS idx_appt_day_dept_queue_active
  ON appointments(day, COALESCE(department_id, 0), queue_number) WHERE status <> 'cancelled';
CREATE INDEX IF NOT EXISTS idx_appt_day     ON appointments(day);
CREATE INDEX IF NOT EXISTS idx_appt_patient ON appointments(patient_id);
CREATE INDEX IF NOT EXISTS idx_appt_dept    ON appointments(department_id);

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

CREATE TABLE IF NOT EXISTS waiting_list (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name       TEXT NOT NULL,
  phone           TEXT NOT NULL,
  department_id   INTEGER REFERENCES departments(id) ON DELETE SET NULL,
  department_name TEXT,
  note            TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  handled         INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS reminders (
  appointment_id INTEGER PRIMARY KEY REFERENCES appointments(id) ON DELETE CASCADE,
  sent_at        TEXT NOT NULL DEFAULT (datetime('now')),
  status         TEXT NOT NULL DEFAULT 'sent'
);

CREATE TABLE IF NOT EXISTS bot_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  phone      TEXT NOT NULL,
  direction  TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_bot_phone ON bot_messages(phone);

CREATE TABLE IF NOT EXISTS chat_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  kind            TEXT NOT NULL
                  CHECK (kind IN ('booked', 'cancelled', 'turn_now', 'queue_ahead', 'incoming')),
  direction       TEXT NOT NULL DEFAULT 'out'
                  CHECK (direction IN ('in', 'out')),
  patient_id      INTEGER REFERENCES patients(id) ON DELETE SET NULL,
  appointment_id  INTEGER REFERENCES appointments(id) ON DELETE SET NULL,
  department_id   INTEGER REFERENCES departments(id) ON DELETE SET NULL,
  department_name TEXT,
  patient_name    TEXT,
  phone           TEXT,
  day             TEXT,
  queue_number    INTEGER,
  ahead_count     INTEGER,
  eta_minutes     INTEGER,
  body            TEXT NOT NULL,
  delivery        TEXT NOT NULL DEFAULT 'local'
                  CHECK (delivery IN ('local', 'queued', 'sent', 'failed')),
  read_at         TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_chat_events_created ON chat_events(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_chat_events_kind    ON chat_events(kind);

-- Algerian Nomenclature medications catalog (offline, extensible by the doctor).
CREATE TABLE IF NOT EXISTS medications (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  brand            TEXT NOT NULL,
  dci              TEXT NOT NULL,
  strength         TEXT NOT NULL DEFAULT '',
  form             TEXT NOT NULL DEFAULT '',
  specialty        TEXT NOT NULL DEFAULT 'general',
  keywords_ar      TEXT NOT NULL DEFAULT '',
  default_dosage   TEXT NOT NULL DEFAULT '',
  default_duration TEXT NOT NULL DEFAULT '',
  custom           INTEGER NOT NULL DEFAULT 0,
  active           INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_meds_brand     ON medications(brand);
CREATE INDEX IF NOT EXISTS idx_meds_dci       ON medications(dci);
CREATE INDEX IF NOT EXISTS idx_meds_specialty ON medications(specialty);

-- Medical prescriptions (Ordonnances médicales).
CREATE TABLE IF NOT EXISTS prescriptions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id       INTEGER REFERENCES patients(id) ON DELETE SET NULL,
  appointment_id   INTEGER REFERENCES appointments(id) ON DELETE SET NULL,
  department_id    INTEGER REFERENCES departments(id) ON DELETE SET NULL,
  day              TEXT NOT NULL,
  patient_name     TEXT NOT NULL,
  patient_age      TEXT NOT NULL DEFAULT '',
  patient_weight   TEXT NOT NULL DEFAULT '',
  doctor_name      TEXT NOT NULL DEFAULT '',
  doctor_specialty TEXT NOT NULL DEFAULT '',
  doctor_ordre     TEXT NOT NULL DEFAULT '',
  diagnosis        TEXT NOT NULL DEFAULT '',
  vitals_bp        TEXT NOT NULL DEFAULT '',
  vitals_hr        TEXT NOT NULL DEFAULT '',
  vitals_temp      TEXT NOT NULL DEFAULT '',
  vitals_spo2      TEXT NOT NULL DEFAULT '',
  vitals_glycemia  TEXT NOT NULL DEFAULT '',
  exams_requested  TEXT NOT NULL DEFAULT '',
  advice           TEXT NOT NULL DEFAULT '',
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_rx_patient ON prescriptions(patient_id);
CREATE INDEX IF NOT EXISTS idx_rx_day     ON prescriptions(day DESC, id DESC);

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
  sort_order      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_rx_items_rx ON prescription_items(prescription_id);

-- Reusable protocol templates (Ordonnances types).
CREATE TABLE IF NOT EXISTS prescription_templates (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  title_fr        TEXT NOT NULL,
  title_ar        TEXT NOT NULL,
  specialty       TEXT NOT NULL DEFAULT 'general',
  exams_requested TEXT NOT NULL DEFAULT '',
  advice          TEXT NOT NULL DEFAULT '',
  items_json      TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Medical certificates / sick leave (Certificats médicaux).
CREATE TABLE IF NOT EXISTS medical_certificates (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id       INTEGER REFERENCES patients(id) ON DELETE SET NULL,
  department_id    INTEGER REFERENCES departments(id) ON DELETE SET NULL,
  day              TEXT NOT NULL,
  patient_name     TEXT NOT NULL,
  patient_age      TEXT NOT NULL DEFAULT '',
  doctor_name      TEXT NOT NULL DEFAULT '',
  doctor_specialty TEXT NOT NULL DEFAULT '',
  doctor_ordre     TEXT NOT NULL DEFAULT '',
  kind             TEXT NOT NULL DEFAULT 'arret_travail'
                   CHECK (kind IN ('arret_travail', 'aptitude', 'scolaire', 'general')),
  rest_days        INTEGER NOT NULL DEFAULT 0,
  start_day        TEXT,
  content          TEXT NOT NULL DEFAULT '',
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_cert_patient ON medical_certificates(patient_id);
`;

const MIGRATIONS = [MIGRATION_1];

function migrate(db) {
  const current = db.pragma('user_version', { simple: true });
  if (current >= SCHEMA_VERSION) return current;

  const run = db.transaction(() => {
    for (let version = current; version < SCHEMA_VERSION; version += 1) {
      db.exec(MIGRATIONS[version]);
    }
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  });
  run();
  return SCHEMA_VERSION;
}

module.exports = { SCHEMA_VERSION, migrate };
