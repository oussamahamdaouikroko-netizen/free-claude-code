'use strict';
/**
 * Framework-free action layer for MediRDV.
 *
 * `createHandlers()` returns the complete action map used by:
 *  - the Electron IPC bridge (src/main/ipc.js);
 *  - the browser demo server (demo/server.js).
 */

const { getDb } = require('./db');
const settings = require('./services/settings');
const patients = require('./services/patients');
const departments = require('./services/departments');
const appointments = require('./services/appointments');
const treatments = require('./services/treatments');
const prescriptions = require('./services/prescriptions');
const nomenclature = require('./services/nomenclature');
const diagnoses = require('./services/diagnoses');
const emr = require('./services/emr');
const billing = require('./services/billing');
const safety = require('./services/safety');
const intake = require('./services/intake');
const payments = require('./services/payments');
const expenses = require('./services/expenses');
const reports = require('./services/reports');
const backup = require('./services/backup');
const chat = require('./services/chat');
const bot = require('./whatsapp/bot');
const sheets = require('./export/sheets');
const auth = require('./services/auth');
const security = require('./services/security');
const license = require('./services/license');
const autostart = require('./autostart');
const holidays = require('./services/holidays');
const operations = require('./services/operations');
const documents = require('./services/documents');
const {
  prescriptionHtml,
  certificateHtml,
  invoiceHtml,
  referralLetterHtml,
  medicalReportHtml,
  labOrderHtml,
  imagingOrderHtml,
} = require('./print');
const { AppError } = require('./utils/common');
const { toISODate } = require('./utils/dates');

/** Methods that may be called before the dashboard is unlocked. */
const PUBLIC = new Set([
  'app:bootstrap',
  'app:info',
  'app:demo',
  'app:copy-text',
  'license:status',
  'license:activate',
  'auth:status',
  'auth:setup',
  'auth:login',
  'auth:user-login',
  'auth:pin-unlock',
  'auth:lock',
]);

function dashboardToday(day = toISODate(), departmentId = null) {
  const report = reports.daily(day);
  const rxToday = getDb()
    .prepare('SELECT COUNT(*) AS n FROM prescriptions WHERE day = ?')
    .get(day).n;
  return {
    day,
    stats: appointments.dayStats(day, departmentId),
    agenda: appointments.agenda(day, departmentId),
    departments: departments.listActive(),
    prescriptions_today: rxToday || 0,
    money: {
      income: report.income,
      expenses: report.expenses,
      net: report.net,
      unpaid_debts: report.unpaid_debts,
      new_patients: report.new_patients,
      currency: report.currency,
    },
    debtors: patients.debtors().slice(0, 8),
    upcoming_waiting: appointments.waitingList().length,
  };
}

