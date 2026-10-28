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

const SCHEMA_VERSION = 13;

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

const MIGRATION_2 = `
-- Phase 1: Patient pre-visit intake (unverified until doctor confirms & applies).
CREATE TABLE IF NOT EXISTS patient_intake (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id          INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  appointment_id      INTEGER REFERENCES appointments(id) ON DELETE SET NULL,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
  source              TEXT NOT NULL DEFAULT 'whatsapp'
                      CHECK (source IN ('whatsapp', 'manual')),
  weight_kg           REAL CHECK (weight_kg IS NULL OR (weight_kg >= 0.3 AND weight_kg <= 400)),
  height_cm           REAL CHECK (height_cm IS NULL OR (height_cm >= 30 AND height_cm <= 250)),
  age_years           REAL CHECK (age_years IS NULL OR (age_years >= 0 AND age_years <= 130)),
  is_child_intake     INTEGER NOT NULL DEFAULT 0 CHECK (is_child_intake IN (0, 1)),
  chief_complaint     TEXT NOT NULL DEFAULT '',
  symptom_duration    TEXT NOT NULL DEFAULT '',
  current_medications TEXT NOT NULL DEFAULT '',
  known_allergies     TEXT NOT NULL DEFAULT '',
  chronic_conditions  TEXT NOT NULL DEFAULT '',
  is_pregnant         INTEGER CHECK (is_pregnant IN (0, 1) OR is_pregnant IS NULL),
  is_breastfeeding    INTEGER CHECK (is_breastfeeding IN (0, 1) OR is_breastfeeding IS NULL),
  smoker              INTEGER CHECK (smoker IN (0, 1) OR smoker IS NULL),
  last_blood_pressure TEXT NOT NULL DEFAULT '',
  last_glycemia       TEXT NOT NULL DEFAULT '',
  consent_at          TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'reviewed', 'applied', 'rejected')),
  reviewed_by         TEXT NOT NULL DEFAULT '',
  reviewed_at         TEXT
);
CREATE INDEX IF NOT EXISTS idx_intake_patient     ON patient_intake(patient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_intake_appointment ON patient_intake(appointment_id);
CREATE INDEX IF NOT EXISTS idx_intake_status      ON patient_intake(status);

-- Verified weight history per patient (recorded on intake confirmation or consultation).
CREATE TABLE IF NOT EXISTS patient_weight_history (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id     INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  appointment_id INTEGER REFERENCES appointments(id) ON DELETE SET NULL,
  intake_id      INTEGER REFERENCES patient_intake(id) ON DELETE SET NULL,
  weight_kg      REAL NOT NULL CHECK (weight_kg >= 0.3 AND weight_kg <= 400),
  height_cm      REAL CHECK (height_cm IS NULL OR (height_cm >= 30 AND height_cm <= 250)),
  recorded_at    TEXT NOT NULL DEFAULT (datetime('now')),
  source         TEXT NOT NULL DEFAULT 'doctor'
);
CREATE INDEX IF NOT EXISTS idx_weight_hist_patient ON patient_weight_history(patient_id, recorded_at DESC);
`;

const MIGRATION_3 = `
-- Phase 2: Clinical decision-support tables (starter rows carry verified = 0).
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
  verified                INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0, 1)),
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
  verified     INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0, 1)),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_interactions_a ON interaction_pairs(dci_a);
CREATE INDEX IF NOT EXISTS idx_interactions_b ON interaction_pairs(dci_b);

CREATE TABLE IF NOT EXISTS contraindications (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  dci             TEXT NOT NULL,
  condition_type  TEXT NOT NULL
                  CHECK (condition_type IN ('pregnancy', 'breastfeeding', 'renal', 'hepatic', 'asthma', 'ulcer', 'g6pd', 'min_age_months', 'max_age_years', 'chronic')),
  condition_match TEXT NOT NULL DEFAULT '',
  severity        TEXT NOT NULL CHECK (severity IN ('contraindicated', 'avoid', 'caution')),
  message_fr      TEXT NOT NULL DEFAULT '',
  message_ar      TEXT NOT NULL DEFAULT '',
  source          TEXT NOT NULL DEFAULT 'starter',
  verified        INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0, 1)),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_contraindications_dci ON contraindications(dci);

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
  verified        INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0, 1)),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS controlled_rules (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  dci                TEXT NOT NULL UNIQUE,
  schedule           TEXT NOT NULL DEFAULT 'psychotrope',
  max_duration_days  INTEGER,
  requires_secure_rx INTEGER NOT NULL DEFAULT 0 CHECK (requires_secure_rx IN (0, 1)),
  notes_fr           TEXT NOT NULL DEFAULT '',
  notes_ar           TEXT NOT NULL DEFAULT '',
  source             TEXT NOT NULL DEFAULT 'starter',
  verified           INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0, 1)),
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
  has_unverified_rules INTEGER NOT NULL DEFAULT 0 CHECK (has_unverified_rules IN (0, 1))
);
CREATE INDEX IF NOT EXISTS idx_rx_safety_audit_rx ON prescription_safety_audits(prescription_id);
`;

