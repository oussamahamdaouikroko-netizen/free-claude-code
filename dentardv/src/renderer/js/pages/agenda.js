/* Agenda: one day at a time, capacity and actions. */
(function () {
  'use strict';
  const { t, formatMoney, formatLong, formatDate } = window.I18N;
  const { h, clear, emptyState, statusBadge, toast, errorMessage, modal, input, field, todayISO } = window.UI;
  const Pages = window.Pages;

  function addDays(iso, days) {
    const [y, m, d] = iso.split('-').map(Number);
    const date = new Date(Date.UTC(y, m - 1, d + days));
    return date.toISOString().slice(0, 10);
  }

  function rescheduleDialog(appointment, onDone) {
    return window.Components.rescheduleDialog(appointment, onDone);
  }

  function row(appointment, ctx) {
    const currency = window.App.settings.currency;
    const due = Math.max(0, appointment.price - appointment.paid);
    const today = todayISO();
    const isFutureDay = appointment.day > today;
    const isTodayDay = appointment.day === today;

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
      if (isFutureDay) {
        buttons.append(
          h(
            'span',
            { class: 'badge warn', title: t('patients.futureLockedHint') },
            '🔒 ' + t('patients.futureLockedBadge'),
          ),
        );
      } else {
        const canCompleteNow = !isTodayDay || Boolean(appointment.is_current_turn);
        buttons.append(
          h(
            'button',
            {
              class: 'btn icon sm soft',
              disabled: !canCompleteNow,
              title: canCompleteNow
                ? t('queue.finishAndCallNext')
                : t('error.QUEUE_OUT_OF_TURN'),
              onClick: () => window.Components.completeAppointment(appointment, ctx.refresh),
            },
            '✓',
          ),
          h(
            'button',
            {
              class: 'btn icon sm',
              title: t('agenda.noShow'),
              onClick: () => action('no_show', t('agenda.noShow')),
            },
            '🚫',
          ),
        );
      }
    }
    if (appointment.status !== 'cancelled') {
      buttons.append(
        h(
          'button',
          {
            class: 'btn icon sm',
            title: t('rx.newPrescription'),
            onClick: () => {
              if (window.openPrescriptionComposer) {
                window.openPrescriptionComposer({
                  id: appointment.patient_id,
                  full_name: appointment.full_name,
                  allergies: appointment.allergies || '',
                  chronic_conditions: appointment.chronic_conditions || '',
                });
              }
            },
          },
          window.Icons ? window.Icons.el('prescription', { size: 15 }) : '℞',
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
      appointment.confirmation_status === 'confirmed'
        ? h('span', { class: 'badge ok' }, t('agenda.confirmedBadge'))
        : null,
      appointment.intake_id && (appointment.intake_status === 'pending' || appointment.intake_status === 'reviewed')
        ? h('span', { class: 'badge warn' }, t('intake.pendingBadge'))
        : null,
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
          'button',
          {
            class: 'btn ghost sm',
            style: { padding: '0', minHeight: 'auto', fontWeight: '700', fontSize: '1rem' },
            onClick: () => window.openPatientFile(appointment.patient_id),
          },
          appointment.full_name,
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
      const [agenda, info] = await Promise.all([
        window.API.invoke('appointments:agenda', { day }).catch((error) => ({ error })),
        window.API.invoke('appointments:day-info', { day }).catch(() => null),
      ]);

      if (agenda.error) {
        ctx.setHeader(t('agenda.title'), '');
        clear(root).append(h('div', { class: 'card error-text' }, errorMessage(agenda.error)));
        return;
      }

      const dayPicker = input({ type: 'date', value: day, style: { maxWidth: '190px' } });
      dayPicker.addEventListener('change', () => {
        window.App.day = dayPicker.value;
        ctx.refresh();
      });

      const totalDue = agenda.reduce((sum, appointment) => sum + Math.max(0, appointment.price - appointment.paid), 0);
      const sCfg = window.App.settings || {};
      const is24h = sCfg.clinic_24h_enabled === '1';
      const isTwoShifts = !is24h && sCfg.two_shifts_enabled === '1';
      const isBreak = !is24h && sCfg.break_enabled === '1';
      const activeHoliday = info?.holiday || null;

      ctx.setHeader(
        t('agenda.title'),
        formatLong(day),
        h(
          'div',
          { class: 'row wrap' },
          h('button', { class: 'btn icon', title: t('common.back'), onClick: () => { window.App.day = addDays(day, -1); ctx.refresh(); } }, '‹'),
          dayPicker,
          h('button', { class: 'btn icon', title: t('common.today'), onClick: () => { window.App.day = addDays(day, 1); ctx.refresh(); } }, '›'),
          h('button', { class: 'btn', onClick: () => { window.App.day = todayISO(); ctx.refresh(); } }, t('common.today')),
          activeHoliday
            ? h(
                'button',
                {
                  class: 'btn soft',
                  onClick: async () => {
                    try {
                      await window.API.invoke('holidays:remove', { id: activeHoliday.id });
                      toast(t('holidays.removed'), 'ok');
                      ctx.refresh();
                    } catch (err) {
                      toast(errorMessage(err), 'error');
                    }
                  },
                },
                '🔓 ',
                t('agenda.reopenDay'),
              )
            : h(
                'button',
                {
                  class: 'btn soft',
                  onClick: () =>
                    window.Components.openHolidayModal({
                      defaultDay: day,
                      onSaved: () => ctx.refresh(),
                    }),
                },
                '🏖️ ',
                t('agenda.markDayOff'),
              ),
          h(
            'button',
            {
              class: 'btn primary',
              disabled: Boolean(activeHoliday),
              onClick: () => window.Components.openAppointmentModal({ day, onSaved: ctx.refresh }),
            },
            '＋ ',
            t('agenda.newAppointment'),
          ),
        ),
      );

      ctx.cancel = (appointment) => window.Components.cancelAppointment(appointment, ctx.refresh);

      const activeReasonLabel = activeHoliday
        ? activeHoliday.reason_type === 'sick'
          ? '🩺 ' + t('holidays.reasonSick')
          : activeHoliday.reason_type === 'other'
            ? '🔒 ' + t('holidays.reasonOther')
            : '🏖️ ' + t('holidays.reasonVacation')
        : '';

      clear(root).append(
        h(
          'div',
          { class: 'row wrap mb' },
          is24h ? h('span', { class: 'badge ok' }, '🕒 ', t('dash.open24hBadge')) : null,
          isTwoShifts
            ? h(
                'span',
                { class: 'badge info' },
                '🕒 ',
                t('dash.twoShiftsBadge', {
                  s1: `${sCfg.work_start_hour || '08:00'}–${sCfg.work_end_hour || '17:00'}`,
                  s2: `${sCfg.shift2_start_hour || '21:00'}–${sCfg.shift2_end_hour || '00:00'}`,
                }),
              )
            : null,
          isBreak
            ? h(
                'span',
                { class: 'badge gray' },
                '☕ ',
                t('dash.breakBadge', {
                  from: sCfg.break_start_hour || '12:30',
                  to: sCfg.break_end_hour || '13:30',
                }),
              )
            : null,
          activeHoliday
            ? h('span', { class: 'badge warn' }, '🏖️ ', t('agenda.doctorOnLeave'))
            : h(
                'span',
                { class: `badge ${info && info.working ? (info.left > 0 ? 'ok' : 'warn') : 'gray'}` },
                info && info.working
                  ? info.left > 0
                    ? t('dash.capacityLeft', { n: info.left, cap: info.capacity })
                    : t('dash.fullDay')
                  : t('dash.closedDay'),
              ),
          activeHoliday ? h('span', { class: 'badge info' }, activeReasonLabel) : null,
          activeHoliday && activeHoliday.label
            ? h('span', { class: 'badge gray' }, activeHoliday.label)
            : null,
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
