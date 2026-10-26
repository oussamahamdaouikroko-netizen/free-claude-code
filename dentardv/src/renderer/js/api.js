/* Thin bridge to the main process.
   In Electron, `window.dentardv` is injected by the preload script.
   In the browser demo (npm run demo) the same calls go to /api/invoke. */
(function () {
  'use strict';

  const hasElectron = typeof window.dentardv !== 'undefined';

  async function httpInvoke(method, payload) {
    const response = await fetch('/api/invoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method, payload: payload || {} }),
    });
    const result = await response.json();
    if (!result.ok) {
      const info = result.error || { code: 'INTERNAL_ERROR' };
      const error = new Error(info.message || info.code);
      error.code = info.code;
      error.details = info.details;
      if (info.code === 'LOCKED') window.dispatchEvent(new CustomEvent('session-locked'));
      throw error;
    }
    return result.data;
  }

  async function invoke(method, payload) {
    try {
      if (hasElectron) {
        if (typeof window.dentardv.invokeRaw === 'function') {
          const result = await window.dentardv.invokeRaw(method, payload);
          if (!result || result.ok !== true) {
            const info = (result && result.error) || { code: 'INTERNAL_ERROR', message: 'Unknown error' };
            const error = new Error(info.message || info.code);
            error.code = info.code;
            error.details = info.details;
            if (info.code === 'LOCKED') window.dispatchEvent(new CustomEvent('session-locked'));
            if (info.code === 'LICENSE_EXPIRED' || info.code === 'LICENSE_REQUIRED') {
              window.dispatchEvent(new CustomEvent('license-expired'));
            }
            throw error;
          }
          return result.data;
        }
        return await window.dentardv.invoke(method, payload);
      }
      return await httpInvoke(method, payload);
    } catch (error) {
      if (error.code === 'LOCKED') window.dispatchEvent(new CustomEvent('session-locked'));
      if (error.code === 'LICENSE_EXPIRED' || error.code === 'LICENSE_REQUIRED') {
        window.dispatchEvent(new CustomEvent('license-expired'));
      }
      throw error;
    }
  }

  /**
   * Copy text to the system clipboard (used by « Copier pour Google Sheets »).
   * Electron exposes the real clipboard through the preload bridge; in the
   * browser preview we fall back to the async Clipboard API.
   */
  async function copyText(text) {
    if (hasElectron) {
      try {
        await invoke('app:copy-text', { text });
        return true;
      } catch (error) {
        return false;
      }
    }
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (error) {
      // Older browsers / blocked permissions: the textarea trick still works.
      try {
        const area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.append(area);
        area.select();
        const ok = document.execCommand('copy');
        area.remove();
        return ok;
      } catch (fallbackError) {
        return false;
      }
    }
  }

  window.API = {
    invoke,
    copyText,
    demo: !hasElectron,
    onWhatsAppStatus: (cb) =>
      hasElectron ? window.dentardv.onWhatsAppStatus(cb) : () => {},
    onEvent: (cb) => (hasElectron ? window.dentardv.onEvent(cb) : () => {}),
  };
})();