const MIGRATION_4 = `
-- Phase 3: Algerian National Drug Nomenclature extensions & FTS5 search.
ALTER TABLE medications ADD COLUMN registration_number    TEXT NOT NULL DEFAULT '';
ALTER TABLE medications ADD COLUMN laboratory             TEXT NOT NULL DEFAULT '';
ALTER TABLE medications ADD COLUMN country                TEXT NOT NULL DEFAULT '';
ALTER TABLE medications ADD COLUMN is_generic             INTEGER NOT NULL DEFAULT 0 CHECK (is_generic IN (0, 1));
ALTER TABLE medications ADD COLUMN reference_dci_group    TEXT NOT NULL DEFAULT '';
ALTER TABLE medications ADD COLUMN ppa                    REAL;
ALTER TABLE medications ADD COLUMN reference_price        REAL;
ALTER TABLE medications ADD COLUMN reimbursable           INTEGER NOT NULL DEFAULT 0 CHECK (reimbursable IN (0, 1));
ALTER TABLE medications ADD COLUMN reimbursement_rate     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE medications ADD COLUMN schedule               TEXT NOT NULL DEFAULT '';
ALTER TABLE medications ADD COLUMN marketed               INTEGER NOT NULL DEFAULT 1 CHECK (marketed IN (0, 1));
ALTER TABLE medications ADD COLUMN expiry_of_registration TEXT NOT NULL DEFAULT '';
ALTER TABLE medications ADD COLUMN source                 TEXT NOT NULL DEFAULT 'starter';
ALTER TABLE medications ADD COLUMN verified               INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0, 1));
ALTER TABLE medications ADD COLUMN last_updated           TEXT NOT NULL DEFAULT '';
ALTER TABLE medications ADD COLUMN folded_search          TEXT NOT NULL DEFAULT '';

UPDATE medications
SET reference_dci_group = lower(trim(dci)) || '|' || lower(trim(strength)),
    folded_search = lower(brand || ' ' || dci || ' ' || strength || ' ' || form || ' ' || specialty || ' ' || keywords_ar)
WHERE reference_dci_group = '' OR folded_search = '';

CREATE INDEX IF NOT EXISTS idx_medications_reg_num   ON medications(registration_number);
CREATE INDEX IF NOT EXISTS idx_medications_dci_group ON medications(reference_dci_group);
CREATE INDEX IF NOT EXISTS idx_medications_folded    ON medications(folded_search);

CREATE VIRTUAL TABLE IF NOT EXISTS medications_fts USING fts5(
  brand,
  dci,
  strength,
  form,
  laboratory,
  keywords_ar,
  folded_search,
  content='medications',
  content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);

INSERT INTO medications_fts(medications_fts) VALUES('rebuild');

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

ALTER TABLE prescriptions ADD COLUMN print_mode    TEXT NOT NULL DEFAULT 'both' CHECK (print_mode IN ('brand', 'dci', 'both'));
ALTER TABLE prescriptions ADD COLUMN controlled_rx INTEGER NOT NULL DEFAULT 0 CHECK (controlled_rx IN (0, 1));
ALTER TABLE prescription_items ADD COLUMN substitutable INTEGER NOT NULL DEFAULT 1 CHECK (substitutable IN (0, 1));
ALTER TABLE prescription_items ADD COLUMN schedule      TEXT NOT NULL DEFAULT '';
`;

