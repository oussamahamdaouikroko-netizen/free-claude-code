'use strict';
/**
 * Payment engine (Part 5) — BaridiMob manual verification.
 *
 * There is NO BaridiMob merchant API assumed here. The patient pays
 * independently in BaridiMob, submits the transaction reference + receipt,
 * and an authorized verifier confirms actual receipt of funds.
 * A screenshot alone NEVER marks a payment as paid.
 */
const fs = require('node:fs');
const path = require('node:path');
const { getDb, withTransaction, utcNow } = require('../db');
const { AppError, validation, notFound, conflict } = require('../errors');
const { cleanText } = require('../validate');
const booking = require('./booking');
const { logAudit } = require('./audit');

const RECEIPT_MAX_BYTES = 5 * 1024 * 1024; // 5 MB
const RECEIPT_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.pdf']);

function receiptsDir() {
  const raw = process.env.MEDIRDV_RECEIPTS_DIR || './data/receipts';
  const dir = path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getPaymentByAppointment(appointmentId) {
  return getDb().prepare('SELECT * FROM payments WHERE appointment_id = ?').get(appointmentId) || null;
}

function getPaymentById(id) {
  const row = getDb().prepare('SELECT * FROM payments WHERE id = ?').get(id);
  if (!row) throw notFound('Payment');
  return row;
}

function getPaymentByRef(publicRef) {
  const row = getDb().prepare('SELECT * FROM payments WHERE public_ref = ?').get(publicRef);
  if (!row) throw notFound('Payment');
  return row;
}

function audit(paymentId, actor, action, { fromStatus = null, toStatus = null, note = '' } = {}) {
  getDb()
    .prepare(
      `INSERT INTO payment_audit_logs (payment_id, actor, action, from_status, to_status, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(paymentId, actor, action, fromStatus, toStatus, String(note).slice(0, 500), utcNow());
}

/** Create the payment row for a new appointment (idempotent per appointment). */
function ensurePaymentFor(appointment) {
  const existing = getPaymentByAppointment(appointment.id);
  if (existing) return existing;
  const amount = (appointment.consultation_fee || 0) + (appointment.service_fee || 0);
  const publicRef = `PAY-${appointment.public_ref}`;
  const now = utcNow();
  const result = getDb()
    .prepare(
      `INSERT INTO payments (public_ref, appointment_id, method, amount, status, created_at, updated_at)
       VALUES (?, ?, 'baridimob', ?, 'awaiting_payment', ?, ?)`
    )
    .run(publicRef, appointment.id, amount, now, now);
  const payment = getPaymentById(result.lastInsertRowid);
  audit(payment.id, 'system', 'created', { toStatus: 'awaiting_payment', note: `Payment created for ${appointment.public_ref}` });
  return payment;
}

/** Validate an uploaded receipt buffer; returns { ext, mime } or throws. */
function validateReceipt(filename, buffer) {
  if (!buffer || buffer.length === 0) throw validation('Receipt file is required');
  if (buffer.length > RECEIPT_MAX_BYTES) {
    throw new AppError('PAYLOAD_TOO_LARGE', 'Receipt file exceeds 5 MB');
  }
  const ext = path.extname(String(filename || '')).toLowerCase();
  if (!RECEIPT_EXTENSIONS.has(ext)) throw validation('Receipt must be JPG, PNG or PDF');
  // Magic-byte check (do not trust the extension alone).
  const head = buffer.subarray(0, 8);
  const isJpeg = head[0] === 0xff && head[1] === 0xd8;
  const isPng = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47;
  const isPdf = head.toString('ascii', 0, 4) === '%PDF';
  if (!isJpeg && !isPng && !isPdf) throw validation('Receipt file content is not a valid image or PDF');
  const mime = isPdf ? 'application/pdf' : isPng ? 'image/png' : 'image/jpeg';
  return { ext, mime };
}

function saveReceipt(paymentId, filename, buffer) {
  const { ext } = validateReceipt(filename, buffer);
  const name = `payment-${paymentId}${ext}`;
  const target = path.join(receiptsDir(), name);
  fs.writeFileSync(target, buffer);
  return target;
}

/**
 * Submit a payment reference + receipt (patient action).
 * Duplicate transaction references are rejected (unique index + check).
 */
function submitPayment(paymentId, { transactionRef, filename, buffer }) {
  const ref = cleanText(transactionRef, 80);
  if (!ref) throw validation('Transaction reference is required');
  const payment = getPaymentById(paymentId);
  if (payment.status === 'paid') throw conflict('INVALID_STATE', 'This payment is already verified as paid');
  if (payment.status === 'refunded') throw conflict('INVALID_STATE', 'This payment has been refunded');

  const duplicate = getDb()
    .prepare('SELECT id FROM payments WHERE transaction_ref = ? AND id <> ?')
    .get(ref, paymentId);
  if (duplicate) throw conflict('DUPLICATE_PAYMENT', 'This transaction reference has already been submitted');

  const receiptPath = saveReceipt(paymentId, filename, buffer);
  return withTransaction(() => {
    const fresh = getPaymentById(paymentId);
    if (fresh.status === 'paid') throw conflict('INVALID_STATE', 'This payment is already verified as paid');
    getDb()
      .prepare(
        `UPDATE payments SET transaction_ref = ?, receipt_path = ?, status = 'under_verification',
           submitted_at = ?, updated_at = ? WHERE id = ?`
      )
      .run(ref, receiptPath, utcNow(), utcNow(), paymentId);
    audit(paymentId, 'patient', 'submitted', { fromStatus: fresh.status, toStatus: 'under_verification', note: `Reference ${ref}` });
    // Move the appointment into payment verification when applicable.
    const appointment = booking.getAppointmentById(fresh.appointment_id);
    if (appointment.status === 'pending_payment') {
      booking.transition(appointment.id, 'payment_verification', { actor: 'patient', note: 'Payment submitted for verification' });
    }
    return getPaymentById(paymentId);
  });
}

/**
 * Verify (or reject) a payment — authorized verifiers only.
 * `paid` requires an explicit human confirmation that funds were received.
 */
function verifyPayment(paymentId, { decision, verifierId, note = '' }) {
  if (decision !== 'paid' && decision !== 'rejected') {
    throw validation('decision must be paid or rejected');
  }
  return withTransaction(() => {
    const payment = getPaymentById(paymentId);
    if (payment.status !== 'under_verification' && payment.status !== 'submitted') {
      throw conflict('INVALID_STATE', `Cannot verify a payment in status ${payment.status}`);
    }
    const now = utcNow();
    getDb()
      .prepare(
        `UPDATE payments SET status = ?, verified_by = ?, verified_at = ?, verification_note = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(decision, verifierId, now, String(note).slice(0, 1000), now, paymentId);
    audit(paymentId, `user:${verifierId}`, decision === 'paid' ? 'verified_paid' : 'rejected', {
      fromStatus: payment.status,
      toStatus: decision,
      note,
    });
    logAudit({ userId: verifierId, action: `payment.${decision}`, entity: 'payment', entityId: String(paymentId), detail: String(note).slice(0, 500) });

    const appointment = booking.getAppointmentById(payment.appointment_id);
    if (decision === 'paid') {
      if (appointment.status === 'payment_verification') {
        booking.transition(appointment.id, 'pending_doctor_approval', { actor: 'system', note: 'Payment verified; awaiting doctor response' });
        // Automatic confirmation ONLY when the doctor explicitly enabled it (Part 6.2).
        const doctor = getDb().prepare('SELECT auto_confirm FROM doctors WHERE id = ?').get(appointment.doctor_id);
        if (doctor && doctor.auto_confirm) {
          booking.transition(appointment.id, 'confirmed', {
            actor: 'system',
            note: 'Doctor has automatic confirmation enabled',
          });
        }
      }
    } else if (appointment.status === 'payment_verification') {
      booking.transition(appointment.id, 'pending_payment', { actor: 'system', note: 'Payment rejected; patient may resubmit' });
    }
    return getPaymentById(paymentId);
  });
}

