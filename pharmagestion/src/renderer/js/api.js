/* Thin wrapper around the preload bridge.
 *
 * The window has no Node access: every call goes through `window.pharmagestion`
 * which only exposes `invoke(method, payload)`. Keeping the wrapper in one file
 * means the pages never touch `window.pharmagestion` directly, which makes the
 * security review (and a future web demo) trivial.
 */
(function () {
  'use strict';

  const bridge = window.pharmagestion || null;
  const listeners = new Set();

  function offlineError() {
    const error = new Error(
      (window.I18N && window.I18N.t('error.OFFLINE')) || 'Application bridge unavailable',
    );
    error.code = 'OFFLINE';
    return error;
  }

  async function invoke(method, payload) {
    if (!bridge || typeof bridge.invoke !== 'function') throw offlineError();
    return bridge.invoke(method, payload);
  }

  function onEvent(callback) {
    if (typeof callback !== 'function') return () => {};
    listeners.add(callback);
    return () => listeners.delete(callback);
  }

  if (bridge && typeof bridge.onEvent === 'function') {
    bridge.onEvent((event) => {
      for (const listener of listeners) {
        try {
          listener(event);
        } catch (error) {
          console.error('[api] event listener failed', error);
        }
      }
    });
  }

  window.API = {
    invoke,
    onEvent,
    available: Boolean(bridge),
    platform: bridge && bridge.platform ? bridge.platform : 'unknown',
  };
})();
