'use strict';
/**
 * Electron IPC bridge.
 *
 * One channel (`dentardv:invoke`) with an action allowlist. Every sensitive
 * action goes through `auth.requireUnlocked()`, results are wrapped so the
 * preload can rebuild a clean Error with a translatable `code`.
 */

const { ipcMain, dialog, shell, BrowserWindow } = require('electron');
const path = require('node:path');
const auth = require('./services/auth');
const backup = require('./services/backup');
const { createHandlers, PUBLIC } = require('./handlers');
const { AppError } = require('./utils/common');
const { toISODate } = require('./utils/dates');

let handlers = {};

function registerIpc(context = {}) {
  const dataDir = context.dataDir || '';

  handlers = createHandlers({
    version: context.version || '1.0.0',
    dataDir,
    demo: false,
    wa: context.wa,
    printReceipt: context.printReceipt,
    dialogs: {
      openPath: (target) => shell.openPath(target),
      chooseBackup: async () => {
        const { canceled, filePaths } = await dialog.showOpenDialog({
          title: 'Choisir une sauvegarde / اختر نسخة احتياطية',
          defaultPath: backup.backupsDir(),
          filters: [{ name: 'SQLite', extensions: ['sqlite', 'db', 'sqlite3'] }],
          properties: ['openFile'],
        });
        return { canceled, file: filePaths?.[0] };
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

/** Reload every window after a restore. */
function reloadWindows() {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.reload();
  }
}

module.exports = { registerIpc, reloadWindows };
