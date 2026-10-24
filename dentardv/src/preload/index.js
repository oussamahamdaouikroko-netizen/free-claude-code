'use strict';
/**
 * Preload bridge. Exposes a *single* narrow API to the renderer:
 * `dentardv.invoke(method, payload)` plus two event subscriptions.
 * No Node API, no filesystem, no remote code in the UI layer.
 */

const { contextBridge, ipcRenderer } = require('electron');

const invoke = async (method, payload) => {
  const result = await ipcRenderer.invoke('dentardv:invoke', method, payload);
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
  onWhatsAppStatus: (callback) => subscribe('dentardv:wa-status', callback),
  onEvent: (callback) => subscribe('dentardv:event', callback),
  platform: process.platform,
});
