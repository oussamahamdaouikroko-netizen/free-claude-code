/* WhatsApp connection + reminder panel. */
(function () {
  'use strict';
  const { t, formatDate, formatDateTime } = window.I18N;
  const { h, clear, toast, errorMessage, input } = window.UI;
  const Pages = window.Pages;

  // Why the last message was ignored — shown so "connected but silent" is
  // understandable without reading a log file.
  const SKIP_KEY = {
    not_a_private_chat: 'wa.skipNotPrivate',
    own_message: 'wa.skipOwn',
    not_a_question: 'wa.skipNotQuestion',
    duplicate: 'wa.skipDuplicate',
    too_old: 'wa.skipTooOld',
    no_phone: 'wa.skipNoPhone',
    rate_limit: 'wa.skipRateLimit',
    no_reply: 'wa.skipNoReply',
  };

  const STATE_KEY = {
    connected: 'wa.connected',
    connecting: 'wa.connecting',
    qr: 'wa.qr',
    stopped: 'wa.stopped',
    logged_out: 'wa.logged_out',
    error: 'wa.error',
    unavailable: 'wa.stopped',
  };

  function statusCard(status, ctx) {
    const label = t(STATE_KEY[status.state] || 'wa.disconnected');
    return h(
      'div',
      { class: 'card' },
      h('h2', { class: 'card-title' }, t('wa.status')),
      h(
        'div',
        { class: 'row', style: { fontSize: '1.05rem', fontWeight: '700' } },
        h('span', { class: `status-dot ${status.state}` }),
        label,
      ),
      status.phone ? h('div', { class: 'info-line' }, h('span', { class: 'k' }, t('wa.phone')), h('strong', { dir: 'ltr' }, `+${status.phone}`)) : null,
      h('div', { class: 'info-line' }, h('span', { class: 'k' }, t('wa.repliesToday')), h('strong', {}, String(status.replies_today ?? 0))),
      h('div', { class: 'info-line' }, h('span', { class: 'k' }, t('wa.received')), h('strong', {}, String(status.messages?.received ?? 0))),
      h('div', { class: 'info-line' }, h('span', { class: 'k' }, t('wa.replied')), h('strong', {}, String(status.messages?.replied ?? 0))),
      status.messages?.last_at
        ? h('div', { class: 'info-line' }, h('span', { class: 'k' }, t('wa.lastMessage')), h('span', {}, formatDateTime(status.messages.last_at)))
        : null,
      status.messages?.last_skip
        ? h(
            'div',
            { class: 'info-line' },
            h('span', { class: 'k' }, t('wa.lastSkip')),
            h('span', { class: 'small muted' },
              `${t(SKIP_KEY[status.messages.last_skip.reason] || 'wa.skipOther')} · ${formatDateTime(status.messages.last_skip.at)}`),
          )
        : null,
      status.last_error ? h('div', { class: 'info-line' }, h('span', { class: 'k' }, t('wa.lastError')), h('span', { class: 'small', style: { color: 'var(--danger)' } }, status.last_error)) : null,
      h(
        'div',
        { class: 'row mt wrap' },
        status.state === 'connected'
          ? h('button', { class: 'btn', onClick: async () => { await window.API.invoke('wa:stop'); toast(t('common.saved'), 'ok'); ctx.refresh(); } }, t('wa.stop'))
          : h('button', { class: 'btn primary', onClick: async () => {
              try {
                await window.API.invoke('wa:start');
                ctx.refresh();
              } catch (error) {
                toast(errorMessage(error), 'error');
              }
            } }, '💬 ' + t('wa.start')),
        status.state === 'connected' || status.state === 'logged_out'
          ? h(
              'button',
              {
                class: 'btn danger',
                onClick: async () => {
                  const ok = await window.UI.confirmDialog(t('wa.logoutConfirm'));
                  if (!ok) return;
                  await window.API.invoke('wa:logout').catch((error) => toast(errorMessage(error), 'error'));
                  ctx.refresh();
                },
              },
              t('wa.logout'),
            )
          : null,
      ),
    );
  }

  function qrCard(status) {
    if (status.state === 'qr' && status.qr) {
      return h(
        'div',
        { class: 'qr-box' },
        h('h3', { style: { marginTop: '0' } }, t('wa.scan')),
        h('img', { src: status.qr, alt: 'QR' }),
        h('p', { class: 'help' }, t('wa.scanSteps')),
        h('p', { class: 'help' }, t('wa.qrHint')),
      );
    }
    if (status.state === 'connected') {
      return h(
        'div',
        { class: 'qr-box' },
        h('div', { style: { fontSize: '3rem' } }, '✅'),
        h('p', { class: 'strong' }, t('wa.connected')),
        h('p', { class: 'help' }, t('wa.reservationDesc')),
      );
    }
    return h(
      'div',
      { class: 'qr-box' },
      h('div', { style: { fontSize: '3rem' } }, '💬'),
      h('p', { class: 'strong' }, t('wa.disconnected')),
      h('p', { class: 'help' }, t('wa.scanSteps')),
    );
  }

  function infoCard() {
    return h(
      'div',
      { class: 'card' },
      h('h2', { class: 'card-title' }, t('wa.reservation')),
      h('p', { class: 'muted small' }, t('wa.reservationDesc')),
      h('div', { class: 'tag-list mt-s' }, h('span', { class: 'tag' }, t('wa.commandCancel')), h('span', { class: 'tag' }, t('wa.commandMine'))),
      h('h2', { class: 'card-title mt' }, t('wa.antiban')),
      h('p', { class: 'muted small' }, t('wa.antibanDesc')),
    );
  }

  async function reminderCard(ctx, settings, status) {
    const preview = await window.API.invoke('wa:preview').catch(() => []);
    const toggle = h('input', { type: 'checkbox', checked: settings.reminder_enabled === '1' });
    toggle.addEventListener('change', async () => {
      try {
        await window.API.invoke('settings:set', { reminder_enabled: toggle.checked ? '1' : '0' });
        toast(t('common.saved'), 'ok');
      } catch (error) {
        toast(errorMessage(error), 'error');
      }
    });

    return h(
      'div',
      { class: 'card' },
      h('h2', { class: 'card-title' }, t('wa.reminders'),
        h('label', { class: 'switch' }, toggle, h('span', {}))),
      h('p', { class: 'muted small' }, t('wa.remindersDesc')),
      h('div', { class: 'row between mt-s' }, h('span', { class: 'small muted' }, t('wa.reminderHour')), h('strong', {}, `${settings.reminder_hour}:00`)),
      h(
        'div',
        { class: 'mt' },
        h('div', { class: 'row between mb' },
          h('h3', { style: { margin: '0', fontSize: '0.95rem' } }, t('wa.preview')),
          h(
            'button',
            {
              class: 'btn sm soft',
              disabled: status.state !== 'connected',
              onClick: async (event) => {
                const button = event.currentTarget;
                button.disabled = true;
                try {
                  const result = await window.API.invoke('wa:reminders-now');
                  if (result.sent) toast(t('wa.sentNow', { n: result.sent }), 'ok');
                  else if (result.skipped === 'not_connected') toast(t('wa.notConnected'), 'error');
                  else toast(t('wa.nothingToSend'));
                  ctx.refresh();
                } catch (error) {
                  toast(errorMessage(error), 'error');
                } finally {
                  button.disabled = false;
                }
              },
            },
            '📤 ' + t('wa.sendNow'),
          ),
        ),
        preview.length === 0
          ? h('div', { class: 'muted small' }, t('wa.nothingToSend'))
          : h(
              'div',
              { class: 'table-wrap' },
              h(
                'table',
                { class: 'list' },
                h('thead', {}, h('tr', {}, h('th', {}, t('common.patient')), h('th', {}, t('common.date')), h('th', {}, 'N°'), h('th', {}, t('common.status')))),
                h(
                  'tbody',
                  {},
                  preview.map((row) =>
                    h(
                      'tr',
                      {},
                      h('td', {}, row.full_name),
                      h('td', {}, formatDate(row.day)),
                      h('td', {}, String(row.queue_number)),
                      h(
                        'td',
                        {},
                        row.reminder_status === 'sent'
                          ? h('span', { class: 'badge ok' }, t('wa.reminderSent'))
                          : row.reminder_status
                            ? h('span', { class: 'badge gray' }, t('wa.notOnWhatsApp'))
                            : h('span', { class: 'badge' }, t('wa.reminderPending')),
                      ),
                    ),
                  ),
                ),
              ),
            ),
      ),
    );
  }

  /** Patients the bot could not place (planning full). */
  async function waitingCard(ctx) {
    const rows = await window.API.invoke('appointments:waiting-list').catch(() => []);
    if (rows.length === 0) return null;
    return h(
      'div',
      { class: 'card' },
      h('h2', { class: 'card-title' }, t('dash.waiting', { n: rows.length })),
      h(
        'div',
        { class: 'table-wrap' },
        h(
          'table',
          { class: 'list' },
          h('thead', {}, h('tr', {}, h('th', {}, t('common.name')), h('th', {}, t('common.phone')), h('th', {}, t('common.date')), h('th', { class: 'actions' }, ''))),
          h(
            'tbody',
            {},
            rows.map((row) =>
              h(
                'tr',
                {},
                h('td', { class: 'strong' }, row.full_name),
                h('td', { dir: 'ltr' }, row.phone),
                h('td', {}, formatDate((row.created_at || '').slice(0, 10))),
                h(
                  'td',
                  { class: 'actions' },
                  h(
                    'button',
                    {
                      class: 'btn sm primary',
                      onClick: () => window.Components.openAppointmentModal({ onSaved: async () => {
                        await window.API.invoke('appointments:waiting-handle', { id: row.id }).catch(() => {});
                        ctx.refresh();
                      } }),
                    },
                    '🗓️ ' + t('patients.book'),
                  ),
                  h(
                    'button',
                    {
                      class: 'btn icon sm',
                      title: t('common.delete'),
                      onClick: async () => {
                        await window.API.invoke('appointments:waiting-handle', { id: row.id }).catch(() => {});
                        ctx.refresh();
                      },
                    },
                    '✓',
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  Pages.whatsapp = {
    async render(root, ctx) {
      ctx.setHeader(t('wa.title'), t('wa.subtitle'));

      let status;
      let settings;
      try {
        [status, settings] = await Promise.all([
          window.API.invoke('wa:status'),
          window.API.invoke('settings:get'),
        ]);
      } catch (error) {
        clear(root).append(h('div', { class: 'card error-text' }, errorMessage(error)));
        return;
      }

      clear(root).append(
        h(
          'div',
          { class: 'wa-panel' },
          h('div', { class: 'col' }, statusCard(status, ctx), qrCard(status), infoCard()),
          h('div', { class: 'col' }, await reminderCard(ctx, settings, status), await waitingCard(ctx)),
        ),
      );

      // Refresh the QR panel while the dentist is scanning.
      const timer = setInterval(() => {
        if (window.App.page !== 'whatsapp') {
          clearInterval(timer);
          return;
        }
        if (window.App.bootInfo?.auth?.unlocked === false) {
          clearInterval(timer);
          return;
        }
        window.API.invoke('wa:status')
          .then((next) => {
            if (next.qr !== status.qr || next.state !== status.state) ctx.refresh();
          })
          .catch(() => clearInterval(timer));
      }, 4000);
    },
  };
})();
