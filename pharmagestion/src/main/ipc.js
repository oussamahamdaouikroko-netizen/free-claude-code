'use strict';
/**
 * Electron IPC bridge.
 *
 * A single channel (`pharmagestion:invoke`) with an **allowlist** of methods.
 * Results are wrapped as { ok, data } / { ok, error } so the preload can
 * rebuild a clean Error carrying a translatable `code` instead of leaking a
 * main-process stack trace into the window.
 *
 * Three defences, all tested:
 *  1. the sending page must be our own file:// window;
 *  2. the method must exist in handlers.js;
 *  3. the payload must be a small, plain object.
 */

const { ipcMain, BrowserWindow } = require('electron');
const { createHandlers, allowedMethods } = require('./handlers');
const { AppError } = require('./utils/common');
const {
  assertAllowedMethod,
  assertPayloadSize,
  isTrustedFrameUrl,
  toErrorPayload,
} = require('./security');

let registered = false;
let allowed = new Set();

/** Read the URL of the frame that sent the IPC message, safely. */
function frameUrl(event) {
  try {
    return event.senderFrame && event.senderFrame.url ? event.senderFrame.url : '';
  } catch (error) {
    return '';
  }
}

function senderIsTrusted(event) {
  return isTrustedFrameUrl(frameUrl(event));
}

function registerIpc(context) {
  if (registered) throw new AppError('IPC_ALREADY_REGISTERED');
  const handlers = createHandlers(context);
  allowed = allowedMethods(handlers);

  ipcMain.handle('pharmagestion:invoke', async (event, method, payload) => {
    try {
      if (!senderIsTrusted(event)) throw new AppError('UNTRUSTED_SENDER');
      assertAllowedMethod(allowed, method);
      const args = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
      assertPayloadSize(args);
      const data = await handlers[method](args);
      return { ok: true, data };
    } catch (error) {
      if (!(error instanceof AppError)) console.error('[ipc] handler failed:', error);
      return { ok: false, error: toErrorPayload(error, (value) => value instanceof AppError) };
    }
  });

  registered = true;
  return { methods: allowed };
}

/** Reload every window after a restore, so stale state disappears. */
function reloadWindows() {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.reload();
  }
}

function methods() {
  return allowed;
}

module.exports = { registerIpc, reloadWindows, methods, senderIsTrusted };
