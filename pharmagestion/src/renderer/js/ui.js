/* Shared UI builders for the renderer.
 *
 * No framework: the whole interface is built with these few helpers, which
 * keeps the code readable for a beginner maintainer. Everything is plain DOM,
 * so there is no template string that could inject untrusted HTML: text always
 * goes through textContent.
 */
(function () {
  'use strict';

  const { t } = window.I18N;

  /* ------------------------------- creation -------------------------------- */

  /**
   * create an element.
   * @param {string} tag
   * @param {Object} [props] attributes; `onClick`-style keys become listeners
   * @param {...(Node|string|number|Array|null|false|undefined)} children
   */
  function h(tag, props, ...children) {
    const element = document.createElement(tag);
    if (props) {
      for (const [key, value] of Object.entries(props)) {
        if (value === null || value === undefined || value === false) continue;
        if (key.startsWith('on') && typeof value === 'function') {
          element.addEventListener(key.slice(2).toLowerCase(), value);
        } else if (key === 'class' || key === 'className') {
          element.className = value;
        } else if (key === 'dataset') {
          Object.assign(element.dataset, value);
        } else if (key === 'value') {
          element.value = value;
          element.setAttribute('value', String(value));
        } else if (key === 'checked' || key === 'disabled' || key === 'selected') {
          element[key] = Boolean(value);
        } else if (key === 'text') {
          element.textContent = String(value);
        } else {
          element.setAttribute(key, String(value));
        }
      }
    }
    append(element, children);
    return element;
  }

  function append(parent, children) {
    for (const child of children) {
      if (child === null || child === undefined || child === false || child === true) continue;
      if (Array.isArray(child)) {
        append(parent, child);
      } else if (child instanceof Node) {
        parent.appendChild(child);
      } else {
        parent.appendChild(document.createTextNode(String(child)));
      }
    }
    return parent;
  }

  function clear(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild);
    return node;
  }

  function mount(container, ...children) {
    clear(container);
    append(container, children);
    return container;
  }

  /* -------------------------------- buttons -------------------------------- */

  /**
   * @param {string} label
   * @param {{tone?: 'primary'|'ghost'|'danger'|'soft', size?: 'sm'|'lg',
   *          icon?: string, onClick?: Function, type?: string, block?: boolean,
   *          title?: string, disabled?: boolean, id?: string}} [options]
   */
  function button(label, options = {}) {
    const classes = ['btn'];
    classes.push(`btn-${options.tone || 'primary'}`);
    if (options.size) classes.push(`btn-${options.size}`);
    if (options.block) classes.push('btn-block');
    const element = h(
      'button',
      {
        class: classes.join(' '),
        type: options.type || 'button',
        title: options.title || null,
        disabled: options.disabled,
        id: options.id,
        onClick: options.onClick,
      },
      options.icon ? window.Icons.icon(options.icon, { size: options.size === 'lg' ? 22 : 18 }) : null,
      h('span', { class: 'btn-label' }, label),
    );
    return element;
  }

  /** Run `task` while showing a spinner and preventing double clicks. */
  async function busy(buttonElement, task) {
    if (!buttonElement) return task();
    const label = buttonElement.querySelector('.btn-label');
    const original = label ? label.textContent : '';
    buttonElement.disabled = true;
    buttonElement.classList.add('is-busy');
    if (label) label.textContent = t('common.saving');
    try {
      return await task();
    } finally {
      buttonElement.disabled = false;
      buttonElement.classList.remove('is-busy');
      if (label) label.textContent = original;
    }
  }

  /* -------------------------------- messages -------------------------------- */

  function toastRoot() {
    let root = document.getElementById('toast-root');
    if (!root) {
      root = h('div', { id: 'toast-root', class: 'toast-root', 'aria-live': 'polite' });
      document.body.appendChild(root);
    }
    return root;
  }

  /**
   * @param {string} message
   * @param {'info'|'success'|'warning'|'error'} [tone]
   */
  function toast(message, tone = 'info', duration = 4200) {
    const root = toastRoot();
    const element = h(
      'div',
      { class: `toast toast-${tone}`, role: tone === 'error' ? 'alert' : 'status' },
      h('span', { class: 'toast-text' }, message),
      h('button', { class: 'toast-close', type: 'button', 'aria-label': t('common.close'), onClick: () => element.remove() }, '×'),
    );
    root.appendChild(element);
    if (duration > 0) setTimeout(() => element.remove(), duration);
    return element;
  }

  /** Turn an Error coming from the main process into a translated sentence. */
  function errorMessage(error) {
    if (!error) return t('common.error');
    const code = error.code || '';
    if (code) {
      const key = `error.${code}`;
      const translated = t(key);
      if (translated !== key) return translated;
    }
    return error.message || t('common.error');
  }

  /* --------------------------------- modal --------------------------------- */

  /**
   * Show a modal dialog.
   * @param {{title: string, body?: Node|string, actions?: Array<Object>,
   *          onClose?: Function, width?: string}} options
   * @returns {Promise<any>} the `value` of the clicked action (null when closed)
   */
  function modal(options) {
    return new Promise((resolve) => {
      const root = document.getElementById('modal-root') || document.body.appendChild(h('div', { id: 'modal-root' }));
      const previousFocus = document.activeElement;
      let settled = false;

      const finish = (value) => {
        if (settled) return;
        settled = true;
        document.removeEventListener('keydown', onKeyDown, true);
        overlay.remove();
        if (previousFocus && typeof previousFocus.focus === 'function') previousFocus.focus();
        if (typeof options.onClose === 'function') options.onClose(value);
        resolve(value);
      };

      const onKeyDown = (event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          finish(null);
        }
      };

      const actionButtons = (options.actions || []).map((action) =>
        button(action.label, {
          tone: action.tone || 'ghost',
          onClick: () => finish(action.value),
        }),
      );

      const overlay = h(
        'div',
        {
          class: 'modal-overlay',
          onClick: (event) => {
            if (event.target === overlay) finish(null);
          },
        },
        h(
          'div',
          {
            class: 'modal',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': options.title,
            style: options.width ? `max-width:${options.width}` : null,
          },
          h(
            'div',
            { class: 'modal-head' },
            h('h2', { class: 'modal-title' }, options.title),
            h('button', { class: 'modal-close', type: 'button', 'aria-label': t('common.close'), onClick: () => finish(null) }, '×'),
          ),
          h('div', { class: 'modal-body' }, options.body || null),
          actionButtons.length ? h('div', { class: 'modal-foot' }, actionButtons) : null,
        ),
      );

      root.appendChild(overlay);
      document.addEventListener('keydown', onKeyDown, true);
      const focusTarget = overlay.querySelector('input, select, textarea, .btn-primary');
      if (focusTarget) focusTarget.focus();
    });
  }

  /** Promise<boolean> confirmation dialog. */
  async function confirm(options = {}) {
    const result = await modal({
      title: options.title || t('common.confirm'),
      body: h('p', { class: 'modal-text' }, options.message || ''),
      actions: [
        { label: options.cancelLabel || t('common.cancel'), value: false, tone: 'ghost' },
        {
          label: options.confirmLabel || t('common.confirm'),
          value: true,
          tone: options.danger ? 'danger' : 'primary',
        },
      ],
    });
    return result === true;
  }

  /* --------------------------------- forms --------------------------------- */

  function field(labelText, control, hintText, options = {}) {
    const id = control && control.id ? control.id : null;
    return h(
      'div',
      { class: `field${options.className ? ` ${options.className}` : ''}` },
      labelText ? h('label', { class: 'field-label', for: id || null }, labelText) : null,
      control,
      hintText ? h('p', { class: 'field-hint' }, hintText) : null,
    );
  }

  function input(options = {}) {
    return h('input', {
      class: `input${options.className ? ` ${options.className}` : ''}`,
      type: options.type || 'text',
      id: options.id || null,
      name: options.name || null,
      value: options.value ?? '',
      placeholder: options.placeholder || '',
      autocomplete: options.autocomplete || 'off',
      inputmode: options.inputmode || null,
      min: options.min,
      max: options.max,
      step: options.step,
      maxlength: options.maxlength,
      disabled: options.disabled,
      dir: options.dir || null,
    });
  }

  function textarea(options = {}) {
    return h('textarea', {
      class: 'input textarea',
      id: options.id || null,
      rows: options.rows || 3,
      placeholder: options.placeholder || '',
      value: options.value ?? '',
      maxlength: options.maxlength,
    });
  }

  function select(options = {}) {
    const element = h('select', {
      class: 'input select',
      id: options.id || null,
      disabled: options.disabled,
    });
    for (const option of options.options || []) {
      const node = h('option', { value: option.value }, option.label);
      if (String(option.value) === String(options.value)) node.selected = true;
      element.appendChild(node);
    }
    return element;
  }

  function checkbox(labelText, checked, options = {}) {
    const box = h('input', { type: 'checkbox', checked: Boolean(checked), id: options.id || null });
    const wrapper = h(
      'label',
      { class: 'checkbox' },
      box,
      h('span', { class: 'checkbox-label' }, labelText),
    );
    wrapper.input = box;
    return wrapper;
  }

  function switchRow(labelText, hintText, checked, onChange) {
    const box = h('input', { type: 'checkbox', checked: Boolean(checked) });
    box.addEventListener('change', () => onChange && onChange(box.checked));
    return h(
      'label',
      { class: 'switch-row' },
      h('span', { class: 'switch-text' }, h('span', { class: 'switch-title' }, labelText), hintText ? h('span', { class: 'switch-hint' }, hintText) : null),
      h('span', { class: 'switch' }, box, h('span', { class: 'switch-track' })),
    );
  }

  /* -------------------------------- surfaces -------------------------------- */

  function card(options = {}) {
    return h(
      'section',
      { class: `card${options.className ? ` ${options.className}` : ''}` },
      options.title || options.actions
        ? h(
            'header',
            { class: 'card-head' },
            h(
              'div',
              { class: 'card-title-wrap' },
              options.icon ? h('span', { class: 'card-icon' }, window.Icons.icon(options.icon, { size: 20 })) : null,
              h(
                'div',
                {},
                h('h2', { class: 'card-title' }, options.title || ''),
                options.subtitle ? h('p', { class: 'card-subtitle' }, options.subtitle) : null,
              ),
            ),
            options.actions ? h('div', { class: 'card-actions' }, options.actions) : null,
          )
        : null,
      h('div', { class: `card-body${options.padded === false ? ' card-body-flush' : ''}` }, options.body || null),
    );
  }

  function stat(options = {}) {
    return h(
      'div',
      { class: `stat stat-${options.tone || 'neutral'}` },
      h(
        'div',
        { class: 'stat-top' },
        options.icon ? h('span', { class: 'stat-icon' }, window.Icons.icon(options.icon, { size: 20 })) : null,
        h('span', { class: 'stat-label' }, options.label || ''),
      ),
      h('div', { class: 'stat-value' }, options.value ?? '0'),
      options.hint ? h('div', { class: 'stat-hint' }, options.hint) : null,
    );
  }

  function badge(labelText, tone = 'neutral') {
    return h('span', { class: `badge badge-${tone}` }, labelText);
  }

  function empty(message) {
    return h(
      'div',
      { class: 'empty' },
      window.Icons.icon('info', { size: 26 }),
      h('p', {}, message || t('common.empty')),
    );
  }

  function loading(message) {
    return h(
      'div',
      { class: 'loading' },
      h('span', { class: 'spinner', 'aria-hidden': 'true' }),
      h('span', {}, message || t('common.loading')),
    );
  }

  function list(items) {
    return h('ul', { class: 'bullet-list' }, (items || []).map((item) => h('li', {}, item)));
  }

  function definitionList(rows) {
    return h(
      'dl',
      { class: 'def-list' },
      (rows || []).map(([term, value]) =>
        h('div', { class: 'def-row' }, h('dt', {}, term), h('dd', {}, value ?? '—')),
      ),
    );
  }

  /* --------------------------------- tables -------------------------------- */

  /**
   * @param {{columns: Array<{key: string, label: string, render?: Function, align?: string}>,
   *          rows: Array<Object>, empty?: string, rowKey?: string}} options
   */
  function table(options = {}) {
    const columns = options.columns || [];
    const rows = options.rows || [];
    if (!rows.length) return empty(options.empty || t('common.empty'));

    return h(
      'div',
      { class: 'table-wrap' },
      h(
        'table',
        { class: 'table' },
        h(
          'thead',
          {},
          h(
            'tr',
            {},
            columns.map((column) =>
              h('th', { class: column.align ? `align-${column.align}` : null }, column.label),
            ),
          ),
        ),
        h(
          'tbody',
          {},
          rows.map((row, index) =>
            h(
              'tr',
              { 'data-key': options.rowKey ? String(row[options.rowKey]) : String(index) },
              columns.map((column) =>
                h(
                  'td',
                  { class: column.align ? `align-${column.align}` : null },
                  column.render ? column.render(row) : String(row[column.key] ?? '—'),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  /* ------------------------------- formatting ------------------------------ */

  function formatNumber(value, options = {}) {
    return window.I18N.formatNumber(value, options);
  }

  /** Integer centimes → "1 234,56 DA". */
  function formatMoney(cents, options = {}) {
    const value = (Number(cents) || 0) / 100;
    let formatted;
    try {
      formatted = new Intl.NumberFormat('fr-DZ', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(value);
    } catch (error) {
      formatted = value.toFixed(2);
    }
    return options.plain ? formatted : `${formatted} ${t('common.currency')}`;
  }

  /** "2026-03-31" → "31/03/2026" (day-first, the local habit). */
  function formatDate(isoDate) {
    if (!isoDate) return '—';
    const text = String(isoDate).slice(0, 10);
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
    if (!match) return text;
    return `${match[3]}/${match[2]}/${match[1]}`;
  }

  /** "2026-10-25 14:05:00" → "25/10/2026 14:05". */
  function formatDateTime(value) {
    if (!value) return '—';
    const text = String(value);
    const date = formatDate(text.slice(0, 10));
    const time = /\d{2}:\d{2}/.exec(text.slice(11));
    return time ? `${date} ${time[0]}` : date;
  }

  function formatBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value < 1024) return `${value} ${t('common.bytes')}`;
    if (value < 1024 * 1024) return `${formatNumber(value / 1024, { maximumFractionDigits: 1 })} ${t('common.kb')}`;
    return `${formatNumber(value / (1024 * 1024), { maximumFractionDigits: 2 })} ${t('common.mb')}`;
  }

  window.UI = {
    h,
    clear,
    mount,
    append,
    button,
    busy,
    toast,
    errorMessage,
    modal,
    confirm,
    field,
    input,
    textarea,
    select,
    checkbox,
    switchRow,
    card,
    stat,
    badge,
    empty,
    loading,
    list,
    definitionList,
    table,
    formatNumber,
    formatMoney,
    formatDate,
    formatDateTime,
    formatBytes,
    todayISO: () => {
      const now = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    },
  };
})();
