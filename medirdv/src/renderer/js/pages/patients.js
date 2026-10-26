/* Patients list: organized chronologically by appointment days & dates, with strict date & queue-turn enforcement. */
(function () {
  'use strict';
  const { t, formatMoney, formatDate, formatLong } = window.I18N;
  const { h, clear, emptyState, statusBadge, toast, errorMessage, input, debounce } = window.UI;
  const Pages = window.Pages;

  let activeMode = 'by_days'; // 'by_days' | 'today' | 'all' | 'debtors'
  let selectedDayFilter = '';

  function relativeDayBadge(group) {
    const delta = Number(group.days_from_today || 0);
    if (delta === 0) return h('span', { class: 'badge ok' }, '🟢 ' + t('patients.dayToday'));
    if (delta === 1) return h('span', { class: 'badge warn' }, '🗓️ ' + t('patients.dayTomorrow'));
    if (delta === 2) return h('span', { class: 'badge warn' }, '🗓️ ' + t('patients.dayAfterTomorrow'));
    if (delta > 2) return h('span', { class: 'badge warn' }, '🗓️ ' + t('patients.dayInDays', { n: delta }));
    return h('span', { class: 'badge gray' }, '📁 ' + t('patients.dayPast'));
  }

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

      const search = input({ placeholder: t('patients.search'), class: 'input', style: { maxWidth: '300px' } });
      const dateInput = input({
        type: 'date',
        value: selectedDayFilter,
        class: 'input',
        title: t('patients.filterDate'),
        style: { maxWidth: '175px' },
      });
      const clearDateBtn = h(
        'button',
        {
          class: 'btn sm ghost',
          style: { display: selectedDayFilter ? 'inline-flex' : 'none' },
          onClick: () => {
            selectedDayFilter = '';
            dateInput.value = '';
            clearDateBtn.style.display = 'none';
            load();
          },
        },
        '✕ ',
        t('patients.clearDate'),
      );
      const dateFilterWrap = h(
        'div',
        { class: 'row', style: { gap: '6px', display: activeMode === 'by_days' ? 'flex' : 'none' } },
        dateInput,
        clearDateBtn,
      );

      const contentHost = h('div', { class: 'col', style: { gap: '16px' } });

      const tabByDays = h(
        'button',
        { class: activeMode === 'by_days' ? 'active' : '', onClick: () => setMode('by_days') },
        '📅 ' + t('patients.byDays'),
      );
      const tabToday = h(
        'button',
        { class: activeMode === 'today' ? 'active' : '', onClick: () => setMode('today') },
        '🟢 ' + t('patients.todayTab'),
      );
      const tabAll = h(
        'button',
        { class: activeMode === 'all' ? 'active' : '', onClick: () => setMode('all') },
        t('patients.all'),
      );
      const tabDebtors = h(
        'button',
        { class: activeMode === 'debtors' ? 'active' : '', onClick: () => setMode('debtors') },
        t('patients.onlyDebtors'),
      );
      const tabs = h('div', { class: 'tabs' }, tabByDays, tabToday, tabAll, tabDebtors);

      function setMode(mode) {
        if (activeMode === mode) return;
        activeMode = mode;
        tabByDays.classList.toggle('active', mode === 'by_days');
        tabToday.classList.toggle('active', mode === 'today');
        tabAll.classList.toggle('active', mode === 'all');
        tabDebtors.classList.toggle('active', mode === 'debtors');
        dateFilterWrap.style.display = mode === 'by_days' ? 'flex' : 'none';
        load();
      }

      const markNoShow = async (item) => {
        try {
          await window.API.invoke('appointments:status', { id: item.id, status: 'no_show' });
          toast(t('agenda.noShow'), 'ok');
          ctx.refresh();
        } catch (error) {
          toast(errorMessage(error), 'error');
        }
      };

      const deletePatient = async (patientId, fullName) => {
        const ok = await window.UI.confirmDialog(t('patients.deleteConfirm', { name: fullName }));
        if (!ok) return;
        try {
          await window.API.invoke('patients:remove', { id: patientId });
          toast(t('common.deleted'), 'ok');
          ctx.refresh();
        } catch (error) {
          toast(errorMessage(error), 'error');
        }
      };

      function renderDayGroupCard(group) {
        const isTodayGroup = group.day_relation === 'today';
        const isFutureGroup = group.day_relation === 'future';

        const headerRight = h(
          'div',
          { class: 'row', style: { gap: '8px', flexWrap: 'wrap' } },
          h('span', { class: 'badge gray' }, t('patients.groupCount', { n: group.total_count })),
          isFutureGroup
            ? h(
                'span',
                { class: 'badge warn', title: t('patients.futureLockedHint') },
                '🔒 ' + t('patients.futureLockedBadge'),
              )
            : null,
        );

        const header = h(
          'div',
          {
            class: 'row',
            style: {
              justifyContent: 'space-between',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: '10px',
              paddingBottom: '12px',
              marginBottom: '12px',
              borderBottom: '1px solid var(--border, rgba(0,0,0,0.08))',
            },
          },
          h(
            'div',
            { class: 'row', style: { gap: '10px', alignItems: 'center', flexWrap: 'wrap' } },
            relativeDayBadge(group),
            h('strong', { style: { fontSize: '1.03rem' } }, formatLong(group.day)),
            h('span', { class: 'muted' }, `(${formatDate(group.day)})`),
          ),
          headerRight,
        );

        const tbody = h(
          'tbody',
          {},
          group.items.map((item) => {
            const deptLabel = window.Components.departmentLabel(item);
            const actions = h('div', { class: 'row', style: { justifyContent: 'flex-end', gap: '4px' } });

            if (item.status === 'booked') {
              if (item.day_relation === 'future') {
                actions.append(
                  h(
                    'span',
                    { class: 'badge warn', title: t('patients.futureLockedHint') },
                    '🔒',
                  ),
                  h(
                    'button',
                    {
                      class: 'btn icon sm',
                      title: t('agenda.reschedule'),
                      onClick: () => window.Components.rescheduleDialog(item, ctx.refresh),
                    },
                    '📅',
                  ),
                );
              } else {
                const waitTitle = item.can_complete
                  ? t('queue.finishAndCallNext')
                  : t('patients.waitTurnHint', {
                      q: item.blocking_queue_number || 1,
                      name: item.blocking_patient_name || '—',
                    });
                actions.append(
                  h(
                    'button',
                    {
                      class: 'btn icon sm soft',
                      disabled: !item.can_complete,
                      title: waitTitle,
                      onClick: () => window.Components.completeAppointment(item, ctx.refresh),
                    },
                    '✓',
                  ),
                  h(
                    'button',
                    {
                      class: 'btn icon sm',
                      disabled: !item.can_mark_no_show,
                      title: t('agenda.noShow'),
                      onClick: () => markNoShow(item),
                    },
                    '🚫',
                  ),
                  h(
                    'button',
                    {
                      class: 'btn icon sm',
                      title: t('agenda.reschedule'),
                      onClick: () => window.Components.rescheduleDialog(item, ctx.refresh),
                    },
                    '📅',
                  ),
                );
              }
              actions.append(
                h(
                  'button',
                  {
                    class: 'btn icon sm',
                    title: t('common.cancel'),
                    onClick: () => window.Components.cancelAppointment(item, ctx.refresh),
                  },
                  '✕',
                ),
              );
            }

            actions.append(
              h(
                'button',
                {
                  class: 'btn icon sm',
                  title: t('patients.newAppointment'),
                  onClick: () =>
                    window.Components.openAppointmentModal({ patientId: item.patient_id, onSaved: ctx.refresh }),
                },
                '🗓️',
              ),
              h(
                'button',
                {
                  class: 'btn icon sm',
                  title: t('common.edit'),
                  onClick: async () => {
                    try {
                      const detail = await window.API.invoke('patients:get', { id: item.patient_id });
                      window.Components.openPatientModal({ patient: detail.patient, onSaved: ctx.refresh });
                    } catch (err) {
                      toast(errorMessage(err), 'error');
                    }
                  },
                },
                '✏️',
              ),
            );

            let turnPill = null;
            if (item.day_relation === 'today' && item.status === 'booked') {
              turnPill = item.is_current_turn
                ? h('span', { class: 'badge ok', style: { marginInlineStart: '6px' } }, t('queue.currentNow'))
                : h(
                    'span',
                    {
                      class: 'badge gray',
                      style: { marginInlineStart: '6px' },
                      title: t('patients.waitTurnHint', {
                        q: item.blocking_queue_number || 1,
                        name: item.blocking_patient_name || '—',
                      }),
                    },
                    t('patients.waitTurnBadge', { q: item.blocking_queue_number || 1 }),
                  );
            }

            return h(
              'tr',
              {},
              h(
                'td',
                {},
                h('strong', {}, `#${item.queue_number}`),
                item.slot_time ? h('div', { class: 'muted', style: { fontSize: '0.82rem' } }, item.slot_time) : null,
              ),
              h(
                'td',
                {},
                h(
                  'button',
                  {
                    class: 'btn ghost sm',
                    style: { padding: '0', fontWeight: '700', minHeight: 'auto' },
                    onClick: () => window.openPatientFile(item.patient_id),
                  },
                  item.full_name,
                ),
                turnPill,
              ),
              h('td', {}, item.phone || '—'),
              h('td', {}, deptLabel || '—'),
              h('td', {}, statusBadge(item.status)),
              h(
                'td',
                {},
                Number(item.patient_balance) > 0.009
                  ? h('span', { class: 'badge danger' }, formatMoney(item.patient_balance, currency))
                  : h('span', { class: 'badge ok' }, t('patients.paidAll')),
              ),
              h('td', { class: 'actions' }, actions),
            );
          }),
        );

        return h(
          'div',
          {
            class: 'card',
            style: isTodayGroup
              ? { borderInlineStart: '4px solid var(--ok, #16a34a)' }
              : isFutureGroup
                ? { borderInlineStart: '4px solid var(--warn, #d97706)' }
                : {},
          },
          header,
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
                  h('th', {}, t('patients.queue')),
                  h('th', {}, t('common.name')),
                  h('th', {}, t('common.phone')),
                  h('th', {}, t('patients.department')),
                  h('th', {}, t('common.status')),
                  h('th', {}, t('patients.balance')),
                  h('th', { class: 'actions' }, t('common.actions')),
                ),
              ),
              tbody,
            ),
          ),
        );
      }

      function renderFlatPatientsCard(rows, { titleText = '', isDebtors = false } = {}) {
        return h(
          'div',
          { class: 'card' },
          titleText
            ? h(
                'div',
                {
                  class: 'row',
                  style: {
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    paddingBottom: '12px',
                    marginBottom: '12px',
                    borderBottom: '1px solid var(--border, rgba(0,0,0,0.08))',
                  },
                },
                h('strong', {}, titleText),
                h('span', { class: 'badge gray' }, t('patients.groupCount', { n: rows.length })),
              )
            : null,
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
                  !isDebtors ? h('th', {}, t('patients.upcoming')) : null,
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
                    !isDebtors
                      ? h(
                          'td',
                          {},
                          patient.next_visit
                            ? h('span', { class: 'badge warn' }, formatDate(patient.next_visit))
                            : '—',
                        )
                      : null,
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
                          onClick: () => window.Components.openPatientModal({ patient, onSaved: ctx.refresh }),
                        },
                        '✏️',
                      ),
                      h(
                        'button',
                        {
                          class: 'btn icon sm',
                          title: t('common.delete'),
                          onClick: () => deletePatient(patient.id, patient.full_name),
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
      }

      let loadSeq = 0;
      const load = async () => {
        const seq = ++loadSeq;
        try {
          const term = search.value.trim();

          if (activeMode === 'by_days' || activeMode === 'today') {
            const payload =
              activeMode === 'today'
                ? { scope: 'today', search: term }
                : { scope: 'all', day: selectedDayFilter || '', search: term };
            const res = await window.API.invoke('patients:by-day', payload);
            if (seq !== loadSeq) return;
            clear(contentHost);
            contentHost.dataset.mode = activeMode;
            const groups = res?.groups || [];
            const unscheduled = res?.unscheduled || [];

            if (groups.length === 0 && unscheduled.length === 0) {
              contentHost.append(
                h(
                  'div',
                  { class: 'card' },
                  emptyState(
                    term || selectedDayFilter ? t('patients.noAppointmentsMatch') : t('patients.noHistory'),
                    '📅',
                  ),
                ),
              );
              return;
            }

            groups.forEach((group) => contentHost.append(renderDayGroupCard(group)));
            if (unscheduled.length > 0) {
              contentHost.append(
                renderFlatPatientsCard(unscheduled, { titleText: '📋 ' + t('patients.unscheduledTitle') }),
              );
            }
            return;
          }

          const rows =
            activeMode === 'debtors'
              ? await window.API.invoke('patients:debtors')
              : await window.API.invoke('patients:list', { search: term, limit: 500 });
          if (seq !== loadSeq) return;
          clear(contentHost);
          contentHost.dataset.mode = activeMode;

          if (rows.length === 0) {
            contentHost.append(
              h(
                'div',
                { class: 'card' },
                emptyState(
                  activeMode === 'debtors'
                    ? t('patients.noDebtors')
                    : term
                      ? t('common.searchEmpty')
                      : t('patients.noHistory'),
                  activeMode === 'debtors' ? '✅' : '👤',
                ),
              ),
            );
            return;
          }

          contentHost.append(renderFlatPatientsCard(rows, { isDebtors: activeMode === 'debtors' }));
        } catch (error) {
          if (seq !== loadSeq) return;
          clear(contentHost).append(h('div', { class: 'card error-text' }, errorMessage(error)));
        }
      };

      search.addEventListener('input', debounce(load, 220));
      dateInput.addEventListener('change', () => {
        selectedDayFilter = dateInput.value || '';
        clearDateBtn.style.display = selectedDayFilter ? 'inline-flex' : 'none';
        load();
      });

      clear(root).append(
        h(
          'div',
          { class: 'row mb', style: { justifyContent: 'space-between', flexWrap: 'wrap', gap: '10px' } },
          h('div', { class: 'row', style: { gap: '8px', flexWrap: 'wrap' } }, search, dateFilterWrap),
          tabs,
        ),
        contentHost,
      );
      await load();
    },
  };
})();
