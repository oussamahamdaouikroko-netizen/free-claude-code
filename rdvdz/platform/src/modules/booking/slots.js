/**
 * Créneaux : génération à partir des horaires, requête des disponibilités,
 * blocage/déblocage ponctuel.
 *
 * Un créneau est une ligne en base (`doctor_slots`) : il n'est jamais calculé
 * à la volée côté client, sinon deux patients pourraient « voir » le même
 * créneau libre et le serveur ne pourrait pas arbitrer.
 */

import { db, many, one } from '../../db.js';
import { Errors } from '../../lib/errors.js';

/** L'Algérie est à UTC+1 toute l'année (aucune heure d'été). */
export const LOCAL_OFFSET_MINUTES = 60;

/** Convertit `HH:MM` ou `HH:MM:SS` en minutes depuis minuit. */
function minutesOfTime(value) {
  const [h, m] = String(value).split(':').map(Number);
  return h * 60 + (m || 0);
}

/**
 * Construit les intervalles d'une journée d'ouverture, pauses exclues.
 * @returns {Array<{start: number, end: number}>} minutes depuis minuit
 */
function openingIntervals({ opens, closes, break_start, break_end }) {
  const start = minutesOfTime(opens);
  const end = minutesOfTime(closes);
  const intervals = [];
  if (break_start && break_end) {
    const bs = minutesOfTime(break_start);
    const be = minutesOfTime(break_end);
    if (bs > start) intervals.push({ start, end: Math.min(bs, end) });
    if (be < end) intervals.push({ start: Math.max(be, start), end });
  } else {
    intervals.push({ start, end });
  }
  return intervals.filter((i) => i.end > i.start);
}

/** Date ISO `YYYY-MM-DD` → `Date` à midi UTC (évite les décalages de fuseau). */
export function dayToDate(isoDay) {
  const [y, m, d] = String(isoDay).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
}

export function isIsoDay(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/** Ajoute `n` jours à une date ISO. */
export function addDays(isoDay, n) {
  const date = dayToDate(isoDay);
  date.setUTCDate(date.getUTCDate() + n);
  return date.toISOString().slice(0, 10);
}

/**
 * Génère les créneaux d'un médecin entre deux dates (bornes incluses).
 * Idempotent : `ON CONFLICT DO NOTHING` sur (doctor_id, starts_at, mode).
 *
 * @param {string} doctorId
 * @param {{ from: string, to: string, mode?: string }} range
 * @returns {Promise<{created: number, skipped: number}>}
 */
export async function generateSlots(doctorId, { from, to, mode = 'IN_CLINIC' }) {
  if (!isIsoDay(from) || !isIsoDay(to)) throw Errors.validation({ from: 'YYYY-MM-DD required' });
  if (to < from) throw Errors.validation({ to: 'must be after from' });

  const doctor = await one(
    `SELECT d.id, d.clinic_id, d.slot_minutes FROM doctors d WHERE d.id = $1`,
    [doctorId],
  );
  if (!doctor) throw Errors.notFound('Doctor');

  // Horaires propres au médecin prioritaires sur ceux de la clinique.
  const hours = await many(
    `SELECT DISTINCT ON (weekday) weekday, opens, closes, break_start, break_end, doctor_id
       FROM clinic_hours
      WHERE doctor_id = $1 OR (doctor_id IS NULL AND clinic_id = $2)
      ORDER BY weekday, (doctor_id IS NOT NULL) DESC`,
    [doctorId, doctor.clinic_id],
  );
  if (hours.length === 0) return { created: 0, skipped: 0, reason: 'NO_SCHEDULE' };

  const timeOff = await many(
    'SELECT starts_at, ends_at FROM doctor_time_off WHERE doctor_id = $1 AND ends_at > $2 AND starts_at < $3',
    [doctorId, new Date(`${from}T00:00:00Z`), new Date(`${to}T23:59:59Z`)],
  );

  const step = doctor.slot_minutes || 20;
  const values = [];
  const params = [];
  let index = 1;

  for (let day = from; day <= to; day = addDays(day, 1)) {
    const date = dayToDate(day);
    for (const entry of hours.filter((h) => h.weekday === date.getUTCDay())) {
      for (const interval of openingIntervals(entry)) {
        for (let minute = interval.start; minute + step <= interval.end; minute += step) {
          // Heure locale Algérie (UTC+1, sans heure d'été) → instant UTC.
          const utcStart = new Date(
            Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, minute) - LOCAL_OFFSET_MINUTES * 60_000,
          );
          const utcEnd = new Date(utcStart.getTime() + step * 60_000);
          const blocked = timeOff.some((off) => new Date(off.starts_at) < utcEnd && new Date(off.ends_at) > utcStart);

          values.push(`($${index++}, $${index++}, $${index++}, $${index++}, $${index++}, 'GENERATED')`);
          params.push(doctorId, utcStart.toISOString(), utcEnd.toISOString(), mode, blocked ? 'BLOCKED' : 'OPEN');
        }
      }
    }
  }

  if (values.length === 0) return { created: 0, skipped: 0 };

  const result = await db().query(
    `INSERT INTO doctor_slots (doctor_id, starts_at, ends_at, mode, status, source)
     VALUES ${values.join(', ')}
     ON CONFLICT (doctor_id, starts_at, mode) DO NOTHING
     RETURNING id`,
    params,
  );
  return { created: result.rows.length, skipped: values.length - result.rows.length };
}

/**
 * Créneaux réservables d'un médecin sur une fenêtre.
 * Exclut : les créneaux réservés, bloqués, et les verrous encore valides.
 */
export async function listOpenSlots(doctorId, { from, to, mode = null, limit = 100 }) {
  const rows = await many(
    `SELECT s.id, s.starts_at, s.ends_at, s.mode
       FROM doctor_slots s
      WHERE s.doctor_id = $1
        AND s.status = 'OPEN'
        AND s.starts_at >= $2
        AND s.starts_at <= $3
        AND s.starts_at > now()
        AND ($4::text IS NULL OR s.mode = $4)
      ORDER BY s.starts_at ASC
      LIMIT $5`,
    [doctorId, new Date(`${from}T00:00:00Z`), new Date(`${to}T23:59:59Z`), mode, Math.min(limit, 500)],
  );
  return rows;
}

/** Bloque un créneau (indisponibilité ponctuelle du médecin). */
export async function blockSlot(slotId, doctorId) {
  const row = await one('SELECT id, doctor_id, status FROM doctor_slots WHERE id = $1', [slotId]);
  if (!row || row.doctor_id !== doctorId) throw Errors.notFound('Slot');
  if (row.status === 'BOOKED') throw Errors.conflict('SLOT_BOOKED', 'Créneau déjà réservé');
  const updated = await one(
    `UPDATE doctor_slots SET status = 'BLOCKED', hold_expires_at = NULL
      WHERE id = $1 RETURNING *`,
    [slotId],
  );
  return updated;
}

/** Débloque un créneau précédemment bloqué. */
export async function unblockSlot(slotId, doctorId) {
  const row = await one('SELECT id, doctor_id, status FROM doctor_slots WHERE id = $1', [slotId]);
  if (!row || row.doctor_id !== doctorId) throw Errors.notFound('Slot');
  if (row.status !== 'BLOCKED') throw Errors.conflict('SLOT_NOT_BLOCKED', 'Créneau non bloqué');
  return one(`UPDATE doctor_slots SET status = 'OPEN' WHERE id = $1 RETURNING *`, [slotId]);
}
