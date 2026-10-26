'use strict';
/**
 * Framework-free action layer (DentaRDV v2.0.0).
 *
 * `createHandlers()` returns the complete action map used by:
 *  - the Electron IPC bridge (src/main/ipc.js);
 *  - the browser demo server (demo/server.js).
 */

const settings = require('./services/settings');
const patients = require('./services/patients');
const appointments = require('./services/appointments');
const treatments = require('./services/treatments');
const payments = require('./services/payments');
const expenses = require('./services/expenses');
const reports = require('./services/reports');
const backup = require('./services/backup');
const chat = require('./services/chat');
const intake = require('./services/intake');
const safety = require('./services/safety');
const nomenclature = require('./services/nomenclature');
const prescriptions = require('./services/prescriptions');
const license = require('./services/license');
const bot = require('./whatsapp/bot');
const sheets = require('./export/sheets');
const auth = require('./services/auth');
const { AppError } = require('./utils/common');
const { toISODate } = require('./utils/dates');

/** Methods that may be called before the dashboard is unlocked. */
const PUBLIC = new Set([
  'app:bootstrap',
  'app:info',
  'app:demo',
  'app:copy-text',
  'auth:status',
  'auth:setup',
  'auth:login',
  'auth:lock',
  'license:status',
  'license:activate',
  'license:machine-code',
]);

/** Write methods gated by an active trial or activated license (Read-Only mode on expiry). */
const WRITE_GATED = new Set([
  'patients:create',
  'patients:update',
  'patients:remove',
  'appointments:create',
  'appointments:update',
  'appointments:reschedule',
  'appointments:status',
  'appointments:cancel',
  'appointments:complete',
  'appointments:confirm',
  'appointments:waiting-handle',
  'treatments:create',
  'treatments:update',
  'treatments:remove',
  'payments:add',
  'payments:pay-debt',
  'payments:remove',
  'expenses:create',
  'expenses:update',
  'expenses:remove',
  'expenses:create-category',
  'prescriptions:create',
  'prescriptions:remove',
  'prescriptions:medication-create',
  'prescriptions:template-create',
  'prescriptions:template-remove',
  'prescriptions:certificate-create',
  'prescriptions:certificate-remove',
  'intake:create',
  'intake:update',
  'intake:confirm',
  'intake:reject',
  'intake:weight-add',
  'nomenclature:import',
]);

function clinicBlock() {
  return {
    name: settings.get('clinic_name'),
    phone: settings.get('clinic_phone'),
    address: settings.get('clinic_address'),
  };
}

