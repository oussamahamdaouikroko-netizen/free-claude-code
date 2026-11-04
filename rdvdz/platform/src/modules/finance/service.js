/**
 * Moteur de commissions et de revenus.
 *
 * Principe : les taux ne sont JAMAIS dans le code. Ils vivent dans
 * `commission_rules` (historisées par `effective_from`) et sont lus ici.
 *
 * Règle comptable : une commission n'est `ACCRUED` que si le paiement est
 * `PAID` **et** `livemode = true`. Un paiement simulé (sandbox) ne génère
 * aucun revenu : il est comptabilisé séparément et affiché comme simulé.
 */

import { db, many, one } from '../../db.js';
import { Errors } from '../../lib/errors.js';

/**
 * Règle de commission applicable.
 * @param {'BOOKING_FEE'|'TELECONSULT'} scope
 * @param {string|null} branchId
 */
export async function resolveRule(scope, branchId = null) {
  const row = await one(
    `SELECT * FROM commission_rules
      WHERE scope = $1 AND active
        AND (branch_id = $2 OR branch_id IS NULL)
      ORDER BY effective_from DESC, (branch_id IS NOT NULL) DESC
      LIMIT 1`,
    [scope, branchId],
  );
  if (row) return row;

  // Repli sur les paramètres publics, puis sur des valeurs conservatrices.
  const fallback = await one(`SELECT value FROM system_settings WHERE key = 'public.default_commission'`);
  const value = fallback?.value ?? {};
  if (scope === 'TELECONSULT') {
    const pct = Number(value.teleconsult?.platform_pct ?? 15);
    return {
      id: null,
      scope,
      platform_pct: pct,
      branch_pct: 0,
      operator_pct: 0,
      psp_fixed: 0,
      doctor_pct: 100 - pct,
    };
  }
  return {
    id: null,
    scope,
    platform_pct: Number(value.booking?.platform_pct ?? 60),
    branch_pct: Number(value.booking?.branch_pct ?? 15),
    operator_pct: Number(value.booking?.operator_pct ?? 15),
    psp_fixed: Number(value.booking?.psp_fixed ?? 0),
    doctor_pct: 0,
  };
}

/** Arrondi sûr en centimes (jamais de flottant conservé en base). */
const cents = (value) => Math.round(Number(value));

/**
 * Répartit un montant encaissé.
 * @param {{ amount: number, scope: 'BOOKING_FEE'|'TELECONSULT', rule: object }} input
 */
export function splitAmount({ amount, scope, rule }) {
  const total = cents(amount);
  if (scope === 'TELECONSULT') {
    const platform = cents((total * Number(rule.platform_pct)) / 100);
    return [
      { beneficiary_type: 'PLATFORM', amount: platform },
      { beneficiary_type: 'DOCTOR', amount: total - platform },
    ];
  }
  const psp = Math.min(cents(rule.psp_fixed || 0), total);
  const distributable = total - psp;
  const branch = cents((distributable * Number(rule.branch_pct || 0)) / 100);
  const operator = cents((distributable * Number(rule.operator_pct || 0)) / 100);
  const platform = distributable - branch - operator;
  const parts = [{ beneficiary_type: 'PLATFORM', amount: platform }];
  if (branch > 0) parts.push({ beneficiary_type: 'BRANCH', amount: branch });
  if (operator > 0) parts.push({ beneficiary_type: 'OPERATOR', amount: operator });
  if (psp > 0) parts.push({ beneficiary_type: 'PSP', amount: psp });
  const sum = parts.reduce((acc, p) => acc + p.amount, 0);
  if (sum !== total) throw new Error(`COMMISSION_SPLIT_MISMATCH ${sum} != ${total}`);
  return parts;
}

