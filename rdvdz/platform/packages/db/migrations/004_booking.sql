-- 004_booking.sql — patients, créneaux, rendez-vous, historique, verrous

CREATE TABLE IF NOT EXISTS patients (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid UNIQUE REFERENCES users(id) ON DELETE SET NULL,
  full_name      text NOT NULL,
  phone          text NOT NULL,
  birth_date     date,
  gender         text CHECK (gender IS NULL OR gender IN ('f','m')),
  wilaya_code    integer REFERENCES wilayas(code),
  commune        text NOT NULL DEFAULT '',
  consent_version text,
  consent_at     timestamptz,
  created_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_patients_phone ON patients (phone);
CREATE INDEX IF NOT EXISTS ix_patients_name ON patients (lower(full_name));

CREATE TABLE IF NOT EXISTS doctor_slots (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doctor_id        uuid NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
  starts_at        timestamptz NOT NULL,
  ends_at          timestamptz NOT NULL,
  mode             text NOT NULL DEFAULT 'IN_CLINIC' CHECK (mode IN ('IN_CLINIC','VIDEO','PHONE')),
  status           text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','HELD','BOOKED','BLOCKED')),
  hold_expires_at  timestamptz,
  source           text NOT NULL DEFAULT 'GENERATED' CHECK (source IN ('GENERATED','MANUAL','DESKTOP')),
  desktop_uuid     text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (starts_at < ends_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_slots_identity ON doctor_slots (doctor_id, starts_at, mode);
CREATE INDEX IF NOT EXISTS ix_slots_open ON doctor_slots (doctor_id, starts_at) WHERE status = 'OPEN';
CREATE INDEX IF NOT EXISTS ix_slots_held ON doctor_slots (hold_expires_at) WHERE status = 'HELD';

CREATE TABLE IF NOT EXISTS appointments (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference          text NOT NULL,
  slot_id            uuid NOT NULL REFERENCES doctor_slots(id) ON DELETE RESTRICT,
  patient_id         uuid NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
  doctor_id          uuid NOT NULL REFERENCES doctors(id) ON DELETE RESTRICT,
  clinic_id          uuid REFERENCES clinics(id) ON DELETE SET NULL,
  branch_id          uuid,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  source             text NOT NULL DEFAULT 'PATIENT_WEBSITE'
                     CHECK (source IN ('PATIENT_WEBSITE','OPERATOR','BRANCH','WHATSAPP','OTHER')),
  status             text NOT NULL DEFAULT 'PENDING' CHECK (status IN (
                       'PENDING','AWAITING_PAYMENT','PAID','CONFIRMED','CANCELLED',
                       'REJECTED','COMPLETED','NO_SHOW','REFUNDED')),
  mode               text NOT NULL DEFAULT 'IN_CLINIC' CHECK (mode IN ('IN_CLINIC','VIDEO','PHONE')),
  price              integer NOT NULL DEFAULT 0 CHECK (price >= 0),
  service_fee        integer NOT NULL DEFAULT 0 CHECK (service_fee >= 0),
  currency           text NOT NULL DEFAULT 'DZD',
  notes              text NOT NULL DEFAULT '',
  cancel_reason      text NOT NULL DEFAULT '',
  desktop_uuid       text,
  idempotency_key    text,
  confirmed_at       timestamptz,
  completed_at       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_appointments_reference ON appointments (reference);
-- Un créneau ne peut porter qu'UN rendez-vous : la base refuse la seconde
-- réservation, même en cas de course applicative.
CREATE UNIQUE INDEX IF NOT EXISTS uq_appointments_slot ON appointments (slot_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_appointments_idem ON appointments (idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_appointments_patient ON appointments (patient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_appointments_doctor ON appointments (doctor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_appointments_status ON appointments (status, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_appointments_branch ON appointments (branch_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_appointments_desktop ON appointments (desktop_uuid)
  WHERE desktop_uuid IS NOT NULL;

CREATE TABLE IF NOT EXISTS appointment_status_history (
  id             bigserial PRIMARY KEY,
  appointment_id uuid NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  from_status    text,
  to_status      text NOT NULL,
  actor_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_role     text,
  reason         text NOT NULL DEFAULT '',
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_status_history_appt ON appointment_status_history (appointment_id, created_at);

CREATE TABLE IF NOT EXISTS booking_holds (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slot_id     uuid NOT NULL REFERENCES doctor_slots(id) ON DELETE CASCADE,
  patient_id  uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  appointment_id uuid REFERENCES appointments(id) ON DELETE CASCADE,
  payment_id  uuid,
  expires_at  timestamptz NOT NULL,
  released_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_holds_active ON booking_holds (expires_at) WHERE released_at IS NULL;
