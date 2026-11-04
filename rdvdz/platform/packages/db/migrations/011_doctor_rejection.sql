-- 011_doctor_rejection.sql — trace explicite du refus d'un dossier médecin.
--
-- Jusqu'ici un refus remettait `verified_at` à NULL : le dossier retombait dans
-- la file « en attente » sans distinguer un premier dépôt d'un refus motivé.
-- On conserve donc la date et le motif du refus, sans jamais supprimer la
-- trace (exigence d'auditabilité, loi 18-07).

ALTER TABLE doctors ADD COLUMN IF NOT EXISTS rejected_at timestamptz;
ALTER TABLE doctors ADD COLUMN IF NOT EXISTS rejection_reason text NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS ix_doctors_pending ON doctors (created_at)
  WHERE verified_at IS NULL AND rejected_at IS NULL;
