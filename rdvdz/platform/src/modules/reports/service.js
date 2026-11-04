/**
 * Rapports et exports.
 *
 * Règle : les chiffres sont recalculés à la demande depuis les tables de
 * vérité. Aucun total n'est stocké, donc aucun total ne peut devenir faux.
 * Les paiements en attente et les paiements simulés sont toujours présentés
 * séparément du chiffre d'affaires réel.
 */

import { many, one } from '../../db.js';
import { Errors } from '../../lib/errors.js';
import { revenueSummary } from '../finance/service.js';

/** Bornes de période à partir de `from`/`to` (ISO), défaut : mois courant. */
export function resolvePeriod(from, to) {
  const start = from ? new Date(from) : new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  const end = to ? new Date(to) : new Date(start.getTime() + 31 * 86400000);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw Errors.validation({ period: 'dates invalides' });
  }
  if (end <= start) throw Errors.validation({ period: 'la fin doit suivre le début' });
  return { from: start.toISOString(), to: end.toISOString() };
}

/** Vue d'ensemble de la plateforme (administration). */
export async function platformOverview({ from, to }) {
  const patients = await one(`SELECT count(*)::int AS n FROM patients`);
  const doctors = await one(
    `SELECT count(*)::int AS n, count(*) FILTER (WHERE verified_at IS NOT NULL)::int AS verified FROM doctors`,
  );
  const clinics = await one(`SELECT count(*)::int AS n FROM clinics WHERE status = 'ACTIVE'`);
  const bookings = await one(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE a.status = 'CONFIRMED')::int AS confirmed,
            count(*) FILTER (WHERE a.status = 'COMPLETED')::int AS completed,
            count(*) FILTER (WHERE a.status = 'CANCELLED')::int AS cancelled,
            count(*) FILTER (WHERE a.status = 'NO_SHOW')::int AS no_show,
            count(*) FILTER (WHERE a.status IN ('PENDING','AWAITING_PAYMENT'))::int AS pending
       FROM appointments a
      WHERE a.created_at >= $1 AND a.created_at < $2`,
    [from, to],
  );
  const consultations = await one(
    `SELECT count(*)::int AS n, count(*) FILTER (WHERE status IN ('ANSWERED','CLOSED'))::int AS answered
       FROM consultations WHERE created_at >= $1 AND created_at < $2`,
    [from, to],
  );
  const revenue = await revenueSummary({ from, to });
  const created = Number(bookings.total) || 0;
  const confirmed = Number(bookings.confirmed) + Number(bookings.completed);

  return {
    period: { from, to },
    patients: patients.n,
    doctors: { total: doctors.n, verified: doctors.verified },
    clinics: clinics.n,
    bookings,
    consultations,
    conversion: { created, confirmed, rate: created ? Math.round((confirmed / created) * 1000) / 10 : 0 },
    revenue,
  };
}

/** Activité par médecin (agenda, présence, consultations, gains). */
export async function doctorReport({ from, to, doctorId = null }) {
  const params = [from, to];
  let filter = '';
  if (doctorId) {
    params.push(doctorId);
    filter = ` AND a.doctor_id = $${params.length}`;
  }
  const rows = await many(
    `SELECT d.id AS doctor_id, u.full_name AS doctor_name,
            count(a.id)::int AS bookings,
            count(a.id) FILTER (WHERE a.status = 'CONFIRMED')::int AS confirmed,
            count(a.id) FILTER (WHERE a.status = 'COMPLETED')::int AS completed,
            count(a.id) FILTER (WHERE a.status = 'NO_SHOW')::int AS no_show,
            count(a.id) FILTER (WHERE a.status = 'CANCELLED')::int AS cancelled,
            coalesce(sum(c.amount) FILTER (WHERE c.beneficiary_type = 'DOCTOR' AND c.status = 'ACCRUED'), 0)::int AS earnings
       FROM doctors d
       JOIN users u ON u.id = d.user_id
       LEFT JOIN appointments a ON a.doctor_id = d.id AND a.created_at >= $1 AND a.created_at < $2
       LEFT JOIN commissions c ON c.source_id = a.id AND c.source_type = 'APPOINTMENT'
      WHERE true ${filter}
      GROUP BY d.id, u.full_name
      ORDER BY bookings DESC`,
    params,
  );
  const consultations = await many(
    `SELECT c.doctor_id, count(*)::int AS consultations
       FROM consultations c
      WHERE c.created_at >= $1 AND c.created_at < $2 ${doctorId ? 'AND c.doctor_id = $3' : ''}
      GROUP BY c.doctor_id`,
    doctorId ? [from, to, doctorId] : [from, to],
  );
  const map = new Map(consultations.map((r) => [r.doctor_id, r.consultations]));
  return rows.map((row) => ({
    ...row,
    consultations: map.get(row.doctor_id) ?? 0,
    attendance_rate:
      row.completed + row.no_show > 0
        ? Math.round((row.completed / (row.completed + row.no_show)) * 1000) / 10
        : null,
  }));
}

/** Activité par branche et productivité des opérateurs. */
export async function branchReport({ from, to }) {
  const branches = await many(
    `SELECT b.id, b.code, b.name, b.wilaya_code,
            count(a.id)::int AS bookings,
            count(a.id) FILTER (WHERE a.status = 'CONFIRMED')::int AS confirmed,
            count(a.id) FILTER (WHERE a.status = 'COMPLETED')::int AS completed,
            count(a.id) FILTER (WHERE a.source IN ('OPERATOR','BRANCH'))::int AS operator_bookings,
            coalesce(sum(c.amount) FILTER (WHERE c.beneficiary_type = 'BRANCH' AND c.status = 'ACCRUED'), 0)::int AS branch_share,
            coalesce(sum(c.amount) FILTER (WHERE c.beneficiary_type = 'OPERATOR' AND c.status = 'ACCRUED'), 0)::int AS operator_share
       FROM branches b
       LEFT JOIN appointments a ON a.branch_id = b.id AND a.created_at >= $1 AND a.created_at < $2
       LEFT JOIN commissions c ON c.source_id = a.id AND c.source_type = 'APPOINTMENT'
      GROUP BY b.id, b.code, b.name, b.wilaya_code
      ORDER BY bookings DESC`,
    [from, to],
  );

  const operators = await many(
    `SELECT u.id AS operator_id, u.full_name,
            b.id AS branch_id, b.name AS branch_name,
            count(a.id)::int AS bookings,
            coalesce(sum(c.amount) FILTER (WHERE c.beneficiary_type = 'OPERATOR' AND c.status = 'ACCRUED'), 0)::int AS commission
       FROM users u
       JOIN branch_operators bo ON bo.user_id = u.id
       JOIN branches b ON b.id = bo.branch_id
       LEFT JOIN appointments a ON a.created_by_user_id = u.id AND a.created_at >= $1 AND a.created_at < $2
       LEFT JOIN commissions c ON c.source_id = a.id AND c.source_type = 'APPOINTMENT'
      WHERE u.role IN ('OPERATOR','BRANCH_MANAGER')
      GROUP BY u.id, u.full_name, b.id, b.name
      ORDER BY bookings DESC`,
    [from, to],
  );

  return { branches, operators };
}

/** Remboursements sur la période. */
export async function refundReport({ from, to }) {
  return many(
    `SELECT r.id, r.amount, r.reason, r.status, r.created_at, r.processed_at,
            p.provider, p.amount AS payment_amount, p.livemode
       FROM refunds r JOIN payments p ON p.id = r.payment_id
      WHERE r.created_at >= $1 AND r.created_at < $2
      ORDER BY r.created_at DESC`,
    [from, to],
  );
}

/** Sérialisation CSV (compatible Excel : BOM UTF-8 + séparateur `;`). */
export function toCsv(rows, { columns = null, separator = ';' } = {}) {
  if (!rows || rows.length === 0) return '\uFEFF';
  const keys = columns ?? Object.keys(rows[0]);
  const escape = (value) => {
    if (value === null || value === undefined) return '';
    const text = value instanceof Date ? value.toISOString() : String(value);
    if (/[";\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
    return text;
  };
  const lines = [keys.join(separator)];
  for (const row of rows) lines.push(keys.map((key) => escape(row[key])).join(separator));
  return `\uFEFF${lines.join('\r\n')}`;
}

/** Détail des revenus par nature, une ligne par catégorie. */
async function revenueExport(from, to) {
  const summary = await revenueSummary({ from, to });
  return [
    { indicateur: 'CA réel vérifié (centimes)', valeur: summary.confirmed_revenue },
    { indicateur: 'Encaissements réels', valeur: summary.confirmed_count },
    { indicateur: 'Encaissements simulés (centimes)', valeur: summary.simulated_revenue },
    { indicateur: 'Encaissements simulés', valeur: summary.simulated_count },
    { indicateur: 'En attente (centimes)', valeur: summary.pending_amount },
    { indicateur: 'Remboursé (centimes)', valeur: summary.refunded_amount },
    { indicateur: 'Part plateforme (centimes)', valeur: summary.shares.PLATFORM },
    { indicateur: 'Part branches (centimes)', valeur: summary.shares.BRANCH },
    { indicateur: 'Part opérateurs (centimes)', valeur: summary.shares.OPERATOR },
    { indicateur: 'Part médecins (centimes)', valeur: summary.shares.DOCTOR },
    { indicateur: 'Frais PSP (centimes)', valeur: summary.shares.PSP },
  ];
}

/** Tableau récapitulatif prêt pour un export PDF/impression côté client. */
export async function exportBundle({ from, to, kind }) {
  if (kind === 'doctors') return doctorReport({ from, to });
  if (kind === 'branches') return branchReport({ from, to });
  if (kind === 'refunds') return refundReport({ from, to });
  if (kind === 'revenue') return revenueExport(from, to);
  if (kind === 'overview') {
    const overview = await platformOverview({ from, to });
    return [
      { indicateur: 'Patients', valeur: overview.patients },
      { indicateur: 'Médecins vérifiés', valeur: `${overview.doctors.verified}/${overview.doctors.total}` },
      { indicateur: 'Cliniques actives', valeur: overview.clinics },
      { indicateur: 'Rendez-vous (période)', valeur: overview.bookings.total },
      { indicateur: 'Confirmés', valeur: overview.bookings.confirmed },
      { indicateur: 'Taux de confirmation (%)', valeur: overview.conversion.rate },
      { indicateur: 'Consultations', valeur: overview.consultations.n },
      { indicateur: 'CA réel vérifié (centimes)', valeur: overview.revenue.confirmed_revenue },
      { indicateur: 'Encaissements simulés (centimes)', valeur: overview.revenue.simulated_revenue },
      { indicateur: 'En attente (centimes)', valeur: overview.revenue.pending_amount },
      { indicateur: 'Remboursé (centimes)', valeur: overview.revenue.refunded_amount },
    ];
  }
  throw Errors.validation({ kind: `export inconnu: ${kind} (overview, revenue, doctors, branches, refunds)` });
}
