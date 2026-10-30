/**
 * Professional inline SVG icon set.
 *
 * Replaces emoji with crisp, consistent 24×24 stroke icons (2px stroke, round
 * caps) that inherit `currentColor`, scale with the font and print correctly.
 * No network, no font file, no icon library: ~40 paths in one place.
 *
 * Usage:
 *   Icons.el('calendar')                    → <svg> DOM element
 *   Icons.el('calendar', { size: 28 })
 *   Icons.html('calendar')                  → string (for template strings)
 *   Icons.names()                           → every available name (tests)
 */
(function () {
  'use strict';

  /** name → body of the <svg> (paths only). */
  const PATHS = {
    dashboard:
      '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
    calendar:
      '<rect x="3" y="5" width="18" height="16" rx="2.5"/><path d="M8 3v4M16 3v4M3 10h18"/><path d="M8 15h2M14 15h2"/>',
    users:
      '<path d="M16 19v-1.5a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4V19"/><circle cx="9" cy="7" r="3.4"/><path d="M22 19v-1.5a4 4 0 0 0-3-3.87"/><path d="M16.5 3.6a3.4 3.4 0 0 1 0 6.6"/>',
    tooth:
      '<path d="M12 5.5c-1.6-1.6-3-2-4.4-2C5.2 3.5 4 5.4 4 7.6c0 1.5.5 2.6.9 4 .4 1.3.5 2.4.7 3.9.2 1.7.4 3.5 1.6 3.5 1.4 0 1.2-2.4 1.6-4.4.3-1.6.8-2.6 2.2-2.6s1.9 1 2.2 2.6c.4 2 .2 4.4 1.6 4.4 1.2 0 1.4-1.8 1.6-3.5.2-1.5.3-2.6.7-3.9.4-1.4.9-2.5.9-4 0-2.2-1.2-4.1-3.6-4.1-1.4 0-2.8.4-4.4 2Z"/>',
    receipt:
      '<path d="M5 3h14v18l-2.5-1.6L14 21l-2-1.6L10 21l-2.5-1.6L5 21Z"/><path d="M9 8h6M9 12h6M9 16h3"/>',
    cash:
      '<rect x="2.5" y="6" width="19" height="12" rx="2.5"/><circle cx="12" cy="12" r="2.6"/><path d="M6 9.5v.01M18 14.5v.01"/>',
    folder:
      '<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H10l2 2.5h6.5A2.5 2.5 0 0 1 21 10v7.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5Z"/>',
    save:
      '<path d="M5 3h11l5 5v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z"/><path d="M8 3v6h8V3"/><rect x="7" y="14" width="10" height="8" rx="1"/>',
    ban: '<circle cx="12" cy="12" r="9"/><path d="m5.6 5.6 12.8 12.8"/>',
    checkCircle:
      '<circle cx="12" cy="12" r="9"/><path d="m8.5 12.5 2.5 2.5 4.5-5"/>',
    undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h9a7 7 0 0 1 0 14h-3"/>',
    tag:
      '<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0l-7.2-7.2A2 2 0 0 1 3 12V5a2 2 0 0 1 2-2h7a2 2 0 0 1 1.4.6l7.2 7.2a2 2 0 0 1 0 2.6Z"/><path d="M7.5 7.5h.01"/>',
    wallet:
      '<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H18a2 2 0 0 1 2 2v1"/><rect x="3" y="7.5" width="18" height="12" rx="2.5"/><path d="M16 13.5h.01"/><path d="M20 10.5h-4a2 2 0 0 0 0 4h4"/>',
    chart:
      '<path d="M3 3v18h18"/><path d="M7 16v-5M12 16V7M17 16v-8"/>',
    whatsapp:
      '<path d="M20.5 11.6A8.4 8.4 0 0 1 8 19.2L3.5 20.5l1.3-4.4A8.4 8.4 0 1 1 20.5 11.6Z"/><path d="M9 9.2c.2-.5.5-.5.8-.5h.5c.2 0 .4 0 .6.4l.7 1.6c.1.3 0 .5-.2.7l-.5.6c-.1.2-.2.3 0 .6.4.7 1.1 1.4 1.9 1.8.3.1.4.1.6-.1l.6-.7c.2-.2.4-.2.6-.1l1.5.8c.3.1.4.3.3.6-.2.8-.9 1.2-1.6 1.3-1 .1-2-.3-3.4-1.2-1.2-.9-2.2-2.2-2.6-3-.3-.7-.4-1.4-.2-1.9Z"/>',
    settings:
      '<circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    close: '<path d="M18 6 6 18M6 6l12 12"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
    trash:
      '<path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/>',
    print:
      '<path d="M6 9V3h12v6"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M6 17h12v4H6z"/><path d="M17 12.5h.01"/>',
    download: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M4 21h16"/>',
    upload: '<path d="M12 21V9"/><path d="m7 14 5-5 5 5"/><path d="M4 3h16"/>',
    sheet:
      '<rect x="3" y="3" width="18" height="18" rx="2.5"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/>',
    copy:
      '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
    lock: '<rect x="4" y="10" width="16" height="11" rx="2.5"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
    globe:
      '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18Z"/>',
    file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/>',
    database:
      '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6"/><path d="M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>',
    shield: '<path d="M12 3 5 6v5c0 4.4 3 8.2 7 9.5 4-1.3 7-5.1 7-9.5V6Z"/><path d="m9 12 2 2 4-4"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
    arrowUp: '<path d="M12 19V5"/><path d="m5 12 7-7 7 7"/>',
    arrowDown: '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>',
    arrowRight: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
    bell: '<path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1"/>',
    phone:
      '<path d="M6.6 3h-.9A2.7 2.7 0 0 0 3 5.9c0 8.4 6.8 15.2 15.2 15.2a2.7 2.7 0 0 0 2.8-2.7v-1a1.8 1.8 0 0 0-1.4-1.8l-2.6-.6a1.8 1.8 0 0 0-1.8.7l-.8 1a12.6 12.6 0 0 1-5.6-5.6l1-.8A1.8 1.8 0 0 0 10 8.5L9.4 6A1.8 1.8 0 0 0 6.6 3Z"/>',
    note: '<path d="M4 4h16v12l-4 4H4Z"/><path d="M16 20v-4h4"/><path d="M8 8h8M8 12h5"/>',
    sparkles:
      '<path d="M12 3l1.9 4.9L19 9.8l-5.1 1.9L12 16.6l-1.9-4.9L5 9.8l5.1-1.9Z"/><path d="M18 15.5l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9Z"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/>',
    alert: '<path d="M12 3 2.5 20h19Z"/><path d="M12 9v5"/><path d="M12 17h.01"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
    box: '<path d="m21 8-9-5-9 5v8l9 5 9-5Z"/><path d="M3 8l9 5 9-5"/><path d="M12 13v8"/>',
    repeat:
      '<path d="M17 2l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>',
    eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
    chat:
      '<path d="M21 12a8 8 0 0 1-8 8H7l-4 3v-6.5A8 8 0 1 1 21 12Z"/><path d="M8 11h8M8 14.5h5"/>',
    send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
    prescription:
      '<path d="M6 3h9l4 4v14H6Z"/><path d="M15 3v4h4"/><path d="M9 11h4a2 2 0 0 1 0 4H9V9"/><path d="m12 15 4 4M16 15l-4 4"/>',
    clipboard:
      '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4.5h6v3H9z"/><path d="M9 11h6M9 15h4"/>',
    scale:
      '<path d="M12 3v18"/><path d="M5 7h14"/><path d="m5 7-2.5 6a2.5 2.5 0 0 0 5 0Z"/><path d="m19 7-2.5 6a2.5 2.5 0 0 0 5 0Z"/><path d="M8 21h8"/>',
    key:
      '<circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.7 12.3 9.3-9.3"/><path d="m17 6 3 3M14.5 8.5l2.5 2.5"/>',
    certificate:
      '<rect x="3" y="4" width="18" height="14" rx="2"/><circle cx="16" cy="15" r="3"/><path d="m14.8 17.5-.8 4.5 2-1.2 2 1.2-.8-4.5"/><path d="M7 9h7M7 13h4"/>',
  };

  const SIZE_DEFAULT = 20;

  function nameOf(name) {
    return PATHS[name] ? name : 'info';
  }

  function html(name, options = {}) {
    const size = Number(options.size) || SIZE_DEFAULT;
    const stroke = Number(options.stroke) || 2;
    const extra = options.class ? ` class="${options.class}"` : '';
    const label = options.label ? ` role="img" aria-label="${String(options.label)}"` : ' aria-hidden="true"';
    return (
      `<svg${extra} viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" ` +
      `stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" ` +
      `stroke-linejoin="round" focusable="false"${label}>${PATHS[nameOf(name)]}</svg>`
    );
  }

  function el(name, options = {}) {
    const template = document.createElement('template');
    template.innerHTML = html(name, options).trim();
    return template.content.firstChild;
  }

  /**
   * Replace the icon inside a button/label without touching its text:
   * `Icons.decorate(button, 'plus')` prepends the SVG.
   */
  function decorate(node, name, options = {}) {
    if (!node) return node;
    node.prepend(el(name, { size: 18, ...options }));
    node.classList.add('has-icon');
    return node;
  }

  window.Icons = { el, html, decorate, names: () => Object.keys(PATHS), has: (name) => Boolean(PATHS[name]) };
})();
