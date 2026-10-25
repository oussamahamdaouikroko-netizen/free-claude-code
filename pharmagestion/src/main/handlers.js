'use strict';
/**
 * The complete list of actions the interface may ask the main process to run.
 *
 * Anything not declared here is rejected by `ipc.js`, so the renderer cannot
 * reach the filesystem, the network or the database on its own. Every handler
 * validates its payload; nothing is trusted from the window.
 */

const fs = require('node:fs');
const path = require('node:path');
const db = require('./db');
const settings = require('./services/settings');
const backup = require('./services/backup');
const audit = require('./services/audit');
const { AppError, cleanText, nowLocal } = require('./utils/common');
const { todayISO } = require('./utils/dates');

/** Sections shown in the sidebar; used by the dashboard "modules" card. */
const SECTIONS = [
  'dashboard',
  'stock',
  'purchases',
  'sales',
  'customer_debts',
  'supplier_debts',
  'expiry',
  'import_export',
  'reports',
  'settings',
];

/**
 * @param {{
 *   version: string,
 *   dataDir: string,
 *   logFile?: string|null,
 *   isPackaged?: boolean,
 *   dialogs: {
 *     chooseBackup: () => Promise<{canceled: boolean, file?: string}>,
 *     saveBackup: (name: string) => Promise<{canceled: boolean, file?: string}>,
 *     openPath: (target: string) => Promise<string>,
 *     copyText: (text: string) => void,
 *   },
 * }} context
 */
