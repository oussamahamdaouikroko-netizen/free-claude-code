/* Agenda: one day at a time, multi-department filter, capacity, prescriptions & actions. */
(function () {
  'use strict';
  const { t, formatMoney, formatLong } = window.I18N;
  const { h, clear, emptyState, statusBadge, toast, errorMessage, modal, input, field, todayISO } = window.UI;
  const Pages = window.Pages;

  let selectedDepartmentId = null;

  function addDays(iso, days) {
    const [y, m, d] = iso.split('-').map(Number);
    const date = new Date(Date.UTC(y, m - 1, d + days));
    return date.toISOString().slice(0, 10);
  }

  function rescheduleDialog(appointment, onDone) {
    const day = input({ type: 'date', value: appointment.day, min: todayISO() });
    const error = h('div', { class: 'error-text' });
    modal({
      title: t('agenda.reschedule'),
      body: h('div', { class: 'col' }, field(t('agenda.chooseDay'), day), error),
      actions: [
        { label: t('common.cancel'), kind: 'ghost' },
        {
          label: t('common.confirm'),
          kind: 'primary',
          onClick: async () => {
            try {
              await window.API.invoke('appointments:reschedule', { id: appointment.id, day: day.value });
              toast(t('agenda.rescheduled'), 'ok');
              onDone();
            } catch (err) {
              error.textContent = errorMessage(err);
              return false;
            }
            return true;
          },
        },
      ],
    });
  }

  function row(appointment, ctx) {
    const currency = window.App.settings.currency;
    const due = Math.max(0, appointment.price - appointment.paid);
    const deptLabel = window.Components.departmentLabel(appointment);

    const action = async (status, message) => {
      try {
        await window.API.invoke('appointments:status', { id: appointment.id, status });
        toast(message, 'ok');
        ctx.refresh();
      } catch (error) {
        toast(errorMessage(error), 'error');
      }
    };

    const buttons = h('div', { class: 'row' });
    if (appointment.status === 'booked') {
      buttons.append(
        h(
          'button',
          {
            class: 'btn icon sm soft',
            title: t('queue.finishAndCallNext'),
            onClick: () => window.Components.completeAppointment(appointment, ctx.refresh),
          },
          '✓',
        ),
        h('button', { class: 'btn icon sm', title: t('agenda.noShow'), onClick: () => action('no_show', t('agenda.noShow')) }, '🚫'),
      );
    }
    if (appointment.status !== 'cancelled') {
      const secPayBtn = window.Components.confirmPaymentButton(appointment, ctx.refresh);
      if (secPayBtn) buttons.append(secPayBtn);
      buttons.append(
        h(
          'button',
          {
            class: 'btn icon sm',
            title: t('intake.newManual'),
            onClick: () =>
              window.Components.openIntakeModal({
                patient: { id: appointment.patient_id, full_name: appointment.full_name },
                appointmentId: appointment.id,
                onSaved: ctx.refresh,
              }),
          },
          window.Icons ? window.Icons.el('clipboard', { size: 15 }) : '📋',
        ),
        h(
          'button',
          {
            class: 'btn icon sm',
            title: t('patients.newPrescription'),
            onClick: () => {
              if (window.openPrescriptionComposer) {
                window.openPrescriptionComposer({
                  patient_id: appointment.patient_id,
                  patient_name: appointment.full_name,
                  patient_allergies: appointment.allergies || '',
                  patient_chronic: appointment.chronic_conditions || '',
                  department_id: appointment.department_id || null,
                });
              }
            },
          },
          window.Icons ? window.Icons.el('prescription', { size: 16 }) : '💊',
        ),
        h(
          'button',
          {
            class: 'btn icon sm',
            title: t('agenda.addPayment'),
            onClick: () =>
              window.Components.openPaymentModal({
                patientId: appointment.patient_id,
                appointment,
                onSaved: ctx.refresh,
              }),
          },
          '💵',
        ),
        h(
          'button',
          {
            class: 'btn icon sm',
            title: t('common.edit'),
            onClick: () => window.Components.openAppointmentEditModal({ appointment, onSaved: ctx.refresh }),
          },
          '💲',
        ),
        h('button', { class: 'btn icon sm', title: t('agenda.reschedule'), onClick: () => rescheduleDialog(appointment, ctx.refresh) }, '📅'),
      );
    }
    buttons.append(
      h('button', { class: 'btn icon sm', title: t('common.delete'), onClick: () => ctx.cancel(appointment) }, '✕'),
    );

    const badges = h(
      'div',
      { class: 'row wrap', style: { gap: '6px', justifyContent: 'flex-end' } },
      deptLabel ? h('span', { class: 'dept-pill' }, deptLabel) : null,
      window.Components.intakeBadge(appointment),
      window.Components.queueEtaBadge(appointment, appointment.day),
      statusBadge(appointment.status),
    );

    return h(
      'div',
      { class: `appt ${appointment.is_current_turn && appointment.day === todayISO() ? 'current-turn' : ''}` },
      h('div', { class: `queue ${appointment.status === 'done' ? 'done' : appointment.status === 'no_show' ? 'missed' : ''}` }, appointment.queue_number),
      h(
        'div',
        { class: 'who' },
        h(
          'div',
          { class: 'row wrap', style: { gap: '8px' } },
          h(
            'button',
            {
              class: 'btn ghost sm',
              style: { padding: '0', minHeight: 'auto', fontWeight: '700', fontSize: '1rem' },
              onClick: () => window.openPatientFile(appointment.patient_id),
            },
            appointment.full_name,
          ),
          appointment.allergies ? h('span', { class: 'badge danger', title: appointment.allergies }, '⚠️ ' + appointment.allergies) : null,
        ),
        h('div', { class: 'meta' }, [appointment.phone, appointment.treatment_name].filter(Boolean).join(' · ') || t('common.none')),
        appointment.notes ? h('div', { class: 'meta' }, '📝 ' + appointment.notes) : null,
      ),
      h('div', { class: 'col', style: { gap: '6px', alignItems: 'flex-end' } }, badges, buttons),
      h(
        'div',
        { class: 'money' },
        h('div', { class: 'strong' }, formatMoney(appointment.price, currency)),
        due > 0 ? h('div', { class: 'due' }, `${t('common.due')} ${formatMoney(due, currency)}`) : h('div', { class: 'paid' }, '✓'),
      ),
    );
  }

  Pages.agenda = {
    async render(root, ctx) {
      const day = window.App.day || todayISO();
      const [agenda, info, depts] = await Promise.all([
        window.API.invoke('appointments:agenda', { day, department_id: selectedDepartmentId }).catch((error) => ({ error })),
        window.API.invoke('appointments:day-info', { day, department_id: selectedDepartmentId }).catch(() => null),
        window.API.invoke('departments:list').catch(() => []),
      ]);

      if (agenda.error) {
        ctx.setHeader(t('agenda.title'), '');
        clear(root).append(h('div', { class: 'card error-text' }, errorMessage(agenda.error)));
        return;
      }

      if (selectedDepartmentId && !depts.some((d) => d.id === selectedDepartmentId)) {
        selectedDepartmentId = null;
      }

      const dayPicker = input({ type: 'date', value: day, style: { maxWidth: '190px' } });
      dayPicker.addEventListener('change', () => {
        window.App.day = dayPicker.value;
        ctx.refresh();
      });

      const totalDue = agenda.reduce((sum, appointment) => sum + Math.max(0, appointment.price - appointment.paid), 0);

      ctx.setHeader(
        t('agenda.title'),
        formatLong(day),
        h(
          'div',
          { class: 'row' },
          h('button', { class: 'btn icon', title: t('common.back'), onClick: () => { window.App.day = addDays(day, -1); ctx.refresh(); } }, '‹'),
          dayPicker,
          h('button', { class: 'btn icon', title: t('common.today'), onClick: () => { window.App.day = addDays(day, 1); ctx.refresh(); } }, '›'),
          h('button', { class: 'btn', onClick: () => { window.App.day = todayISO(); ctx.refresh(); } }, t('common.today')),
          h(
            'button',
            {
              class: 'btn soft',
              onClick: async () => {
                const board = await window.API.invoke('ops:waiting-room', {
                  day,
                  department_id: selectedDepartmentId,
                });
                modal({
                  title: t('ops.waitingRoomTitle'),
                  body:
                    board.length === 0
                      ? emptyState('🪑', t('agenda.emptyTitle'), '')
                      : h(
                          'div',
                          { class: 'col', style: { gap: '8px' } },
                          ...board.map((b) =>
                            h(
                              'div',
                              { class: 'card row between wrap', style: { padding: '12px 16px' } },
                              h(
                                'div',
                                { class: 'row', style: { gap: '12px' } },
                                h('span', { class: 'queue-pill current' }, `#${b.queue_number}`),
                                h('strong', { style: { fontSize: '18px' } }, b.initials),
                                b.slot_time ? h('span', { class: 'badge info' }, b.slot_time) : null,
                                b.priority === 'urgent' ? h('span', { class: 'badge danger' }, t('ops.priorityUrgent')) : null,
                              ),
                              h('div', { class: 'muted small' }, `${b.room ? b.room + ' · ' : ''}~${b.estimated_wait_min} min`),
                            ),
                          ),
                        ),
                  actions: [{ label: t('common.close'), kind: 'primary' }],
                });
              },
            },
            '📺 ',
            t('ops.waitingRoomBtn'),
          ),
          h(
            'button',
            {
              class: 'btn primary',
              onClick: () =>
                window.Components.openAppointmentModal({
                  day,
                  departmentId: selectedDepartmentId,
                  onSaved: ctx.refresh,
                }),
            },
            '＋ ',
            t('agenda.newAppointment'),
          ),
        ),
      );

      ctx.cancel = (appointment) => window.Components.cancelAppointment(appointment, ctx.refresh);

      const deptBar =
        depts.length > 0
          ? h(
              'div',
              { class: 'dept-tabs' },
              h(
                'button',
                {
                  type: 'button',
                  class: `dept-tab ${!selectedDepartmentId ? 'active' : ''}`,
                  onClick: () => {
                    selectedDepartmentId = null;
                    ctx.refresh();
                  },
                },
                t('dept.all'),
              ),
              ...depts.map((d) =>
                h(
                  'button',
                  {
                    type: 'button',
                    class: `dept-tab ${selectedDepartmentId === d.id ? 'active' : ''}`,
                    onClick: () => {
                      selectedDepartmentId = d.id;
                      ctx.refresh();
                    },
                  },
                  window.App.language === 'ar' ? d.name_ar || d.name_fr : d.name_fr,
                ),
              ),
            )
          : null;

      clear(root).append(
        deptBar,
        h(
          'div',
          { class: 'row wrap mb' },
          h('span', { class: `badge ${info && info.working ? (info.left > 0 ? 'ok' : 'warn') : 'gray'}` },
            info && info.working
              ? info.left > 0
                ? t('dash.capacityLeft', { n: info.left, cap: info.capacity })
                : t('dash.fullDay')
              : t('dash.closedDay')),
          h('span', { class: 'badge' }, `${t('dash.appointmentsToday')} : ${agenda.filter((a) => a.status !== 'cancelled').length}`),
          h('span', { class: 'badge warn' }, `${t('agenda.totalDue')} : ${formatMoney(totalDue, window.App.settings.currency)}`),
        ),
        window.Components.queueLiveBanner(agenda, { day, onChanged: ctx.refresh }),
        h(
          'div',
          { class: 'card' },
          agenda.length === 0
            ? emptyState(t('agenda.empty'))
            : h('div', {}, agenda.map((appointment) => row(appointment, ctx))),
        ),
      );
    },
  };
})();
