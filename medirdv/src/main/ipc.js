'use strict';
/**
 * Electron IPC bridge.
 *
 * One channel (`medirdv:invoke`) with an action allowlist. Every sensitive
 * action goes through `auth.requireUnlocked()`, results are wrapped so the
 * preload can rebuild a clean Error with a translatable `code`.
 */

const { ipcMain, dialog, shell, clipboard, BrowserWindow } = require('electron');
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
    logFile: context.logFile,
    demo: Boolean(context.demo),
    wa: context.wa,
    onEvent: context.onEvent,
    autostartOptions: context.autostartOptions,
    onAutostartChanged: context.onAutostartChanged,
    printReceipt: context.printReceipt,
    dialogs: {
      openPath: (target) => shell.openPath(target),
      // « Copier pour Google Sheets » : the renderer cannot touch the OS
      // clipboard (sandboxed preload), so the main process does it.
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
        // The default folder must exist, otherwise Windows opens the dialog
        // in an unrelated place (Documents, Desktop…).
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
          defaultPath: path.join(dataDir, `medirdv-${toISODate()}.sqlite`),
          filters: [{ name: 'SQLite', extensions: ['sqlite'] }],
        });
        return { canceled, file: filePath };
      },
    },
  });

  ipcMain.handle('medirdv:invoke', async (_event, method, payload) => {
    try {
      const handler = handlers[method];
      if (!handler) throw new AppError('UNKNOWN_METHOD', `Unknown method: ${method}`);
      if (!PUBLIC.has(method)) auth.requireUnlocked(method);
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
