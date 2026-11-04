-- 009_notifications_reviews.sql — notifications, préférences, modèles, jobs,
-- messages WhatsApp sortants.

CREATE TABLE IF NOT EXISTS notification_templates (
  code                  text NOT NULL,
  channel               text NOT NULL CHECK (channel IN ('IN_APP','EMAIL','WHATSAPP','SMS')),
  locale                text NOT NULL CHECK (locale IN ('ar','fr')),
  subject               text NOT NULL DEFAULT '',
  body                  text NOT NULL,
  whatsapp_template_name text,
  active                boolean NOT NULL DEFAULT true,
  PRIMARY KEY (code, channel, locale)
);

CREATE TABLE IF NOT EXISTS notifications (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid REFERENCES users(id) ON DELETE CASCADE,
  patient_id    uuid REFERENCES patients(id) ON DELETE CASCADE,
  channel       text NOT NULL CHECK (channel IN ('IN_APP','EMAIL','WHATSAPP','SMS')),
  template_code text NOT NULL,
  locale        text NOT NULL DEFAULT 'fr',
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  body          text NOT NULL DEFAULT '',
  status        text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','SENT','FAILED','READ')),
  dedupe_key    text,
  read_at       timestamptz,
  sent_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_notifications_dedupe ON notifications (dedupe_key)
  WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_notifications_user ON notifications (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_notifications_pending ON notifications (status) WHERE status = 'QUEUED';

CREATE TABLE IF NOT EXISTS notification_preferences (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_code text NOT NULL,
  channel    text NOT NULL CHECK (channel IN ('IN_APP','EMAIL','WHATSAPP','SMS')),
  enabled    boolean NOT NULL DEFAULT true,
  PRIMARY KEY (user_id, event_code, channel)
);

CREATE TABLE IF NOT EXISTS wa_messages (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  to_phone            text NOT NULL,
  template_name       text,
  locale              text NOT NULL DEFAULT 'fr',
  body                text NOT NULL DEFAULT '',
  mode                text NOT NULL CHECK (mode IN ('OFFICIAL_API','CLICK_TO_CHAT')),
  status              text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','SENT','FAILED','CLICK_READY')),
  provider_message_id text,
  error               text NOT NULL DEFAULT '',
  created_at          timestamptz NOT NULL DEFAULT now(),
  sent_at             timestamptz
);
CREATE INDEX IF NOT EXISTS ix_wa_status ON wa_messages (status, created_at DESC);

CREATE TABLE IF NOT EXISTS jobs (
  id           bigserial PRIMARY KEY,
  kind         text NOT NULL,
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  run_at       timestamptz NOT NULL DEFAULT now(),
  attempts     integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  status       text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','RUNNING','DONE','FAILED')),
  locked_at    timestamptz,
  last_error   text NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_jobs_due ON jobs (run_at) WHERE status = 'PENDING';
