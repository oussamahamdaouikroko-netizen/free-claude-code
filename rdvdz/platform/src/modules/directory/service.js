/**
 * Annuaire : wilayas, spécialités, cliniques, médecins, recherche, avis.
 *
 * Toute donnée exposée au public passe par une **liste blanche** de colonnes :
 * un champ ajouté plus tard en base (par exemple un identifiant interne) ne
 * fuite jamais vers le front.
 */

import { db, many, one } from '../../db.js';
import { Errors } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { listOpenSlots } from '../booking/slots.js';

const PUBLIC_DOCTOR_FIELDS = [
  'id',
  'full_name',
  'primary_specialty_code',
  'specialty_fr',
  'specialty_ar',
  'bio_fr',
  'bio_ar',
  'languages',
  'consultation_fee',
  'teleconsult_fee',
  'teleconsult_enabled',
  'rating_avg',
  'rating_count',
  'verified',
  'clinic_id',
  'clinic_name_fr',
  'clinic_name_ar',
  'commune',
  'address',
  'wilaya_code',
  'wilaya_fr',
  'wilaya_ar',
  'kind',
];

function shapeDoctor(row) {
  const out = {};
  for (const key of PUBLIC_DOCTOR_FIELDS) if (row[key] !== undefined) out[key] = row[key];
  out.verified = Boolean(row.verified_at);
  return out;
}

/** Référentiels publics. */
export async function wilayas() {
  return many('SELECT code, name_ar, name_fr FROM wilayas ORDER BY code');
}

export async function specialties() {
  return many('SELECT code, name_ar, name_fr FROM specialties WHERE active ORDER BY name_fr');
}

/** Réglages exposables au public (jamais un secret). */
export async function publicConfig() {
  const rows = await many(`SELECT key, value FROM system_settings WHERE key LIKE 'public.%'`);
  const out = {};
  for (const row of rows) out[row.key.replace('public.', '')] = row.value;
  return out;
}

/**
 * Recherche de médecins vérifiés.
 * @param {{ q?: string, specialty?: string, wilaya?: number, commune?: string,
 *           teleconsult?: boolean, limit?: number, offset?: number }} filters
 */
