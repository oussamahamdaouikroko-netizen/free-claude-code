-- 006_payments_finance.sql — paiements, événements PSP, remboursements,
-- règles de commission, grand livre, reversements.

CREATE TABLE IF NOT EXISTS payments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purpose         text NOT NULL CHECK (purpose IN ('BOOKING_SERVICE_FEE','BOOKING_DEPOSIT','TELECONSULTATION')),
  appointment_id  uuid REFERENCES appointments(id) ON DELETE SET NULL,
  consultation_id uuid REFERENCES consultations(id) ON DELETE SET NULL,
  patient_id      uuid NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
  provider        text NOT NULL CHECK (provider IN ('chargily','manual','sandbox')),
  provider_ref    text,
  amount          integer NOT NULL CHECK (amount > 0),
  currency        text NOT NULL DEFAULT 'DZD',
  status          text NOT NULL DEFAULT 'CREATED'
                  CHECK (status IN ('CREATED','PENDING','PAID','FAILED','REFUNDED','EXPIRED')),
  livemode        boolean NOT NULL DEFAULT false,
  checkout_url    text,
  idempotency_key text,
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  paid_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_idem ON payments (idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_payments_patient ON payments (patient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_payments_status ON payments (status, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_payments_provider_ref ON payments (provider, provider_ref);

CREATE TABLE IF NOT EXISTS payment_events (
  id                 bigserial PRIMARY KEY,
  provider           text NOT NULL,
  provider_event_id  text NOT NULL,
  event_type         text NOT NULL DEFAULT '',
  signature_valid    boolean NOT NULL DEFAULT false,
  payload            jsonb NOT NULL DEFAULT '{}'::jsonb,
  received_at        timestamptz NOT NULL DEFAULT now(),
  processed_at       timestamptz
);
-- Un événement PSP ne peut être traité qu'une seule fois (idempotence).
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_events ON payment_events (provider, provider_event_id);

CREATE TABLE IF NOT EXISTS refunds (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id   uuid NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
  amount       integer NOT NULL CHECK (amount > 0),
  reason       text NOT NULL DEFAULT '',
  status       text NOT NULL DEFAULT 'REQUESTED'
               CHECK (status IN ('REQUESTED','APPROVED','PROCESSED','REJECTED')),
  provider_ref text,
  requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
  processed_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_refunds_payment ON refunds (payment_id);

CREATE TABLE IF NOT EXISTS commission_rules (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope          text NOT NULL CHECK (scope IN ('BOOKING_FEE','TELECONSULT')),
  branch_id      uuid,
  platform_pct   numeric(5,2) NOT NULL CHECK (platform_pct BETWEEN 0 AND 100),
  branch_pct     numeric(5,2) NOT NULL DEFAULT 0 CHECK (branch_pct BETWEEN 0 AND 100),
  operator_pct   numeric(5,2) NOT NULL DEFAULT 0 CHECK (operator_pct BETWEEN 0 AND 100),
  psp_fixed      integer NOT NULL DEFAULT 0 CHECK (psp_fixed >= 0),
  doctor_pct     numeric(5,2) NOT NULL DEFAULT 0 CHECK (doctor_pct BETWEEN 0 AND 100),
  effective_from timestamptz NOT NULL DEFAULT now(),
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_rules_scope ON commission_rules (scope, active, effective_from DESC);

CREATE TABLE IF NOT EXISTS commissions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type      text NOT NULL CHECK (source_type IN ('APPOINTMENT','CONSULTATION')),
  source_id        uuid NOT NULL,
  payment_id       uuid REFERENCES payments(id) ON DELETE SET NULL,
  rule_id          uuid REFERENCES commission_rules(id) ON DELETE SET NULL,
  beneficiary_type text NOT NULL CHECK (beneficiary_type IN ('PLATFORM','BRANCH','OPERATOR','DOCTOR','PSP')),
  beneficiary_id   uuid,
  amount           integer NOT NULL,
  currency         text NOT NULL DEFAULT 'DZD',
  status           text NOT NULL DEFAULT 'ACCRUED' CHECK (status IN ('ACCRUED','REVERSED','SETTLED')),
  settlement_id    uuid,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_commissions_source ON commissions (source_type, source_id);
CREATE INDEX IF NOT EXISTS ix_commissions_beneficiary ON commissions (beneficiary_type, beneficiary_id, created_at DESC);

CREATE TABLE IF NOT EXISTS settlements (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  beneficiary_type text NOT NULL CHECK (beneficiary_type IN ('BRANCH','OPERATOR','DOCTOR')),
  beneficiary_id   uuid NOT NULL,
  period_start     date NOT NULL,
  period_end       date NOT NULL,
  gross            integer NOT NULL DEFAULT 0,
  fees             integer NOT NULL DEFAULT 0,
  net              integer NOT NULL DEFAULT 0,
  status           text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','APPROVED','PAID')),
  reference        text,
  paid_at          timestamptz,
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (period_start <= period_end)
);
CREATE INDEX IF NOT EXISTS ix_settlements_beneficiary ON settlements (beneficiary_type, beneficiary_id, period_end DESC);