const MIGRATION_5 = `
-- Phase 4: Structured ICD-10 diagnoses, ALD 100% / MDO flags & clinical protocols.
CREATE TABLE IF NOT EXISTS icd10 (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  code           TEXT NOT NULL UNIQUE,
  label_fr       TEXT NOT NULL,
  label_ar       TEXT NOT NULL DEFAULT '',
  chapter        TEXT NOT NULL DEFAULT '',
  is_chronic_ald INTEGER NOT NULL DEFAULT 0 CHECK (is_chronic_ald IN (0, 1)),
  is_notifiable  INTEGER NOT NULL DEFAULT 0 CHECK (is_notifiable IN (0, 1)),
  folded_search  TEXT NOT NULL DEFAULT '',
  source         TEXT NOT NULL DEFAULT 'starter',
  verified       INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0, 1)),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_icd10_code   ON icd10(code);
CREATE INDEX IF NOT EXISTS idx_icd10_folded ON icd10(folded_search);

CREATE VIRTUAL TABLE IF NOT EXISTS icd10_fts USING fts5(
  code,
  label_fr,
  label_ar,
  folded_search,
  content='icd10',
  content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS trg_icd10_ai AFTER INSERT ON icd10 BEGIN
  INSERT INTO icd10_fts(rowid, code, label_fr, label_ar, folded_search)
  VALUES (new.id, new.code, new.label_fr, new.label_ar, new.folded_search);
END;

CREATE TRIGGER IF NOT EXISTS trg_icd10_ad AFTER DELETE ON icd10 BEGIN
  INSERT INTO icd10_fts(icd10_fts, rowid, code, label_fr, label_ar, folded_search)
  VALUES ('delete', old.id, old.code, old.label_fr, old.label_ar, old.folded_search);
END;

CREATE TRIGGER IF NOT EXISTS trg_icd10_au AFTER UPDATE ON icd10 BEGIN
  INSERT INTO icd10_fts(icd10_fts, rowid, code, label_fr, label_ar, folded_search)
  VALUES ('delete', old.id, old.code, old.label_fr, old.label_ar, old.folded_search);
  INSERT INTO icd10_fts(rowid, code, label_fr, label_ar, folded_search)
  VALUES (new.id, new.code, new.label_fr, new.label_ar, new.folded_search);
END;

CREATE TABLE IF NOT EXISTS prescription_diagnoses (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  prescription_id INTEGER NOT NULL REFERENCES prescriptions(id) ON DELETE CASCADE,
  patient_id      INTEGER REFERENCES patients(id) ON DELETE SET NULL,
  department_id   INTEGER REFERENCES departments(id) ON DELETE SET NULL,
  day             TEXT NOT NULL,
  icd10_id        INTEGER REFERENCES icd10(id) ON DELETE SET NULL,
  icd10_code      TEXT NOT NULL DEFAULT '',
  label_fr        TEXT NOT NULL DEFAULT '',
  label_ar        TEXT NOT NULL DEFAULT '',
  free_text       TEXT NOT NULL DEFAULT '',
  is_chronic_ald  INTEGER NOT NULL DEFAULT 0 CHECK (is_chronic_ald IN (0, 1)),
  is_notifiable   INTEGER NOT NULL DEFAULT 0 CHECK (is_notifiable IN (0, 1))
);
CREATE INDEX IF NOT EXISTS idx_rx_diag_rx   ON prescription_diagnoses(prescription_id);
CREATE INDEX IF NOT EXISTS idx_rx_diag_day  ON prescription_diagnoses(day, department_id);
CREATE INDEX IF NOT EXISTS idx_rx_diag_code ON prescription_diagnoses(icd10_code);

ALTER TABLE prescription_templates ADD COLUMN icd10_code TEXT NOT NULL DEFAULT '';
ALTER TABLE prescription_templates ADD COLUMN source     TEXT NOT NULL DEFAULT 'starter';
ALTER TABLE prescription_templates ADD COLUMN verified   INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0, 1));
`;

