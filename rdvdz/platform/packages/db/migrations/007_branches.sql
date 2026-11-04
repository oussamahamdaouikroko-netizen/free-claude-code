-- 007_branches.sql — branches, managers, opérateurs, affectations médecins

CREATE TABLE IF NOT EXISTS branches (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code            text NOT NULL,
  name            text NOT NULL,
  wilaya_code     integer NOT NULL REFERENCES wilayas(code),
  manager_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  commission_pct  numeric(5,2) NOT NULL DEFAULT 15 CHECK (commission_pct BETWEEN 0 AND 100),
  phone           text,
  status          text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED')),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_branches_code ON branches (code);
CREATE INDEX IF NOT EXISTS ix_branches_wilaya ON branches (wilaya_code);

CREATE TABLE IF NOT EXISTS branch_operators (
  branch_id  uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (branch_id, user_id)
);

CREATE TABLE IF NOT EXISTS doctor_branches (
  doctor_id      uuid NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
  branch_id      uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  commission_pct numeric(5,2) NOT NULL DEFAULT 15 CHECK (commission_pct BETWEEN 0 AND 100),
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (doctor_id, branch_id)
);

ALTER TABLE appointments
  ADD CONSTRAINT fk_appointments_branch
  FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE SET NULL;

ALTER TABLE user_scopes
  ADD CONSTRAINT fk_scopes_branch
  FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE CASCADE;
