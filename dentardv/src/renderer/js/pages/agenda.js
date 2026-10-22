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
        h('button', { class: 'btn icon sm', title: t('agenda.done'), onClick: () => action('done', t('agenda.done')) }, '✓'),
        h('button', { class: 'btn icon sm', title: t('agenda.noShow'), onClick: () => action('no_show', t('agenda.noShow')) }, '🚫'),
      );
    }
    if (appointment.status !== 'cancelled') {
      buttons.append(
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

    return h(
      'div',
      { class: 'appt' },
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
      h('div', { class: 'col', style: { gap: '6px', alignItems: 'flex-end' } }, statusBadge(appointment.status), buttons),
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
          h('button', { class: 'btn primary', onClick: () => window.Components.openAppointmentModal({ day, onSaved: ctx.refresh }) }, '＋ ', t('agenda.newAppointment')),
        ),
      );

      ctx.cancel = async (appointment) => {
        const ok = await window.UI.confirmDialog(
          t('agenda.cancelConfirm', { name: appointment.full_name, date: formatDate(appointment.day) }),
        );
        if (!ok) return;
        try {
          await window.API.invoke('appointments:cancel', { id: appointment.id });
          toast(t('agenda.cancelled'), 'ok');
          ctx.refresh();
        } catch (error) {
          toast(errorMessage(error), 'error');
        }
      };

      clear(root).append(
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