const MIGRATION_6 = `
-- Phase 5: Structured Electronic Medical Record (EMR), extended patient identity,
-- consultations, secure documents, labs/imaging, Algerian vaccination schedule,
-- pregnancy follow-up, WHO growth & vitals trends.
ALTER TABLE patients ADD COLUMN rh_factor               TEXT NOT NULL DEFAULT '';
ALTER TABLE patients ADD COLUMN marital_status          TEXT NOT NULL DEFAULT '';
ALTER TABLE patients ADD COLUMN occupation              TEXT NOT NULL DEFAULT '';
ALTER TABLE patients ADD COLUMN chifa_number            TEXT NOT NULL DEFAULT '';
ALTER TABLE patients ADD COLUMN nss                     TEXT NOT NULL DEFAULT '';
ALTER TABLE patients ADD COLUMN wilaya                  TEXT NOT NULL DEFAULT '';
ALTER TABLE patients ADD COLUMN commune                 TEXT NOT NULL DEFAULT '';
ALTER TABLE patients ADD COLUMN emergency_contact_name  TEXT NOT NULL DEFAULT '';
ALTER TABLE patients ADD COLUMN emergency_contact_phone TEXT NOT NULL DEFAULT '';
ALTER TABLE patients ADD COLUMN legal_guardian_name     TEXT NOT NULL DEFAULT '';
ALTER TABLE patients ADD COLUMN legal_guardian_phone    TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS consultations (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id            INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  appointment_id        INTEGER REFERENCES appointments(id) ON DELETE SET NULL,
  department_id         INTEGER REFERENCES departments(id) ON DELETE SET NULL,
  day                   TEXT NOT NULL,
  doctor_name           TEXT NOT NULL DEFAULT '',
  chief_complaint       TEXT NOT NULL DEFAULT '',
  history_of_illness    TEXT NOT NULL DEFAULT '',
  physical_exam         TEXT NOT NULL DEFAULT '',
  assessment            TEXT NOT NULL DEFAULT '',
  plan                  TEXT NOT NULL DEFAULT '',
  vitals_bp_sys         INTEGER,
  vitals_bp_dia         INTEGER,
  vitals_hr             INTEGER,
  vitals_temp           REAL,
  vitals_spo2           INTEGER,
  vitals_glycemia       REAL,
  weight_kg             REAL,
  height_cm             REAL,
  head_circumference_cm REAL,
  bmi                   REAL,
  created_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_consultations_patient ON consultations(patient_id, day DESC);

CREATE TABLE IF NOT EXISTS patient_documents (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id      INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  consultation_id INTEGER REFERENCES consultations(id) ON DELETE SET NULL,
  category        TEXT NOT NULL DEFAULT 'other'
                  CHECK (category IN ('lab', 'imaging', 'letter', 'consent', 'other')),
  title           TEXT NOT NULL,
  filename        TEXT NOT NULL,
  stored_name     TEXT NOT NULL,
  mime_type       TEXT NOT NULL DEFAULT '',
  size_bytes      INTEGER NOT NULL DEFAULT 0,
  day             TEXT NOT NULL,
  notes           TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_patient_docs_patient ON patient_documents(patient_id, day DESC);

CREATE TABLE IF NOT EXISTS lab_orders (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id       INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  consultation_id  INTEGER REFERENCES consultations(id) ON DELETE SET NULL,
  day              TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'ordered' CHECK (status IN ('ordered', 'completed')),
  fasting_required INTEGER NOT NULL DEFAULT 0 CHECK (fasting_required IN (0, 1)),
  requested_tests  TEXT NOT NULL DEFAULT '',
  notes            TEXT NOT NULL DEFAULT '',
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_lab_orders_patient ON lab_orders(patient_id, day DESC);

CREATE TABLE IF NOT EXISTS lab_results (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  lab_order_id  INTEGER REFERENCES lab_orders(id) ON DELETE CASCADE,
  patient_id    INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  day           TEXT NOT NULL,
  analyte_code  TEXT NOT NULL,
  analyte_label TEXT NOT NULL,
  value_num     REAL,
  value_text    TEXT NOT NULL DEFAULT '',
  unit          TEXT NOT NULL DEFAULT '',
  ref_min       REAL,
  ref_max       REAL,
  abnormal_flag TEXT NOT NULL DEFAULT '' CHECK (abnormal_flag IN ('', 'low', 'high', 'critical')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_lab_results_patient ON lab_results(patient_id, analyte_code, day ASC);

CREATE TABLE IF NOT EXISTS imaging_orders (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id      INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  consultation_id INTEGER REFERENCES consultations(id) ON DELETE SET NULL,
  day             TEXT NOT NULL,
  modality        TEXT NOT NULL DEFAULT 'rx'
                  CHECK (modality IN ('rx', 'echo', 'ct', 'mri', 'ecg', 'other')),
  body_region     TEXT NOT NULL DEFAULT '',
  indication      TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'ordered' CHECK (status IN ('ordered', 'completed')),
  findings        TEXT NOT NULL DEFAULT '',
  abnormal_flag   INTEGER NOT NULL DEFAULT 0 CHECK (abnormal_flag IN (0, 1)),
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_imaging_orders_patient ON imaging_orders(patient_id, day DESC);

CREATE TABLE IF NOT EXISTS vaccine_schedule (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  vaccine_code            TEXT NOT NULL UNIQUE,
  name_fr                 TEXT NOT NULL,
  name_ar                 TEXT NOT NULL DEFAULT '',
  recommended_age_months  INTEGER NOT NULL DEFAULT 0,
  dose_label              TEXT NOT NULL DEFAULT '',
  booster_interval_months INTEGER,
  notes_fr                TEXT NOT NULL DEFAULT '',
  notes_ar                TEXT NOT NULL DEFAULT '',
  source                  TEXT NOT NULL DEFAULT 'starter',
  verified                INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0, 1))
);

CREATE TABLE IF NOT EXISTS patient_vaccinations (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id       INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  vaccine_code     TEXT NOT NULL,
  vaccine_name     TEXT NOT NULL,
  dose_label       TEXT NOT NULL DEFAULT '',
  administered_day TEXT NOT NULL,
  lot_number       TEXT NOT NULL DEFAULT '',
  next_due_day     TEXT NOT NULL DEFAULT '',
  notes            TEXT NOT NULL DEFAULT '',
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_patient_vacc_patient ON patient_vaccinations(patient_id, administered_day DESC);

CREATE TABLE IF NOT EXISTS pregnancy_episodes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id  INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  ddr         TEXT NOT NULL,
  dpa         TEXT NOT NULL,
  gravida     INTEGER NOT NULL DEFAULT 1,
  para        INTEGER NOT NULL DEFAULT 0,
  risk_level  TEXT NOT NULL DEFAULT 'normal' CHECK (risk_level IN ('normal', 'high')),
  risk_notes  TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'delivered', 'closed')),
  outcome     TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pregnancy_patient ON pregnancy_episodes(patient_id, status);

CREATE TABLE IF NOT EXISTS pregnancy_visits (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  episode_id        INTEGER NOT NULL REFERENCES pregnancy_episodes(id) ON DELETE CASCADE,
  patient_id        INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  day               TEXT NOT NULL,
  gestational_weeks REAL,
  weight_kg         REAL,
  bp                TEXT NOT NULL DEFAULT '',
  uterine_height_cm REAL,
  fetal_hr          INTEGER,
  albuminuria       TEXT NOT NULL DEFAULT '',
  glycosuria        TEXT NOT NULL DEFAULT '',
  ultrasound_notes  TEXT NOT NULL DEFAULT '',
  notes             TEXT NOT NULL DEFAULT '',
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_preg_visits_episode ON pregnancy_visits(episode_id, day DESC);
`;