/**
 * Enregistre les commissions d'un paiement vérifié.
 * Idempotent : si des écritures existent déjà pour ce paiement, rien n'est
 * dupliqué.
 *
 * @param {object} input
 * @param {string} input.paymentId
 * @param {'APPOINTMENT'|'CONSULTATION'} input.sourceType
 * @param {string} input.sourceId
 * @param {'BOOKING_FEE'|'TELECONSULT'} input.scope
 * @param {number} input.amount
 * @param {boolean} input.livemode
 * @param {string|null} [input.branchId]
 * @param {string|null} [input.branchBeneficiaryId]
 * @param {string|null} [input.operatorBeneficiaryId]
 * @param {string|null} [input.doctorBeneficiaryId]
 */
export async function accrueForPayment(input) {
  const existing = await many('SELECT id FROM commissions WHERE payment_id = $1', [input.paymentId]);
  if (existing.length) return { created: 0, skipped: existing.length, simulated: !input.livemode };

  if (!input.livemode) {
    // Paiement simulé : aucun revenu réel n'est comptabilisé.
    return { created: 0, skipped: 0, simulated: true };
  }

  const rule = await resolveRule(input.scope, input.branchId ?? null);
  const parts = splitAmount({ amount: input.amount, scope: input.scope, rule });

  const beneficiaryMap = {
    BRANCH: input.branchBeneficiaryId ?? null,
    OPERATOR: input.operatorBeneficiaryId ?? null,
    DOCTOR: input.doctorBeneficiaryId ?? null,
    PLATFORM: null,
    PSP: null,
  };

  await db().tx(async (client) => {
    for (const part of parts) {
      await client.query(
        `INSERT INTO commissions
           (source_type, source_id, payment_id, rule_id, beneficiary_type, beneficiary_id, amount, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'ACCRUED')`,
        [
          input.sourceType,
          input.sourceId,
          input.paymentId,
          rule.id,
          part.beneficiary_type,
          beneficiaryMap[part.beneficiary_type] ?? null,
          part.amount,
        ],
      );
    }
  });

  return { created: parts.length, skipped: 0, simulated: false, rule_id: rule.id };
}

/** Annule les commissions d'un paiement remboursé (écritures compensatoires). */
export async function reverseForPayment(paymentId, reason = 'refund') {
  const rows = await many(
    `SELECT * FROM commissions WHERE payment_id = $1 AND status = 'ACCRUED'`,
    [paymentId],
  );
  if (!rows.length) return { reversed: 0 };
  await db().tx(async (client) => {
    for (const row of rows) {
      await client.query(`UPDATE commissions SET status = 'REVERSED' WHERE id = $1`, [row.id]);
      await client.query(
        `INSERT INTO commissions
           (source_type, source_id, payment_id, rule_id, beneficiary_type, beneficiary_id, amount, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'REVERSED')`,
        [
          row.source_type,
          row.source_id,
          row.payment_id,
          row.rule_id,
          row.beneficiary_type,
          row.beneficiary_id,
          -row.amount,
        ],
      );
    }
  });
  return { reversed: rows.length, reason };
}