function createHandlers(context) {
  const {
    version,
    dataDir,
    logFile,
    wa,
    printReceipt,
    dialogs = {},
    demo = false,
    onEvent,
    autostartOptions = {},
    onAutostartChanged,
  } = context;
  const emit = typeof onEvent === 'function' ? onEvent : () => {};

  const requireWa = () => {
    if (!wa) throw new AppError('WA_UNAVAILABLE');
    return wa;
  };

  return {
    /* ------------------------------ app / auth ----------------------------- */
    'app:bootstrap': () => ({
      clinic_name: settings.get('clinic_name'),
      doctor_name: settings.get('doctor_name'),
      doctor_specialty: settings.get('doctor_specialty'),
      language: settings.get('language'),
      currency: settings.get('currency'),
      auth: auth.status(),
      license: license.getStatus(),
    }),
    'app:info': () => ({ version, dataDir, logFile: logFile || null, demo }),
    'app:open-data-folder': () => {
      if (dialogs.openPath) dialogs.openPath(dataDir);
      return { ok: true };
    },
    'app:copy-text': (payload) => {
      if (dialogs.copyText) dialogs.copyText(String(payload?.text ?? ''));
      return { ok: true };
    },
    'license:status': () => license.getStatus(),
    'license:activate': (payload) => {
      const status = license.activate(payload?.code);
      emit({ type: 'license_changed', payload: status });
      return status;
    },
    'app:autostart-get': () => autostart.getAutostartStatus(autostartOptions),
    'app:autostart-set': (payload) => {
      const res = autostart.setAutostartEnabled(Boolean(payload?.enabled), autostartOptions);
      if (typeof onAutostartChanged === 'function') onAutostartChanged(res);
      return res;
    },

    'auth:status': () => auth.status(),
    'auth:setup': (payload) => auth.setup(payload),
    'auth:login': (payload) => auth.login(payload?.password),
    'auth:user-login': (payload) => auth.loginUser(payload || {}),
    'auth:pin-unlock': (payload) => auth.unlockPin(payload || {}),
    'auth:lock': () => auth.lock(),
    'auth:change-password': (payload) => auth.changePassword(payload),

    /* ---------------- Phase 7: Users, Audit, Security & 18-07 -------------- */
    'users:list': () => security.listUsers(),
    'users:create': (payload) => security.createUser(payload || {}, auth.currentUser()),
    'users:update': (payload) => security.updateUser(payload || {}, auth.currentUser()),
    'audit:list': (payload) => security.listAuditLog(payload || {}),
    'audit:verify': () => security.verifyAuditChain(),
    'security:encrypted-backup': (payload) => security.createEncryptedBackup(payload || {}),
    'security:verify-backup': (payload) => security.verifyEncryptedBackup(payload || {}),
    'security:restore-encrypted': (payload) => security.restoreEncryptedBackup(payload || {}),
    'security:usb-copy': (payload) => security.copyBackupToUsb(payload || {}),
    'privacy:consents': (payload) => security.listConsents18_07(payload?.patient_id),
    'privacy:consent-record': (payload) => security.recordConsent18_07(payload || {}),
    'privacy:export': (payload) => security.exportPatientData18_07(payload?.patient_id, auth.currentUser()),
    'privacy:anonymize': (payload) =>
      security.anonymizePatient18_07(payload?.patient_id, {
        reason: payload?.reason,
        actor: auth.currentUser(),
      }),

    /* -------------------------------- settings ----------------------------- */
    'settings:get': () => settings.all(),
    'settings:set': (payload) => settings.setMany(payload),
    'settings:day-labels': (payload) => settings.dayLabels(payload?.lang),

    /* ------------------------------- departments --------------------------- */
    'departments:list': (payload) => departments.list(Boolean(payload?.include_inactive)),
    'departments:get': (payload) => departments.get(payload?.id),
    'departments:create': (payload) => departments.create(payload),
    'departments:update': (payload) => departments.update(payload),
    'departments:remove': (payload) => departments.remove(payload?.id),

    /* ------------------------------- dashboard ----------------------------- */
    'dashboard:today': (payload) => dashboardToday(payload?.day, payload?.department_id),

    /* -------------------------------- patients ----------------------------- */
    'patients:list': (payload) => patients.list(payload?.search, { limit: payload?.limit, today: payload?.today }),
    'patients:by-day': (payload) => patients.byDayGroups(payload || {}),
    'patients:get': (payload) => ({
      patient: patients.get(payload?.id),
      history: patients.history(payload?.id),
      prescriptions: prescriptions.forPatient(payload?.id),
      certificates: prescriptions.listCertificates({ patientId: payload?.id }),
      intakes: intake.listForPatient(payload?.id),
      pending_intake: intake.latestPendingForPatient(payload?.id),
      weight_history: intake.weightHistory(payload?.id),
    }),
    'patients:create': (payload) => patients.create(payload),
    'patients:update': (payload) => patients.update(payload),
    'patients:remove': (payload) => patients.remove(payload?.id),
    'patients:debtors': () => patients.debtors(),

    /* ----------------------------- patient intake -------------------------- */
    'intake:create': (payload) => {
      const created = intake.create(payload || {});
      emit({ type: 'intake', payload: { kind: 'created', id: created.id, patient_id: created.patient_id } });
      return created;
    },
    'intake:get': (payload) => intake.get(payload?.id),
    'intake:update': (payload) => intake.update(payload?.id, payload?.patch || payload || {}),
    'intake:confirm': (payload) => {
      const result = intake.confirmAndApply(payload?.id, {
        reviewed_by: payload?.reviewed_by,
        edits: payload?.edits,
      });
      emit({ type: 'intake', payload: { kind: 'confirmed', id: result.intake.id, patient_id: result.patient.id } });
      return result;
    },
    'intake:reject': (payload) => {
      const rejected = intake.reject(payload?.id, { reviewed_by: payload?.reviewed_by });
      emit({ type: 'intake', payload: { kind: 'rejected', id: rejected.id, patient_id: rejected.patient_id } });
      return rejected;
    },
    'intake:for-patient': (payload) => intake.listForPatient(payload?.patient_id, { limit: payload?.limit }),
    'intake:latest': (payload) => intake.latestForPatient(payload?.patient_id),
    'intake:pending': (payload) => intake.latestPendingForPatient(payload?.patient_id),
    'intake:for-appointment': (payload) => intake.forAppointment(payload?.appointment_id),
    'intake:weight-history': (payload) => intake.weightHistory(payload?.patient_id, { limit: payload?.limit }),
    'intake:record-weight': (payload) => intake.recordWeight(payload || {}),

    /* ----------------- Phase 5: Structured Medical Record ------------------ */
    'emr:consultation-create': (payload) => emr.createConsultation(payload || {}),
    'emr:consultations': (payload) => emr.listConsultations(payload?.patient_id),
    'emr:consultation-remove': (payload) => emr.removeConsultation(payload?.id),
    'emr:doc-attach': (payload) => emr.attachDocument(payload || {}),
    'emr:docs': (payload) => emr.listDocuments(payload?.patient_id),
    'emr:doc-read': (payload) => emr.readDocument(payload?.id),
    'emr:doc-remove': (payload) => emr.removeDocument(payload?.id),
    'emr:lab-order': (payload) => emr.createLabOrder(payload || {}),
    'emr:lab-result': (payload) => emr.addLabResult(payload || {}),
    'emr:labs': (payload) => emr.listLabs(payload?.patient_id),
    'emr:imaging-order': (payload) => emr.createImagingOrder(payload || {}),
    'emr:imaging-update': (payload) => emr.updateImagingOrder(payload || {}),
    'emr:imaging': (payload) => emr.listImaging(payload?.patient_id),
    'emr:vaccinations': (payload) => emr.listVaccinations(payload?.patient_id),
    'emr:vaccination-record': (payload) => emr.recordVaccination(payload || {}),
    'emr:pregnancy-create': (payload) => emr.createPregnancyEpisode(payload || {}),
    'emr:pregnancy-visit': (payload) => emr.addPregnancyVisit(payload || {}),
    'emr:pregnancy': (payload) => emr.listPregnancy(payload?.patient_id),
    'emr:who-growth': (payload) => emr.computeWhoGrowth(payload || {}),
    'emr:vitals-trends': (payload) => emr.vitalsTrends(payload?.patient_id),
    'emr:timeline': (payload) => emr.patientTimeline(payload?.patient_id),

    /* ------------------------------ appointments --------------------------- */
    'appointments:agenda': (payload) => appointments.agenda(payload?.day, payload?.department_id),
    'appointments:day-info': (payload) => appointments.dayInfo(payload?.day, payload?.department_id),
    'appointments:next-free-day': (payload) => appointments.findNextFreeDay(payload || {}),
    'appointments:available-days': (payload) => appointments.listAvailableDays(payload || {}),
    'appointments:check-day': (payload) =>
      appointments.checkDayAvailability(payload?.day, payload?.department_id, payload || {}),
    'appointments:range': (payload) => appointments.listRange(payload?.start, payload?.end),
    'appointments:create': (payload) => {
      const created = appointments.create(payload);
      if (!payload?.historical && created?.status === 'booked') {
        chat.recordBooked(created, { delivery: 'local' });
        emit({ type: 'chat', payload: { kind: 'booked', appointment_id: created.id } });
      }
      return created;
    },
    'appointments:update': (payload) => appointments.updateDetails(payload),
    'appointments:reschedule': (payload) => appointments.reschedule(payload),
    'appointments:status': (payload) => {
      const prev = payload?.id ? appointments.get(payload.id) : null;
      const waConnected = Boolean(wa && wa.publicStatus()?.connected);
      if (payload?.status === 'cancelled') {
        const cancelled = appointments.cancel(payload?.id);
        chat.recordCancelled(cancelled, { delivery: 'local' });
        if (prev?.status === 'booked') {
          const updates = appointments.advanceNotificationsAfterRemoval(cancelled, {
            waConnected,
            resolveLanguage: (phone, fullName) => bot.preferredLanguage(phone, fullName),
          });
          if (waConnected && updates.length > 0 && typeof wa.notifyQueueAdvance === 'function') {
            wa.notifyQueueAdvance(updates).catch((error) => {
              console.error('[wa] queue notification failed:', error.message);
            });
          }
        }
        emit({ type: 'chat', payload: { kind: 'cancelled', appointment_id: cancelled.id } });
        return cancelled;
      }
      if (payload?.status === 'done' && prev?.status === 'booked') {
        const result = appointments.completeAndAdvance(payload?.id, {
          waConnected,
          resolveLanguage: (phone, fullName) => bot.preferredLanguage(phone, fullName),
        });
        if (waConnected && result.notifications.length > 0 && typeof wa.notifyQueueAdvance === 'function') {
          wa.notifyQueueAdvance(result.notifications).catch((error) => {
            console.error('[wa] queue notification failed:', error.message);
          });
        }
        emit({ type: 'chat', payload: { kind: 'turn_now', count: result.notifications.length } });
        return result.appointment;
      }
      const updated = appointments.setStatus(payload?.id, payload?.status);
      if (payload?.status === 'no_show' && prev?.status === 'booked') {
        const updates = appointments.advanceNotificationsAfterRemoval(updated, {
          waConnected,
          resolveLanguage: (phone, fullName) => bot.preferredLanguage(phone, fullName),
        });
        if (waConnected && updates.length > 0 && typeof wa.notifyQueueAdvance === 'function') {
          wa.notifyQueueAdvance(updates).catch((error) => {
            console.error('[wa] queue notification failed:', error.message);
          });
        }
      }
      return updated;
    },
    'appointments:cancel': (payload) => {
      const prev = payload?.id ? appointments.get(payload.id) : null;
      const waConnected = Boolean(wa && wa.publicStatus()?.connected);
      const cancelled = appointments.cancel(payload?.id);
      chat.recordCancelled(cancelled, { delivery: 'local' });
      if (prev?.status === 'booked') {
        const updates = appointments.advanceNotificationsAfterRemoval(cancelled, {
          waConnected,
          resolveLanguage: (phone, fullName) => bot.preferredLanguage(phone, fullName),
        });
        if (waConnected && updates.length > 0 && typeof wa.notifyQueueAdvance === 'function') {
          wa.notifyQueueAdvance(updates).catch((error) => {
            console.error('[wa] queue notification failed:', error.message);
          });
        }
      }
      emit({ type: 'chat', payload: { kind: 'cancelled', appointment_id: cancelled.id } });
      return cancelled;
    },
    'appointments:complete': (payload) => {
      const waConnected = Boolean(wa && wa.publicStatus()?.connected);
      const result = appointments.completeAndAdvance(payload?.id, {
        waConnected,
        resolveLanguage: (phone, fullName) => bot.preferredLanguage(phone, fullName),
      });
      if (waConnected && result.notifications.length > 0 && typeof wa.notifyQueueAdvance === 'function') {
        wa.notifyQueueAdvance(result.notifications).catch((error) => {
          console.error('[wa] queue notification failed:', error.message);
        });
      }
      emit({ type: 'chat', payload: { kind: 'turn_now', count: result.notifications.length } });
      return result;
    },
    'appointments:waiting-list': () => appointments.waitingList(),
    'appointments:waiting-handle': (payload) => appointments.markWaitingHandled(payload?.id),
    'appointments:confirm': (payload) => appointments.confirmAppointment(payload?.id),

    /* ---------------- Phase 8: Scheduling, Inventory & HR ------------------ */
    'ops:closures': (payload) => operations.listClosures(payload || {}),
    'ops:closure-add': (payload) => operations.addClosure(payload || {}),
    'ops:closure-delete': (payload) => operations.deleteClosure(payload?.id),
    'ops:holidays-seed': (payload) => operations.seedAlgerianHolidays(payload?.year),
    'ops:slots': (payload) => operations.availableSlots(payload?.day, payload?.department_id),
    'ops:noshow-stats': (payload) => operations.noShowStats(payload || {}),
    'ops:waiting-room': (payload) => operations.waitingRoomBoard(payload?.day, payload?.department_id),
    'ops:inventory': () => operations.listInventory(),
    'ops:inventory-upsert': (payload) => operations.upsertInventoryItem(payload || {}),
    'ops:inventory-move': (payload) => operations.recordMovement(payload || {}),
    'ops:inventory-alerts': (payload) => operations.inventoryAlerts(payload?.day),
    'ops:treatment-consumables': (payload) =>
      operations.setTreatmentConsumables(payload?.treatment_id, payload?.links || []),
    'ops:staff': (payload) => operations.listStaff(Boolean(payload?.include_inactive)),
    'ops:staff-upsert': (payload) => operations.upsertStaff(payload || {}),
    'ops:attendance': (payload) => operations.listAttendance(payload?.day),
    'ops:attendance-record': (payload) => operations.recordAttendance(payload || {}),
    'ops:payroll': (payload) => operations.listPayroll(payload?.period_month),
    'ops:payroll-run': (payload) => operations.runPayroll(payload || {}),
    'ops:rooms': () => operations.listRooms(),
    'ops:room-upsert': (payload) => operations.upsertRoom(payload || {}),
    'ops:room-delete': (payload) => operations.deleteRoom(payload?.id),

    /* ---------------- Phase 9: Clinical Documents & Printouts -------------- */
    'docs:create': (payload) => documents.createDocument(payload || {}),
    'docs:get': (payload) => documents.getDocument(payload?.id),
    'docs:list': (payload) => documents.listForPatient(payload?.patient_id),
    'docs:html': (payload) => ({ html: documents.renderDocumentHtml(payload?.id, payload?.options) }),
    'docs:lab-html': (payload) => ({ html: documents.renderLabOrderHtml(payload?.id, payload?.options) }),
    'docs:imaging-html': (payload) => ({ html: documents.renderImagingOrderHtml(payload?.id, payload?.options) }),
    'print:clinical-doc': async (payload) => {
      const doc = documents.getDocument(payload?.id);
      const clinic = reports.clinicProfile();
      if (doc.doc_type === 'referral') return printReceipt({ doc, clinic }, 'referral');
      if (doc.doc_type === 'medical_report') return printReceipt({ doc, clinic }, 'medical_report');
      return printReceipt(
        {
          certificate: {
            id: doc.id,
            kind:
              doc.doc_type === 'cert_fitness_sports'
                ? 'fitness_sports'
                : doc.doc_type === 'cert_school'
                  ? 'school'
                  : 'vaccination',
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
        },
        'certificate',
      );
    },

    /* ------------------------------- mini chat ----------------------------- */
    'chat:feed': (payload) => chat.feed(payload || {}),
    'chat:mark-read': () => chat.markAllRead(),
    'chat:simulate': (payload) => {
      if (!demo) throw new AppError('DEMO_ONLY');
      const mode = payload?.mode || 'custom';
      const today = toISODate();
      const curLang = settings.get('language');
      const isAr = curLang === 'ar';
      const isEn = curLang === 'en';

      if (mode === 'cancel_next') {
        const bookedToday = appointments.agenda(today).filter((a) => a.status === 'booked');
        const target = bookedToday[bookedToday.length - 1] || bookedToday[0];
        if (!target) throw new AppError('APPOINTMENT_NOT_FOUND');
        if (target.phone) {
          bot.handle({
            phone: target.phone,
            text: isAr ? 'إلغاء' : isEn ? 'CANCEL' : 'ANNULER',
            delivery: 'local',
          });
          const sim = bot.handle({
            phone: target.phone,
            text: isAr ? 'نعم' : isEn ? 'YES' : 'OUI',
            delivery: 'local',
          });
          emit({ type: 'chat', payload: { kind: 'cancelled', appointment_id: target.id } });
          return { action: sim.action, appointment: target, reply: sim.reply };
        }
        const cancelled = appointments.cancel(target.id);
        chat.recordCancelled(cancelled, { delivery: 'local' });
        emit({ type: 'chat', payload: { kind: 'cancelled', appointment_id: cancelled.id } });
        return { action: 'cancelled', appointment: cancelled };
      }

      if (mode === 'book_new') {
        const names = isAr
          ? ['سليم بوعلام', 'مريم بن عيسى', 'رشيد حمدان', 'سميرة لعريبي', 'وليد قاسي']
          : ['Salim Boualem', 'Meriem Benaissa', 'Rachid Hamdane', 'Samira Laribi', 'Walid Kaci'];
        const suffix = String(Math.floor(100000 + Math.random() * 899999));
        const phone = `0559${suffix}`;
        const name = names[Math.floor(Math.random() * names.length)];
        const person = patients.upsertFromWhatsApp({ name, phone });
        const activeDepts = departments.listActive();
        const chosenDept =
          activeDepts.length > 0
            ? activeDepts[Math.floor(Math.random() * activeDepts.length)]
            : null;
        const deptId = chosenDept ? chosenDept.id : null;
        const info = appointments.dayInfo(today, deptId);
        const targetDay =
          info.left > 0
            ? today
            : appointments.findNextFreeDay({ allowSameDay: true, departmentId: deptId }) || today;
        const created = appointments.create({
          patient_id: person.patient.id,
          department_id: deptId,
          day: targetDay,
          source: 'whatsapp',
          historical: !departments.isWorkingDay(deptId, targetDay),
        });
        const event = chat.recordBooked(created, {
          phone,
          lang: isAr ? 'ar' : isEn ? 'en' : 'fr',
          delivery: 'local',
        });
        emit({ type: 'chat', payload: { kind: 'booked', appointment_id: created.id } });
        return { action: 'booked', appointment: created, chatEvent: event };
      }

      const sim = bot.handle({
        phone: String(payload?.phone || '0555999888'),
        text: String(payload?.text || ''),
        delivery: 'local',
      });
      emit({ type: 'chat', payload: { kind: sim.action } });
      return sim;
    },

    /* ------------------- medications & prescriptions ----------------------- */
    'medications:search': (payload) => prescriptions.searchMedications(payload || {}),
    'medications:stats': () => prescriptions.medicationStats(),
    'medications:create': (payload) => prescriptions.createMedication(payload),
    'medications:substitutes': (payload) => nomenclature.findSubstitutes(payload || {}),
    'nomenclature:import': (payload) => nomenclature.importNomenclature(payload || {}),
    'nomenclature:summary': () => nomenclature.nomenclatureSummary(),

    'prescriptions:list': (payload) => prescriptions.list(payload || {}),
    'prescriptions:get': (payload) => prescriptions.get(payload?.id),
    'prescriptions:for-patient': (payload) => prescriptions.forPatient(payload?.patient_id),
    'prescriptions:create': (payload) => prescriptions.create(payload),
    'prescriptions:remove': (payload) => prescriptions.remove(payload?.id),
    'prescriptions:html': (payload) => ({
      html: prescriptionHtml({
        prescription: prescriptions.get(payload?.id),
        clinic: reports.clinicProfile(),
      }),
    }),
    'prescriptions:templates': () => prescriptions.listTemplates(),
    'prescriptions:template-create': (payload) => prescriptions.createTemplate(payload),
    'prescriptions:template-update': (payload) => prescriptions.updateTemplate(payload?.id, payload),
    'prescriptions:template-remove': (payload) => prescriptions.removeTemplate(payload?.id),

    /* ----------------------- ICD-10 & diagnosis stats ---------------------- */
    'icd10:search': (payload) => diagnoses.searchIcd10(getDb(), payload || {}),
    'icd10:upsert': (payload) => diagnoses.upsertIcd10(getDb(), payload || {}),
    'icd10:import': (payload) => diagnoses.importIcd10(getDb(), payload || {}),
    'icd10:verify': (payload) => diagnoses.verifyIcd10(getDb(), payload || {}),
    'icd10:summary': () => diagnoses.icd10Summary(getDb()),
    'diagnoses:stats': (payload) => diagnoses.diagnosisStats(getDb(), payload || {}),

    /* --------------------- clinical safety & dose engine ------------------- */
    'safety:evaluate': (payload) => safety.evaluatePrescription(payload || {}),
    'safety:pediatric-dose': (payload) => safety.calculatePediatricDose(payload || {}),
    'safety:rules-list': (payload) => safety.listRules(payload || {}),
    'safety:rules-import': (payload) => safety.importRules(payload || {}),
    'safety:rule-verify': (payload) => safety.verifyRule(payload || {}),
    'safety:stats': () => safety.stats(),
    'safety:audit': (payload) => safety.getAuditForPrescription(payload?.prescription_id),

    'certificates:list': (payload) => prescriptions.listCertificates(payload || {}),
    'certificates:get': (payload) => prescriptions.getCertificate(payload?.id),
    'certificates:create': (payload) => prescriptions.createCertificate(payload),
    'certificates:remove': (payload) => prescriptions.removeCertificate(payload?.id),
    'certificates:html': (payload) => ({
      html: certificateHtml({
        certificate: prescriptions.getCertificate(payload?.id),
        clinic: reports.clinicProfile(),
      }),
    }),

    /* ------------------------------- treatments ---------------------------- */
    'treatments:list': (payload) => treatments.list(Boolean(payload?.include_inactive)),
    'treatments:create': (payload) => treatments.create(payload),
    'treatments:update': (payload) => treatments.update(payload),
    'treatments:remove': (payload) => treatments.remove(payload?.id),

    /* -------------------------------- payments ----------------------------- */
    'payments:add': (payload) => payments.add(payload),
    'secretary:confirm-payment': (payload) => {
      const res = payments.confirmAppointmentPayment({
        ...(payload || {}),
        actor: auth.currentUser(),
      });
      emit({
        type: 'payment',
        payload: {
          appointment_id: res.appointment?.id || payload?.appointment_id,
          payment_id: res.payment?.id || null,
          already_paid: Boolean(res.already_paid),
        },
      });
      return res;
    },
    'payments:pay-debt': (payload) => payments.payDebt(payload),
    'payments:by-day': (payload) => payments.byDay(payload?.day),
    'payments:by-patient': (payload) => payments.byPatient(payload?.patient_id),
    'payments:remove': (payload) => payments.remove(payload?.id),
    'payments:receipt': (payload) => reports.receipt(payload?.id),

    /* -------------- Phase 6: Billing, CNAS/CASNOS & Invoices --------------- */
    'billing:preview': (payload) => billing.previewCoverage(payload || {}),
    'billing:invoice-create': (payload) => billing.createInvoice(payload || {}),
    'billing:invoice-get': (payload) => billing.getInvoice(payload?.id),
    'billing:invoices': (payload) => billing.listInvoices(payload || {}),
    'billing:invoice-html': (payload) => ({
      html: invoiceHtml({
        invoice: billing.getInvoice(payload?.id),
        clinic: reports.clinicProfile(),
      }),
    }),
    'billing:refund': (payload) => billing.recordRefund(payload || {}),
    'billing:z-report': (payload) => billing.dailyZReport(payload?.day),
    'billing:claims-export': (payload) => billing.exportInsuranceClaims(payload || {}),

    /* -------------------------------- expenses ----------------------------- */
    'expenses:categories': () => expenses.categories(),
    'expenses:list': (payload) => expenses.list(payload || {}),
    'expenses:create': (payload) => expenses.create(payload),
    'expenses:update': (payload) => expenses.update(payload),
    'expenses:remove': (payload) => expenses.remove(payload?.id),
    'expenses:by-category': (payload) => expenses.byCategory(payload?.start, payload?.end),
    'expenses:create-category': (payload) => expenses.createCategory(payload),

    /* --------------------------------- reports ----------------------------- */
    'reports:daily': (payload) => reports.daily(payload?.day),
    'reports:monthly': (payload) => reports.monthly(payload?.month),

    /* ------------------- doctor holidays / sick-leave days ----------------- */
    'holidays:list': (payload) => holidays.list(payload || {}),
    'holidays:create': (payload) => holidays.create(payload || {}),
    'holidays:remove': (payload) => holidays.remove(payload?.id),

    /* --------------------------------- backups ----------------------------- */
    'backup:list': () => backup.list(),
    'backup:create': () => backup.create({ reason: 'manual' }),
    'backup:restore': (payload) => {
      if (!payload?.file) throw new AppError('BACKUP_NOT_FOUND');
      return backup.restore(payload.file);
    },
    'backup:restore-dialog': async () => {
      if (!dialogs.chooseBackup) return { canceled: true };
      const chosen = await dialogs.chooseBackup();
      if (chosen.canceled || !chosen.file) return { canceled: true };
      return { ...backup.restore(chosen.file), restored_from: chosen.file };
    },
    'backup:export': async () => {
      if (!dialogs.saveBackup) return { canceled: true };
      const target = await dialogs.saveBackup();
      if (target.canceled || !target.file) return { canceled: true };
      backup.backupTo(target.file);
      return { ok: true, file: target.file };
    },
    'backup:reveal': () => {
      if (dialogs.openPath) dialogs.openPath(backup.backupsDir());
      return { ok: true };
    },

    /* ---------------------------- spreadsheet export ------------------------ */
    'export:sheet': async (payload) => {
      const kind = ['daily', 'monthly', 'full'].includes(payload?.kind) ? payload.kind : 'daily';
      const workbook = sheets.build(kind, payload?.day || payload?.month);
      if (!dialogs.saveExport) {
        return {
          ok: true,
          canceled: false,
          filename: workbook.filename,
          sheets: workbook.sheets,
          base64: workbook.buffer.toString('base64'),
        };
      }
      const target = await dialogs.saveExport(workbook.filename);
      if (target?.canceled || !target?.file) return { canceled: true };
      require('node:fs').writeFileSync(target.file, workbook.buffer);
      return { ok: true, file: target.file, filename: workbook.filename, sheets: workbook.sheets };
    },
    'export:clipboard': (payload) => ({
      ok: true,
      tsv: sheets.clipboardTable(payload?.kind === 'monthly' ? 'monthly' : 'daily', payload?.day || payload?.month),
    }),
    'export:reveal': (payload) => {
      if (payload?.file && dialogs.openPath) {
        dialogs.openPath(require('node:path').dirname(payload.file));
      }
      return { ok: true };
    },
    'app:copy-text': (payload) => {
      if (!dialogs.copyText) throw new AppError('CLIPBOARD_UNAVAILABLE');
      dialogs.copyText(payload?.text ?? '');
      return { ok: true };
    },

    /* -------------------------------- printing ----------------------------- */
    'print:receipt': async (payload) => {
      const data = reports.receipt(payload?.id);
      if (!printReceipt) throw new AppError('PRINT_UNAVAILABLE');
      await printReceipt(data, 'receipt');
      return { ok: true };
    },
    'print:daily-report': async (payload) => {
      const data = reports.daily(payload?.day);
      if (!printReceipt) throw new AppError('PRINT_UNAVAILABLE');
      await printReceipt(data, 'report');
      return { ok: true };
    },
    'print:prescription': async (payload) => {
      const doc = {
        prescription: prescriptions.get(payload?.id),
        clinic: reports.clinicProfile(),
      };
      if (!printReceipt) return { ok: true, fallback: true, html: prescriptionHtml(doc) };
      await printReceipt(doc, 'prescription');
      return { ok: true };
    },
    'print:certificate': async (payload) => {
      const doc = {
        certificate: prescriptions.getCertificate(payload?.id),
        clinic: reports.clinicProfile(),
      };
      if (!printReceipt) return { ok: true, fallback: true, html: certificateHtml(doc) };
      await printReceipt(doc, 'certificate');
      return { ok: true };
    },
    'print:invoice': async (payload) => {
      const doc = {
        invoice: billing.getInvoice(payload?.id),
        clinic: reports.clinicProfile(),
      };
      if (!printReceipt) return { ok: true, fallback: true, html: invoiceHtml(doc) };
      await printReceipt(doc, 'invoice');
      return { ok: true };
    },

    /* -------------------------------- whatsapp ----------------------------- */
    'wa:status': () => (wa ? wa.publicStatus() : { state: 'unavailable' }),
    'wa:start': async () => {
      settings.set('bot_enabled', '1');
      return requireWa().start();
    },
    'wa:stop': async () => {
      settings.set('bot_enabled', '0');
      return requireWa().stop({ logout: false });
    },
    'wa:logout': () => requireWa().stop({ logout: true }),
    'wa:preview': () => (wa ? wa.reminderPreview() : []),
    'wa:reminders-now': () => (wa ? wa.sendReminders({ force: true }) : { skipped: 'not_connected' }),
  };
}

module.exports = { createHandlers, PUBLIC, dashboardToday };