const MIGRATION_7 = `
-- Phase 6: Billing, CNAS/CASNOS conventions, gap-free sequential invoices, refunds & Z-report.
ALTER TABLE treatments ADD COLUMN price_private   REAL;
ALTER TABLE treatments ADD COLUMN price_insured   REAL;
ALTER TABLE treatments ADD COLUMN convention_rate INTEGER NOT NULL DEFAULT 80;

ALTER TABLE patients ADD COLUMN insurance_type     TEXT NOT NULL DEFAULT 'none'
  CHECK (insurance_type IN ('none', 'CNAS', 'CASNOS', 'other', 'free'));
ALTER TABLE patients ADD COLUMN insurance_rate     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE patients ADD COLUMN insurance_org_name TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS invoice_counters (
  year     INTEGER PRIMARY KEY,
  last_seq INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS invoices (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_number  TEXT NOT NULL UNIQUE,
  year            INTEGER NOT NULL,
  seq             INTEGER NOT NULL,
  patient_id      INTEGER REFERENCES patients(id) ON DELETE SET NULL,
  appointment_id  INTEGER REFERENCES appointments(id) ON DELETE SET NULL,
  day             TEXT NOT NULL,
  patient_name    TEXT NOT NULL,
  insurance_type  TEXT NOT NULL DEFAULT 'none',
  chifa_number    TEXT NOT NULL DEFAULT '',
  nss             TEXT NOT NULL DEFAULT '',
  subtotal        REAL NOT NULL DEFAULT 0,
  discount_amount REAL NOT NULL DEFAULT 0,
  discount_reason TEXT NOT NULL DEFAULT '',
  total_amount    REAL NOT NULL DEFAULT 0,
  insured_share   REAL NOT NULL DEFAULT 0,
  patient_share   REAL NOT NULL DEFAULT 0,
  paid_amount     REAL NOT NULL DEFAULT 0,
  refunded_amount REAL NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'issued'
                  CHECK (status IN ('issued', 'paid', 'partial', 'refunded', 'cancelled')),
  notes           TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (year, seq)
);
CREATE INDEX IF NOT EXISTS idx_invoices_day     ON invoices(day DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_invoices_patient ON invoices(patient_id, day DESC);

CREATE TABLE IF NOT EXISTS invoice_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id    INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  treatment_id  INTEGER REFERENCES treatments(id) ON DELETE SET NULL,
  description   TEXT NOT NULL,
  quantity      INTEGER NOT NULL DEFAULT 1,
  unit_price    REAL NOT NULL DEFAULT 0,
  insured_rate  INTEGER NOT NULL DEFAULT 0,
  line_total    REAL NOT NULL DEFAULT 0,
  insured_share REAL NOT NULL DEFAULT 0,
  patient_share REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_invoice_items_inv ON invoice_items(invoice_id);

CREATE TABLE IF NOT EXISTS payment_refunds (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id  INTEGER REFERENCES payments(id) ON DELETE SET NULL,
  invoice_id  INTEGER REFERENCES invoices(id) ON DELETE SET NULL,
  patient_id  INTEGER REFERENCES patients(id) ON DELETE SET NULL,
  amount      REAL NOT NULL CHECK (amount > 0),
  method      TEXT NOT NULL DEFAULT 'cash',
  reason      TEXT NOT NULL DEFAULT '',
  day         TEXT NOT NULL,
  refunded_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_refunds_day ON payment_refunds(day DESC);
`;

