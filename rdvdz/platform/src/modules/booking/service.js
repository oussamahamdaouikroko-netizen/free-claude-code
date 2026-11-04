/**
 * Moteur de réservation — le cœur du produit.
 *
 * Règles non négociables, toutes couvertes par des tests :
 *  1. un créneau ne peut porter qu'un seul rendez-vous ;
 *  2. le créneau est verrouillé pendant le paiement (`HELD`, TTL 10 min) puis
 *     libéré automatiquement s'il n'est pas payé ;
 *  3. `CONFIRMED` n'est atteignable qu'après un paiement **vérifié serveur**
 *     lorsque des frais de service sont dus ;
 *  4. chaque changement de statut est tracé (jamais d'écrasement) ;
 *  5. un rendez-vous payé et annulé devient `CANCELLED` + remboursement tracé,
 *     jamais « disparu ».
 *
 * Concurrence : la sélection du créneau utilise `FOR UPDATE` dans la même
 * transaction que l'insertion, et `UNIQUE (slot_id)` sur `appointments` sert de
 * dernier rempart physique.
 */

import { db, many, one, nextReference } from '../../db.js';
import { Errors } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { config } from '../../config.js';

export const STATUSES = [
  'PENDING',
  'AWAITING_PAYMENT',
  'PAID',
  'CONFIRMED',
  'CANCELLED',
  'REJECTED',
  'COMPLETED',
  'NO_SHOW',
  'REFUNDED',
];

/** Transitions autorisées. Toute autre est refusée par `changeStatus`. */
export const TRANSITIONS = {
  PENDING: ['CONFIRMED', 'REJECTED', 'CANCELLED', 'AWAITING_PAYMENT'],
  AWAITING_PAYMENT: ['PAID', 'CANCELLED', 'REJECTED'],
  PAID: ['CONFIRMED', 'REFUNDED', 'CANCELLED'],
  CONFIRMED: ['COMPLETED', 'NO_SHOW', 'CANCELLED'],
  CANCELLED: ['REFUNDED'],
  REJECTED: ['REFUNDED'],
  COMPLETED: ['REFUNDED'],
  NO_SHOW: [],
  REFUNDED: [],
};

/** Statuts qui occupent encore le créneau. */
const OCCUPYING = new Set(['PENDING', 'AWAITING_PAYMENT', 'PAID', 'CONFIRMED', 'COMPLETED']);

/** Paramètres publics (frais, TTL du verrou) lus en base, jamais en dur. */
export async function bookingConfig() {
  const row = await one(`SELECT value FROM system_settings WHERE key = 'public.booking'`);
  const value = row?.value ?? {};
  return {
    holdTtlMinutes: Number(value.hold_ttl_minutes ?? config.booking.holdTtlMinutes),
    cancellationNoticeHours: Number(value.cancellation_notice_hours ?? 24),
    refundPctBeforeNotice: Number(value.refund_pct_before_notice ?? 100),
    refundPctLate: Number(value.refund_pct_late ?? 0),
  };
}

export async function serviceFee() {
  const row = await one(`SELECT value FROM system_settings WHERE key = 'public.service_fee'`);
  return Number(row?.value?.amount ?? 0);
}

