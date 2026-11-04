-- 003_directory.sql — cliniques, médecins, spécialités, horaires, congés, avis

CREATE TABLE IF NOT EXISTS clinics (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name_ar     text NOT NULL,
  name_fr     text NOT NULL,
  kind        text NOT NULL DEFAULT 'MEDICAL' CHECK (kind IN ('DENTAL','MEDICAL','POLYCLINIC')),
  wilaya_code integer NOT NULL REFERENCES wilayas(code),
  commune     text NOT NULL DEFAULT '',
  address     text NOT NULL DEFAULT '',
  phone       text,
  lat         numeric(9,6),
  lng         numeric(9,6),
  photos      jsonb NOT NULL DEFAULT '[]'::jsonb,
  verified_at timestamptz,
  verified_by uuid REFERENCES users(id) ON DELETE SET NULL,
  status      text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED','PENDING')),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_clinics_wilaya ON clinics (wilaya_code, status);

CREATE TABLE IF NOT EXISTS doctors (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  clinic_id              uuid REFERENCES clinics(id) ON DELETE SET NULL,
  primary_specialty_code text NOT NULL REFERENCES specialties(code),
  license_no             text,
  bio_ar                 text NOT NULL DEFAULT '',
  bio_fr                 text NOT NULL DEFAULT '',
  languages              text[] NOT NULL DEFAULT ARRAY['ar','fr']::text[],
  consultation_fee       integer NOT NULL DEFAULT 0 CHECK (consultation_fee >= 0),
  teleconsult_fee        integer NOT NULL DEFAULT 0 CHECK (teleconsult_fee >= 0),
  teleconsult_enabled    boolean NOT NULL DEFAULT false,
  manual_confirmation    boolean NOT NULL DEFAULT false,
  accepting_new          boolean NOT NULL DEFAULT true,
  slot_minutes           integer NOT NULL DEFAULT 20 CHECK (slot_minutes BETWEEN 5 AND 180),
  rating_avg             numeric(3,2) NOT NULL DEFAULT 0,
  rating_count           integer NOT NULL DEFAULT 0,
  verified_at            timestamptz,
  verified_by            uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at             timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_doctors_user ON doctors (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_doctors_license ON doctors (license_no) WHERE license_no IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_doctors_specialty ON doctors (primary_specialty_code);
CREATE INDEX IF NOT EXISTS ix_doctors_clinic ON doctors (clinic_id);

CREATE TABLE IF NOT EXISTS doctor_specialties (
  doctor_id      uuid NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
  specialty_code text NOT NULL REFERENCES specialties(code),
  PRIMARY KEY (doctor_id, specialty_code)
);

CREATE TABLE IF NOT EXISTS clinic_hours (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id   uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  doctor_id   uuid REFERENCES doctors(id) ON DELETE CASCADE,
  weekday     integer NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  opens       time NOT NULL,
  closes      time NOT NULL,
  break_start time,
  break_end   time,
  CHECK (opens < closes),
  CHECK (break_start IS NULL OR break_end IS NULL OR break_start < break_end)
);
CREATE INDEX IF NOT EXISTS ix_hours_lookup ON clinic_hours (clinic_id, doctor_id, weekday);

CREATE TABLE IF NOT EXISTS doctor_time_off (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doctor_id  uuid NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
  starts_at  timestamptz NOT NULL,
  ends_at    timestamptz NOT NULL,
  reason     text NOT NULL DEFAULT '',
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (starts_at < ends_at)
);
CREATE INDEX IF NOT EXISTS ix_timeoff_doctor ON doctor_time_off (doctor_id, starts_at);

CREATE TABLE IF NOT EXISTS reviews (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doctor_id      uuid NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
  patient_id     uuid NOT NULL,
  appointment_id uuid NOT NULL,
  rating         integer NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment        text NOT NULL DEFAULT '',
  status         text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  moderated_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  moderated_at   timestamptz,
  moderation_note text NOT NULL DEFAULT '',
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_reviews_appointment ON reviews (appointment_id);
CREATE INDEX IF NOT EXISTS ix_reviews_doctor ON reviews (doctor_id, status, created_at DESC);
