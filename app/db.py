"""SQLite schema, migrations and connection helpers (Part 9).

Normalized relational schema. Migrations are additive only — routine
migrations never delete existing records. All timestamps are stored in UTC
(ISO-8601); Africa/Algiers is used for display.
"""
from __future__ import annotations

import sqlite3
from pathlib import Path

SCHEMA_VERSION = 1

MIGRATION_1 = """
CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'patient'
                CHECK (role IN ('super_admin','admin','payment_verifier','support_agent','doctor','patient')),
  full_name     TEXT NOT NULL DEFAULT '',
  phone         TEXT,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','inactive')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

CREATE TABLE IF NOT EXISTS patients (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name  TEXT NOT NULL,
  phone      TEXT NOT NULL,
  phone_norm TEXT,
  email      TEXT,
  lang       TEXT NOT NULL DEFAULT 'fr' CHECK (lang IN ('fr','ar')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_patients_phone ON patients(phone);
CREATE INDEX IF NOT EXISTS idx_patients_phone_norm ON patients(phone_norm);

CREATE TABLE IF NOT EXISTS specialties (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  name_fr TEXT NOT NULL UNIQUE,
  name_ar TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS doctors (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  full_name       TEXT NOT NULL,
  specialty       TEXT NOT NULL DEFAULT '',
  phone           TEXT,
  whatsapp_number TEXT,
  email           TEXT,
  photo_url       TEXT,
  wilaya          TEXT NOT NULL DEFAULT '',
  city            TEXT NOT NULL DEFAULT '',
  address         TEXT NOT NULL DEFAULT '',
  lat             REAL,
  lng             REAL,
  status          TEXT NOT NULL DEFAULT 'pending_approval'
                  CHECK (status IN ('active','pending_approval','suspended','inactive')),
  fee             REAL NOT NULL DEFAULT 0 CHECK (fee >= 0),
  duration_min    INTEGER NOT NULL DEFAULT 20 CHECK (duration_min >= 5),
  payment_policy  TEXT NOT NULL DEFAULT 'baridimob'
                  CHECK (payment_policy IN ('baridimob','cash_at_clinic','free')),
  auto_confirm    INTEGER NOT NULL DEFAULT 0,
  booking_rules   TEXT NOT NULL DEFAULT '{}',
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_doctors_status ON doctors(status);
CREATE INDEX IF NOT EXISTS idx_doctors_specialty ON doctors(specialty);
CREATE INDEX IF NOT EXISTS idx_doctors_wilaya ON doctors(wilaya);

CREATE TABLE IF NOT EXISTS clinics (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  address    TEXT NOT NULL DEFAULT '',
  wilaya     TEXT NOT NULL DEFAULT '',
  city       TEXT NOT NULL DEFAULT '',
  phone      TEXT,
  lat        REAL,
  lng        REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_clinics_wilaya ON clinics(wilaya);

CREATE TABLE IF NOT EXISTS doctor_clinics (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  doctor_id     INTEGER NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
  clinic_id     INTEGER NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  working_days  TEXT NOT NULL DEFAULT '0,1,2,3,4',
  start_time    TEXT NOT NULL DEFAULT '09:00',
  end_time      TEXT NOT NULL DEFAULT '17:00',
  slot_minutes  INTEGER NOT NULL DEFAULT 20 CHECK (slot_minutes >= 5),
  max_per_day   INTEGER NOT NULL DEFAULT 30 CHECK (max_per_day >= 1),
  active        INTEGER NOT NULL DEFAULT 1,
  UNIQUE (doctor_id, clinic_id)
);
CREATE INDEX IF NOT EXISTS idx_doctor_clinics_doctor ON doctor_clinics(doctor_id);

CREATE TABLE IF NOT EXISTS blocked_dates (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  doctor_id INTEGER NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
  clinic_id INTEGER REFERENCES clinics(id) ON DELETE CASCADE,
  date      TEXT NOT NULL,
  reason    TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_blocked_doctor_date ON blocked_dates(doctor_id, date);

CREATE TABLE IF NOT EXISTS appointments (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  ref                TEXT NOT NULL UNIQUE,
  idempotency_key    TEXT UNIQUE,
  patient_id         INTEGER REFERENCES patients(id) ON DELETE SET NULL,
  patient_name       TEXT NOT NULL DEFAULT '',
  patient_phone      TEXT NOT NULL DEFAULT '',
  doctor_id          INTEGER NOT NULL REFERENCES doctors(id) ON DELETE RESTRICT,
  clinic_id          INTEGER REFERENCES clinics(id) ON DELETE SET NULL,
  date               TEXT NOT NULL,
  time               TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft','pending_payment','payment_verification',
                       'pending_doctor_approval','confirmed','rejected',
                       'rescheduling_requested','cancelled','completed','expired')),
  payment_status     TEXT NOT NULL DEFAULT 'awaiting_payment'
                     CHECK (payment_status IN ('awaiting_payment','submitted',
                       'under_verification','paid','rejected','expired','refunded')),
  whatsapp_status    TEXT NOT NULL DEFAULT 'not_sent'
                     CHECK (whatsapp_status IN ('not_sent','queued','sent','delivered','read','failed','click_to_chat')),
  doctor_response    TEXT,
  doctor_responded_at TEXT,
  response_deadline  TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_appt_doctor_date ON appointments(doctor_id, date);
CREATE INDEX IF NOT EXISTS idx_appt_status ON appointments(status);
CREATE INDEX IF NOT EXISTS idx_appt_patient_phone ON appointments(patient_phone);
CREATE INDEX IF NOT EXISTS idx_appt_ref ON appointments(ref);
-- Double-booking guard: one active appointment per doctor+clinic+date+time.
CREATE UNIQUE INDEX IF NOT EXISTS idx_appt_no_double_booking
  ON appointments(doctor_id, COALESCE(clinic_id, 0), date, time)
  WHERE status NOT IN ('cancelled','rejected','expired');

CREATE TABLE IF NOT EXISTS appointment_events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  appointment_id INTEGER NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL,
  detail         TEXT NOT NULL DEFAULT '',
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_appt_events_appt ON appointment_events(appointment_id);

CREATE TABLE IF NOT EXISTS whatsapp_accounts (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  doctor_id        INTEGER NOT NULL UNIQUE REFERENCES doctors(id) ON DELETE CASCADE,
  mode             TEXT NOT NULL DEFAULT 'cloud' CHECK (mode IN ('cloud','click_to_chat')),
  waba_id          TEXT,
  phone_number_id  TEXT,
  display_number   TEXT,
  access_token_enc TEXT,
  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','connected','disconnected','error')),
  last_error       TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS whatsapp_messages (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  appointment_id INTEGER REFERENCES appointments(id) ON DELETE SET NULL,
  doctor_id      INTEGER REFERENCES doctors(id) ON DELETE SET NULL,
  direction      TEXT NOT NULL CHECK (direction IN ('out','in')),
  body           TEXT NOT NULL DEFAULT '',
  wa_message_id  TEXT,
  status         TEXT NOT NULL DEFAULT 'queued',
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_wa_msg_appt ON whatsapp_messages(appointment_id);
CREATE INDEX IF NOT EXISTS idx_wa_msg_doctor ON whatsapp_messages(doctor_id);

CREATE TABLE IF NOT EXISTS whatsapp_webhook_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  phone_number_id TEXT,
  payload_hash    TEXT NOT NULL UNIQUE,
  payload         TEXT NOT NULL DEFAULT '',
  processed       INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS payments (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  appointment_id INTEGER NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  amount         REAL NOT NULL CHECK (amount >= 0),
  method         TEXT NOT NULL DEFAULT 'baridimob'
                 CHECK (method IN ('baridimob','cash','baridi_pay','cib','edahabia')),
  recipient_info TEXT NOT NULL DEFAULT '',
  txn_ref        TEXT,
  status         TEXT NOT NULL DEFAULT 'awaiting_payment'
                 CHECK (status IN ('awaiting_payment','submitted','under_verification',
                   'paid','rejected','expired','refunded')),
  receipt_path   TEXT,
  verified_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  verified_at    TEXT,
  notes          TEXT NOT NULL DEFAULT '',
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_payments_appt ON payments(appointment_id);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_txn_ref_unique
  ON payments(txn_ref) WHERE txn_ref IS NOT NULL AND txn_ref <> '';

CREATE TABLE IF NOT EXISTS payment_audit_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id INTEGER NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  actor      TEXT NOT NULL DEFAULT 'system',
  action     TEXT NOT NULL,
  detail     TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pay_audit_payment ON payment_audit_logs(payment_id);

CREATE TABLE IF NOT EXISTS notifications (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  appointment_id INTEGER REFERENCES appointments(id) ON DELETE SET NULL,
  channel        TEXT NOT NULL DEFAULT 'in_app' CHECK (channel IN ('in_app','whatsapp','email')),
  recipient      TEXT NOT NULL DEFAULT '',
  body           TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','failed')),
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notifications_appt ON notifications(appointment_id);

CREATE TABLE IF NOT EXISTS device_connections (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  doctor_id  INTEGER NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
  device_id  TEXT NOT NULL UNIQUE,
  token_hash TEXT NOT NULL,
  app_kind   TEXT NOT NULL DEFAULT 'medirdv',
  last_seen  TEXT,
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','offline','revoked')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sync_queue (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id  TEXT NOT NULL,
  kind       TEXT NOT NULL,
  payload    TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','acked','failed')),
  attempts   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sync_device ON sync_queue(device_id, status);

CREATE TABLE IF NOT EXISTS integration_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,
  detail     TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS system_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  actor      TEXT NOT NULL DEFAULT 'system',
  action     TEXT NOT NULL,
  entity     TEXT NOT NULL DEFAULT '',
  entity_id  TEXT NOT NULL DEFAULT '',
  detail     TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);
"""

