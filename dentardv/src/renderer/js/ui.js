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
    if (props) {
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
        else el.setAttribute(key, value);
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
    toastHost().append(node);
    setTimeout(() => node.remove(), 3200);
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
        h('button', { class: 'btn ghost icon', onClick: closeModal, 'aria-label': 'close' }, '✕'),
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
    const el = h('select', { class: 'select', ...props });
    for (const option of options) {
      el.append(
        h('option', { value: option.value, selected: option.selected }, option.label),
      );
    }
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

  function emptyState(text, emoji = '🗓️') {
    return h('div', { class: 'empty' }, h('span', { class: 'emoji' }, emoji), text);
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
    todayISO,
  };
})();
