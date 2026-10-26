/* Thin bridge to the main process.
   In Electron, `window.medirdv` is injected by the preload script.
   In the browser demo (npm run demo) the same calls go to /api/invoke. */
(function () {
  'use strict';

  const hasElectron = typeof window.medirdv !== 'undefined';

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
      if (hasElectron && typeof window.medirdv.invokeRaw === 'function') {
        const result = await window.medirdv.invokeRaw(method, payload);
        if (!result || result.ok !== true) {
          const info = (result && result.error) || { code: 'INTERNAL_ERROR', message: 'Unknown error' };
          const error = new Error(info.message || info.code);
          error.code = info.code;
          error.details = info.details;
          throw error;
        }
        return result.data;
      }
      if (hasElectron) return await window.medirdv.invoke(method, payload);
      return await httpInvoke(method, payload);
    } catch (error) {
      if (error.code === 'LOCKED') window.dispatchEvent(new CustomEvent('session-locked'));
      throw error;
    }
  }

  /**
   * Print a standalone HTML document via a hidden iframe (browser preview fallback).
   */
  function printHtml(html) {
    const existing = document.getElementById('medirdv-print-frame');
    if (existing) existing.remove();
    const frame = document.createElement('iframe');
    frame.id = 'medirdv-print-frame';
    frame.style.position = 'fixed';
    frame.style.right = '0';
    frame.style.bottom = '0';
    frame.style.width = '0';
    frame.style.height = '0';
    frame.style.border = '0';
    frame.srcdoc = html;
    document.body.appendChild(frame);
    frame.onload = () => {
      try {
        frame.contentWindow.focus();
        frame.contentWindow.print();
      } catch (err) {
        console.warn('Browser print fallback failed:', err);
      }
    };
  }

  /**
   * Copy text to the system clipboard (used by « Copier pour Google Sheets »).
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
    printHtml,
    demo: !hasElectron,
    onWhatsAppStatus: (cb) =>
      hasElectron ? window.medirdv.onWhatsAppStatus(cb) : () => {},
    onEvent: (cb) => (hasElectron ? window.medirdv.onEvent(cb) : () => {}),
  };
})();
