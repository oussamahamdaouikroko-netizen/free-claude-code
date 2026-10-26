'use strict';
/**
 * Electron IPC bridge (DentaRDV v2.0.0).
 *
 * One channel (`dentardv:invoke`) with an action allowlist, unlock check,
 * and license write-guard for Read-Only expiry mode.
 */

const { ipcMain, dialog, shell, clipboard, BrowserWindow } = require('electron');
const path = require('node:path');
const auth = require('./services/auth');
const license = require('./services/license');
const backup = require('./services/backup');
const { createHandlers, PUBLIC, WRITE_GATED } = require('./handlers');
const { AppError } = require('./utils/common');
const { toISODate } = require('./utils/dates');

let handlers = {};

function registerIpc(context = {}) {
  const dataDir = context.dataDir || '';

  handlers = createHandlers({
    version: context.version || '2.0.0',
    dataDir,
    logFile: context.logFile,
    demo: Boolean(context.demo),
    wa: context.wa,
    autostart: context.autostart,
    onEvent: context.onEvent,
    printReceipt: context.printReceipt,
    prescriptionHtml: context.prescriptionHtml,
    certificateHtml: context.certificateHtml,
    dialogs: {
      openPath: (target) => shell.openPath(target),
      copyText: (text) => clipboard.writeText(String(text ?? '')),
      chooseBackup: async () => {
        const { canceled, filePaths } = await dialog.showOpenDialog({
          title: 'Choisir une sauvegarde / اختر نسخة احتياطية',
          defaultPath: backup.backupsDir(),
          filters: [{ name: 'SQLite', extensions: ['sqlite', 'db', 'sqlite3'] }],
          properties: ['openFile'],
        });
        return { canceled, file: filePaths?.[0] };
      },
      saveExport: async (filename) => {
        const exportsDir = path.join(dataDir, 'exports');
        require('node:fs').mkdirSync(exportsDir, { recursive: true });
        const { canceled, filePath } = await dialog.showSaveDialog({
          title: 'Exporter vers Google Sheets / Excel',
          defaultPath: path.join(exportsDir, filename),
          filters: [{ name: 'Classeur Excel / Google Sheets', extensions: ['xlsx'] }],
        });
        return { canceled, file: filePath };
      },
      saveBackup: async () => {
        const { canceled, filePath } = await dialog.showSaveDialog({
          title: 'Exporter une sauvegarde / تصدير نسخة احتياطية',
          defaultPath: path.join(dataDir, `dentardv-${toISODate()}.sqlite`),
          filters: [{ name: 'SQLite', extensions: ['sqlite'] }],
        });
        return { canceled, file: filePath };
      },
    },
  });

  ipcMain.handle('dentardv:invoke', async (_event, method, payload) => {
    try {
      const handler = handlers[method];
      if (!handler) throw new AppError('UNKNOWN_METHOD', `Unknown method: ${method}`);
      if (!PUBLIC.has(method)) auth.requireUnlocked();
      if (WRITE_GATED.has(method)) license.requireValidLicense();
      const data = await handler(payload || {});
      return { ok: true, data };
    } catch (error) {
      if (error instanceof AppError) {
        return {
          ok: false,
          error: { code: error.code, message: error.message, details: error.details },
        };
      }
      console.error(`[ipc] ${method} failed:`, error);
      return { ok: false, error: { code: 'INTERNAL_ERROR', message: error.message } };
    }
  });
}

function reloadWindows() {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.reload();
  }
}

module.exports = { registerIpc, reloadWindows };
