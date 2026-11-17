/* Dashboard: today's KPIs and queue. */
(function () {
  'use strict';
  const { t, formatMoney, formatLong, formatDate } = window.I18N;
  const { h, clear, emptyState, statusBadge, toast, errorMessage } = window.UI;
  const Pages = window.Pages;

  function kpi(label, value, cls = '', foot = '') {
    return h(
      'div',
      { class: 'card kpi' },
      h('div', { class: 'label' }, label),
      h('div', { class: `value ${cls}` }, value),
      foot ? h('div', { class: 'foot' }, foot) : null,
    );
  }

  function appointmentRow(appointment, onChanged) {
    const currency = window.App.settings.currency;
    const due = Math.max(0, appointment.price - appointment.paid);
    const actions = h('div', { class: 'row' });

    if (appointment.status === 'booked') {
      actions.append(
        h(
          'button',
          {
            class: 'btn sm soft',
            title: t('queue.finishAndCallNext'),
            onClick: () => window.Components.completeAppointment(appointment, onChanged),
          },
          '✓ ' + t('queue.finishTreatment'),
        ),
      );
    }
    if (due > 0) {
      actions.append(
        h(
          'button',
          {
            class: 'btn sm',
            onClick: () =>
              window.Components.openPaymentModal({
                patientId: appointment.patient_id,
                appointment,
                onSaved: onChanged,
              }),
          },
          '💵 ' + t('dash.addPayment'),
        ),
      );
    }
    if (appointment.status === 'booked') {
      actions.append(
        h(
          'button',
          {
            class: 'btn icon sm ghost',
            title: t('common.cancel'),
            onClick: () => window.Components.cancelAppointment(appointment, onChanged),
          },
          '✕',
        ),
      );
    }

    const badges = h(
      'div',
      { class: 'row wrap', style: { gap: '6px', justifyContent: 'flex-end' } },
      window.Components.queueEtaBadge(appointment, appointment.day),
      statusBadge(appointment.status),
    );

    return h(
      'div',
      { class: `appt ${appointment.is_current_turn ? 'current-turn' : ''}` },
      h('div', { class: `queue ${appointment.status === 'done' ? 'done' : appointment.status === 'no_show' ? 'missed' : ''}` }, appointment.queue_number),
      h(
        'div',
        { class: 'who' },
        h(
          'button',
          {
            class: 'btn ghost sm',
            style: { padding: '0', minHeight: 'auto', fontWeight: '700' },
            onClick: () => window.openPatientFile(appointment.patient_id),
          },
          appointment.full_name,
        ),
        h('div', { class: 'meta' }, [appointment.treatment_name || t('common.none'), appointment.phone].filter(Boolean).join(' · ')),
      ),
      h('div', { class: 'col', style: { alignItems: 'flex-end', gap: '6px' } }, badges, actions),
      h(
        'div',
        { class: 'money' },
        h('div', { class: 'strong' }, formatMoney(appointment.price, currency)),
        due > 0
          ? h('div', { class: 'due' }, `${t('common.due')} ${formatMoney(due, currency)}`)
          : h('div', { class: 'paid' }, t('patients.paidAll')),
      ),
    );
  }

  Pages.dashboard = {
    async render(root, ctx) {
      const day = window.App.day = window.UI.todayISO();
      ctx.setHeader(
        `${t('dash.greeting')}, ${window.App.settings.clinic_name || ''}`,
        formatLong(day),
        h(
          'div',
          { class: 'row' },
          h('button', { class: 'btn', onClick: () => window.Components.openExpenseModal({ onSaved: ctx.refresh }) }, '💸 ', t('dash.quickExpense')),
          h('button', { class: 'btn', onClick: () => window.Components.openPatientModal({ onSaved: ctx.refresh }) }, '👤 ', t('dash.quickPatient')),
          h('button', { class: 'btn primary lg', onClick: () => window.Components.openAppointmentModal({ day, onSaved: ctx.refresh }) }, '＋ ', t('dash.quickBook')),
        ),
      );

      root.append(h('div', { class: 'empty' }, t('common.loading')));
      let data;
      let nextFree = null;
      try {
        data = await window.API.invoke('dashboard:today', { day });
        nextFree = await window.API.invoke('appointments:next-free-day', {}).catch(() => null);
      } catch (error) {
        clear(root).append(h('div', { class: 'card error-text' }, errorMessage(error)));
        return;
      }
      if (!root.isConnected) return;

      const currency = window.App.settings.currency;
      const stats = data.stats;

      clear(root).append(
        h(
          'div',
          { class: 'grid four' },
          kpi(t('dash.incomeToday'), formatMoney(data.money.income, currency), 'income', `${t('dash.appointmentsToday')} : ${stats.total}`),
          kpi(t('dash.expensesToday'), formatMoney(data.money.expenses, currency), 'expense'),
          kpi(t('dash.netToday'), formatMoney(data.money.net, currency), 'net'),
          kpi(t('dash.debts'), formatMoney(data.money.unpaid_debts, currency), 'expense', `${t('dash.newPatients')} : ${data.money.new_patients}`),
        ),
        h(
          'div',
          { class: 'grid mt', style: { gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)', alignItems: 'start' } },
          h(
            'div',
            { class: 'card' },
            h(
              'h2',
              { class: 'card-title' },
              t('dash.queue'),
              h(
                'span',
                { class: `badge ${stats.left === 0 ? 'warn' : 'ok'}` },
                stats.working
                  ? stats.left > 0
                    ? t('dash.capacityLeft', { n: stats.left, cap: stats.capacity })
                    : t('dash.fullDay')
                  : t('dash.closedDay'),
              ),
            ),
            window.Components.queueLiveBanner(data.agenda, { day, onChanged: ctx.refresh }),
            data.agenda.length === 0
              ? emptyState(t('dash.noAppointments'))
              : h('div', {}, data.agenda.map((appointment) => appointmentRow(appointment, ctx.refresh))),
          ),
          h(
            'div',
            { class: 'col' },
            h(
              'div',
              { class: 'card' },
              h('h2', { class: 'card-title' }, t('dash.today')),
              h('div', { class: 'info-line' }, h('span', { class: 'k' }, t('dash.appointmentsToday')), h('strong', {}, `${stats.total} / ${stats.capacity}`)),
              h('div', { class: 'info-line' }, h('span', { class: 'k' }, t('reports.done')), h('strong', {}, String(stats.done))),
              h('div', { class: 'info-line' }, h('span', { class: 'k' }, t('reports.missed')), h('strong', {}, String(stats.no_show))),
              h(
                'div',
                { class: 'info-line' },
                h('span', { class: 'k' }, t('dash.nextFree')),
                h('strong', {}, nextFree ? formatDate(nextFree) : '—'),
              ),
              data.upcoming_waiting
                ? h('div', { class: 'badge warn mt-s' }, t('dash.waiting', { n: data.upcoming_waiting }))
                : null,
            ),
            h(
              'div',
              { class: 'card' },
              h(
                'h2',
                { class: 'card-title' },
                t('dash.debtors'),
                h('button', { class: 'btn ghost sm', onClick: () => ctx.navigate('patients') }, t('dash.viewAll') + ' →'),
              ),
              data.debtors.length === 0
                ? h('div', { class: 'muted small' }, '✓ ' + t('patients.paidAll'))
                : h(
                    'div',
                    { class: 'col' },
                    data.debtors.map((patient) =>
                      h(
                        'div',
                        { class: 'row between' },
                        h('button', { class: 'btn ghost sm', onClick: () => window.openPatientFile(patient.id) }, patient.full_name),
                        h('span', { class: 'badge danger' }, formatMoney(patient.balance, currency)),
                      ),
                    ),
                  ),
            ),
          ),
        ),
      );
    },
  };
})();
