/* Patients list. */
(function () {
  'use strict';
  const { t, formatMoney, formatDate } = window.I18N;
  const { h, clear, emptyState, toast, errorMessage, input, debounce } = window.UI;
  const Pages = window.Pages;

  Pages.patients = {
    async render(root, ctx) {
      const currency = window.App.settings.currency;
      ctx.setHeader(
        t('patients.title'),
        t('patients.subtitle'),
        h(
          'button',
          { class: 'btn primary', onClick: () => window.Components.openPatientModal({ onSaved: ctx.refresh }) },
          '＋ ',
          t('patients.new'),
        ),
      );

      const search = input({ placeholder: t('patients.search'), class: 'input', style: { maxWidth: '360px' } });
      const tableHost = h('div', {});

      const load = async () => {
        try {
          const rows = await window.API.invoke('patients:list', { search: search.value.trim(), limit: 500 });
          clear(tableHost);
          if (rows.length === 0) {
            tableHost.append(emptyState(search.value ? t('common.searchEmpty') : t('patients.noHistory'), '👤'));
            return;
          }
          tableHost.append(
            h(
              'div',
              { class: 'table-wrap' },
              h(
                'table',
                { class: 'list' },
                h(
                  'thead',
                  {},
                  h(
                    'tr',
                    {},
                    h('th', {}, t('common.name')),
                    h('th', {}, t('common.phone')),
                    h('th', {}, t('patients.balance')),
                    h('th', {}, t('patients.lastVisit')),
                    h('th', { class: 'actions' }, t('common.actions')),
                  ),
                ),
                h(
                  'tbody',
                  {},
                  rows.map((patient) =>
                    h(
                      'tr',
                      {},
                      h(
                        'td',
                        {},
                        h(
                          'button',
                          {
                            class: 'btn ghost sm',
                            style: { padding: '0', fontWeight: '700', minHeight: 'auto' },
                            onClick: () => window.openPatientFile(patient.id),
                          },
                          patient.full_name,
                        ),
                      ),
                      h('td', {}, patient.phone || '—'),
                      h(
                        'td',
                        {},
                        Number(patient.balance) > 0.009
                          ? h('span', { class: 'badge danger' }, formatMoney(patient.balance, currency))
                          : h('span', { class: 'badge ok' }, t('patients.paidAll')),
                      ),
                      h('td', {}, patient.last_visit ? formatDate(patient.last_visit) : '—'),
                      h(
                        'td',
                        { class: 'actions' },
                        h(
                          'button',
                          {
                            class: 'btn icon sm',
                            title: t('patients.newAppointment'),
                            onClick: () =>
                              window.Components.openAppointmentModal({ patientId: patient.id, onSaved: ctx.refresh }),
                          },
                          '🗓️',
                        ),
                        h(
                          'button',
                          {
                            class: 'btn icon sm',
                            title: t('common.edit'),
                            onClick: () =>
                              window.Components.openPatientModal({ patient, onSaved: ctx.refresh }),
                          },
                          '✏️',
                        ),
                        h(
                          'button',
                          {
                            class: 'btn icon sm',
                            title: t('common.delete'),
                            onClick: async () => {
                              const ok = await window.UI.confirmDialog(
                                t('patients.deleteConfirm', { name: patient.full_name }),
                              );
                              if (!ok) return;
                              try {
                                await window.API.invoke('patients:remove', { id: patient.id });
                                toast(t('common.deleted'), 'ok');
                                ctx.refresh();
                              } catch (error) {
                                toast(errorMessage(error), 'error');
                              }
                            },
                          },
                          '🗑️',
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          );
        } catch (error) {
          clear(tableHost).append(h('div', { class: 'error-text' }, errorMessage(error)));
        }
      };

      search.addEventListener('input', debounce(load, 220));
      clear(root).append(
        h('div', { class: 'row mb' }, search),
        h('div', { class: 'card' }, tableHost),
      );
      await load();
    },
  };
})();