const MIGRATION_8 = `
-- Phase 7: Multi-user RBAC, scrypt + PIN lock, tamper-evident SHA-256 audit chain & Law 18-07 consents.
CREATE TABLE IF NOT EXISTS users (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  username        TEXT NOT NULL UNIQUE,
  full_name       TEXT NOT NULL,
  role            TEXT NOT NULL DEFAULT 'doctor'
                  CHECK (role IN ('admin', 'doctor', 'secretary', 'nurse', 'accountant')),
  password_hash   TEXT NOT NULL,
  password_salt   TEXT NOT NULL,
  pin_hash        TEXT NOT NULL DEFAULT '',
  pin_salt        TEXT NOT NULL DEFAULT '',
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until    INTEGER NOT NULL DEFAULT 0,
  active          INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at   TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  username    TEXT NOT NULL DEFAULT 'system',
  role        TEXT NOT NULL DEFAULT 'system',
  action      TEXT NOT NULL,
  entity_type TEXT NOT NULL DEFAULT '',
  entity_id   TEXT NOT NULL DEFAULT '',
  summary     TEXT NOT NULL DEFAULT '',
  prev_hash   TEXT NOT NULL,
  entry_hash  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(id DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action  ON audit_log(action);

CREATE TABLE IF NOT EXISTS patient_consents (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id   INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  consent_type TEXT NOT NULL DEFAULT 'data_processing'
               CHECK (consent_type IN ('care', 'whatsapp', 'data_processing')),
  granted      INTEGER NOT NULL DEFAULT 1 CHECK (granted IN (0, 1)),
  recorded_by  TEXT NOT NULL DEFAULT '',
  recorded_at  TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at   TEXT NOT NULL DEFAULT '',
  notes        TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_consents_patient ON patient_consents(patient_id);
`;

