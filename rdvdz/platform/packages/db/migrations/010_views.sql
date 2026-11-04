-- 010_views.sql — vues de reporting. Aucune donnée dupliquée, aucun cache :
-- les chiffres sont toujours recalculés à partir des tables de vérité.
-- Règle comptable : seuls les paiements PAID **et** livemode entrent dans le CA.

CREATE OR REPLACE VIEW v_revenue_daily AS
SELECT
  date_trunc('day', p.paid_at)::date AS day,
  count(*) FILTER (WHERE p.status = 'PAID' AND p.livemode) AS paid_count,
  coalesce(sum(p.amount) FILTER (WHERE p.status = 'PAID' AND p.livemode), 0) AS gross_paid,
  coalesce(sum(p.amount) FILTER (WHERE p.status = 'PAID' AND NOT p.livemode), 0) AS simulated_amount,
  coalesce(sum(c.amount) FILTER (WHERE c.beneficiary_type = 'PLATFORM' AND c.status = 'ACCRUED'), 0) AS platform_share,
  coalesce(sum(c.amount) FILTER (WHERE c.beneficiary_type = 'BRANCH' AND c.status = 'ACCRUED'), 0) AS branch_share,
  coalesce(sum(c.amount) FILTER (WHERE c.beneficiary_type = 'OPERATOR' AND c.status = 'ACCRUED'), 0) AS operator_share,
  coalesce(sum(c.amount) FILTER (WHERE c.beneficiary_type = 'DOCTOR' AND c.status = 'ACCRUED'), 0) AS doctor_share
FROM payments p
LEFT JOIN commissions c ON c.payment_id = p.id
WHERE p.paid_at IS NOT NULL
GROUP BY 1
ORDER BY 1 DESC;

CREATE OR REPLACE VIEW v_doctor_earnings AS
SELECT
  d.id AS doctor_id,
  u.full_name AS doctor_name,
  date_trunc('month', now())::date AS month,
  coalesce(sum(c.amount) FILTER (WHERE c.beneficiary_type = 'DOCTOR' AND c.status = 'ACCRUED'), 0) AS doctor_share,
  coalesce(sum(c.amount) FILTER (WHERE c.beneficiary_type = 'PLATFORM' AND c.status = 'ACCRUED'), 0) AS platform_share
FROM doctors d
JOIN users u ON u.id = d.user_id
LEFT JOIN commissions c ON c.beneficiary_id = d.id
GROUP BY d.id, u.full_name;

CREATE OR REPLACE VIEW v_branch_performance AS
SELECT
  b.id AS branch_id,
  b.code,
  b.name,
  date_trunc('month', now())::date AS month,
  count(a.id) AS bookings,
  count(a.id) FILTER (WHERE a.status = 'CONFIRMED') AS confirmed,
  count(a.id) FILTER (WHERE a.status = 'CANCELLED') AS cancelled,
  count(a.id) FILTER (WHERE a.status = 'COMPLETED') AS completed,
  coalesce(sum(c.amount) FILTER (WHERE c.beneficiary_type = 'BRANCH' AND c.status = 'ACCRUED'), 0) AS branch_share,
  coalesce(sum(c.amount) FILTER (WHERE c.beneficiary_type = 'OPERATOR' AND c.status = 'ACCRUED'), 0) AS operator_share
FROM branches b
LEFT JOIN appointments a ON a.branch_id = b.id
LEFT JOIN commissions c ON c.source_id = a.id AND c.source_type = 'APPOINTMENT'
GROUP BY b.id, b.code, b.name;

CREATE OR REPLACE VIEW v_conversion AS
SELECT
  date_trunc('day', created_at)::date AS day,
  count(*) FILTER (WHERE status IN ('PENDING','AWAITING_PAYMENT','PAID','CONFIRMED','COMPLETED')) AS created,
  count(*) FILTER (WHERE status IN ('CONFIRMED','COMPLETED')) AS confirmed,
  count(*) FILTER (WHERE status = 'CANCELLED') AS cancelled,
  count(*) FILTER (WHERE status = 'REJECTED') AS rejected,
  count(*) FILTER (WHERE status = 'NO_SHOW') AS no_show
FROM appointments
GROUP BY 1
ORDER BY 1 DESC;
