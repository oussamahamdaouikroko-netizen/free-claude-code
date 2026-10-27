/* Patients list — grouped by days & dates with strict turn & future-day locks. */
(function () {
  'use strict';
  const { t, formatMoney, formatLong, formatDate } = window.I18N;
  const { h, clear, emptyState, statusBadge, toast, errorMessage, input, debounce, todayISO } = window.UI;
  const Pages = window.Pages;

  function diffDaysISO(dayISO, refISO) {
    if (!dayISO || !refISO) return 0;
    const [y1, m1, d1] = dayISO.split('-').map(Number);
    const [y2, m2, d2] = refISO.split('-').map(Number);
    const utc1 = Date.UTC(y1, m1 - 1, d1);
    const utc2 = Date.UTC(y2, m2 - 1, d2);
    return Math.round((utc1 - utc2) / 86400000);
  }

  function buildDayBadge(group) {
    const diff = diffDaysISO(group.day, group.today);
    if (diff === 0) return { text: t('patients.dayToday'), cls: 'badge ok' };
    if (diff === 1) return { text: t('patients.dayTomorrow'), cls: 'badge info' };
    if (diff === 2) return { text: t('patients.dayAfterTomorrow'), cls: 'badge info' };
    if (diff > 2) return { text: t('patients.dayInDays', { n: diff }), cls: 'badge gray' };
    return { text: t('patients.dayPast'), cls: 'badge warn' };
  }

  function renderPatientNameCell(patientId, fullName, allergies, notes) {
    return h(
      'td',
      {},
      h(
        'div',
        { class: 'row wrap', style: { gap: '6px' } },
        h(
          'button',
          {
            class: 'btn ghost sm',
            style: { padding: '0', fontWeight: '700', minHeight: 'auto' },
            onClick: () => window.openPatientFile && window.openPatientFile(patientId),
          },
          fullName,
        ),
        allergies
          ? h('span', { class: 'badge danger' }, t('patients.allergyTag', { v: allergies }))
          : null,
      ),
      notes ? h('div', { class: 'muted small' }, notes) : null,
    );
  }

  function renderBalanceBadge(balance, currency) {
    return Number(balance) > 0.009
      ? h('span', { class: 'badge danger' }, formatMoney(balance, currency))
      : h('span', { class: 'badge ok' }, t('patients.paidAll'));
  }

  function renderScheduledGroupCard(group, currency, ctx, onRefresh) {
    const rel = buildDayBadge(group);
    const isFuture = Boolean(group.isFuture);
    const isToday = Boolean(group.isToday);

    const setStatusAction = async (appointmentId, status, msg) => {
      try {
        await window.API.invoke('appointments:status', { id: appointmentId, status });
        toast(msg, 'ok');
        onRefresh();
      } catch (error) {
        toast(errorMessage(error), 'error');
      }
    };

    return h(
      'div',
      { class: 'card mb' },
      h(
        'div',
        { class: 'row between wrap mb-s', style: { gap: '8px' } },
        h(
          'div',
          { class: 'row wrap', style: { gap: '8px' } },
          h('span', { class: rel.cls }, rel.text),
          h('h3', { class: 'card-title', style: { margin: 0 } }, '📅 ' + formatLong(group.day)),
          h('span', { class: 'muted small', dir: 'ltr' }, `(${group.day})`),
        ),
        h(
          'div',
          { class: 'row wrap', style: { gap: '6px' } },
          isFuture
            ? h(
                'span',
                { class: 'badge warn', title: t('patients.futureLockedHint') },
                '🔒 ' + t('patients.futureLockedBadge'),
              )
            : null,
          h('span', { class: 'badge' }, t('patients.groupCount', { n: group.items.length })),
        ),
      ),
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
              h('th', {}, t('patients.treatment')),
              h('th', {}, t('common.status')),
              h('th', {}, t('patients.balance')),
              h('th', { class: 'actions' }, t('common.actions')),
            ),
          ),
          h(
            'tbody',
            {},
            group.items.map((item) => {
              const isBooked = item.status === 'booked';
              const canCompleteNow = isBooked && !isFuture && (!isToday || Boolean(item.is_current_turn));
              const isWaitingTurn = isBooked && isToday && !item.is_current_turn;

              const actionBtns = [];

              if (isBooked) {
                if (isFuture) {
                  actionBtns.push(
                    h(
                      'span',
                      { class: 'badge gray', title: t('patients.futureLockedHint') },
                      '🔒 ' + t('patients.futureLockedBadge'),
                    ),
                    h(
                      'button',
                      {
                        class: 'btn sm ghost',
                        title: t('agenda.reschedule'),
                        onClick: () =>
                          window.Components.rescheduleDialog &&
                          window.Components.rescheduleDialog(item, onRefresh),
                      },
                      '🗓️ ' + t('agenda.reschedule'),
                    ),
                  );
                } else if (canCompleteNow) {
                  actionBtns.push(
                    h(
                      'button',
                      {
                        class: 'btn sm soft',
                        title: t('queue.finishAndCallNext'),
                        onClick: () => window.Components.completeAppointment(item, onRefresh),
                      },
                      '✓ ' + t('queue.finishTreatment'),
                    ),
                    h(
                      'button',
                      {
                        class: 'btn icon sm',
                        title: t('agenda.noShow'),
                        onClick: () => setStatusAction(item.id, 'no_show', t('agenda.noShow')),
                      },
                      '🚫',
                    ),
                  );
                } else if (isWaitingTurn) {
                  const waitTitle = item.blocking_patient
                    ? t('patients.waitTurnHint', {
                        q: item.blocking_patient.queue_number,
                        name: item.blocking_patient.full_name,
                      })
                    : t('error.QUEUE_OUT_OF_TURN');
                  actionBtns.push(
                    h(
                      'button',
                      {
                        class: 'btn sm ghost',
                        disabled: true,
                        title: waitTitle,
                      },
                      '⏳ ' + t('patients.waitTurnBadge', { q: item.ahead_count || 1 }),
                    ),
                    h(
                      'button',
                      {
                        class: 'btn icon sm',
                        title: t('agenda.noShow'),
                        onClick: () => setStatusAction(item.id, 'no_show', t('agenda.noShow')),
                      },
                      '🚫',
                    ),
                  );
                }
              }

              actionBtns.push(
                h(
                  'button',
                  {
                    class: 'btn icon sm',
                    title: t('rx.newPrescription'),
                    onClick: () =>
                      window.openPrescriptionComposer &&
                      window.openPrescriptionComposer({
                        id: item.patient_id,
                        full_name: item.full_name,
                        allergies: item.allergies || '',
                        chronic_conditions: item.chronic_conditions || '',
                      }),
                  },
                  window.Icons ? window.Icons.el('prescription', { size: 15 }) : '℞',
                ),
                h(
                  'button',
                  {
                    class: 'btn icon sm',
                    title: t('common.details'),
                    onClick: () => window.openPatientFile && window.openPatientFile(item.patient_id),
                  },
                  '📂',
                ),
              );

              return h(
                'tr',
                {},
                h(
                  'td',
                  {},
                  h('span', { class: 'badge' }, `#${item.queue_number}`),
                  item.priority === 'urgent'
                    ? h('span', { class: 'badge danger', style: { marginInlineStart: '4px' } }, '🚨')
                    : null,
                  item.slot_time
                    ? h('div', { class: 'muted small', dir: 'ltr' }, item.slot_time)
                    : null,
                ),
                renderPatientNameCell(item.patient_id, item.full_name, item.allergies, item.notes),
                h('td', { dir: 'ltr' }, item.phone || '—'),
                h('td', {}, item.treatment_name || '—'),
                h('td', {}, statusBadge(item.status)),
                h('td', {}, renderBalanceBadge(item.patient_balance, currency)),
                h('td', { class: 'actions' }, ...actionBtns),
              );
            }),
          ),
        ),
      ),
    );
  }

  function renderFlatPatientTable(rows, currency, ctx, onRefresh) {
    return h(
      'div',
      { class: 'card' },
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
                renderPatientNameCell(patient.id, patient.full_name, patient.allergies, patient.notes),
                h('td', { dir: 'ltr' }, patient.phone || '—'),
                h('td', {}, renderBalanceBadge(patient.balance, currency)),
                h(
                  'td',
                  {},
                  patient.next_visit
                    ? h(
                        'span',
                        {},
                        '📅 ' + formatDate(patient.next_visit),
                        patient.last_visit
                          ? h('div', { class: 'muted small' }, formatDate(patient.last_visit))
                          : null,
                      )
                    : patient.last_visit
                      ? formatDate(patient.last_visit)
                      : '—',
                ),
                h(
                  'td',
                  { class: 'actions' },
                  h(
                    'button',
                    {
                      class: 'btn icon sm',
                      title: t('rx.newPrescription'),
                      onClick: () =>
                        window.openPrescriptionComposer && window.openPrescriptionComposer(patient),
                    },
                    window.Icons ? window.Icons.el('prescription', { size: 15 }) : '℞',
                  ),
                  h(
                    'button',
                    {
                      class: 'btn icon sm',
                      title: t('patients.newAppointment'),
                      onClick: () =>
                        window.Components.openAppointmentModal({
                          patientId: patient.id,
                          onSaved: onRefresh,
                        }),
                    },
                    '🗓️',
                  ),
                  h(
                    'button',
                    {
                      class: 'btn icon sm',
                      title: t('common.edit'),
                      onClick: () =>
                        window.Components.openPatientModal({
                          patient,
                          onSaved: onRefresh,
                        }),
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
                          onRefresh();
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
  }

  Pages.patients = {
    async render(root, ctx) {
      const currency = window.App.settings.currency;
      let mode = ctx.filter === 'debtors' ? 'debtors' : ctx.filter || 'by_day';
      let selectedDay = '';

      ctx.setHeader(
        t('patients.title'),
        t('patients.subtitle'),
        h(
          'button',
          {
            class: 'btn primary',
            onClick: () => window.Components.openPatientModal({ onSaved: ctx.refresh }),
          },
          '＋ ',
          t('patients.new'),
        ),
      );

      const search = input({
        placeholder: t('patients.search'),
        class: 'input',
        style: { maxWidth: '320px' },
      });

      const dateFilter = input({
        type: 'date',
        value: '',
        class: 'input',
        title: t('patients.filterDate'),
        style: { maxWidth: '185px' },
      });

      const clearDateBtn = h(
        'button',
        {
          class: 'btn sm ghost',
          style: { display: 'none' },
          onClick: () => {
            selectedDay = '';
            dateFilter.value = '';
            clearDateBtn.style.display = 'none';
            load();
          },
        },
        '✕ ' + t('patients.clearDate'),
      );

      const dateFilterWrap = h(
        'div',
        {
          class: 'row',
          style: { gap: '8px', display: mode === 'by_day' ? 'flex' : 'none' },
        },
        dateFilter,
        clearDateBtn,
      );

      const tabButtons = {};
      const makeTab = (key, label) => {
        const btn = h(
          'button',
          {
            class: mode === key ? 'active' : '',
            onClick: () => {
              if (mode === key) return;
              mode = key;
              ctx.filter = key;
              Object.entries(tabButtons).forEach(([k, b]) => {
                b.classList.toggle('active', k === mode);
              });
              dateFilterWrap.style.display = mode === 'by_day' ? 'flex' : 'none';
              load();
            },
          },
          label,
        );
        tabButtons[key] = btn;
        return btn;
      };

      const tabs = h(
        'div',
        { class: 'tabs' },
        makeTab('by_day', '📅 ' + t('patients.byDays')),
        makeTab('today', '🦷 ' + t('patients.todayTab')),
        makeTab('all', t('patients.all')),
        makeTab('debtors', t('patients.onlyDebtors')),
      );

      const tableHost = h('div', {});
      let loadSeq = 0;

      const load = async () => {
        const seq = ++loadSeq;
        try {
          if (mode === 'by_day' || mode === 'today') {
            const dayParam = mode === 'today' ? todayISO() : selectedDay || '';
            const data = await window.API.invoke('patients:by-day', {
              search: search.value.trim(),
              day: dayParam,
              includePast: mode === 'by_day' && !selectedDay,
            });
            if (seq !== loadSeq) return;
            clear(tableHost);

            const groups = Array.isArray(data?.groups) ? data.groups : [];
            const unscheduled =
              mode === 'by_day' && !selectedDay && Array.isArray(data?.unscheduled)
                ? data.unscheduled
                : [];

            if (groups.length === 0 && unscheduled.length === 0) {
              tableHost.append(
                h('div', { class: 'card' }, emptyState(t('patients.noAppointmentsMatch'), '📅')),
              );
              return;
            }

            groups.forEach((group) => {
              tableHost.append(renderScheduledGroupCard(group, currency, ctx, load));
            });

            if (unscheduled.length > 0) {
              tableHost.append(
                h(
                  'div',
                  { class: 'mt' },
                  h(
                    'h3',
                    { class: 'card-title mb-s' },
                    '📁 ' + t('patients.unscheduledTitle') + ` (${unscheduled.length})`,
                  ),
                  renderFlatPatientTable(unscheduled, currency, ctx, load),
                ),
              );
            }
            return;
          }

          const rows =
            mode === 'debtors'
              ? await window.API.invoke('patients:debtors')
              : await window.API.invoke('patients:list', {
                  search: search.value.trim(),
                  limit: 500,
                });
          if (seq !== loadSeq) return;
          clear(tableHost);

          if (rows.length === 0) {
            tableHost.append(
              h(
                'div',
                { class: 'card' },
                emptyState(
                  mode === 'debtors'
                    ? t('patients.noDebtors')
                    : search.value
                      ? t('common.searchEmpty')
                      : t('patients.noHistory'),
                  mode === 'debtors' ? '✅' : '👤',
                ),
              ),
            );
            return;
          }

          tableHost.append(renderFlatPatientTable(rows, currency, ctx, load));
        } catch (error) {
          if (seq !== loadSeq) return;
          clear(tableHost).append(h('div', { class: 'card error-text' }, errorMessage(error)));
        }
      };

      search.addEventListener('input', debounce(load, 220));
      dateFilter.addEventListener('change', () => {
        selectedDay = dateFilter.value || '';
        clearDateBtn.style.display = selectedDay ? '' : 'none';
        load();
      });

      clear(root).append(
        h(
          'div',
          { class: 'row mb wrap', style: { justifyContent: 'space-between', gap: '8px' } },
          h('div', { class: 'row wrap', style: { gap: '8px' } }, search, dateFilterWrap),
          tabs,
        ),
        tableHost,
      );
      await load();
    },
  };
})();