export async function searchDoctors(filters = {}) {
  const params = [];
  const where = [`u.status = 'ACTIVE'`, `d.verified_at IS NOT NULL`];

  if (filters.specialty) {
    params.push(filters.specialty);
    where.push(
      `(d.primary_specialty_code = $${params.length}
        OR EXISTS (SELECT 1 FROM doctor_specialties ds WHERE ds.doctor_id = d.id AND ds.specialty_code = $${params.length}))`,
    );
  }
  if (filters.wilaya) {
    params.push(Number(filters.wilaya));
    where.push(`c.wilaya_code = $${params.length}`);
  }
  if (filters.commune) {
    params.push(String(filters.commune));
    where.push(`c.commune ILIKE '%' || $${params.length} || '%'`);
  }
  if (filters.teleconsult) where.push('d.teleconsult_enabled');
  if (filters.accepting !== false) where.push('d.accepting_new');
  if (filters.q) {
    params.push(String(filters.q).trim());
    where.push(
      `(u.full_name ILIKE '%' || $${params.length} || '%'
        OR c.name_fr ILIKE '%' || $${params.length} || '%'
        OR c.name_ar ILIKE '%' || $${params.length} || '%'
        OR c.commune ILIKE '%' || $${params.length} || '%')`,
    );
  }

  const limit = Math.min(Number(filters.limit) || 20, 60);
  const offset = Math.max(Number(filters.offset) || 0, 0);
  params.push(limit, offset);

  const rows = await many(
    `SELECT d.id, u.full_name, d.primary_specialty_code,
            sp.name_fr AS specialty_fr, sp.name_ar AS specialty_ar,
            d.bio_fr, d.bio_ar, d.languages, d.consultation_fee, d.teleconsult_fee,
            d.teleconsult_enabled, d.rating_avg, d.rating_count, d.verified_at,
            c.id AS clinic_id, c.name_fr AS clinic_name_fr, c.name_ar AS clinic_name_ar,
            c.commune, c.address, c.wilaya_code, c.kind,
            w.name_fr AS wilaya_fr, w.name_ar AS wilaya_ar
       FROM doctors d
       JOIN users u ON u.id = d.user_id
       JOIN specialties sp ON sp.code = d.primary_specialty_code
       LEFT JOIN clinics c ON c.id = d.clinic_id
       LEFT JOIN wilayas w ON w.code = c.wilaya_code
      WHERE ${where.join(' AND ')}
      ORDER BY (d.rating_count > 0) DESC, d.rating_avg DESC, u.full_name ASC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  return rows.map(shapeDoctor);
}

/** Profil public complet (médecin vérifié uniquement). */
export async function doctorProfile(doctorId, { slotsFrom, slotsTo } = {}) {
  const row = await one(
    `SELECT d.id, u.full_name, d.primary_specialty_code,
            sp.name_fr AS specialty_fr, sp.name_ar AS specialty_ar,
            d.bio_fr, d.bio_ar, d.languages, d.consultation_fee, d.teleconsult_fee,
            d.teleconsult_enabled, d.rating_avg, d.rating_count, d.verified_at,
            c.id AS clinic_id, c.name_fr AS clinic_name_fr, c.name_ar AS clinic_name_ar,
            c.commune, c.address, c.phone AS clinic_phone, c.photos, c.lat, c.lng,
            c.wilaya_code, c.kind, w.name_fr AS wilaya_fr, w.name_ar AS wilaya_ar
       FROM doctors d
       JOIN users u ON u.id = d.user_id
       JOIN specialties sp ON sp.code = d.primary_specialty_code
       LEFT JOIN clinics c ON c.id = d.clinic_id
       LEFT JOIN wilayas w ON w.code = c.wilaya_code
      WHERE d.id = $1 AND u.status = 'ACTIVE' AND d.verified_at IS NOT NULL`,
    [doctorId],
  );
  if (!row) throw Errors.notFound('Doctor');

  const others = await many(
    'SELECT specialty_code FROM doctor_specialties WHERE doctor_id = $1',
    [doctorId],
  );
  const reviews = await many(
    `SELECT r.rating, r.comment, r.created_at, split_part(p.full_name, ' ', 1) AS patient_first_name
       FROM reviews r JOIN patients p ON p.id = r.patient_id
      WHERE r.doctor_id = $1 AND r.status = 'APPROVED'
      ORDER BY r.created_at DESC LIMIT 20`,
    [doctorId],
  );
  const from = slotsFrom ?? new Date().toISOString().slice(0, 10);
  const to = slotsTo ?? new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
  const slots = await listOpenSlots(doctorId, { from, to, limit: 60 });

  const feeRow = await one(`SELECT value FROM system_settings WHERE key = 'public.service_fee'`);
  const serviceFee = Number(feeRow?.value?.amount ?? 0);

  return {
    doctor: shapeDoctor(row),
    clinic: row.clinic_id
      ? {
          id: row.clinic_id,
          name_fr: row.clinic_name_fr,
          name_ar: row.clinic_name_ar,
          commune: row.commune,
          address: row.address,
          phone: row.clinic_phone,
          photos: row.photos ?? [],
          lat: row.lat,
          lng: row.lng,
          kind: row.kind,
        }
      : null,
    other_specialties: others.map((o) => o.specialty_code),
    reviews,
    slots,
    fees: {
      consultation: row.consultation_fee,
      teleconsultation: row.teleconsult_fee,
      service_fee: serviceFee,
      currency: 'DZD',
    },
  };
}

/** Clinique publique + médecins rattachés. */
export async function clinicProfile(clinicId) {
  const clinic = await one(
    `SELECT c.*, w.name_fr AS wilaya_fr, w.name_ar AS wilaya_ar
       FROM clinics c JOIN wilayas w ON w.code = c.wilaya_code
      WHERE c.id = $1 AND c.status = 'ACTIVE'`,
    [clinicId],
  );
  if (!clinic) throw Errors.notFound('Clinic');
  const doctors = await searchDoctors({ limit: 60 });
  return {
    clinic: {
      id: clinic.id,
      name_fr: clinic.name_fr,
      name_ar: clinic.name_ar,
      kind: clinic.kind,
      wilaya_fr: clinic.wilaya_fr,
      wilaya_ar: clinic.wilaya_ar,
      commune: clinic.commune,
      address: clinic.address,
      phone: clinic.phone,
      photos: clinic.photos ?? [],
      lat: clinic.lat,
      lng: clinic.lng,
    },
    doctors: doctors.filter((d) => d.clinic_id === clinicId),
  };
}

/* ---------------------------------- avis ---------------------------------- */

/** Un patient ne peut noter qu'un rendez-vous terminé, une seule fois. */
export async function createReview({ patientId, appointmentId, rating, comment = '', actor }) {
  const appointment = await one(
    `SELECT a.*, s.starts_at FROM appointments a JOIN doctor_slots s ON s.id = a.slot_id
      WHERE a.id = $1`,
    [appointmentId],
  );
  if (!appointment) throw Errors.notFound('Appointment');
  if (appointment.patient_id !== patientId) throw Errors.forbidden('Rendez-vous d\'un autre patient');
  if (appointment.status !== 'COMPLETED') {
    throw Errors.conflict('REVIEW_NOT_ALLOWED', 'Seul un rendez-vous terminé peut être noté');
  }
  const value = Number(rating);
  if (!Number.isInteger(value) || value < 1 || value > 5) throw Errors.validation({ rating: '1..5' });

  const existing = await one('SELECT id FROM reviews WHERE appointment_id = $1', [appointmentId]);
  if (existing) throw Errors.conflict('REVIEW_EXISTS', 'Avis déjà déposé pour ce rendez-vous');

  const review = await one(
    `INSERT INTO reviews (doctor_id, patient_id, appointment_id, rating, comment, status)
     VALUES ($1,$2,$3,$4,$5,'PENDING') RETURNING id, rating, status, created_at`,
    [appointment.doctor_id, patientId, appointmentId, value, String(comment).slice(0, 1000)],
  );
  await audit({
    actor,
    action: 'review.created',
    entity: 'review',
    entityId: review.id,
    details: { doctor_id: appointment.doctor_id, rating: value },
  });
  return review;
}

/** Modération : approuver/rejeter met à jour la note moyenne du médecin. */
export async function moderateReview(reviewId, { status, note = '', actor }) {
  if (!['APPROVED', 'REJECTED'].includes(status)) throw Errors.validation({ status: 'invalid' });
  const review = await one('SELECT * FROM reviews WHERE id = $1', [reviewId]);
  if (!review) throw Errors.notFound('Review');

  await db().query(
    `UPDATE reviews SET status = $2, moderated_by = $3, moderated_at = now(), moderation_note = $4 WHERE id = $1`,
    [reviewId, status, actor?.id ?? null, String(note).slice(0, 500)],
  );

  const stats = await one(
    `SELECT count(*)::int AS count, coalesce(avg(rating), 0)::numeric(3,2) AS avg
       FROM reviews WHERE doctor_id = $1 AND status = 'APPROVED'`,
    [review.doctor_id],
  );
  await db().query('UPDATE doctors SET rating_count = $2, rating_avg = $3 WHERE id = $1', [
    review.doctor_id,
    stats.count,
    stats.avg,
  ]);

  await audit({
    actor,
    action: `review.${status.toLowerCase()}`,
    entity: 'review',
    entityId: reviewId,
    details: { doctor_id: review.doctor_id, note },
  });
  return { ok: true, rating_avg: stats.avg, rating_count: stats.count };
}

/** Vérification d'un médecin par un administrateur (jamais automatique). */
export async function verifyDoctor(doctorId, { approved, note = '', actor }) {
  const doctor = await one(
    `SELECT d.*, u.id AS user_id, u.status AS user_status FROM doctors d JOIN users u ON u.id = d.user_id WHERE d.id = $1`,
    [doctorId],
  );
  if (!doctor) throw Errors.notFound('Doctor');

  if (approved) {
    await db().query(
      `UPDATE doctors SET verified_at = now(), verified_by = $2,
              rejected_at = NULL, rejection_reason = ''
        WHERE id = $1`,
      [doctorId, actor?.id ?? null],
    );
    await db().query(`UPDATE users SET status = 'ACTIVE' WHERE id = $1 AND status = 'PENDING'`, [doctor.user_id]);
  } else {
    // Refus tracé : le motif est conservé et le dossier porte une date de
    // refus, ce qui le sort de la file « en attente » sans le supprimer.
    await db().query(
      `UPDATE doctors SET verified_at = NULL, verified_by = $2,
              rejected_at = now(), rejection_reason = $3
        WHERE id = $1`,
      [doctorId, actor?.id ?? null, String(note || '').slice(0, 500)],
    );
    await db().query(`UPDATE users SET status = 'SUSPENDED' WHERE id = $1`, [doctor.user_id]);
  }

  await audit({
    actor,
    action: approved ? 'doctor.verified' : 'doctor.rejected',
    entity: 'doctor',
    entityId: doctorId,
    details: { note },
  });
  return { ok: true, approved: Boolean(approved), note: String(note || '') };
}

/** Création/édition de clinique (administration ou médecine vérifiée). */
export async function upsertClinic(input, { actor }) {
  const data = {
    name_fr: String(input.name_fr ?? '').trim().slice(0, 160),
    name_ar: String(input.name_ar ?? '').trim().slice(0, 160),
    kind: ['DENTAL', 'MEDICAL', 'POLYCLINIC'].includes(input.kind) ? input.kind : 'MEDICAL',
    wilaya_code: Number(input.wilaya_code),
    commune: String(input.commune ?? '').trim().slice(0, 120),
    address: String(input.address ?? '').trim().slice(0, 240),
    phone: input.phone ? String(input.phone).slice(0, 40) : null,
  };
  if (!data.name_fr || !data.name_ar) throw Errors.validation({ name: 'requis en arabe et en français' });
  const wilaya = await one('SELECT code FROM wilayas WHERE code = $1', [data.wilaya_code]);
  if (!wilaya) throw Errors.validation({ wilaya_code: 'inconnue' });

  let row;
  if (input.id) {
    row = await one(
      `UPDATE clinics SET name_fr=$2, name_ar=$3, kind=$4, wilaya_code=$5, commune=$6, address=$7, phone=$8
        WHERE id = $1 RETURNING *`,
      [input.id, data.name_fr, data.name_ar, data.kind, data.wilaya_code, data.commune, data.address, data.phone],
    );
  } else {
    row = await one(
      `INSERT INTO clinics (name_fr, name_ar, kind, wilaya_code, commune, address, phone)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [data.name_fr, data.name_ar, data.kind, data.wilaya_code, data.commune, data.address, data.phone],
    );
  }
  if (!row) throw Errors.notFound('Clinic');
  await audit({ actor, action: input.id ? 'clinic.updated' : 'clinic.created', entity: 'clinic', entityId: row.id });
  return row;
}