function dashboardToday(day = toISODate()) {
  const report = reports.daily(day);
  return {
    day,
    stats: appointments.dayStats(day),
    agenda: appointments.agenda(day),
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
    prescriptionHtml,
    certificateHtml,
    autostart,
    dialogs = {},
    demo = false,
    onEvent,
  } = context;
  const emit = typeof onEvent === 'function' ? onEvent : () => {};

  const requireWa = () => {
    if (!wa) throw new AppError('WA_UNAVAILABLE');
    return wa;
  };

  const notifyRemovalAdvance = (removedAppt) => {
    if (!removedAppt) return [];
    const waConnected = Boolean(wa && wa.publicStatus()?.connected);
    const notifications = appointments.advanceNotificationsAfterRemoval(removedAppt, {
      waConnected,
      resolveLanguage: (phone, fullName) => bot.preferredLanguage(phone, fullName),
    });
    if (waConnected && notifications.length > 0 && typeof wa.notifyQueueAdvance === 'function') {
      wa.notifyQueueAdvance(notifications).catch((err) => {
        console.error('[wa] post-cancel queue notification failed:', err.message);
      });
    }
    if (notifications.length > 0) {
      emit({ type: 'chat', payload: { kind: 'turn_now', count: notifications.length } });
    }
    return notifications;
  };

  return {
    /* ------------------------------ app / auth ----------------------------- */
    'app:bootstrap': () => ({
      clinic_name: settings.get('clinic_name'),
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

    'auth:status': () => auth.status(),
    'auth:setup': (payload) => auth.setup(payload),
    'auth:login': (payload) => auth.login(payload?.password),
    'auth:lock': () => auth.lock(),
    'auth:change-password': (payload) => auth.changePassword(payload),

    /* ------------------------------- licensing ----------------------------- */
    'license:status': () => license.getStatus(),
    'license:machine-code': () => ({ machineCode: license.getMachineCode() }),
    'license:activate': (payload) => {
      const status = license.activate(payload?.code || '');
      emit({ type: 'license', payload: status });
      return status;
    },

    /* ------------------------------- autostart ----------------------------- */
    'autostart:status': () =>
      autostart ? autostart.getStatus() : { supported: false, enabled: false },
    'autostart:set': (payload) =>
      autostart
        ? autostart.setEnabled(Boolean(payload?.enabled))
        : { supported: false, enabled: false },

    /* -------------------------------- settings ----------------------------- */
    'settings:get': () => settings.all(),
    'settings:set': (payload) => {
      const updated = settings.setMany(payload);
      if (autostart && payload?.autostart_enabled !== undefined) {
        autostart.setEnabled(String(payload.autostart_enabled) === '1' || payload.autostart_enabled === true);
      }
      return updated;
    },
    'settings:day-labels': (payload) => settings.dayLabels(payload?.lang),

    /* ------------------------------- dashboard ----------------------------- */
    'dashboard:today': (payload) => dashboardToday(payload?.day),

    /* -------------------------------- patients ----------------------------- */
    'patients:list': (payload) => patients.list(payload?.search, { limit: payload?.limit }),
    'patients:get': (payload) => {
      const pid = payload?.id;
      return {
        patient: patients.get(pid),
        history: patients.history(pid),
        prescriptions: prescriptions.forPatient(pid),
        certificates: prescriptions.listCertificates({ patientId: pid, limit: 30 }),
        intakes: intake.listForPatient(pid, { limit: 15 }),
        pending_intake: intake.latestPendingForPatient(pid),
        weight_history: intake.weightHistory(pid, { limit: 12 }),
      };
    },
    'patients:create': (payload) => patients.create(payload),
    'patients:update': (payload) => patients.update(payload),
    'patients:remove': (payload) => patients.remove(payload?.id),
    'patients:debtors': () => patients.debtors(),

    /* ------------------------------ appointments --------------------------- */
    'appointments:agenda': (payload) => appointments.agenda(payload?.day),
    'appointments:day-info': (payload) => appointments.dayInfo(payload?.day),
    'appointments:next-free-day': (payload) => appointments.findNextFreeDay(payload || {}),
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
    'appointments:confirm': (payload) => appointments.confirmAppointment(payload?.id),
    'appointments:status': (payload) => {
      if (payload?.status === 'cancelled') {
        const cancelled = appointments.cancel(payload?.id);
        chat.recordCancelled(cancelled, { delivery: 'local' });
        emit({ type: 'chat', payload: { kind: 'cancelled', appointment_id: cancelled.id } });
        notifyRemovalAdvance(cancelled);
        return cancelled;
      }
      const updated = appointments.setStatus(payload?.id, payload?.status);
      if (payload?.status === 'no_show') notifyRemovalAdvance(updated);
      return updated;
    },
    'appointments:cancel': (payload) => {
      const cancelled = appointments.cancel(payload?.id);
      chat.recordCancelled(cancelled, { delivery: 'local' });
      emit({ type: 'chat', payload: { kind: 'cancelled', appointment_id: cancelled.id } });
      notifyRemovalAdvance(cancelled);
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

    /* ----------------------- patient pre-visit intake ---------------------- */
    'intake:get': (payload) => intake.get(payload?.id),
    'intake:for-patient': (payload) => ({
      items: intake.listForPatient(payload?.patient_id, { limit: payload?.limit }),
      pending: intake.latestPendingForPatient(payload?.patient_id),
      latest: intake.latestForPatient(payload?.patient_id),
      weights: intake.weightHistory(payload?.patient_id),
    }),
    'intake:for-appointment': (payload) => intake.forAppointment(payload?.appointment_id),
    'intake:create': (payload) => intake.create({ ...payload, source: payload?.source || 'manual', consent: true }),
    'intake:update': (payload) => intake.update(payload?.id, payload),
    'intake:confirm': (payload) =>
      intake.confirmAndApply(payload?.id, {
        reviewed_by: payload?.reviewed_by || settings.get('doctor_name') || 'dentist',
        edits: payload?.edits,
      }),
    'intake:reject': (payload) =>
      intake.reject(payload?.id, {
        reviewed_by: payload?.reviewed_by || settings.get('doctor_name') || 'dentist',
      }),
    'intake:weight-add': (payload) => intake.recordWeight(payload || {}),

    /* -------------------- dental prescriptions & safety -------------------- */
    'prescriptions:medications': (payload) => prescriptions.searchMedications(payload || {}),
    'prescriptions:medication-stats': () => prescriptions.medicationStats(),
    'prescriptions:medication-create': (payload) => prescriptions.createMedication(payload),
    'prescriptions:substitutes': (payload) => nomenclature.findSubstitutes(payload || {}),
    'prescriptions:allergy-check': (payload) =>
      prescriptions.checkAllergyWarnings(payload?.allergies, payload?.items),
    'prescriptions:list': (payload) => prescriptions.list(payload || {}),
    'prescriptions:get': (payload) => prescriptions.get(payload?.id),
    'prescriptions:for-patient': (payload) => prescriptions.forPatient(payload?.patient_id),
    'prescriptions:create': (payload) => prescriptions.create(payload),
    'prescriptions:remove': (payload) => prescriptions.remove(payload?.id),
    'prescriptions:templates': () => prescriptions.listTemplates(),
    'prescriptions:template-create': (payload) => prescriptions.createTemplate(payload),
    'prescriptions:template-remove': (payload) => prescriptions.removeTemplate(payload?.id),
    'prescriptions:certificates': (payload) => prescriptions.listCertificates(payload || {}),
    'prescriptions:certificate-get': (payload) => prescriptions.getCertificate(payload?.id),
    'prescriptions:certificate-create': (payload) => prescriptions.createCertificate(payload),
    'prescriptions:certificate-remove': (payload) => prescriptions.removeCertificate(payload?.id),

    'safety:evaluate': (payload) => safety.evaluatePrescription(payload || {}),
    'safety:pediatric-dose': (payload) => safety.calculatePediatricDose(payload || {}),
    'safety:stats': () => safety.stats(),
    'safety:rules': (payload) => safety.listRules(payload || {}),
    'safety:verify-rule': (payload) => safety.verifyRule(payload || {}),

    'nomenclature:summary': () => nomenclature.nomenclatureSummary(),
    'nomenclature:import': (payload) => nomenclature.importNomenclature(payload || {}),

    /* ------------------------------- mini chat ----------------------------- */
    'chat:feed': (payload) => chat.feed(payload || {}),
    'chat:mark-read': () => chat.markAllRead(),
    'chat:simulate': (payload) => {
      if (!demo) throw new AppError('DEMO_ONLY');
      const mode = payload?.mode || 'custom';
      const today = toISODate();
      const isAr = settings.get('language') === 'ar';

      if (mode === 'cancel_next') {
        const bookedToday = appointments.agenda(today).filter((a) => a.status === 'booked');
        const target = bookedToday[bookedToday.length - 1] || bookedToday[0];
        if (!target) throw new AppError('APPOINTMENT_NOT_FOUND');
        if (target.phone) {
          bot.handle({ phone: target.phone, text: isAr ? 'إلغاء' : 'ANNULER', delivery: 'local' });
          const sim = bot.handle({ phone: target.phone, text: isAr ? 'نعم' : 'OUI', delivery: 'local' });
          notifyRemovalAdvance(target);
          emit({ type: 'chat', payload: { kind: 'cancelled', appointment_id: target.id } });
          return { action: sim.action, appointment: target, reply: sim.reply };
        }
        const cancelled = appointments.cancel(target.id);
        chat.recordCancelled(cancelled, { delivery: 'local' });
        notifyRemovalAdvance(cancelled);
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
        const info = appointments.dayInfo(today);
        const targetDay = info.left > 0 ? today : appointments.findNextFreeDay({ allowSameDay: true }) || today;
        const created = appointments.create({
          patient_id: person.patient.id,
          day: targetDay,
          source: 'whatsapp',
          historical: !settings.isWorkingDay(targetDay),
        });
        const event = chat.recordBooked(created, {
          phone,
          lang: isAr ? 'ar' : 'fr',
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
      if (sim.action === 'cancelled' && sim.appointment) {
        notifyRemovalAdvance(sim.appointment);
      }
      emit({ type: 'chat', payload: { kind: sim.action } });
      return sim;
    },

    /* ------------------------------- treatments ---------------------------- */
    'treatments:list': (payload) => treatments.list(Boolean(payload?.include_inactive)),
    'treatments:create': (payload) => treatments.create(payload),
    'treatments:update': (payload) => treatments.update(payload),
    'treatments:remove': (payload) => treatments.remove(payload?.id),

    /* -------------------------------- payments ----------------------------- */
    'payments:add': (payload) => payments.add(payload),
    'payments:pay-debt': (payload) => payments.payDebt(payload),
    'payments:by-day': (payload) => payments.byDay(payload?.day),
    'payments:by-patient': (payload) => payments.byPatient(payload?.patient_id),
    'payments:remove': (payload) => payments.remove(payload?.id),
    'payments:receipt': (payload) => reports.receipt(payload?.id),

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
      if (!printReceipt) throw new AppError('PRINT_UNAVAILABLE');
      await printReceipt(reports.receipt(payload?.id), 'receipt');
      return { ok: true };
    },
    'print:daily-report': async (payload) => {
      if (!printReceipt) throw new AppError('PRINT_UNAVAILABLE');
      await printReceipt(reports.daily(payload?.day), 'report');
      return { ok: true };
    },
    'print:prescription': async (payload) => {
      if (!printReceipt) throw new AppError('PRINT_UNAVAILABLE');
      const rx = prescriptions.get(payload?.id);
      await printReceipt({ ...rx, clinic: clinicBlock() }, 'prescription', {
        format: payload?.format || 'A4',
        print_mode: payload?.print_mode || rx.print_mode,
      });
      return { ok: true };
    },
    'print:prescription-preview': async (payload) => {
      if (!prescriptionHtml) throw new AppError('PRINT_UNAVAILABLE');
      const rx = prescriptions.get(payload?.id);
      const html = await prescriptionHtml({ ...rx, clinic: clinicBlock() }, {
        format: payload?.format || 'A4',
        print_mode: payload?.print_mode || rx.print_mode,
      });
      return { ok: true, html };
    },
    'print:certificate': async (payload) => {
      if (!printReceipt) throw new AppError('PRINT_UNAVAILABLE');
      const cert = prescriptions.getCertificate(payload?.id);
      await printReceipt({ ...cert, clinic: clinicBlock() }, 'certificate');
      return { ok: true };
    },
    'print:certificate-preview': async (payload) => {
      if (!certificateHtml) throw new AppError('PRINT_UNAVAILABLE');
      const cert = prescriptions.getCertificate(payload?.id);
      const html = await certificateHtml({ ...cert, clinic: clinicBlock() });
      return { ok: true, html };
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

module.exports = { createHandlers, PUBLIC, WRITE_GATED, dashboardToday };
