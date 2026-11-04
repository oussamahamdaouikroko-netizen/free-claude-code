-- 005_teleconsult.sql — consultations, messages, documents médicaux, événements

CREATE TABLE IF NOT EXISTS consultations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference         text NOT NULL,
  patient_id        uuid NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
  doctor_id         uuid NOT NULL REFERENCES doctors(id) ON DELETE RESTRICT,
  appointment_id    uuid REFERENCES appointments(id) ON DELETE SET NULL,
  kind              text NOT NULL DEFAULT 'ASYNC_TEXT'
                    CHECK (kind IN ('ASYNC_TEXT','DOCUMENT_REVIEW','VIDEO_SCHEDULED','FOLLOW_UP')),
  status            text NOT NULL DEFAULT 'REQUESTED' CHECK (status IN (
                      'REQUESTED','ACCEPTED','IN_PROGRESS','AWAITING_PATIENT',
                      'ANSWERED','CLOSED','REJECTED','CANCELLED')),
  price             integer NOT NULL DEFAULT 0 CHECK (price >= 0),
  commission_rate   numeric(5,2) NOT NULL DEFAULT 15.00,
  currency          text NOT NULL DEFAULT 'DZD',
  subject           text NOT NULL DEFAULT '',
  symptom_summary   text NOT NULL DEFAULT '',
  consent_at        timestamptz NOT NULL,
  emergency_ack_at  timestamptz NOT NULL,
  doctor_answer     text NOT NULL DEFAULT '',
  refusal_reason    text NOT NULL DEFAULT '',
  physical_exam_recommended boolean NOT NULL DEFAULT false,
  video_room        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  accepted_at       timestamptz,
  answered_at       timestamptz,
  closed_at         timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_consult_reference ON consultations (reference);
CREATE INDEX IF NOT EXISTS ix_consult_doctor ON consultations (doctor_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_consult_patient ON consultations (patient_id, created_at DESC);

CREATE TABLE IF NOT EXISTS consultation_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consultation_id uuid NOT NULL REFERENCES consultations(id) ON DELETE CASCADE,
  author_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  author_role     text NOT NULL CHECK (author_role IN ('PATIENT','DOCTOR','ADMIN')),
  body            text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  read_at         timestamptz
);
CREATE INDEX IF NOT EXISTS ix_messages_consult ON consultation_messages (consultation_id, created_at);

CREATE TABLE IF NOT EXISTS medical_documents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consultation_id uuid NOT NULL REFERENCES consultations(id) ON DELETE CASCADE,
  patient_id      uuid NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
  doctor_id       uuid NOT NULL REFERENCES doctors(id) ON DELETE RESTRICT,
  storage_key     text NOT NULL,
  filename        text NOT NULL,
  mime            text NOT NULL,
  size_bytes      integer NOT NULL CHECK (size_bytes > 0),
  sha256          text NOT NULL,
  encrypted       boolean NOT NULL DEFAULT true,
  uploaded_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);
CREATE INDEX IF NOT EXISTS ix_documents_consult ON medical_documents (consultation_id, created_at);

CREATE TABLE IF NOT EXISTS consultation_events (
  id              bigserial PRIMARY KEY,
  consultation_id uuid NOT NULL REFERENCES consultations(id) ON DELETE CASCADE,
  event           text NOT NULL,
  actor_user_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  details         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_consult_events ON consultation_events (consultation_id, created_at);
