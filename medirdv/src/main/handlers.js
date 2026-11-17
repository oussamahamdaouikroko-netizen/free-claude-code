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
const payments = require('./services/payments');
const expenses = require('./services/expenses');
const reports = require('./services/reports');
const backup = require('./services/backup');
const chat = require('./services/chat');
const bot = require('./whatsapp/bot');
const sheets = require('./export/sheets');
const auth = require('./services/auth');
const { prescriptionHtml, certificateHtml } = require('./print');
const { AppError } = require('./utils/common');
const { toISODate } = require('./utils/dates');

/** Methods that may be called before the dashboard is unlocked. */
const PUBLIC = new Set([
  'app:bootstrap',
  'app:info',
  'app:demo',
  'auth:status',
  'auth:setup',
  'auth:login',
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
  const { version, dataDir, logFile, wa, printReceipt, dialogs = {}, demo = false, onEvent } = context;
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
    'patients:list': (payload) => patients.list(payload?.search, { limit: payload?.limit }),
    'patients:get': (payload) => ({
      patient: patients.get(payload?.id),
      history: patients.history(payload?.id),
      prescriptions: prescriptions.forPatient(payload?.id),
      certificates: prescriptions.listCertificates({ patientId: payload?.id }),
    }),
    'patients:create': (payload) => patients.create(payload),
    'patients:update': (payload) => patients.update(payload),
    'patients:remove': (payload) => patients.remove(payload?.id),
    'patients:debtors': () => patients.debtors(),

    /* ------------------------------ appointments --------------------------- */
    'appointments:agenda': (payload) => appointments.agenda(payload?.day, payload?.department_id),
    'appointments:day-info': (payload) => appointments.dayInfo(payload?.day, payload?.department_id),
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
    'appointments:status': (payload) => {
      if (payload?.status === 'cancelled') {
        const cancelled = appointments.cancel(payload?.id);
        chat.recordCancelled(cancelled, { delivery: 'local' });
        emit({ type: 'chat', payload: { kind: 'cancelled', appointment_id: cancelled.id } });
        return cancelled;
      }
      return appointments.setStatus(payload?.id, payload?.status);
    },
    'appointments:cancel': (payload) => {
      const cancelled = appointments.cancel(payload?.id);
      chat.recordCancelled(cancelled, { delivery: 'local' });
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
          const sim = bot.handle({
            phone: target.phone,
            text: isAr ? 'إلغاء' : 'ANNULER',
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
      emit({ type: 'chat', payload: { kind: sim.action } });
      return sim;
    },

    /* ------------------- medications & prescriptions ----------------------- */
    'medications:search': (payload) => prescriptions.searchMedications(payload || {}),
    'medications:stats': () => prescriptions.medicationStats(),
    'medications:create': (payload) => prescriptions.createMedication(payload),

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
    'prescriptions:template-remove': (payload) => prescriptions.removeTemplate(payload?.id),

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
