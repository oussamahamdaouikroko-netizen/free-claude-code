'use strict';
/**
 * Framework-free action layer.
 *
 * `createHandlers()` returns the complete action map used by:
 *  - the Electron IPC bridge (src/main/ipc.js);
 *  - the browser demo server (demo/server.js).
 *
 * Nothing here imports Electron: dialogs, printing and the WhatsApp service
 * are injected, which keeps the business surface testable and reusable.
 */

const settings = require('./services/settings');
const patients = require('./services/patients');
const appointments = require('./services/appointments');
const treatments = require('./services/treatments');
const payments = require('./services/payments');
const expenses = require('./services/expenses');
const reports = require('./services/reports');
const backup = require('./services/backup');
const auth = require('./services/auth');
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

/**
 * @param {{
 *   version: string,
 *   dataDir: string,
 *   printReceipt?: (data: object, kind?: string) => Promise<object>,
 *   wa: { publicStatus():object, start():Promise<object>, stop(options?:object):Promise<object>,
 *         reminderPreview():object[], sendReminders(options?:object):Promise<object> },
 *   dialogs?: {
 *     chooseBackup?: () => Promise<{canceled:boolean, file?:string}>,
 *     saveBackup?: () => Promise<{canceled:boolean, file?:string}>,
 *     openPath?: (target:string) => void,
 *   },
 *   demo?: boolean,
 * }} context
 */
function createHandlers(context) {
  const { version, dataDir, logFile, wa, printReceipt, dialogs = {}, demo = false } = context;

  const requireWa = () => {
    if (!wa) throw new AppError('WA_UNAVAILABLE');
    return wa;
  };

  return {
    /* ------------------------------ app / auth ----------------------------- */
    'app:bootstrap': () => ({
      clinic_name: settings.get('clinic_name'),
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

    /* ------------------------------- dashboard ----------------------------- */
    'dashboard:today': (payload) => dashboardToday(payload?.day),

    /* -------------------------------- patients ----------------------------- */
    'patients:list': (payload) => patients.list(payload?.search, { limit: payload?.limit }),
    'patients:get': (payload) => ({
      patient: patients.get(payload?.id),
      history: patients.history(payload?.id),
    }),
    'patients:create': (payload) => patients.create(payload),
    'patients:update': (payload) => patients.update(payload),
    'patients:remove': (payload) => patients.remove(payload?.id),
    'patients:debtors': () => patients.debtors(),

    /* ------------------------------ appointments --------------------------- */
    'appointments:agenda': (payload) => appointments.agenda(payload?.day),
    'appointments:day-info': (payload) => appointments.dayInfo(payload?.day),
    'appointments:next-free-day': (payload) => appointments.findNextFreeDay(payload || {}),
    'appointments:range': (payload) => appointments.listRange(payload?.start, payload?.end),
    'appointments:create': (payload) => appointments.create(payload),
    'appointments:update': (payload) => appointments.updateDetails(payload),
    'appointments:reschedule': (payload) => appointments.reschedule(payload),
    'appointments:status': (payload) => appointments.setStatus(payload?.id, payload?.status),
    'appointments:cancel': (payload) => appointments.cancel(payload?.id),
    'appointments:waiting-list': () => appointments.waitingList(),
    'appointments:waiting-handle': (payload) => appointments.markWaitingHandled(payload?.id),

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
