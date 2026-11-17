/* Floating Mini Chat widget: appointment confirmations, cancellations & queue alerts. */
(function () {
  'use strict';

  const { t, formatDateTime } = window.I18N;
  const { h, clear, toast, errorMessage } = window.UI;

  const state = {
    open: false,
    filter: 'all',
    items: [],
    unread: 0,
    latestId: null,
    todayCounts: { booked: 0, cancelled: 0, queue: 0 },
    loading: false,
    pollTimer: null,
    root: null,
    fabBadge: null,
    panel: null,
    listEl: null,
    subEl: null,
    tabsEl: null,
  };

  function icon(name, size = 16) {
    return window.Icons ? window.Icons.el(name, { size }) : '';
  }

  function kindBadge(item) {
    if (item.kind === 'booked') {
      return h('span', { class: 'badge ok' }, icon('checkCircle', 13), t('chat.kindBooked'));
    }
    if (item.kind === 'cancelled') {
      return h('span', { class: 'badge danger' }, icon('ban', 13), t('chat.kindCancelled'));
    }
    if (item.kind === 'turn_now') {
      return h('span', { class: 'badge' }, icon('bell', 13), t('chat.kindTurnNow'));
    }
    if (item.kind === 'queue_ahead') {
      return h(
        'span',
        { class: 'badge warn' },
        icon('clock', 13),
        t('chat.kindQueueAhead', {
          n: item.ahead_count ?? 1,
          min: item.eta_minutes ?? 20,
        }),
      );
    }
    return h('span', { class: 'badge gray' }, item.kind);
  }

  function deliveryLabel(delivery) {
    if (delivery === 'sent') return t('chat.deliverySent');
    if (delivery === 'queued') return t('chat.deliveryQueued');
    if (delivery === 'failed') return t('chat.deliveryFailed');
    return t('chat.deliveryLocal');
  }

  function renderItem(item) {
    const nameNode =
      item.patient_id && typeof window.openPatientFile === 'function'
        ? h(
            'button',
            {
              type: 'button',
              class: 'chat-patient-link',
              onClick: () => window.openPatientFile(item.patient_id),
            },
            item.patient_name || t('common.patient'),
          )
        : h('span', { class: 'strong' }, item.patient_name || t('common.patient'));

    return h(
      'article',
      { class: `chat-item kind-${item.kind}` },
      h(
        'div',
        { class: 'chat-item-top' },
        kindBadge(item),
        h('span', { class: 'chat-time num' }, formatDateTime(item.created_at)),
      ),
      h(
        'div',
        { class: 'chat-who' },
        item.queue_number ? h('span', { class: 'chat-q num' }, `#${item.queue_number}`) : null,
        nameNode,
        item.phone ? h('span', { class: 'chat-phone muted small', dir: 'ltr' }, item.phone) : null,
      ),
      h('div', { class: 'chat-bubble' }, item.body),
      h(
        'div',
        { class: `chat-foot delivery-${item.delivery || 'local'}` },
        deliveryLabel(item.delivery),
      ),
    );
  }

  function renderTabs() {
    if (!state.tabsEl) return;
    const filters = [
      ['all', t('chat.filterAll')],
      ['booked', t('chat.filterBooked')],
      ['cancelled', t('chat.filterCancelled')],
      ['queue', t('chat.filterQueue')],
    ];
    clear(state.tabsEl).append(
      ...filters.map(([key, label]) =>
        h(
          'button',
          {
            type: 'button',
            class: state.filter === key ? 'active' : '',
            onClick: () => {
              state.filter = key;
              renderTabs();
              refresh({ scrollBottom: true });
            },
          },
          label,
        ),
      ),
    );
  }

  function updateBadge() {
    if (!state.fabBadge) return;
    const count = state.open ? 0 : Number(state.unread) || 0;
    state.fabBadge.textContent = count > 99 ? '99+' : String(count);
    state.fabBadge.classList.toggle('hidden', count <= 0);
  }

  function renderList({ scrollBottom = false } = {}) {
    if (!state.listEl) return;
    if (state.items.length === 0) {
      clear(state.listEl).append(
        h(
          'div',
          { class: 'empty' },
          h('span', { class: 'emoji' }, icon('chat', 30)),
          h('div', {}, t('chat.empty')),
        ),
      );
      return;
    }
    clear(state.listEl).append(...state.items.map(renderItem));
    if (scrollBottom) {
      state.listEl.scrollTop = state.listEl.scrollHeight;
    }
  }

  async function refresh(options = {}) {
    if (!state.root || !state.root.isConnected) return;
    if (window.App?.bootInfo?.auth?.unlocked === false) return;
    try {
      const data = await window.API.invoke('chat:feed', {
        kind: state.filter,
        limit: 60,
      });
      if (!state.root || !state.root.isConnected) return;

      const previousLatest = state.latestId;
      const hadNew = previousLatest !== null && data.latest_id > previousLatest;

      state.items = data.items || [];
      state.unread = data.unread || 0;
      state.latestId = data.latest_id ?? 0;
      state.todayCounts = data.today_counts || { booked: 0, cancelled: 0, queue: 0 };

      if (state.open && state.unread > 0) {
        state.unread = 0;
        window.API.invoke('chat:mark-read').catch(() => {});
      }

      updateBadge();
      renderList({ scrollBottom: Boolean(options.scrollBottom || hadNew) });

      if (hadNew && options.fromPoll && typeof window.App?.onExternalChatUpdate === 'function') {
        window.App.onExternalChatUpdate();
      }
    } catch (error) {
      /* ignore transient background poll errors */
    }
  }

  function setOpen(nextOpen) {
    state.open = Boolean(nextOpen);
    if (!state.panel) return;
    state.panel.classList.toggle('hidden', !state.open);
    if (state.open) {
      if (window.SFX) window.SFX.open();
      if (state.unread > 0) {
        state.unread = 0;
        updateBadge();
        window.API.invoke('chat:mark-read').catch(() => {});
      }
      refresh({ scrollBottom: true });
    } else {
      updateBadge();
    }
  }

  function demoBar() {
    if (!window.App?.demo) return null;
    const bookBtn = h(
      'button',
      {
        type: 'button',
        class: 'btn sm soft',
        onClick: async () => {
          bookBtn.disabled = true;
          try {
            const res = await window.API.invoke('chat:simulate', { mode: 'book_new' });
            if (res?.appointment) {
              toast(
                t('chat.simBookedToast', {
                  name: res.appointment.full_name,
                  q: res.appointment.queue_number,
                }),
                'ok',
              );
            }
            await refresh({ scrollBottom: true });
            if (window.App?.onExternalChatUpdate) window.App.onExternalChatUpdate();
          } catch (err) {
            toast(errorMessage(err), 'error');
          } finally {
            bookBtn.disabled = false;
          }
        },
      },
      icon('plus', 14),
      t('chat.simBook'),
    );

    const cancelBtn = h(
      'button',
      {
        type: 'button',
        class: 'btn sm',
        onClick: async () => {
          cancelBtn.disabled = true;
          try {
            const res = await window.API.invoke('chat:simulate', { mode: 'cancel_next' });
            if (res?.appointment) {
              toast(t('chat.simCancelledToast', { name: res.appointment.full_name }), 'ok');
            }
            await refresh({ scrollBottom: true });
            if (window.App?.onExternalChatUpdate) window.App.onExternalChatUpdate();
          } catch (err) {
            toast(errorMessage(err), 'error');
          } finally {
            cancelBtn.disabled = false;
          }
        },
      },
      icon('ban', 14),
      t('chat.simCancel'),
    );

    return h(
      'div',
      { class: 'mini-chat-sim' },
      h('div', { class: 'mini-chat-sim-label' }, t('chat.simTitle')),
      h('div', { class: 'row wrap', style: { gap: '8px' } }, bookBtn, cancelBtn),
    );
  }

  function stopPolling() {
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  }

  function mount(container) {
    stopPolling();
    state.latestId = null;

    state.fabBadge = h('span', { class: 'chat-fab-badge hidden num' }, '0');
    const fab = h(
      'button',
      {
        type: 'button',
        class: 'chat-fab no-print',
        title: t('chat.title'),
        onClick: () => setOpen(!state.open),
      },
      icon('chat', 20),
      h('span', { class: 'chat-fab-label' }, t('chat.fab')),
      state.fabBadge,
    );

    state.tabsEl = h('div', { class: 'tabs mini-chat-tabs' });
    state.listEl = h('div', { class: 'mini-chat-body' });
    state.subEl = h('div', { class: 'mini-chat-sub' }, t('chat.subtitle'));

    state.panel = h(
      'aside',
      {
        class: `mini-chat no-print ${state.open ? '' : 'hidden'}`,
        'aria-label': t('chat.title'),
      },
      h(
        'div',
        { class: 'mini-chat-head' },
        h(
          'div',
          { class: 'mini-chat-title-wrap' },
          h('div', { class: 'mini-chat-title' }, icon('whatsapp', 18), h('span', {}, t('chat.title'))),
          state.subEl,
        ),
        h(
          'div',
          { class: 'row', style: { gap: '4px' } },
          h(
            'button',
            {
              type: 'button',
              class: 'btn ghost icon sm',
              title: t('chat.markRead'),
              onClick: async () => {
                await window.API.invoke('chat:mark-read').catch(() => {});
                state.unread = 0;
                updateBadge();
                refresh({ scrollBottom: false });
              },
            },
            icon('check', 16),
          ),
          h(
            'button',
            {
              type: 'button',
              class: 'btn ghost icon sm',
              title: t('common.close'),
              onClick: () => setOpen(false),
            },
            icon('close', 16),
          ),
        ),
      ),
      h('div', { class: 'mini-chat-bar' }, state.tabsEl),
      state.listEl,
      demoBar(),
    );

    const wrap = h(
      'div',
      { class: `mini-chat-root no-print ${window.App?.demo ? 'with-demo-banner' : ''}` },
      state.panel,
      fab,
    );
    state.root = wrap;
    renderTabs();
    container.append(wrap);

    refresh({ scrollBottom: true });

    state.pollTimer = setInterval(() => {
      if (!state.root || !state.root.isConnected || !window.App?.bootInfo?.auth?.unlocked) {
        stopPolling();
        return;
      }
      refresh({ fromPoll: true });
    }, 4500);
  }

  window.addEventListener('unload', stopPolling);

  window.MiniChat = {
    mount,
    refresh,
    open: () => setOpen(true),
    close: () => setOpen(false),
    toggle: () => setOpen(!state.open),
    stop: stopPolling,
  };
})();