/** Écrit une transition et l'historique associé. */
export async function recordStatus(appointmentId, from, to, { actor, reason = '', client } = {}) {
  const executor = client ?? db();
  await executor.query(
    `UPDATE appointments
        SET status = $1, updated_at = now(),
            confirmed_at = CASE WHEN $1 = 'CONFIRMED' THEN coalesce(confirmed_at, now()) ELSE confirmed_at END,
            completed_at = CASE WHEN $1 = 'COMPLETED' THEN coalesce(completed_at, now()) ELSE completed_at END
      WHERE id = $2`,
    [to, appointmentId],
  );
  await executor.query(
    `INSERT INTO appointment_status_history (appointment_id, from_status, to_status, actor_user_id, actor_role, reason)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [appointmentId, from, to, actor?.id ?? null, actor?.role ?? null, reason.slice(0, 500)],
  );
  await audit({
    actor,
    action: `appointment.status.${to.toLowerCase()}`,
    entity: 'appointment',
    entityId: appointmentId,
    details: { from, to, reason },
  });
}

/** Transition contrôlée (vérifie la table TRANSITIONS). */
export async function changeStatus(appointmentId, to, options = {}) {
  if (!STATUSES.includes(to)) throw Errors.validation({ status: `unknown status ${to}` });
  const current = await one('SELECT id, status FROM appointments WHERE id = $1', [appointmentId]);
  if (!current) throw Errors.notFound('Appointment');
  if (current.status === to) return current;
  const allowed = TRANSITIONS[current.status] || [];
  if (!allowed.includes(to)) {
    throw Errors.conflict('INVALID_TRANSITION', `Transition ${current.status} → ${to} interdite`, {
      from: current.status,
      to,
      allowed,
    });
  }
  await recordStatus(appointmentId, current.status, to, options);
  return one('SELECT * FROM appointments WHERE id = $1', [appointmentId]);
}

/** Détail complet d'un rendez-vous (médecin, clinique, créneau). */
export async function getAppointment(id) {
  return one(
    `SELECT a.*, s.starts_at, s.ends_at, s.mode AS slot_mode,
            p.full_name AS patient_name, p.phone AS patient_phone,
            u.full_name AS doctor_name, d.primary_specialty_code,
            c.name_fr AS clinic_name_fr, c.name_ar AS clinic_name_ar, c.address, c.commune,
            w.name_fr AS wilaya_fr, w.name_ar AS wilaya_ar
       FROM appointments a
       JOIN doctor_slots s ON s.id = a.slot_id
       JOIN patients p ON p.id = a.patient_id
       JOIN doctors d ON d.id = a.doctor_id
       JOIN users u ON u.id = d.user_id
       LEFT JOIN clinics c ON c.id = a.clinic_id
       LEFT JOIN wilayas w ON w.code = c.wilaya_code
      WHERE a.id = $1`,
    [id],
  );
}

/**
 * Crée une réservation.
 *
 * @param {object} input
 * @param {string} input.slotId
 * @param {string} input.patientId
 * @param {'PATIENT_WEBSITE'|'OPERATOR'|'BRANCH'|'WHATSAPP'|'OTHER'} [input.source]
 * @param {string} [input.notes]
 * @param {string} [input.branchId]
 * @param {string} [input.idempotencyKey]
 * @param {{id?: string, role?: string}} [input.actor]
 * @param {boolean} [input.skipPayment]  usage opérateur : encaissement constaté
 * @returns {Promise<{appointment: object, holdExpiresAt: string|null, paymentRequired: boolean}>}
 */
export async function createBooking(input) {
  const {
    slotId,
    patientId,
    source = 'PATIENT_WEBSITE',
    notes = '',
    branchId = null,
    idempotencyKey = null,
    actor = null,
    skipPayment = false,
  } = input;

  if (!slotId) throw Errors.validation({ slot_id: 'required' });
  if (!patientId) throw Errors.validation({ patient_id: 'required' });
  if (!['PATIENT_WEBSITE', 'OPERATOR', 'BRANCH', 'WHATSAPP', 'OTHER'].includes(source)) {
    throw Errors.validation({ source: 'invalid' });
  }

  // Rejeu idempotent : la même clé renvoie la même réservation.
  if (idempotencyKey) {
    const existing = await one(
      `SELECT a.*, s.starts_at, s.ends_at FROM appointments a
         JOIN doctor_slots s ON s.id = a.slot_id
        WHERE a.idempotency_key = $1`,
      [idempotencyKey],
    );
    if (existing) {
      return {
        appointment: existing,
        holdExpiresAt: existing.hold_expires_at ?? null,
        paymentRequired: existing.status === 'AWAITING_PAYMENT',
        replayed: true,
      };
    }
  }

  const cfg = await bookingConfig();
  const fee = await serviceFee();

  const result = await db().tx(async (client) => {
    // 1. Verrouiller le créneau.
    const slotResult = await client.query('SELECT * FROM doctor_slots WHERE id = $1 FOR UPDATE', [slotId]);
    const slot = slotResult.rows[0];
    if (!slot) throw Errors.notFound('Slot');

    const now = Date.now();
    const holdAlive = slot.status === 'HELD' && slot.hold_expires_at && new Date(slot.hold_expires_at).getTime() > now;
    if (slot.status === 'BOOKED' || slot.status === 'BLOCKED' || holdAlive) {
      throw Errors.conflict('SLOT_TAKEN', 'Ce créneau vient d\'être réservé', { slot_id: slotId });
    }

    const patient = (await client.query('SELECT * FROM patients WHERE id = $1', [patientId])).rows[0];
    if (!patient) throw Errors.notFound('Patient');

    const doctor = (
      await client.query('SELECT * FROM doctors WHERE id = $1', [slot.doctor_id])
    ).rows[0];
    if (!doctor) throw Errors.notFound('Doctor');

    // Un patient ne peut pas avoir deux rendez-vous actifs sur le même créneau.
    const clash = (
      await client.query(
        `SELECT a.id FROM appointments a
          WHERE a.slot_id = $1 AND a.status = ANY($2::text[])`,
        [slotId, [...OCCUPYING]],
      )
    ).rows[0];
    if (clash) throw Errors.conflict('SLOT_TAKEN', 'Créneau déjà réservé', { appointment_id: clash.id });

    const requiresPayment = !skipPayment && fee > 0;
    const initialStatus = requiresPayment
      ? 'AWAITING_PAYMENT'
      : doctor.manual_confirmation
        ? 'PENDING'
        : 'CONFIRMED';

    const reference = await nextReference('RDV', 'appointments');
    const holdExpiresAt = requiresPayment ? new Date(now + cfg.holdTtlMinutes * 60_000) : null;

    const inserted = (
      await client.query(
        `INSERT INTO appointments
           (reference, slot_id, patient_id, doctor_id, clinic_id, branch_id, created_by_user_id,
            source, status, mode, price, service_fee, notes, idempotency_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         RETURNING *`,
        [
          reference,
          slotId,
          patientId,
          slot.doctor_id,
          doctor.clinic_id,
          branchId,
          actor?.id ?? null,
          source,
          initialStatus,
          slot.mode === 'VIDEO' ? 'VIDEO' : slot.mode === 'PHONE' ? 'PHONE' : 'IN_CLINIC',
          doctor.consultation_fee,
          fee,
          notes.slice(0, 1000),
          idempotencyKey,
        ],
      )
    ).rows[0];

    // 2. Marquer le créneau (verrou si paiement, réservé sinon).
    await client.query(
      `UPDATE doctor_slots
          SET status = $2, hold_expires_at = $3
        WHERE id = $1`,
      [slotId, requiresPayment ? 'HELD' : 'BOOKED', holdExpiresAt],
    );

    // 3. Tracer l'historique initial.
    await client.query(
      `INSERT INTO appointment_status_history (appointment_id, from_status, to_status, actor_user_id, actor_role, reason)
       VALUES ($1, NULL, $2, $3, $4, $5)`,
      [inserted.id, initialStatus, actor?.id ?? null, actor?.role ?? null, 'created'],
    );

    if (requiresPayment) {
      await client.query(
        `INSERT INTO booking_holds (slot_id, patient_id, appointment_id, expires_at)
         VALUES ($1, $2, $3, $4)`,
        [slotId, patientId, inserted.id, holdExpiresAt],
      );
    }

    return { appointment: inserted, holdExpiresAt, requiresPayment };
  });

  await audit({
    actor,
    action: 'appointment.created',
    entity: 'appointment',
    entityId: result.appointment.id,
    details: { source, status: result.appointment.status, service_fee: fee },
  });

  return {
    appointment: result.appointment,
    holdExpiresAt: result.holdExpiresAt ? result.holdExpiresAt.toISOString() : null,
    paymentRequired: result.requiresPayment,
  };
}

/**
 * Confirme une réservation après paiement vérifié.
 * Refuse si la réservation n'est pas en `PAID` ou `PENDING` avec paiement.
 */
export async function confirmAfterPayment(appointmentId, { actor = null, client = null } = {}) {
  const run = async (executor) => {
    const row = (
      await executor.query('SELECT * FROM appointments WHERE id = $1 FOR UPDATE', [appointmentId])
    ).rows[0];
    if (!row) throw Errors.notFound('Appointment');
    if (row.status === 'CONFIRMED') return row;
    if (row.status !== 'PAID' && row.status !== 'PENDING') {
      throw Errors.conflict('PAYMENT_UNVERIFIED', `Statut ${row.status} : confirmation impossible`);
    }
    await executor.query(
      `UPDATE appointments
          SET status = 'CONFIRMED', confirmed_at = coalesce(confirmed_at, now()), updated_at = now()
        WHERE id = $1`,
      [appointmentId],
    );
    await executor.query(
      `UPDATE doctor_slots SET status = 'BOOKED', hold_expires_at = NULL
        WHERE id = $1`,
      [row.slot_id],
    );
    await executor.query(
      `UPDATE booking_holds SET released_at = now() WHERE appointment_id = $1 AND released_at IS NULL`,
      [appointmentId],
    );
    await executor.query(
      `INSERT INTO appointment_status_history (appointment_id, from_status, to_status, actor_user_id, actor_role, reason)
       VALUES ($1, $2, 'CONFIRMED', $3, $4, 'payment verified')`,
      [appointmentId, row.status, actor?.id ?? null, actor?.role ?? null],
    );
    return { ...row, status: 'CONFIRMED' };
  };

  const updated = client ? await run(client) : await db().tx(run);
  await audit({
    actor,
    action: 'appointment.confirmed',
    entity: 'appointment',
    entityId: appointmentId,
    details: { reason: 'payment verified' },
  });
  return updated;
}

/** Libère un créneau et le verrou associé. */
async function releaseSlot(client, slotId, appointmentId) {
  await client.query(
    `UPDATE doctor_slots SET status = 'OPEN', hold_expires_at = NULL WHERE id = $1`,
    [slotId],
  );
  await client.query(
    `UPDATE booking_holds SET released_at = now() WHERE slot_id = $1 AND released_at IS NULL`,
    [slotId],
  );
  if (appointmentId) {
    await client.query(
      `UPDATE booking_holds SET released_at = now() WHERE appointment_id = $1 AND released_at IS NULL`,
      [appointmentId],
    );
  }
}

/**
 * Annule une réservation. Calcule l'éligibilité au remboursement selon la
 * politique configurée (délai de prévenance).
 */
export async function cancelBooking(appointmentId, { actor = null, reason = '' } = {}) {
  const cfg = await bookingConfig();
  const outcome = await db().tx(async (client) => {
    const row = (
      await client.query(
        `SELECT a.*, s.starts_at FROM appointments a
           JOIN doctor_slots s ON s.id = a.slot_id
          WHERE a.id = $1 FOR UPDATE`,
        [appointmentId],
      )
    ).rows[0];
    if (!row) throw Errors.notFound('Appointment');
    if (['CANCELLED', 'REJECTED', 'REFUNDED', 'COMPLETED'].includes(row.status)) {
      throw Errors.conflict('NOT_CANCELLABLE', `Statut ${row.status}`);
    }

    const hoursBefore = (new Date(row.starts_at).getTime() - Date.now()) / 3600_000;
    const refundPct =
      hoursBefore >= cfg.cancellationNoticeHours ? cfg.refundPctBeforeNotice : cfg.refundPctLate;
    const wasPaid = ['PAID', 'CONFIRMED'].includes(row.status);

    await client.query(
      `UPDATE appointments SET status = 'CANCELLED', cancel_reason = $2, updated_at = now() WHERE id = $1`,
      [appointmentId, reason.slice(0, 500)],
    );
    await client.query(
      `INSERT INTO appointment_status_history (appointment_id, from_status, to_status, actor_user_id, actor_role, reason)
       VALUES ($1, $2, 'CANCELLED', $3, $4, $5)`,
      [appointmentId, row.status, actor?.id ?? null, actor?.role ?? null, reason.slice(0, 500)],
    );
    await releaseSlot(client, row.slot_id, appointmentId);

    return {
      appointment: { ...row, status: 'CANCELLED' },
      refund: wasPaid ? { eligible: refundPct > 0, percent: refundPct } : { eligible: false, percent: 0 },
    };
  });

  await audit({
    actor,
    action: 'appointment.cancelled',
    entity: 'appointment',
    entityId: appointmentId,
    details: { reason, refund_percent: outcome.refund.percent },
  });
  return outcome;
}

/**
 * Reprogramme vers un autre créneau. L'ancien créneau est libéré et le nouveau
 * verrouillé dans la MÊME transaction : aucun état intermédiaire incohérent.
 */
export async function rescheduleBooking(appointmentId, newSlotId, { actor = null } = {}) {
  const result = await db().tx(async (client) => {
    const current = (
      await client.query(
        `SELECT a.*, s.starts_at AS old_starts_at FROM appointments a
           JOIN doctor_slots s ON s.id = a.slot_id
          WHERE a.id = $1 FOR UPDATE`,
        [appointmentId],
      )
    ).rows[0];
    if (!current) throw Errors.notFound('Appointment');
    if (!['PENDING', 'AWAITING_PAYMENT', 'PAID', 'CONFIRMED'].includes(current.status)) {
      throw Errors.conflict('NOT_RESCHEDULABLE', `Statut ${current.status}`);
    }

    const target = (
      await client.query('SELECT * FROM doctor_slots WHERE id = $1 FOR UPDATE', [newSlotId])
    ).rows[0];
    if (!target) throw Errors.notFound('Slot');
    if (target.doctor_id !== current.doctor_id) {
      throw Errors.conflict('DOCTOR_MISMATCH', 'Le créneau appartient à un autre médecin');
    }
    const holdAlive =
      target.status === 'HELD' && target.hold_expires_at && new Date(target.hold_expires_at) > new Date();
    if (target.status !== 'OPEN' || holdAlive) {
      throw Errors.conflict('SLOT_TAKEN', 'Créneau cible indisponible');
    }

    await releaseSlot(client, current.slot_id, appointmentId);
    await client.query(`UPDATE doctor_slots SET status = 'BOOKED', hold_expires_at = NULL WHERE id = $1`, [
      newSlotId,
    ]);
    await client.query('UPDATE appointments SET slot_id = $2, updated_at = now() WHERE id = $1', [
      appointmentId,
      newSlotId,
    ]);
    await client.query(
      `INSERT INTO appointment_status_history (appointment_id, from_status, to_status, actor_user_id, actor_role, reason)
       VALUES ($1, $2, $2, $3, $4, $5)`,
      [appointmentId, current.status, actor?.id ?? null, actor?.role ?? null, `rescheduled to ${newSlotId}`],
    );
    return { appointment: { ...current, slot_id: newSlotId }, from: current.slot_id };
  });

  await audit({
    actor,
    action: 'appointment.rescheduled',
    entity: 'appointment',
    entityId: appointmentId,
    details: { from_slot: result.from, to_slot: newSlotId },
  });
  return result.appointment;
}

/**
 * Libère les verrous expirés (appelé par le worker toutes les minutes).
 * @returns {Promise<{released: number}>}
 */
export async function releaseExpiredHolds() {
  const released = await db().tx(async (client) => {
    const expired = (
      await client.query(
        `SELECT s.id AS slot_id, a.id AS appointment_id
           FROM doctor_slots s
           LEFT JOIN appointments a ON a.slot_id = s.id AND a.status = 'AWAITING_PAYMENT'
          WHERE s.status = 'HELD' AND s.hold_expires_at IS NOT NULL AND s.hold_expires_at < now()
          FOR UPDATE OF s`,
      )
    ).rows;

    for (const row of expired) {
      await client.query(`UPDATE doctor_slots SET status = 'OPEN', hold_expires_at = NULL WHERE id = $1`, [
        row.slot_id,
      ]);
      await client.query(
        `UPDATE booking_holds SET released_at = now() WHERE slot_id = $1 AND released_at IS NULL`,
        [row.slot_id],
      );
      if (row.appointment_id) {
        await client.query(
          `UPDATE appointments SET status = 'CANCELLED', cancel_reason = 'hold expired', updated_at = now()
            WHERE id = $1 AND status = 'AWAITING_PAYMENT'`,
          [row.appointment_id],
        );
        await client.query(
          `INSERT INTO appointment_status_history (appointment_id, from_status, to_status, reason)
           VALUES ($1, 'AWAITING_PAYMENT', 'CANCELLED', 'hold expired')`,
          [row.appointment_id],
        );
      }
    }
    return expired.length;
  });
  if (released) await audit({ action: 'booking.holds.released', details: { released } });
  return { released };
}

/** Liste filtrée par rôle et périmètre. */
export async function listAppointments({
  patientId = null,
  doctorId = null,
  branchIds = null,
  status = null,
  from = null,
  to = null,
  limit = 50,
  offset = 0,
} = {}) {
  const where = [];
  const params = [];
  const push = (value) => {
    params.push(value);
    return `$${params.length}`;
  };

  if (patientId) where.push(`a.patient_id = ${push(patientId)}`);
  if (doctorId) where.push(`a.doctor_id = ${push(doctorId)}`);
  if (branchIds && branchIds.length) where.push(`a.branch_id = ANY(${push(branchIds)}::uuid[])`);
  if (status) where.push(`a.status = ${push(status)}`);
  if (from) where.push(`s.starts_at >= ${push(new Date(from))}`);
  if (to) where.push(`s.starts_at <= ${push(new Date(to))}`);

  const rows = await many(
    `SELECT a.id, a.reference, a.status, a.source, a.mode, a.price, a.service_fee, a.currency,
            a.created_at, s.starts_at, s.ends_at,
            p.full_name AS patient_name, u.full_name AS doctor_name,
            d.primary_specialty_code,
            coalesce(c.name_fr, '') AS clinic_name_fr, coalesce(c.name_ar, '') AS clinic_name_ar
       FROM appointments a
       JOIN doctor_slots s ON s.id = a.slot_id
       JOIN patients p ON p.id = a.patient_id
       JOIN doctors d ON d.id = a.doctor_id
       JOIN users u ON u.id = d.user_id
       LEFT JOIN clinics c ON c.id = a.clinic_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY s.starts_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, Math.min(limit, 200), Math.max(0, offset)],
  );
  return rows;
}

/** Historique complet des statuts d'un rendez-vous. */
export async function statusHistory(appointmentId) {
  return many(
    `SELECT from_status, to_status, reason, actor_role, created_at
       FROM appointment_status_history
      WHERE appointment_id = $1
      ORDER BY created_at ASC, id ASC`,
    [appointmentId],
  );
}

export { releaseSlot };