/** Profil médecin éditable par le médecin lui-même. */
export async function updateDoctorProfile(doctorId, input, { actor }) {
  const fields = [];
  const params = [];
  const push = (column, value) => {
    params.push(value);
    fields.push(`"${column}" = $${params.length}`);
  };

  if (input.bioFr !== undefined) push('bio_fr', String(input.bioFr).slice(0, 2000));
  if (input.bioAr !== undefined) push('bio_ar', String(input.bioAr).slice(0, 2000));
  if (input.consultationFee !== undefined) {
    const fee = Math.round(Number(input.consultationFee));
    if (!Number.isFinite(fee) || fee < 0 || fee > 500000) throw Errors.validation({ consultation_fee: 'invalide' });
    push('consultation_fee', fee);
  }
  if (input.teleconsultFee !== undefined) {
    const fee = Math.round(Number(input.teleconsultFee));
    if (!Number.isFinite(fee) || fee < 0 || fee > 500000) throw Errors.validation({ teleconsult_fee: 'invalide' });
    push('teleconsult_fee', fee);
  }
  if (input.teleconsultEnabled !== undefined) push('teleconsult_enabled', Boolean(input.teleconsultEnabled));
  if (input.acceptingNew !== undefined) push('accepting_new', Boolean(input.acceptingNew));
  if (input.manualConfirmation !== undefined) push('manual_confirmation', Boolean(input.manualConfirmation));
  if (input.slotMinutes !== undefined) {
    const minutes = Number(input.slotMinutes);
    if (![10, 15, 20, 30, 45, 60].includes(minutes)) throw Errors.validation({ slot_minutes: 'invalide' });
    push('slot_minutes', minutes);
  }
  if (fields.length === 0) return { ok: true, updated: 0 };

  params.push(doctorId);
  const row = await one(
    `UPDATE doctors SET ${fields.join(', ')} WHERE id = $${params.length} RETURNING *`,
    params,
  );
  if (!row) throw Errors.notFound('Doctor');
  await audit({ actor, action: 'doctor.profile.updated', entity: 'doctor', entityId: doctorId, details: { fields: fields.length } });
  return row;
}
