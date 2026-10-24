/* Small DOM toolkit: element builder, modals, toasts, form fields. */
(function () {
  'use strict';

  const { t } = window.I18N;

  /**
   * Create an element.
   * h('div', {class:'row', onClick: fn}, child1, 'text')
   */
  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    if (props && typeof props === 'object' && !Array.isArray(props)) {
      for (const [key, value] of Object.entries(props)) {
        if (value === undefined || value === null || value === false) continue;
        if (key === 'class') el.className = value;
        else if (key === 'text') el.textContent = value;
        else if (key === 'html') el.innerHTML = value;
        else if (key === 'dataset') Object.assign(el.dataset, value);
        else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
        else if (key.startsWith('on') && typeof value === 'function') {
          el.addEventListener(key.slice(2).toLowerCase(), value);
        } else if (key === 'value') el.value = value;
        else if (key === 'checked' || key === 'disabled' || key === 'selected') el[key] = Boolean(value);
        else if (/^[A-Za-z_:][A-Za-z0-9_.:-]*$/.test(key)) el.setAttribute(key, value);
      }
    }
    append(el, children);
    return el;
  }

  function append(el, children) {
    for (const child of children.flat(Infinity)) {
      if (child === null || child === undefined || child === false) continue;
      el.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
  }

  function clear(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
    return el;
  }

  function iconButton(emoji, title, onClick, extraClass = '') {
    return h('button', { class: `btn icon ${extraClass}`, title, 'aria-label': title, onClick }, emoji);
  }

  /* --------------------------------- toasts -------------------------------- */
  function toastHost() {
    let host = document.querySelector('.toast-host');
    if (!host) {
      host = h('div', { class: 'toast-host' });
      document.body.append(host);
    }
    return host;
  }

  function toast(message, type = '') {
    const node = h('div', { class: `toast ${type}` }, message);
    iconize(node);
    toastHost().append(node);
    setTimeout(() => node.remove(), 3200);
    // One place for feedback sounds: every success or failure is heard, even
    // when the caller forgot to call SFX itself.
    if (window.SFX) {
      if (type === 'ok' || type === 'success') window.SFX.success();
      else if (type === 'error') window.SFX.error();
    }
  }

  /* --------------------------------- modals -------------------------------- */
  let openModal = null;

  /**
   * @param {{title:string, body:Node, actions:Array<{label:string,kind?:string,
   *          onClick?:Function, close?:boolean}>, wide?:boolean, onClose?:Function}} options
   */
  function modal(options) {
    closeModal();
    const body = options.body || h('div');
    const actions = options.actions || [];
    const foot = h(
      'div',
      { class: 'modal-foot' },
      actions.map((action) =>
        h(
          'button',
          {
            class: `btn ${action.kind || ''}`,
            onClick: async (event) => {
              if (action.onClick) {
                const keep = await action.onClick(event);
                if (keep === false) return;
              }
              if (action.close !== false) closeModal();
            },
          },
          action.label,
        ),
      ),
    );
    const dialog = h(
      'div',
      { class: `modal ${options.wide ? 'wide' : ''}`, role: 'dialog', 'aria-modal': 'true' },
      h(
        'div',
        { class: 'modal-head' },
        h('h2', {}, options.title || ''),
        h(
          'button',
          { class: 'btn ghost icon', onClick: closeModal, 'aria-label': 'close' },
          window.Icons ? window.Icons.el('close', { size: 18 }) : '✕',
        ),
      ),
      h('div', { class: 'modal-body' }, body),
      foot,
    );
    const overlay = h('div', {
      class: 'overlay',
      onClick: (event) => {
        if (event.target === overlay) closeModal();
      },
    }, dialog);

    const onKey = (event) => {
      if (event.key === 'Escape') closeModal();
    };
    document.addEventListener('keydown', onKey);
    iconize(overlay);
    document.body.append(overlay);
    openModal = { overlay, dialog, onKey, onClose: options.onClose };

    // Focus the first input/button for keyboard users.
    const focusable = dialog.querySelector('input, select, textarea, button.primary');
    if (focusable) setTimeout(() => focusable.focus(), 30);

    return { overlay, dialog, close: closeModal };
  }

  function closeModal() {
    if (!openModal) return;
    const { overlay, onKey, onClose } = openModal;
    document.removeEventListener('keydown', onKey);
    overlay.remove();
    openModal = null;
    if (onClose) onClose();
  }

  function confirmDialog(message, { danger = true, confirmLabel } = {}) {
    return new Promise((resolve) => {
      let decided = false;
      const finish = (value) => {
        if (decided) return;
        decided = true;
        resolve(value);
      };
      modal({
        title: t('common.confirm'),
        body: h('p', { class: 'strong' }, message),
        actions: [
          { label: t('common.cancel'), kind: 'ghost', onClick: () => finish(false) },
          {
            label: confirmLabel || t('common.confirm'),
            kind: danger ? 'danger' : 'primary',
            onClick: () => finish(true),
          },
        ],
        onClose: () => finish(false),
      });
    });
  }

  /* --------------------------------- fields -------------------------------- */
  function field(label, control, help) {
    return h(
      'div',
      { class: 'field' },
      label ? h('label', {}, label) : null,
      control,
      help ? h('div', { class: 'help' }, help) : null,
    );
  }

  function input(props) {
    return h('input', { class: 'input', ...props });
  }

  function select(options, props = {}) {
    const normProps =
      props !== null && typeof props === 'object' && !Array.isArray(props)
        ? { ...props }
        : props !== undefined && props !== null
          ? { value: String(props) }
          : {};
    const initialValue = normProps.value;
    delete normProps.value;
    const el = h('select', { class: 'select', ...normProps });
    for (const option of options) {
      const isSelected =
        Boolean(option.selected) ||
        (initialValue !== undefined && String(option.value) === String(initialValue));
      el.append(
        h('option', { value: option.value, selected: isSelected }, option.label),
      );
    }
    if (initialValue !== undefined) el.value = String(initialValue);
    return el;
  }

  function textarea(props) {
    return h('textarea', { class: 'textarea', ...props });
  }

  function requiredNote() {
    return h('div', { class: 'help' }, '* ' + t('common.required'));
  }

  /* --------------------------------- errors -------------------------------- */
  function errorMessage(error) {
    if (!error) return t('common.error');
    if (error.code) {
      const key = `error.${error.code}`;
      const text = t(key);
      if (text !== key) {
        if (error.code === 'TOO_MANY_ATTEMPTS' && error.details?.seconds) {
          return t('auth.tooMany', { s: error.details.seconds });
        }
        return text;
      }
    }
    return error.message || t('common.error');
  }

  function handleError(error) {
    console.error(error);
    toast(errorMessage(error), 'error');
  }

  /** Disable a button while a promise runs (prevents double submits). */
  async function busy(button, task) {
    if (!button) return task();
    const original = button.textContent;
    button.disabled = true;
    button.textContent = t('common.saving');
    try {
      return await task();
    } finally {
      button.disabled = false;
      button.textContent = original;
    }
  }

  function debounce(fn, delay = 250) {
    let timer = null;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), delay);
    };
  }

  /**
   * Empty state. Accepts either the legacy emoji or an icon name from
   * js/icons.js (all call sites below now pass icon names).
   */
  function emptyState(text, icon = 'calendar') {
    const glyph = window.Icons && window.Icons.has(icon)
      ? window.Icons.el(icon, { size: 34, stroke: 1.6 })
      : h('span', { class: 'emoji' }, icon);
    return h('div', { class: 'empty' }, h('span', { class: 'emoji' }, glyph), text);
  }

  function statusBadge(status) {
    const map = {
      booked: { class: '', key: 'agenda.status.booked' },
      done: { class: 'ok', key: 'agenda.status.done' },
      cancelled: { class: 'gray', key: 'agenda.status.cancelled' },
      no_show: { class: 'warn', key: 'agenda.status.no_show' },
    };
    const info = map[status] || map.booked;
    return h('span', { class: `badge ${info.class}` }, t(info.key));
  }

  function todayISO() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  }

  /* ------------------------------ icon mapping ------------------------------ */
  /**
   * Replaces the emoji used as a bullet in labels with the SVG icon of
   * js/icons.js. Emoji render differently on every Windows version (and are
   * greyed out by some printers); the SVG set is identical everywhere and
   * inherits the text colour, which matters in RTL Arabic screens.
   *
   * The call sites keep writing an emoji before the translated label — readable
   * in the source — and this single pass upgrades them at render time. Emoji
   * without a match are left untouched.
   */
  const EMOJI_ICONS = {
    '💵': 'cash',
    '💲': 'cash',
    '💰': 'wallet',
    '💸': 'wallet',
    '🖨️': 'print',
    '🖨': 'print',
    '📅': 'calendar',
    '🗓️': 'calendar',
    '🗓': 'calendar',
    '👤': 'user',
    '👥': 'users',
    '🦷': 'tooth',
    '📝': 'note',
    '📄': 'file',
    '📂': 'folder',
    '📤': 'upload',
    '📥': 'download',
    '📊': 'dashboard',
    '📈': 'chart',
    '⚙️': 'settings',
    '⚙': 'settings',
    '🔒': 'lock',
    '💾': 'save',
    '✏️': 'edit',
    '✏': 'edit',
    '🗑️': 'trash',
    '🗑': 'trash',
    '🚫': 'ban',
    '✅': 'checkCircle',
    '✓': 'check',
    '✕': 'close',
    '↩️': 'undo',
    '↩': 'undo',
    '💡': 'info',
    '💬': 'whatsapp',
    '🌐': 'globe',
    '🏷️': 'tag',
    '🏷': 'tag',
    '🧪': 'sparkles',
    '🎉': 'sparkles',
  };

  const EMOJI_PATTERN = new RegExp(
    '^\\s*(' +
      Object.keys(EMOJI_ICONS)
        .sort((a, b) => b.length - a.length)
        .map((emoji) => emoji.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('|') +
      ')\\s*',
  );

  function iconizeNode(node) {
    if (!window.Icons || !node) return;
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    const targets = [];
    while (walker.nextNode()) targets.push(walker.currentNode);
    for (const textNode of targets) {
      const match = EMOJI_PATTERN.exec(textNode.nodeValue || '');
      if (!match) continue;
      const icon = EMOJI_ICONS[match[1]];
      if (!icon || !window.Icons.has(icon)) continue;
      textNode.nodeValue = textNode.nodeValue.slice(match[0].length);
      const svg = window.Icons.el(icon, { size: 17 });
      svg.setAttribute('aria-hidden', 'true');
      const host = textNode.parentNode;
      host.insertBefore(svg, textNode);
      if (host.nodeType === 1 && host.matches('button, a')) host.classList.add('has-icon');
    }
  }

  /** Upgrade every emoji bullet inside a rendered subtree. */
  function iconize(root = document.body) {
    iconizeNode(root);
  }

  window.UI = {
    h,
    clear,
    append,
    iconButton,
    toast,
    modal,
    closeModal,
    confirmDialog,
    field,
    input,
    select,
    textarea,
    requiredNote,
    errorMessage,
    handleError,
    busy,
    debounce,
    emptyState,
    statusBadge,
    iconize,
    todayISO,
  };
})();