function createHandlers(context) {
  const dataDir = context.dataDir;
  const dialogs = context.dialogs || {};

  /** Files the pharmacist explicitly picked in a native dialog. */
  const approvedRestoreFiles = new Set();

  function exportsDir() {
    return path.join(dataDir, 'exports');
  }

  function requireSqlitePath(file) {
    const value = cleanText(file, 400);
    if (!value) throw new AppError('BACKUP_NOT_FOUND');
    const resolved = path.resolve(value);
    if (!/\.(sqlite|sqlite3|db)$/i.test(resolved)) {
      throw new AppError('INVALID_FILE', 'Only .sqlite / .sqlite3 / .db files can be restored');
    }
    return resolved;
  }

  const handlers = {
    /* ------------------------------ application ----------------------------- */

    'app:info': async () => ({
      name: 'PharmaGestion DZ',
      version: context.version,
      platform: process.platform,
      electron: process.versions.electron,
      node: process.versions.node,
      chrome: process.versions.chrome,
      isPackaged: Boolean(context.isPackaged),
      dataDir,
      databaseFile: db.getPath(),
      logFile: context.logFile || null,
      language: settings.getLanguage(),
      currency: settings.getRaw('currency'),
      schemaVersion: db.stats().schemaVersion,
      today: todayISO(),
      now: nowLocal(),
    }),

    'app:openFolder': async (payload = {}) => {
      const targets = {
        data: dataDir,
        database: path.dirname(db.getPath()),
        log: context.logFile ? path.dirname(context.logFile) : dataDir,
        backups: backup.backupsDir(),
        exports: exportsDir(),
      };
      const target = targets[payload.kind];
      if (!target) throw new AppError('INVALID_TARGET');
      fs.mkdirSync(target, { recursive: true });
      const message = await dialogs.openPath(target);
      if (message) throw new AppError('OPEN_FOLDER_FAILED', message);
      return { opened: target };
    },

    'app:copyText': async (payload = {}) => {
      const text = String(payload.text ?? '');
      if (text.length > 20000) throw new AppError('TEXT_TOO_LONG');
      if (typeof dialogs.copyText === 'function') dialogs.copyText(text);
      return { copied: true };
    },

    /* -------------------------------- settings ------------------------------ */

    'settings:all': async () => settings.all(),

    'settings:set': async (payload = {}) => {
      // Accept either { key, value } or { values: { … } } (a whole form).
      const values = payload.values && typeof payload.values === 'object' ? payload.values : null;
      if (values) {
        settings.setMany(values);
      } else {
        if (!payload.key) throw new AppError('INVALID_SETTING_KEY');
        settings.set(String(payload.key), payload.value);
      }
      return settings.all();
    },

    'settings:language': async (payload = {}) => {
      const language = settings.setLanguage(payload.language);
      audit.log('settings.language', { entity: 'settings', details: language });
      return { language };
    },

    'settings:pickBackupFolder': async () => ({
      // Informational: the app always writes backups inside its data folder.
      folder: backup.backupsDir(),
    }),

    /* ------------------------------- dashboard ------------------------------ */

    'dashboard:summary': async () => {
      const database = db.stats();
      const all = settings.all();
      const backups = backup.list();
      const lastBackup = backups.find((entry) => entry.kind === 'auto' || entry.kind === 'manual');
      const integrity = db.quickCheck();

      return {
        pharmacyName: all.pharmacy_name,
        language: all.language,
        today: todayISO(),
        database: {
          file: database.file,
          sizeBytes: database.sizeBytes,
          schemaVersion: database.schemaVersion,
          integrityOk: integrity.ok,
        },
        backups: {
          enabled: all.backup_enabled,
          due: backup.isDue(),
          keep: all.backup_keep,
          last: lastBackup
            ? { name: lastBackup.name, created_at: lastBackup.created_at, kind: lastBackup.kind }
            : null,
          count: backups.length,
        },
        // Phase 1: no stock or debt tables exist yet. The dashboard shows a
        // real zero plus the section name rather than inventing numbers.
        modules: SECTIONS,
        counters: {
          medicines: 0,
          batches: 0,
          expiringSoon: 0,
          expired: 0,
          customerDebtCents: 0,
          supplierDebtCents: 0,
        },
        recentActivity: audit.list({ limit: 8 }).map((row) => ({
          id: row.id,
          at: row.at,
          action: row.action,
          severity: row.severity,
        })),
      };
    },

    /* --------------------------------- audit -------------------------------- */

    'audit:list': async (payload = {}) => audit.list({ limit: payload.limit }),

    /* -------------------------------- backups ------------------------------- */

    'backup:create': async () => backup.create({ kind: 'manual' }),

    'backup:list': async () => backup.list(),

    'backup:export': async () => {
      if (typeof dialogs.saveBackup !== 'function') throw new AppError('DIALOG_UNAVAILABLE');
      fs.mkdirSync(exportsDir(), { recursive: true });
      const chosen = await dialogs.saveBackup(`pharmagestion-backup-${todayISO()}.sqlite`);
      if (!chosen || chosen.canceled || !chosen.file) return { canceled: true };
      const result = backup.exportCopy(chosen.file);
      return { canceled: false, ...result };
    },

    'backup:choose': async () => {
      if (typeof dialogs.chooseBackup !== 'function') throw new AppError('DIALOG_UNAVAILABLE');
      const chosen = await dialogs.chooseBackup();
      if (!chosen || chosen.canceled || !chosen.file) return { canceled: true };
      const file = requireSqlitePath(chosen.file);
      const integrity = db.checkIntegrity(file);
      approvedRestoreFiles.add(file);
      return {
        canceled: false,
        file,
        name: path.basename(file),
        integrityOk: integrity.ok,
        schemaVersion: integrity.schemaVersion || null,
        tooNew: Boolean(integrity.tooNew),
      };
    },

    'backup:restore': async (payload = {}) => {
      const file = requireSqlitePath(payload.file);
      const inBackupsFolder = file.startsWith(path.resolve(backup.backupsDir()) + path.sep);
      if (!inBackupsFolder && !approvedRestoreFiles.has(file)) {
        throw new AppError('RESTORE_NOT_APPROVED', 'Choose the backup file through the app');
      }
      const result = backup.restore(file);
      approvedRestoreFiles.delete(file);
      return result;
    },

    /* ------------------------------- database ------------------------------- */

    'db:integrity': async () => {
      const stats = db.stats();
      const quick = db.quickCheck();
      return { ...stats, ...quick, checkedAt: nowLocal() };
    },

    'db:stats': async () => db.stats(),
  };

  // Detach the prototype chain: `handlers.toString`, `handlers.constructor` and
  // `handlers.__proto__` must not resolve to anything callable.
  Object.setPrototypeOf(handlers, null);
  return handlers;
}

/** Method names the renderer may call — everything else is refused. */
function allowedMethods(handlers) {
  return new Set(Object.keys(handlers));
}

module.exports = { createHandlers, allowedMethods, SECTIONS };