const MIGRATION_9 = `
ALTER TABLE departments ADD COLUMN scheduling_mode   TEXT    NOT NULL DEFAULT 'queue' CHECK (scheduling_mode IN ('queue', 'slots'));
ALTER TABLE departments ADD COLUMN slot_start_time   TEXT    NOT NULL DEFAULT '08:30';
ALTER TABLE departments ADD COLUMN slot_end_time     TEXT    NOT NULL DEFAULT '16:30';
ALTER TABLE departments ADD COLUMN slot_duration_min INTEGER NOT NULL DEFAULT 20;
ALTER TABLE departments ADD COLUMN equipment_list    TEXT    NOT NULL DEFAULT '';

ALTER TABLE appointments ADD COLUMN slot_time           TEXT NOT NULL DEFAULT '';
ALTER TABLE appointments ADD COLUMN priority            TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal', 'walk_in', 'urgent'));
ALTER TABLE appointments ADD COLUMN confirmation_status TEXT NOT NULL DEFAULT 'pending' CHECK (confirmation_status IN ('pending', 'confirmed', 'cancelled'));

CREATE TABLE IF NOT EXISTS clinic_closures (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  start_day     TEXT NOT NULL,
  end_day       TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'closure'
                CHECK (kind IN ('holiday_national', 'holiday_lunar', 'closure', 'leave')),
  label_fr      TEXT NOT NULL,
  label_ar      TEXT NOT NULL DEFAULT '',
  department_id INTEGER REFERENCES departments(id) ON DELETE CASCADE,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_closures_days ON clinic_closures(start_day, end_day);

CREATE TABLE IF NOT EXISTS clinic_rooms (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL,
  equipment     TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'maintenance')),
  notes         TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS inventory_items (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  sku            TEXT NOT NULL DEFAULT '',
  name_fr        TEXT NOT NULL,
  name_ar        TEXT NOT NULL DEFAULT '',
  category       TEXT NOT NULL DEFAULT 'consommable',
  unit           TEXT NOT NULL DEFAULT 'unité',
  quantity       REAL NOT NULL DEFAULT 0,
  min_threshold  REAL NOT NULL DEFAULT 5,
  expiry_day     TEXT NOT NULL DEFAULT '',
  unit_cost      REAL NOT NULL DEFAULT 0,
  supplier_name  TEXT NOT NULL DEFAULT '',
  supplier_phone TEXT NOT NULL DEFAULT '',
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_inventory_expiry ON inventory_items(expiry_day);

CREATE TABLE IF NOT EXISTS inventory_movements (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id        INTEGER NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  direction      TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  quantity       REAL NOT NULL CHECK (quantity > 0),
  reason         TEXT NOT NULL DEFAULT '',
  appointment_id INTEGER REFERENCES appointments(id) ON DELETE SET NULL,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_inv_moves_item ON inventory_movements(item_id);

CREATE TABLE IF NOT EXISTS treatment_consumables (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  treatment_id INTEGER NOT NULL REFERENCES treatments(id) ON DELETE CASCADE,
  item_id      INTEGER NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  qty_per_act  REAL    NOT NULL DEFAULT 1 CHECK (qty_per_act > 0),
  UNIQUE (treatment_id, item_id)
);

CREATE TABLE IF NOT EXISTS staff_members (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name      TEXT NOT NULL,
  role_title     TEXT NOT NULL DEFAULT '',
  phone          TEXT NOT NULL DEFAULT '',
  monthly_salary REAL NOT NULL DEFAULT 0,
  hire_day       TEXT NOT NULL DEFAULT '',
  active         INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS staff_attendance (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id    INTEGER NOT NULL REFERENCES staff_members(id) ON DELETE CASCADE,
  day         TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'present' CHECK (status IN ('present', 'absent', 'late', 'leave')),
  check_in    TEXT NOT NULL DEFAULT '',
  check_out   TEXT NOT NULL DEFAULT '',
  notes       TEXT NOT NULL DEFAULT '',
  UNIQUE (staff_id, day)
);
CREATE INDEX IF NOT EXISTS idx_staff_att_day ON staff_attendance(day);

CREATE TABLE IF NOT EXISTS staff_payroll (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id      INTEGER NOT NULL REFERENCES staff_members(id) ON DELETE CASCADE,
  period_month  TEXT NOT NULL,
  base_salary   REAL NOT NULL DEFAULT 0,
  bonus         REAL NOT NULL DEFAULT 0,
  deductions    REAL NOT NULL DEFAULT 0,
  net_paid      REAL NOT NULL DEFAULT 0,
  paid_day      TEXT NOT NULL,
  expense_id    INTEGER REFERENCES expenses(id) ON DELETE SET NULL,
  notes         TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

const MIGRATION_10 = `
ALTER TABLE prescriptions        ADD COLUMN verification_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE medical_certificates ADD COLUMN verification_hash TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS clinical_documents (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id        INTEGER REFERENCES patients(id) ON DELETE SET NULL,
  patient_name      TEXT NOT NULL,
  patient_age       TEXT NOT NULL DEFAULT '',
  department_id     INTEGER REFERENCES departments(id) ON DELETE SET NULL,
  doc_type          TEXT NOT NULL
                    CHECK (doc_type IN ('referral', 'medical_report', 'cert_fitness_sports', 'cert_school', 'cert_vaccination')),
  day               TEXT NOT NULL,
  doctor_name       TEXT NOT NULL DEFAULT '',
  doctor_specialty  TEXT NOT NULL DEFAULT '',
  doctor_ordre      TEXT NOT NULL DEFAULT '',
  recipient_doctor  TEXT NOT NULL DEFAULT '',
  specialty_target  TEXT NOT NULL DEFAULT '',
  clinical_summary  TEXT NOT NULL DEFAULT '',
  findings          TEXT NOT NULL DEFAULT '',
  conclusion        TEXT NOT NULL DEFAULT '',
  verification_hash TEXT NOT NULL DEFAULT '',
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_clin_docs_patient ON clinical_documents(patient_id, day DESC);
`;

const MIGRATION_11 = `
CREATE TABLE IF NOT EXISTS bot_sessions (
  phone_key  TEXT PRIMARY KEY,
  state_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

ALTER TABLE medications ADD COLUMN name_normalized TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_medications_name_norm ON medications(name_normalized);
`;

const MIGRATION_12 = `
CREATE INDEX IF NOT EXISTS idx_bot_sessions_updated ON bot_sessions(updated_at);
`;

const MIGRATION_13 = `
CREATE TABLE IF NOT EXISTS clinic_holidays (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  start_day     TEXT NOT NULL,
  end_day       TEXT NOT NULL,
  reason_type   TEXT NOT NULL DEFAULT 'vacation'
                CHECK (reason_type IN ('vacation', 'sick', 'other')),
  label         TEXT NOT NULL DEFAULT '',
  department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL,
  block_all_wa  INTEGER NOT NULL DEFAULT 0 CHECK (block_all_wa IN (0, 1)),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_clinic_holidays_range ON clinic_holidays(start_day, end_day);
`;

const MIGRATIONS = [
  MIGRATION_1,
  MIGRATION_2,
  MIGRATION_3,
  MIGRATION_4,
  MIGRATION_5,
  MIGRATION_6,
  MIGRATION_7,
  MIGRATION_8,
  MIGRATION_9,
  MIGRATION_10,
  MIGRATION_11,
  MIGRATION_12,
  MIGRATION_13,
];

function hasColumn(db, tableName, colName) {
  const cols = db.prepare(`PRAGMA table_info(${tableName})`).all();
  return cols.some((c) => c.name === colName);
}

/**
 * Idempotent schema upgrade for cooldown + secretary payment confirmation.
 * Safe to run any number of times without errors or data loss.
 */
function ensureIdempotentColumns(db) {
  const tx = db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS bot_sessions (
        phone_key  TEXT PRIMARY KEY,
        state_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_bot_sessions_updated ON bot_sessions(updated_at);

      CREATE TABLE IF NOT EXISTS clinic_holidays (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        start_day     TEXT NOT NULL,
        end_day       TEXT NOT NULL,
        reason_type   TEXT NOT NULL DEFAULT 'vacation'
                      CHECK (reason_type IN ('vacation', 'sick', 'other')),
        label         TEXT NOT NULL DEFAULT '',
        department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL,
        block_all_wa  INTEGER NOT NULL DEFAULT 0 CHECK (block_all_wa IN (0, 1)),
        created_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_clinic_holidays_range ON clinic_holidays(start_day, end_day);
    `);

    if (!hasColumn(db, 'patients', 'blocked_until')) {
      db.exec('ALTER TABLE patients ADD COLUMN blocked_until TEXT DEFAULT NULL;');
    }

    if (!hasColumn(db, 'appointments', 'is_paid')) {
      db.exec('ALTER TABLE appointments ADD COLUMN is_paid INTEGER NOT NULL DEFAULT 0;');
    }
    if (!hasColumn(db, 'appointments', 'paid_at')) {
      db.exec('ALTER TABLE appointments ADD COLUMN paid_at TEXT DEFAULT NULL;');
    }
    if (!hasColumn(db, 'appointments', 'paid_by')) {
      db.exec('ALTER TABLE appointments ADD COLUMN paid_by TEXT DEFAULT NULL;');
    }

    // Backfill appointments already settled via `payments` so UI immediately reflects paid status.
    db.exec(`
      UPDATE appointments
      SET is_paid = 1,
          paid_at = COALESCE(
            paid_at,
            (SELECT MAX(pay.paid_at) FROM payments pay WHERE pay.appointment_id = appointments.id)
          )
      WHERE is_paid = 0
        AND price > 0
        AND COALESCE((SELECT SUM(pay.amount) FROM payments pay WHERE pay.appointment_id = appointments.id), 0) >= price - 0.009;
    `);
  });
  tx();
}

function migrate(db) {
  const current = db.pragma('user_version', { simple: true });
  const run = db.transaction(() => {
    for (let version = current; version < SCHEMA_VERSION; version += 1) {
      db.exec(MIGRATIONS[version]);
    }
    ensureIdempotentColumns(db);
    if (current < SCHEMA_VERSION) {
      db.pragma(`user_version = ${SCHEMA_VERSION}`);
    }
  });
  run();
  return SCHEMA_VERSION;
}

module.exports = { SCHEMA_VERSION, MIGRATIONS, migrate, ensureIdempotentColumns };