function refundPayment(paymentId, { verifierId, note = '' }) {
  return withTransaction(() => {
    const payment = getPaymentById(paymentId);
    if (payment.status !== 'paid') throw conflict('INVALID_STATE', 'Only paid payments can be refunded');
    getDb()
      .prepare('UPDATE payments SET status = ?, verification_note = ?, updated_at = ? WHERE id = ?')
      .run('refunded', String(note).slice(0, 1000), utcNow(), paymentId);
    audit(paymentId, `user:${verifierId}`, 'refunded', { fromStatus: 'paid', toStatus: 'refunded', note });
    return getPaymentById(paymentId);
  });
}

function listPayments({ status = null, doctorId = null, limit = 100 } = {}) {
  const clauses = [];
  const params = [];
  if (status) { clauses.push('p.status = ?'); params.push(status); }
  if (doctorId) { clauses.push('a.doctor_id = ?'); params.push(Number(doctorId)); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const n = Math.min(500, Math.max(1, Number(limit) || 100));
  return getDb()
    .prepare(
      `SELECT p.*, a.public_ref AS appointment_ref, a.doctor_id, a.patient_name
       FROM payments p JOIN appointments a ON a.id = p.appointment_id
       ${where} ORDER BY p.id DESC LIMIT ?`
    )
    .all(...params, n);
}

function paymentSummary() {
  const db = getDb();
  const byStatus = db
    .prepare('SELECT status, COUNT(*) AS n, COALESCE(SUM(amount),0) AS total FROM payments GROUP BY status')
    .all();
  const collected = db
    .prepare("SELECT COALESCE(SUM(amount),0) AS total FROM payments WHERE status = 'paid'")
    .get().total;
  return { byStatus, collected };
}

module.exports = {
  RECEIPT_MAX_BYTES,
  getPaymentByAppointment,
  getPaymentById,
  getPaymentByRef,
  ensurePaymentFor,
  validateReceipt,
  submitPayment,
  verifyPayment,
  refundPayment,
  listPayments,
  paymentSummary,
};
