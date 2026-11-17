'use strict';
/**
 * Public patient API (Part 4): search, profiles, booking, tracking, payment.
 * Only verified (active) doctors are exposed. No invented ratings/reviews.
 */
const { getDb, utcNow } = require('../db');
const { validation, notFound, conflict } = require('../errors');
const {
  cleanText, requireText, requirePhoneDZ, normalizePhoneDZ, phoneKey,
  requireISODate, requireId, requireEnum,
} = require('../validate');
const booking = require('../services/booking');
const payments = require('../services/payments');
const whatsapp = require('../services/whatsapp');
const notify = require('../services/notify');

function searchDoctors({ name = '', specialtyId = null, wilaya = '', city = '', clinicId = null, availableOn = null, limit = 50 } = {}) {
  const clauses = ["d.status = 'active'"];
  const params = [];
  if (name) { clauses.push('d.full_name LIKE ?'); params.push(`%${cleanText(name, 80)}%`); }
  if (specialtyId) { clauses.push('d.specialty_id = ?'); params.push(requireId(specialtyId, 'specialtyId')); }
  if (wilaya) { clauses.push('c.wilaya LIKE ?'); params.push(`%${cleanText(wilaya, 80)}%`); }
  if (city) { clauses.push('c.city LIKE ?'); params.push(`%${cleanText(city, 80)}%`); }
  if (clinicId) { clauses.push('dc.clinic_id = ?'); params.push(requireId(clinicId, 'clinicId')); }
  const n = Math.min(200, Math.max(1, Number(limit) || 50));
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT d.* FROM doctors d
       LEFT JOIN doctor_clinics dc ON dc.doctor_id = d.id
       LEFT JOIN clinics c ON c.id = dc.clinic_id
       WHERE ${clauses.join(' AND ')} ORDER BY d.full_name LIMIT ?`
    )
    .all(...params, n);
  return rows.map((doctor) => {
    const clinics = getDb()
      .prepare('SELECT c.* FROM clinics c JOIN doctor_clinics dc ON dc.clinic_id = c.id WHERE dc.doctor_id = ? ORDER BY c.name')
      .all(doctor.id);
    const specialty = doctor.specialty_id
      ? getDb().prepare('SELECT * FROM specialties WHERE id = ?').get(doctor.specialty_id)
      : null;
    const wa = whatsapp.getAccount(doctor.id);
    const hasSlots = availableOn ? booking.availableSlots(doctor.id, requireISODate(availableOn, 'availableOn')).length > 0 : null;
    return {
      id: doctor.id,
      public_ref: doctor.public_ref,
      full_name: doctor.full_name,
      specialty,
      specialty_text: doctor.specialty_text,
      consultation_fee: doctor.consultation_fee,
      payment_mode: doctor.payment_mode,
      clinics,
      whatsapp_mode: wa ? wa.mode : 'none',
      available_on: availableOn || null,
      has_availability: hasSlots,
    };
  });
}

function getDoctorProfile(doctorId) {
  const doctor = getDb().prepare('SELECT * FROM doctors WHERE id = ?').get(doctorId);
  if (!doctor || doctor.status !== 'active') throw notFound('Doctor');
  const clinics = getDb()
    .prepare('SELECT c.* FROM clinics c JOIN doctor_clinics dc ON dc.clinic_id = c.id WHERE dc.doctor_id = ? ORDER BY c.name')
    .all(doctor.id);
  const specialty = doctor.specialty_id
    ? getDb().prepare('SELECT * FROM specialties WHERE id = ?').get(doctor.specialty_id)
    : null;
  const schedules = getDb().prepare('SELECT * FROM doctor_schedules WHERE doctor_id = ? AND is_active = 1 ORDER BY weekday, start_time').all(doctor.id);
  const wa = whatsapp.getAccount(doctor.id);
  return {
    id: doctor.id,
    public_ref: doctor.public_ref,
    full_name: doctor.full_name,
    specialty,
    specialty_text: doctor.specialty_text,
    consultation_fee: doctor.consultation_fee,
    appointment_minutes: doctor.appointment_minutes,
    payment_mode: doctor.payment_mode,
    baridimob_name: doctor.baridimob_name,
    baridimob_rib: doctor.baridimob_rib,
    clinics,
    schedules,
    whatsapp_mode: wa ? wa.mode : 'none',
    whatsapp_number: wa && wa.mode === 'click_to_chat' ? wa.display_number : null,
  };
}

function getOrCreatePatient({ fullName, phone, email = null, lang = 'fr' }) {
  const phoneNorm = normalizePhoneDZ(phone);
  const key = phoneKey(phone);
  const existing = getDb().prepare('SELECT * FROM patients WHERE phone_norm = ?').get(phoneNorm || key);
  if (existing) return existing;
  const now = utcNow();
  const result = getDb()
    .prepare(
      `INSERT INTO patients (full_name, phone, phone_norm, email, preferred_lang, is_guest, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`
    )
    .run(fullName, phone, phoneNorm || key, email, lang === 'ar' ? 'ar' : 'fr', now, now);
  return getDb().prepare('SELECT * FROM patients WHERE id = ?').get(result.lastInsertRowid);
}

/**
 * Create a booking (guest-friendly, idempotent).
 * Returns the appointment + payment instructions + WhatsApp next step.
 */
function createPublicBooking(body) {
  const patientName = requireText(body.patient_name, 'patient_name', 120);
  const patientPhone = requirePhoneDZ(body.patient_phone, 'patient_phone');
  const doctorId = requireId(body.doctor_id, 'doctor_id');
  const clinicId = body.clinic_id ? requireId(body.clinic_id, 'clinic_id') : null;
  const day = requireISODate(body.day, 'day');
  const time = requireText(body.time, 'time', 5);
  const lang = body.lang === 'ar' ? 'ar' : 'fr';
  const idempotencyKey = body.idempotency_key ? cleanText(body.idempotency_key, 120) : null;

  const patient = getOrCreatePatient({ fullName: patientName, phone: patientPhone, email: body.email || null, lang });
  const { appointment, created } = booking.createBooking({
    patientId: patient.id,
    patientName,
    patientPhone,
    patientPhoneNorm: normalizePhoneDZ(patientPhone),
    doctorId,
    clinicId,
    day,
    time,
    source: body.source === 'android' ? 'android' : 'web',
    idempotencyKey,
  });
  const payment = payments.ensurePaymentFor(appointment);
  const doctor = getDb().prepare('SELECT * FROM doctors WHERE id = ?').get(doctorId);
  const clinic = clinicId ? getDb().prepare('SELECT * FROM clinics WHERE id = ?').get(clinicId) : null;
  const wa = whatsapp.getAccount(doctorId);

  const instructions = paymentInstructions(doctor, payment, appointment);
  const nextStep = nextStepFor(appointment, payment, doctor, wa, { clinicName: clinic ? clinic.name : '', lang });

  if (created) {
    notify.notifyPatient({
      patientId: patient.id,
      appointmentId: appointment.id,
      title: lang === 'ar' ? 'تم استلام طلب الحجز' : 'Booking request received',
      body: `${appointment.public_ref} — ${appointment.day} ${appointment.time}`,
    });
  }
  return { appointment, payment, instructions, next_step: nextStep, created };
}

function paymentInstructions(doctor, payment, appointment) {
  const recipientName = doctor.baridimob_name || process.env.BARIDIMOB_RECIPIENT_NAME || '';
  const recipientRib = doctor.baridimob_rib || process.env.BARIDIMOB_RECIPIENT_RIB || '';
  return {
    reference: appointment.public_ref,
    amount_dzd: payment.amount,
    consultation_fee: appointment.consultation_fee,
    service_fee: appointment.service_fee,
    method: doctor.payment_mode === 'cash_at_clinic' ? 'cash' : 'baridimob',
    recipient_name: recipientName,
    recipient_rib: recipientRib,
    steps: [
      'Open BaridiMob and transfer the exact amount.',
      'Keep your transaction reference.',
      'Return here and submit the reference + receipt.',
      'Your payment will be verified by our team.',
    ],
  };
}

function nextStepFor(appointment, payment, doctor, wa, { clinicName = '', lang = 'fr' } = {}) {
  if (doctor.payment_mode === 'free') {
    return { kind: 'awaiting_doctor', message: 'Your request will be sent to the doctor.' };
  }
  if (payment.status === 'paid') {
    return { kind: 'awaiting_doctor', message: 'Payment verified. Awaiting doctor response.' };
  }
  if (wa && wa.mode === 'cloud_api' && wa.status === 'connected') {
    return { kind: 'whatsapp_api', message: 'The doctor will be notified via WhatsApp.' };
  }
  if (wa && wa.mode === 'click_to_chat') {
    const text = whatsapp.bookingNotificationText({ appointment, doctorName: doctor.full_name, clinicName, lang });
    return { kind: 'click_to_chat', message: 'Open WhatsApp to send your booking request.', link: whatsapp.clickToChatLink(doctor, text) };
  }
  return { kind: 'manual', message: 'Our team will contact the doctor on your behalf.' };
}

/** Track a booking by reference + phone (no account required). */
function trackBooking(publicRef, phone) {
  const ref = cleanText(publicRef, 40).toUpperCase();
  const key = phoneKey(phone);
  if (!ref || !key) throw validation('Booking reference and phone are required');
  const appointment = getDb().prepare('SELECT * FROM appointments WHERE public_ref = ?').get(ref);
  if (!appointment) throw notFound('Booking');
  if (phoneKey(appointment.patient_phone_norm) !== key) {
    // Do not reveal whether the reference exists for a wrong phone.
    throw notFound('Booking');
  }
  const payment = payments.getPaymentByAppointment(appointment.id);
  const events = getDb()
    .prepare('SELECT * FROM appointment_events WHERE appointment_id = ? ORDER BY id')
    .all(appointment.id);
  const doctor = getDb().prepare('SELECT full_name, specialty_text FROM doctors WHERE id = ?').get(appointment.doctor_id);
  const clinic = appointment.clinic_id
    ? getDb().prepare('SELECT name, address, wilaya, city FROM clinics WHERE id = ?').get(appointment.clinic_id)
    : null;
  return { appointment, payment, events, doctor, clinic };
}

function cancelPublicBooking(publicRef, phone) {
  const tracked = trackBooking(publicRef, phone);
  const appointment = booking.cancelBooking(tracked.appointment.id, { actor: 'patient' });
  notify.notifyPatient({
    patientId: appointment.patient_id,
    appointmentId: appointment.id,
    title: 'Booking cancelled',
    body: appointment.public_ref,
  });
  return appointment;
}

function listSpecialties() {
  return getDb().prepare('SELECT * FROM specialties WHERE is_active = 1 ORDER BY name_fr').all();
}

function listWilayas() {
  return getDb().prepare('SELECT DISTINCT wilaya FROM clinics WHERE wilaya <> ? ORDER BY wilaya').all('');
}

module.exports = {
  searchDoctors,
  getDoctorProfile,
  createPublicBooking,
  trackBooking,
  cancelPublicBooking,
  listSpecialties,
  listWilayas,
};
