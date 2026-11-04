-- 002_identity.sql — utilisateurs, sessions, OTP, périmètres, audit

CREATE TABLE IF NOT EXISTS users (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role              text NOT NULL CHECK (role IN ('SUPER_ADMIN','ADMIN','FINANCE_MANAGER','BRANCH_MANAGER','OPERATOR','DOCTOR','PATIENT')),
  full_name         text NOT NULL,
  phone             text,
  email             text,
  password_hash     text,
  password_salt     text,
  status            text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('ACTIVE','SUSPENDED','PENDING','DELETED')),
  locale            text NOT NULL DEFAULT 'fr' CHECK (locale IN ('ar','fr')),
  phone_verified_at timestamptz,
  mfa_secret        text,
  failed_logins     integer NOT NULL DEFAULT 0,
  locked_until      timestamptz,
  last_login_at     timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_users_phone ON users (phone) WHERE phone IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_email ON users (lower(email)) WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_users_role_status ON users (role, status);

CREATE TABLE IF NOT EXISTS sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   text NOT NULL,
  csrf_token   text NOT NULL,
  ip           text,
  user_agent   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_sessions_token ON sessions (token_hash);
CREATE INDEX IF NOT EXISTS ix_sessions_user ON sessions (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS otp_codes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone       text NOT NULL,
  purpose     text NOT NULL CHECK (purpose IN ('LOGIN','VERIFY','RESET')),
  code_hash   text NOT NULL,
  attempts    integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz
);
CREATE INDEX IF NOT EXISTS ix_otp_phone ON otp_codes (phone, purpose, created_at DESC);

-- Périmètre : une ligne par (utilisateur, branche|wilaya). SUPER_ADMIN n'en a pas besoin.
CREATE TABLE IF NOT EXISTS user_scopes (
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  branch_id   uuid,
  wilaya_code integer REFERENCES wilayas(code),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, branch_id, wilaya_code)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id            bigserial PRIMARY KEY,
  actor_user_id uuid,
  actor_role    text,
  action        text NOT NULL,
  entity        text,
  entity_id     text,
  ip            text,
  user_agent    text,
  details       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_audit_entity ON audit_logs (entity, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_audit_actor ON audit_logs (actor_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_audit_action ON audit_logs (action, created_at DESC);

CREATE TABLE IF NOT EXISTS consent_records (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('TERMS','PRIVACY','TELECONSULT','MARKETING')),
  version    text NOT NULL,
  granted    boolean NOT NULL,
  ip         text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_consent_user ON consent_records (user_id, kind);
