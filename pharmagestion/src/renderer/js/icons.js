/* Inline SVG icons — no icon font, no network request, no third-party file.
 * Each icon is a 24×24 stroke drawing that inherits the text colour. */
(function () {
  'use strict';

  const PATHS = {
    dashboard:
      '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
    pill: '<path d="M10.5 20.5a5 5 0 0 1-7-7l6-6a5 5 0 1 1 7 7l-6 6Z"/><path d="M7 10l7 7"/>',
    cartIn:
      '<path d="M3 4h2l2.4 10.2A2 2 0 0 0 9.4 16H18a2 2 0 0 0 2-1.6L21.5 8H6"/><circle cx="10" cy="20" r="1.4"/><circle cx="18" cy="20" r="1.4"/><path d="M13 5v5"/><path d="M10.5 7.5L13 10l2.5-2.5"/>',
    cartOut:
      '<path d="M3 4h2l2.4 10.2A2 2 0 0 0 9.4 16H18a2 2 0 0 0 2-1.6L21.5 8H6"/><circle cx="10" cy="20" r="1.4"/><circle cx="18" cy="20" r="1.4"/><path d="M13 10V5"/><path d="M10.5 7.5L13 5l2.5 2.5"/>',
    personDebt:
      '<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5"/><path d="M17.5 8.5v6"/><path d="M15.5 10.5h4"/><path d="M15.5 13h4"/>',
    truckDebt:
      '<path d="M2 7h10v9H2z"/><path d="M12 10h4l3 3v3h-7"/><circle cx="6" cy="18" r="1.6"/><circle cx="16" cy="18" r="1.6"/><path d="M18 3v5"/><path d="M16 5h4"/>',
    clock:
      '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    importExport:
      '<path d="M12 3v10"/><path d="M8.5 6.5L12 3l3.5 3.5"/><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/><path d="M8 12l4 4 4-4" opacity="0.35"/>',
    chart:
      '<path d="M4 20V4"/><path d="M4 20h16"/><rect x="7" y="12" width="3" height="5" rx="1"/><rect x="12" y="8" width="3" height="9" rx="1"/><rect x="17" y="5" width="3" height="12" rx="1"/>',
    settings:
      '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>',
    check: '<path d="M20 6L9 17l-5-5"/>',
    checkCircle: '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.5 2.5L16 9.5"/>',
    alert: '<path d="M12 3.5L2.8 20h18.4L12 3.5Z"/><path d="M12 10v4.5"/><circle cx="12" cy="17.3" r="0.9" fill="currentColor" stroke="none"/>',
    database:
      '<ellipse cx="12" cy="5.5" rx="7.5" ry="3"/><path d="M4.5 5.5v13c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-13"/><path d="M4.5 12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3"/>',
    backup:
      '<path d="M12 3v11"/><path d="M8 10.5l4 4 4-4"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>',
    restore:
      '<path d="M4 12a8 8 0 1 0 2.6-5.9"/><path d="M4 4v4h4"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3.5 9h17M3.5 15h17"/><path d="M12 3c2.4 2.3 3.6 5.4 3.6 9s-1.2 6.7-3.6 9c-2.4-2.3-3.6-5.4-3.6-9S9.6 5.3 12 3Z"/>',
    folder:
      '<path d="M3 7.5A2 2 0 0 1 5 5.5h4l2 2.5h6a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
    shield: '<path d="M12 3l7 2.5V11c0 4.3-2.9 8-7 10-4.1-2-7-5.7-7-10V5.5L12 3Z"/><path d="M9 12l2 2 4-4"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5"/><circle cx="12" cy="7.8" r="0.9" fill="currentColor" stroke="none"/>',
    arrowLeft: '<path d="M19 12H5"/><path d="M11 6l-6 6 6 6"/>',
    arrowRight: '<path d="M5 12h14"/><path d="M13 6l6 6-6 6"/>',
    file: '<path d="M6 3h7l5 5v13H6z"/><path d="M13 3v5h5"/>',
    refresh: '<path d="M20 11a8 8 0 1 0-2.3 6.3"/><path d="M20 4.5V11h-6.5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  };

  /**
   * @param {string} name
   * @param {{size?: number, className?: string}} [options]
   * @returns {SVGElement|string} an SVG element when a DOM is available
   */
  function icon(name, options = {}) {
    const size = Number(options.size) || 22;
    const path = PATHS[name] || PATHS.info;
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" ` +
      `fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" ` +
      `stroke-linejoin="round" aria-hidden="true" focusable="false"` +
      `${options.className ? ` class="${options.className}"` : ''}>${path}</svg>`;

    if (typeof document === 'undefined') return svg;
    const wrapper = document.createElement('span');
    wrapper.className = 'icon';
    wrapper.innerHTML = svg; // static, trusted markup — never user content
    return wrapper.firstElementChild;
  }

  window.Icons = { icon, PATHS, names: Object.keys(PATHS) };
})();
