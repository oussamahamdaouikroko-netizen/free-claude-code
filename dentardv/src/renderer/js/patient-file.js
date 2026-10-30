/* Patient file dialog: identity, upcoming appointment, visits and payments. */
(function () {
  'use strict';
  const { t, formatMoney, formatDate, formatDateTime, formatLong } = window.I18N;
  const { h, modal, toast, errorMessage, emptyState, statusBadge, todayISO } = window.UI;

  function section(title, content, action = null) {
    return h(
      'div',
      { class: 'mt' },
      h('h3', { style: { margin: '0 0 10px', fontSize: '1rem' }, class: 'row between' }, h('span', {}, title), action),
      content,
    );
  }

  async function open(patientId) {
    const currency = () => window.App.settings.currency;
    const host = h('div', {}, h('div', { class: 'empty' }, t('common.loading')));
    const dialog = modal({ title: t('patients.file'), body: host, wide: true, actions: [{ label: t('common.close'), kind: 'ghost' }] });

    async function load() {
      try {
        const [data, payments] = await Promise.all([
          window.API.invoke('patients:get', { id: patientId }),
          window.API.invoke('payments:by-patient', { patient_id: patientId }),
        ]);
        const { patient, history, prescriptions = [], certificates = [], pending_intake: pendingIntake } = data;
        const upcoming = history.find(
          (row) => row.day >= todayISO() && (row.status === 'booked' || row.status === 'done'),
        );
        const balance = Number(patient.balance) || 0;

        const clinicalTags = h(
          'div',
          { class: 'row wrap mt-s', style: { gap: '6px' } },
          patient.blood_group ? h('span', { class: 'badge soft' }, `🩸 ${patient.blood_group}`) : null,
          patient.allergies ? h('span', { class: 'badge danger' }, t('patients.allergyTag', { v: patient.allergies })) : null,
          patient.chronic_conditions ? h('span', { class: 'badge warn' }, patient.chronic_conditions) : null,
        );

        const intakeCard = pendingIntake
          ? h(
              'div',
              {
                class: 'card row wrap between mt',
                style: {
                  padding: '12px 14px',
                  border: '1.5px solid var(--warn)',
                  background: 'var(--warn-soft)',
                  gap: '10px',
                },
              },
              h(
                'div',
                { class: 'col', style: { gap: '4px' } },
                h('strong', { class: 'small' }, '📋 ', t('intake.cardTitle')),
                h(
                  'div',
                  { class: 'small' },
                  [
                    pendingIntake.effective_age_years ? `${Math.round(pendingIntake.effective_age_years)} ans` : '',
                    pendingIntake.weight_kg ? `${pendingIntake.weight_kg} kg` : '',
                    pendingIntake.chief_complaint || '',
                  ]
                    .filter(Boolean)
                    .join(' · '),
                ),
              ),
              h(
                'div',
                { class: 'row wrap', style: { gap: '6px' } },
                h(
                  'button',
                  {
                    class: 'btn sm primary',
                    onClick: async () => {
                      try {
                        await window.API.invoke('intake:confirm', { id: pendingIntake.id });
                        toast(t('intake.appliedToast'), 'ok');
                        load();
                      } catch (err) {
                        toast(errorMessage(err), 'error');
                      }
                    },
                  },
                  t('intake.confirmBtn'),
                ),
                h(
                  'button',
                  {
                    class: 'btn sm ghost',
                    onClick: async () => {
                      try {
                        await window.API.invoke('intake:reject', { id: pendingIntake.id });
                        toast(t('intake.rejectedToast'), 'ok');
                        load();
                      } catch (err) {
                        toast(errorMessage(err), 'error');
                      }
                    },
                  },
                  t('intake.rejectBtn'),
                ),
              ),
            )
          : null;

        host.replaceChildren(
          h(
            'div',
            { class: 'row wrap between' },
            h(
              'div',
              {},
              h('div', { style: { fontSize: '1.25rem', fontWeight: '700' } }, patient.full_name),
              h('div', { class: 'muted small' }, [patient.phone, patient.birth_date ? formatDate(patient.birth_date) : ''].filter(Boolean).join(' · ') || '—'),
              clinicalTags,
              patient.notes ? h('div', { class: 'muted small mt-s' }, '📝 ' + patient.notes) : null,
            ),
            h(
              'div',
              { class: 'col', style: { alignItems: 'flex-end' } },
              h('span', { class: `badge ${balance > 0.009 ? 'danger' : 'ok'}` }, `${t('patients.debt')} : ${formatMoney(Math.max(0, balance), currency())}`),
              h(
                'div',
                { class: 'row wrap' },
                h(
                  'button',
                  {
                    class: 'btn sm',
                    onClick: () =>
                      window.Components.openPatientModal({
                        patient,
                        onSaved: () => load(),
                      }),
                  },
                  '✏️ ' + t('common.edit'),
                ),
                h(
                  'button',
                  {
                    class: 'btn sm soft',
                    onClick: () => {
                      if (window.openPrescriptionComposer) window.openPrescriptionComposer(patient);
                    },
                  },
                  window.Icons ? window.Icons.el('prescription', { size: 15 }) : '',
                  ' ',
                  t('rx.newPrescription'),
                ),
                h(
                  'button',
                  {
                    class: 'btn sm primary',
                    onClick: () =>
                      window.Components.openAppointmentModal({
                        patientId: patient.id,
                        onSaved: () => load(),
                      }),
                  },
                  '🗓️ ' + t('patients.book'),
                ),
                balance > 0.009
                  ? h(
                      'button',
                      {
                        class: 'btn sm soft',
                        onClick: () =>
                          window.Components.openPaymentModal({
                            patientId: patient.id,
                            onSaved: () => load(),
                          }),
                      },
                      '💵 ' + t('patients.payDebt'),
                    )
                  : null,
              ),
            ),
          ),
          intakeCard,
          upcoming
            ? section(
                t('patients.upcoming'),
                h(
                  'div',
                  { class: 'appt' },
                  h('div', { class: 'queue' }, upcoming.queue_number),
                  h(
                    'div',
                    { class: 'who' },
                    h('div', { class: 'name' }, formatLong(upcoming.day)),
                    h('div', { class: 'meta' }, upcoming.treatment_name || t('common.none')),
                  ),
                  h('div', { class: 'money' }, formatMoney(upcoming.price, currency())),
                ),
              )
            : null,
          section(
            `${t('patients.history')} (${history.length})`,
            history.length === 0
              ? emptyState(t('patients.noHistory'), 'clock')
              : h(
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
                        h('th', {}, t('common.date')),
                        h('th', {}, 'N°'),
                        h('th', {}, t('common.treatment')),
                        h('th', {}, t('common.price')),
                        h('th', {}, t('common.paid')),
                        h('th', {}, t('common.due')),
                        h('th', {}, t('common.status')),
                        h('th', { class: 'actions' }, ''),
                      ),
                    ),
                    h(
                      'tbody',
                      {},
                      history.map((row) =>
                        h(
                          'tr',
                          {},
                          h('td', {}, formatDate(row.day)),
                          h('td', {}, String(row.queue_number)),
                          h('td', {}, row.treatment_name || '—'),
                          h('td', { class: 'num' }, formatMoney(row.price, currency())),
                          h('td', { class: 'num' }, formatMoney(row.paid, currency())),
                          h(
                            'td',
                            { class: 'num' },
                            row.balance > 0.009
                              ? h('span', { style: { color: 'var(--danger)', fontWeight: '600' } }, formatMoney(row.balance, currency()))
                              : '✓',
                          ),
                          h('td', {}, statusBadge(row.status)),
                          h(
                            'td',
                            { class: 'actions' },
                            row.status !== 'cancelled'
                              ? h(
                                  'button',
                                  {
                                    class: 'btn icon sm',
                                    title: t('common.edit'),
                                    onClick: () =>
                                      window.Components.openAppointmentEditModal({
                                        appointment: row,
                                        onSaved: () => load(),
                                      }),
                                  },
                                  '💲',
                                )
                              : null,
                            row.status !== 'cancelled' && row.balance > 0.009
                              ? h(
                                  'button',
                                  {
                                    class: 'btn icon sm',
                                    title: t('patients.addPayment'),
                                    onClick: () =>
                                      window.Components.openPaymentModal({
                                        patientId: patient.id,
                                        appointment: row,
                                        onSaved: () => load(),
                                      }),
                                  },
                                  '💵',
                                )
                              : null,
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
          ),
          section(
            t('patients.payments'),
            payments.length === 0
              ? h('div', { class: 'muted small' }, t('patients.noPayments'))
              : h(
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
                        h('th', {}, t('common.date')),
                        h('th', {}, t('common.amount')),
                        h('th', {}, t('common.method')),
                        h('th', {}, t('common.note')),
                        h('th', { class: 'actions' }, ''),
                      ),
                    ),
                    h(
                      'tbody',
                      {},
                      payments.map((payment) =>
                        h(
                          'tr',
                          {},
                          h('td', {}, formatDateTime(payment.paid_at)),
                          h('td', { class: 'num' }, formatMoney(payment.amount, currency())),
                          h('td', {}, t(`common.${payment.method}`)),
                          h('td', {}, payment.note || '—'),
                          h(
                            'td',
                            { class: 'actions' },
                            h(
                              'button',
                              {
                                class: 'btn icon sm',
                                title: t('patients.printReceipt'),
                                onClick: () => window.Components.printReceipt(payment.id),
                              },
                              '🖨️',
                            ),
                            h(
                              'button',
                              {
                                class: 'btn icon sm',
                                title: t('common.delete'),
                                onClick: async () => {
                                  const ok = await window.UI.confirmDialog(t('common.delete') + ' ?');
                                  if (!ok) return;
                                  try {
                                    await window.API.invoke('payments:remove', { id: payment.id });
                                    toast(t('common.deleted'), 'ok');
                                    load();
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
          ),
          section(
            `${t('patients.prescriptions')} (${prescriptions.length})`,
            prescriptions.length === 0
              ? h('div', { class: 'muted small' }, t('rx.historyEmpty'))
              : h(
                  'div',
                  { class: 'table-wrap' },
                  h(
                    'table',
                    { class: 'list' },
                    h('thead', {}, h('tr', {}, h('th', {}, 'N°'), h('th', {}, t('common.date')), h('th', {}, t('rx.toothRef')), h('th', {}, t('rx.diagnosis')), h('th', { class: 'actions' }, ''))),
                    h(
                      'tbody',
                      {},
                      prescriptions.map((rx) =>
                        h(
                          'tr',
                          {},
                          h('td', { class: 'num' }, `#${rx.id}`),
                          h('td', {}, formatDate(rx.day)),
                          h('td', {}, rx.tooth_ref || '—'),
                          h('td', {}, rx.diagnosis || '—'),
                          h(
                            'td',
                            { class: 'actions' },
                            h(
                              'button',
                              {
                                class: 'btn icon sm',
                                title: t('rx.previewTitle'),
                                onClick: () => window.openRxPreviewModal && window.openRxPreviewModal(rx.id, 'A4', rx.print_mode || 'both'),
                              },
                              '🖨️',
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
          ),
          certificates.length > 0
            ? section(
                `${t('patients.certificates')} (${certificates.length})`,
                h(
                  'div',
                  { class: 'row wrap', style: { gap: '8px' } },
                  certificates.map((cert) =>
                    h(
                      'button',
                      {
                        class: 'btn sm soft',
                        onClick: () => window.openCertPreviewModal && window.openCertPreviewModal(cert.id),
                      },
                      `🖨️ #${cert.id} · ${t(`cert.${cert.kind}`)} (${formatDate(cert.day)})`,
                    ),
                  ),
                ),
              )
            : null,
        );
      } catch (error) {
        host.replaceChildren(h('div', { class: 'error-text' }, errorMessage(error)));
      }
    }

    await load();
    return dialog;
  }

  window.openPatientFile = open;
})();
