'use strict';
/**
 * Preload bridge — the only door between the interface and the system.
 *
 * Exposes exactly three things and no more:
 *   - `invoke(method, payload)` → one allowlisted main-process action;
 *   - `onEvent(callback)`      → main-process notifications;
 *   - `platform`               → for cosmetic differences only.
 *
 * No `require`, no `fs`, no `ipcRenderer`, no remote code in the window.
 */

const { contextBridge, ipcRenderer } = require('electron');

const ALLOWED_METHOD = /^[a-z][a-z0-9]*:[a-zA-Z0-9]+$/;

const invoke = async (method, payload) => {
  if (typeof method !== 'string' || !ALLOWED_METHOD.test(method)) {
    throw new Error('INVALID_METHOD');
  }
  const result = await ipcRenderer.invoke('pharmagestion:invoke', method, payload ?? {});
  if (!result || result.ok !== true) {
    const info = (result && result.error) || { code: 'INTERNAL_ERROR', message: 'Unknown error' };
    const error = new Error(info.message || info.code);
    error.code = info.code;
    error.details = info.details;
    throw error;
  }
  return result.data;
};

const subscribe = (callback) => {
  if (typeof callback !== 'function') return () => {};
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on('pharmagestion:event', listener);
  return () => ipcRenderer.removeListener('pharmagestion:event', listener);
};

contextBridge.exposeInMainWorld('pharmagestion', {
  invoke,
  onEvent: subscribe,
  platform: process.platform,
});
