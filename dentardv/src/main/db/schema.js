'use strict';
/**
 * SQLite schema + migrations.
 *
 * The app is offline-first: a single SQLite file holds everything. Schema
 * versions are tracked with PRAGMA user_version, so an upgrade from an older
 * clinic install only runs the missing migrations and never drops data.
 */

const SCHEMA_VERSION = 2;

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

const MIGRATIONS = [
  MIGRATION_1,
  `
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
`,
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
      db.exec(MIGRATIONS[version]);
    }
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  });
  run();
  return SCHEMA_VERSION;
}

module.exports = { SCHEMA_VERSION, migrate };
