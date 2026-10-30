'use strict';
/**
 * Preload bridge. Exposes a narrow API to the renderer:
 * `dentardv.invoke(method, payload)`, `dentardv.invokeRaw(method, payload)`
 * (preserves `.code`/`.details` across Electron's contextBridge), and event subscriptions.
 */

const { contextBridge, ipcRenderer } = require('electron');

const invokeRaw = async (method, payload) => {
  return ipcRenderer.invoke('dentardv:invoke', method, payload);
};

const invoke = async (method, payload) => {
  const result = await invokeRaw(method, payload);
  if (!result || result.ok !== true) {
    const info = (result && result.error) || { code: 'INTERNAL_ERROR', message: 'Unknown error' };
    const error = new Error(info.message || info.code);
    error.code = info.code;
    error.details = info.details;
    throw error;
  }
  return result.data;
};

const subscribe = (channel, callback) => {
  if (typeof callback !== 'function') return () => {};
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('dentardv', {
  invoke,
  invokeRaw,
  onWhatsAppStatus: (callback) => subscribe('dentardv:wa-status', callback),
  onEvent: (callback) => subscribe('dentardv:event', callback),
  platform: process.platform,
});
