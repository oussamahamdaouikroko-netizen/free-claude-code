-- 008_desktop_sync.sql — appairage des postes DENTARDV / MEDIRDV, journaux,
-- boîte de réception rejouable, conflits.

CREATE TABLE IF NOT EXISTS desktop_devices (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id     uuid REFERENCES clinics(id) ON DELETE SET NULL,
  doctor_id     uuid REFERENCES doctors(id) ON DELETE SET NULL,
  product       text NOT NULL CHECK (product IN ('DENTARDV','MEDIRDV')),
  name          text NOT NULL DEFAULT '',
  version       text NOT NULL DEFAULT '',
  token_hash    text NOT NULL,
  secret        text NOT NULL,
  last_cursor   bigint NOT NULL DEFAULT 0,
  registered_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz,
  revoked_at    timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_devices_token ON desktop_devices (token_hash);
CREATE INDEX IF NOT EXISTS ix_devices_doctor ON desktop_devices (doctor_id);

CREATE TABLE IF NOT EXISTS desktop_sync_log (
  id           bigserial PRIMARY KEY,
  device_id    uuid NOT NULL REFERENCES desktop_devices(id) ON DELETE CASCADE,
  direction    text NOT NULL CHECK (direction IN ('IN','OUT')),
  entity       text NOT NULL,
  local_id     text,
  remote_id    text,
  operation    text NOT NULL DEFAULT '',
  status       text NOT NULL CHECK (status IN ('ACK','CONFLICT','ERROR')),
  detail       text NOT NULL DEFAULT '',
  payload_hash text NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_sync_log_device ON desktop_sync_log (device_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_sync_log_status ON desktop_sync_log (status, created_at DESC);

-- Réservations à pousser au poste. `cursor` = id croissant, ce qui donne un
-- ordre total stable pour le rejeu.
CREATE TABLE IF NOT EXISTS desktop_inbox (
  id           bigserial PRIMARY KEY,
  device_id    uuid NOT NULL REFERENCES desktop_devices(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('BOOKING','CANCELLATION','CONSULTATION','PAYMENT_NOTE')),
  remote_id    text NOT NULL,
  payload      jsonb NOT NULL,
  status       text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','DELIVERED','APPLIED','FAILED','EXPIRED')),
  attempts     integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  applied_at   timestamptz,
  last_error   text NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now()
);
-- La même réservation ne peut pas être envoyée deux fois au même poste.
CREATE UNIQUE INDEX IF NOT EXISTS uq_inbox_device_remote ON desktop_inbox (device_id, remote_id);
CREATE INDEX IF NOT EXISTS ix_inbox_pending ON desktop_inbox (device_id, available_at) WHERE status = 'QUEUED';

CREATE TABLE IF NOT EXISTS desktop_conflicts (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id  uuid NOT NULL REFERENCES desktop_devices(id) ON DELETE CASCADE,
  remote_id  text NOT NULL,
  local_id   text,
  reason     text NOT NULL,
  resolution text NOT NULL DEFAULT '',
  resolved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_conflicts_open ON desktop_conflicts (device_id, resolved_at);