DEFAULT_SETTINGS = {
    "platform_name": "Medirdv Central",
    "doctor_response_hours": "24",
    "booking_lead_hours": "2",
    "baridimob_recipient": "",  # verified recipient details shown to patients
    "baridimob_instructions_fr": "Transférez le montant via BaridiMob vers le destinataire affiché, puis revenez ici et saisissez la référence de transaction.",
    "baridimob_instructions_ar": "حوّل المبلغ عبر بريدي موب إلى المستلم المعروض، ثم عد إلى هنا وأدخل مرجع العملية.",
    "whatsapp_template_booking": "booking_request_v1",
    "whatsapp_template_confirmation": "appointment_confirmation_v1",
}


def connect(db_path: Path) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA synchronous = FULL")
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout = 5000")
    return conn


def migrate(conn: sqlite3.Connection) -> None:
    conn.executescript(MIGRATION_1)
    row = conn.execute("SELECT version FROM schema_version LIMIT 1").fetchone()
    if row is None:
        conn.execute("INSERT INTO schema_version (version) VALUES (?)", (SCHEMA_VERSION,))
    for key, value in DEFAULT_SETTINGS.items():
        conn.execute(
            "INSERT OR IGNORE INTO system_settings (key, value) VALUES (?, ?)",
            (key, value),
        )
    conn.commit()


def get_setting(conn: sqlite3.Connection, key: str, default: str = "") -> str:
    row = conn.execute("SELECT value FROM system_settings WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else default


def set_setting(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute(
        "INSERT INTO system_settings (key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, value),
    )
    conn.commit()


def audit(conn: sqlite3.Connection, actor: str, action: str, entity: str = "",
          entity_id: str = "", detail: str = "") -> None:
    conn.execute(
        "INSERT INTO audit_logs (actor, action, entity, entity_id, detail) VALUES (?, ?, ?, ?, ?)",
        (actor, action, entity, str(entity_id), detail),
    )
    conn.commit()
