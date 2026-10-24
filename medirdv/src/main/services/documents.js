'use strict';
/**
 * Phase 9 — Clinical Documents & Printouts Service:
 *  - Referral letter (Lettre d'orientation / رسالة توجيه)
 *  - Medical report (Compte-rendu médical / تقرير طبي)
 *  - Sports fitness, school & vaccination certificates
 *  - Lab & imaging request HTML printouts
 */

const { getDb } = require('../db');
const patients = require('./patients');
const departments = require('./departments');
const settings = require('./settings');
const reports = require('./reports');
const { buildVerificationToken } = require('../utils/qr');
const {
  certificateHtml,
  referralLetterHtml,
  medicalReportHtml,
  labOrderHtml,
  imagingOrderHtml,
} = require('../print');
const { AppError, cleanText, nowLocal, requireId } = require('../utils/common');
const { isValidISODate, toISODate } = require('../utils/dates');

const DOC_TYPES = [
  'referral',
  'medical_report',
  'cert_fitness_sports',
  'cert_school',
  'cert_vaccination',
];

function createDocument(input = {}) {
  const db = getDb();
  let patient = null;
  if (input.patient_id) {
    patient = patients.get(input.patient_id);
  }
  const patientName = cleanText(input.patient_name || patient?.full_name, 120);
  if (!patientName) throw new AppError('PATIENT_NAME_REQUIRED');

  const docType = DOC_TYPES.includes(input.doc_type) ? input.doc_type : 'medical_report';
  const day = isValidISODate(input.day) ? input.day : toISODate();
  const dept = departments.getOptional(input.department_id);
  const doctorName = cleanText(input.doctor_name || dept?.doctor_name || settings.get('doctor_name'), 100);
  const doctorSpecialty = cleanText(
    input.doctor_specialty || dept?.specialty || settings.get('doctor_specialty'),
    120,
  );
  const doctorOrdre = cleanText(input.doctor_ordre || settings.get('doctor_ordre'), 60);

  const info = db
    .prepare(
      `INSERT INTO clinical_documents
        (patient_id, patient_name, patient_age, department_id, doc_type, day,
         doctor_name, doctor_specialty, doctor_ordre, recipient_doctor, specialty_target,
         clinical_summary, findings, conclusion, verification_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?)`,
    )
    .run(
      patient ? patient.id : null,
      patientName,
      cleanText(input.patient_age, 40),
      dept ? dept.id : null,
      docType,
      day,
      doctorName,
      doctorSpecialty,
      doctorOrdre,
      cleanText(input.recipient_doctor, 120),
      cleanText(input.specialty_target, 120),
      cleanText(input.clinical_summary, 2000),
      cleanText(input.findings, 2000),
      cleanText(input.conclusion, 1500),
      nowLocal(),
    );
  const id = info.lastInsertRowid;
  const token = buildVerificationToken(
    docType === 'referral' ? 'REF' : docType === 'medical_report' ? 'RPT' : 'CERT',
    id,
    `${day}|${docType}`,
  );
  db.prepare('UPDATE clinical_documents SET verification_hash = ? WHERE id = ?').run(token, id);
  return getDocument(id);
}

function getDocument(id) {
  const row = getDb().prepare('SELECT * FROM clinical_documents WHERE id = ?').get(requireId(id));
  if (!row) throw new AppError('NOT_FOUND');
  return row;
}

function listForPatient(patientId) {
  return getDb()
    .prepare('SELECT * FROM clinical_documents WHERE patient_id = ? ORDER BY day DESC, id DESC')
    .all(requireId(patientId, 'patient_id'));
}

function renderDocumentHtml(id, options = {}) {
  const doc = getDocument(id);
  const clinic = { ...reports.clinicProfile(), ...options };
  if (doc.doc_type === 'referral') {
    return referralLetterHtml({ doc, clinic });
  }
  if (doc.doc_type === 'medical_report') {
    return medicalReportHtml({ doc, clinic });
  }
  const kindMap = {
    cert_fitness_sports: 'fitness_sports',
    cert_school: 'school',
    cert_vaccination: 'vaccination',
  };
  return certificateHtml({
    certificate: {
      id: doc.id,
      kind: kindMap[doc.doc_type] || 'general',
      patient_name: doc.patient_name,
      patient_age: doc.patient_age,
      day: doc.day,
      doctor_name: doc.doctor_name,
      doctor_specialty: doc.doctor_specialty,
      doctor_ordre: doc.doctor_ordre,
      content: [doc.clinical_summary, doc.findings, doc.conclusion].filter(Boolean).join('\n\n'),
      verification_hash: doc.verification_hash,
    },
    clinic,
  });
}

function renderLabOrderHtml(labOrderId, options = {}) {
  const order = getDb().prepare('SELECT * FROM lab_orders WHERE id = ?').get(requireId(labOrderId));
  if (!order) throw new AppError('NOT_FOUND');
  const patient = patients.get(order.patient_id);
  const clinic = { ...reports.clinicProfile(), ...options };
  return labOrderHtml({ order, patient, clinic });
}

function renderImagingOrderHtml(imagingOrderId, options = {}) {
  const order = getDb()
    .prepare('SELECT * FROM imaging_orders WHERE id = ?')
    .get(requireId(imagingOrderId));
  if (!order) throw new AppError('NOT_FOUND');
  const patient = patients.get(order.patient_id);
  const clinic = { ...reports.clinicProfile(), ...options };
  return imagingOrderHtml({ order, patient, clinic });
}

module.exports = {
  DOC_TYPES,
  createDocument,
  getDocument,
  listForPatient,
  renderDocumentHtml,
  renderLabOrderHtml,
  renderImagingOrderHtml,
};