/** Totaux de revenus sur une période (jamais les paiements en attente). */
export async function revenueSummary({ from, to }) {
  const rows = await many(
    `SELECT c.beneficiary_type,
            sum(c.amount)::int AS amount
       FROM commissions c
      WHERE c.status = 'ACCRUED'
        AND c.created_at >= $1 AND c.created_at < $2
      GROUP BY c.beneficiary_type`,
    [new Date(from), new Date(to)],
  );
  const totals = { PLATFORM: 0, BRANCH: 0, OPERATOR: 0, DOCTOR: 0, PSP: 0 };
  for (const row of rows) totals[row.beneficiary_type] = row.amount;

  const paid = await one(
    `SELECT count(*)::int AS count, coalesce(sum(amount),0)::int AS amount
       FROM payments
      WHERE status = 'PAID' AND livemode AND paid_at >= $1 AND paid_at < $2`,
    [new Date(from), new Date(to)],
  );
  const simulated = await one(
    `SELECT count(*)::int AS count, coalesce(sum(amount),0)::int AS amount
       FROM payments
      WHERE status = 'PAID' AND NOT livemode AND paid_at >= $1 AND paid_at < $2`,
    [new Date(from), new Date(to)],
  );
  const pending = await one(
    `SELECT count(*)::int AS count, coalesce(sum(amount),0)::int AS amount
       FROM payments
      WHERE status IN ('CREATED','PENDING') AND created_at >= $1 AND created_at < $2`,
    [new Date(from), new Date(to)],
  );
  const refunded = await one(
    `SELECT count(*)::int AS count, coalesce(sum(amount),0)::int AS amount
       FROM refunds
      WHERE status = 'PROCESSED' AND created_at >= $1 AND created_at < $2`,
    [new Date(from), new Date(to)],
  );

  return {
    period: { from, to },
    confirmed_revenue: paid.amount,
    confirmed_count: paid.count,
    simulated_revenue: simulated.amount,
    simulated_count: simulated.count,
    pending_amount: pending.amount,
    pending_count: pending.count,
    refunded_amount: refunded.amount,
    refunded_count: refunded.count,
    shares: totals,
  };
}

/**
 * Calcule un bordereau de reversement pour un bénéficiaire (médecin, branche,
 * opérateur) sur une période. Aucun virement automatique : le versement réel
 * est constaté puis marqué `PAID`.
 */
export async function buildSettlement({
  beneficiaryType,
  beneficiaryId,
  periodStart,
  periodEnd,
  createdBy = null,
}) {
  if (!['BRANCH', 'OPERATOR', 'DOCTOR'].includes(beneficiaryType)) {
    throw Errors.validation({ beneficiary_type: 'invalid' });
  }
  const accrued = await one(
    `SELECT coalesce(sum(amount),0)::int AS gross, count(*)::int AS entries
       FROM commissions
      WHERE beneficiary_type = $1 AND beneficiary_id = $2 AND status = 'ACCRUED'
        AND created_at >= $3 AND created_at < $4`,
    [beneficiaryType, beneficiaryId, new Date(periodStart), new Date(periodEnd)],
  );
  if (!accrued || accrued.entries === 0) {
    throw Errors.conflict('NOTHING_TO_SETTLE', 'Aucune commission à reverser sur la période');
  }
  const psp = await one(
    `SELECT coalesce(sum(amount),0)::int AS fees
       FROM commissions
      WHERE beneficiary_type = 'PSP' AND status = 'ACCRUED'
        AND created_at >= $1 AND created_at < $2`,
    [new Date(periodStart), new Date(periodEnd)],
  );
  const net = accrued.gross;
  const row = await one(
    `INSERT INTO settlements
       (beneficiary_type, beneficiary_id, period_start, period_end, gross, fees, net, status, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'DRAFT',$8)
     RETURNING *`,
    [beneficiaryType, beneficiaryId, periodStart, periodEnd, accrued.gross, psp?.fees ?? 0, net, createdBy],
  );
  return row;
}

/** Marque un bordereau comme payé (virement effectué hors plateforme). */
export async function markSettlementPaid(settlementId, { reference, actor = null }) {
  const row = await one(
    `UPDATE settlements
        SET status = 'PAID', paid_at = now(), reference = $2
      WHERE id = $1 AND status IN ('DRAFT','APPROVED')
      RETURNING *`,
    [settlementId, reference ?? null],
  );
  if (!row) throw Errors.conflict('SETTLEMENT_NOT_PAYABLE', 'Bordereau introuvable ou déjà payé');
  await db().query(
    `UPDATE commissions SET status = 'SETTLED', settlement_id = $1
      WHERE beneficiary_type = $2 AND beneficiary_id = $3 AND status = 'ACCRUED'
        AND created_at >= $4 AND created_at < $5`,
    [settlementId, row.beneficiary_type, row.beneficiary_id, row.period_start, row.period_end],
  );
  void actor;
  return row;
}
