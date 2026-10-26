/* Reusable dialogs: patient, appointment, payment, expense, receipt. */
(function () {
  'use strict';

  const { t, formatMoney, formatLong } = window.I18N;
  const { h, modal, toast, field, input, select, textarea, errorMessage, todayISO } = window.UI;
  const C = {};

  const currency = () => window.App?.settings?.currency || 'DZD';

  const methodOptions = () => [
    { value: 'cash', label: t('common.cash') },
    { value: 'card', label: t('common.card') },
    { value: 'transfer', label: t('common.transfer') },
  ];

  function inlineError() {
    return h('div', { class: 'error-text' });
  }

  /** Fill a <select> in place (keeps the DOM node stable). */
  function fillSelect(control, options, selected) {
    control.replaceChildren();
    for (const option of options) {
      control.append(h('option', { value: option.value, selected: String(option.value) === String(selected) }, option.label));
    }
  }

  /* ------------------------------- patient --------------------------------- */
  C.openPatientModal = function openPatientModal({ patient = null, onSaved } = {}) {
    const isEdit = Boolean(patient);
    const name = input({ value: patient?.full_name || '', placeholder: t('patients.name'), autofocus: true });
    const phone = input({ value: patient?.phone || '', placeholder: '05 55 12 34 56', inputmode: 'tel' });
    const birth = input({ type: 'date', value: patient?.birth_date || '' });
    const gender = select(
      [
        { value: '', label: '—' },
        { value: 'f', label: t('patients.female') },
        { value: 'm', label: t('patients.male') },
      ],
      { value: patient?.gender || '' },
    );
    const bloodGroup = select(
      ['', 'A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'].map((bg) => ({
        value: bg,
        label: bg || '—',
      })),
      { value: patient?.blood_group || '' },
    );
    const allergies = input({ value: patient?.allergies || '', placeholder: t('patients.allergies') });
    const chronic = input({ value: patient?.chronic_conditions || '', placeholder: t('patients.chronic') });
    const notes = textarea({ value: patient?.notes || '', placeholder: t('patients.notes') });
    const error = inlineError();

    const save = async () => {
      error.textContent = '';
      if (!name.value.trim()) {
        error.textContent = t('error.PATIENT_NAME_REQUIRED');
        return false;
      }
      try {
        const payload = {
          id: patient?.id,
          full_name: name.value.trim(),
          phone: phone.value.trim(),
          birth_date: birth.value,
          gender: gender.value || null,
          blood_group: bloodGroup.value || '',
          allergies: allergies.value.trim(),
          chronic_conditions: chronic.value.trim(),
          notes: notes.value.trim(),
        };
        const saved = isEdit
          ? await window.API.invoke('patients:update', payload)
          : await window.API.invoke('patients:create', payload);
        toast(t('common.saved'), 'ok');
        if (onSaved) onSaved(saved);
        return true;
      } catch (err) {
        error.textContent = errorMessage(err);
        return false;
      }
    };

    modal({
      title: isEdit ? t('patients.file') : t('patients.new'),
      body: h(
        'div',
        { class: 'col' },
        field(t('patients.name'), name),
        field(t('common.phone'), phone),
        h('div', { class: 'grid three' }, field(t('patients.birth'), birth), field(t('patients.gender'), gender), field(t('patients.bloodGroup'), bloodGroup)),
        field(t('patients.allergies'), allergies),
        field(t('patients.chronic'), chronic),
        field(t('patients.notes'), notes),
        error,
      ),
      actions: [
        { label: t('common.cancel'), kind: 'ghost' },
        {
          label: t('common.save'),
          kind: 'primary',
          onClick: async () => (await save()) || false,
        },
      ],
    });
  };

  /* ----------------------------- appointment ------------------------------- */
  C.openAppointmentModal = function openAppointmentModal({ day, patientId, onSaved } = {}) {
    const targetDay = day || window.App?.day || todayISO();
    const error = inlineError();
    const patientSelect = select([{ value: '', label: t('common.loading') }]);
    const newName = input({ placeholder: t('agenda.newPatientName') });
    const newPhone = input({ placeholder: t('common.phone'), inputmode: 'tel' });
    const newPatientBox = h(
      'div',
      { class: 'col hidden' },
      field(t('agenda.newPatientName'), newName),
      field(`${t('common.phone')} (${t('common.optional')})`, newPhone),
    );
    const treatmentSelect = select([{ value: '', label: t('agenda.noTreatment') }]);
    const priceInput = input({ type: 'number', min: '0', step: '50', value: '0' });
    const dateInput = input({ type: 'date', value: targetDay, min: todayISO() });
    const dayInfo = h('div', { class: 'help' }, '');
    const notes = input({ placeholder: t('agenda.notes') });

    let treatments = [];

    const updateDayInfo = async () => {
      if (!dateInput.value) return;
      try {
        const info = await window.API.invoke('appointments:day-info', { day: dateInput.value });
        if (!info.working) dayInfo.textContent = t('agenda.notWorking');
        else if (info.left <= 0) dayInfo.textContent = t('agenda.dayFull', { cap: info.capacity });
        else dayInfo.textContent = t('dash.capacityLeft', { n: info.left, cap: info.capacity });
      } catch (err) {
        dayInfo.textContent = errorMessage(err);
      }
    };

    const applyTreatmentPrice = () => {
      const chosen = treatments.find((item) => String(item.id) === treatmentSelect.value);
      if (chosen) priceInput.value = String(chosen.default_price);
    };

    patientSelect.addEventListener('change', () => {
      newPatientBox.classList.toggle('hidden', patientSelect.value !== '__new__');
    });
    treatmentSelect.addEventListener('change', applyTreatmentPrice);
    dateInput.addEventListener('change', updateDayInfo);

    (async () => {
      try {
        const [list, catalog, nextFree] = await Promise.all([
          window.API.invoke('patients:list', { limit: 800 }),
          window.API.invoke('treatments:list'),
          window.API.invoke('appointments:next-free-day', {}).catch(() => null),
        ]);
        treatments = catalog;
        fillSelect(
          patientSelect,
          [{ value: '', label: t('agenda.choosePatient') }]
            .concat(
              list.map((patient) => ({
                value: String(patient.id),
                label: `${patient.full_name}${patient.phone ? ` · ${patient.phone}` : ''}`,
              })),
            )
            .concat([{ value: '__new__', label: '＋ ' + t('agenda.orNewPatient') }]),
          patientId ? String(patientId) : '',
        );
        fillSelect(
          treatmentSelect,
          [{ value: '', label: t('agenda.noTreatment') }].concat(
            catalog.map((item) => ({
              value: String(item.id),
              label: `${window.App.language === 'ar' ? item.name_ar : item.name_fr} · ${formatMoney(item.default_price, currency())}`,
            })),
          ),
          '',
        );
        if (nextFree) dayInfo.textContent = t('agenda.nextFree', { date: formatLong(nextFree) });
        await updateDayInfo();
      } catch (err) {
        error.textContent = errorMessage(err);
      }
    })();

    const save = async () => {
      error.textContent = '';
      try {
        let pid = patientSelect.value;
        if (!pid) {
          error.textContent = t('error.PATIENT_NOT_FOUND');
          return false;
        }
        if (pid === '__new__') {
          if (!newName.value.trim()) {
            error.textContent = t('error.PATIENT_NAME_REQUIRED');
            return false;
          }
          const created = await window.API.invoke('patients:create', {
            full_name: newName.value.trim(),
            phone: newPhone.value.trim(),
          });
          pid = created.id;
        }
        await window.API.invoke('appointments:create', {
          patient_id: Number(pid),
          day: dateInput.value,
          treatment_id: treatmentSelect.value ? Number(treatmentSelect.value) : null,
          price: Number(priceInput.value) || 0,
          notes: notes.value.trim(),
        });
        toast(t('common.saved'), 'ok');
        if (window.MiniChat) window.MiniChat.refresh({ scrollBottom: true });
        if (onSaved) onSaved();
        return true;
      } catch (err) {
        error.textContent = errorMessage(err);
        return false;
      }
    };

    modal({
      title: t('agenda.newAppointment'),
      body: h(
        'div',
        { class: 'col' },
        field(t('agenda.selectPatient'), patientSelect),
        newPatientBox,
        h('div', { class: 'grid two' }, field(t('common.date'), dateInput), field(`${t('agenda.price')} (${currency()})`, priceInput)),
        dayInfo,
        field(t('agenda.treatment'), treatmentSelect),
        field(t('agenda.notes'), notes),
        error,
      ),
      actions: [
        { label: t('common.cancel'), kind: 'ghost' },
        {
          label: t('agenda.book'),
          kind: 'primary',
          onClick: async () => (await save()) || false,
        },
      ],
    });
  };

  /* --------------------------- appointment edit ---------------------------- */
  /** Edit treatment, price and note of an existing appointment. */
  C.openAppointmentEditModal = function openAppointmentEditModal({ appointment, onSaved } = {}) {
    const error = inlineError();
    const treatmentSelect = select([{ value: '', label: t('agenda.noTreatment') }]);
    const priceInput = input({
      type: 'number',
      min: '0',
      step: '50',
      value: String(appointment.price ?? 0),
    });
    const notes = input({ value: appointment.notes || '', placeholder: t('agenda.notes') });
    const paidInfo = h('div', { class: 'help' }, '');
    let treatments = [];

    const applyTreatmentPrice = () => {
      const chosen = treatments.find((item) => String(item.id) === treatmentSelect.value);
      if (chosen) priceInput.value = String(chosen.default_price);
    };
    treatmentSelect.addEventListener('change', applyTreatmentPrice);

    (async () => {
      try {
        treatments = await window.API.invoke('treatments:list');
        fillSelect(
          treatmentSelect,
          [{ value: '', label: t('agenda.noTreatment') }].concat(
            treatments.map((item) => ({
              value: String(item.id),
              label: `${window.App.language === 'ar' ? item.name_ar : item.name_fr} · ${formatMoney(item.default_price, currency())}`,
            })),
          ),
          appointment.treatment_id || '',
        );
        const paid = Number(appointment.paid) || 0;
        paidInfo.textContent = `${t('common.paid')} : ${formatMoney(paid, currency())} · ${t('common.due')} : ${formatMoney(Math.max(0, appointment.price - paid), currency())}`;
      } catch (err) {
        error.textContent = errorMessage(err);
      }
    })();

    const save = async () => {
      error.textContent = '';
      try {
        await window.API.invoke('appointments:update', {
          id: appointment.id,
          treatment_id: treatmentSelect.value ? Number(treatmentSelect.value) : null,
          price: Number(priceInput.value) || 0,
          notes: notes.value.trim(),
        });
        toast(t('common.saved'), 'ok');
        if (onSaved) onSaved();
        return true;
      } catch (err) {
        error.textContent = errorMessage(err);
        return false;
      }
    };

    modal({
      title: t('common.edit') + ' · ' + appointment.full_name,
      body: h(
        'div',
        { class: 'col' },
        field(t('agenda.treatment'), treatmentSelect),
        field(`${t('agenda.price')} (${currency()})`, priceInput),
        paidInfo,
        field(t('agenda.notes'), notes),
        error,
      ),
      actions: [
        { label: t('common.cancel'), kind: 'ghost' },
        { label: t('common.save'), kind: 'primary', onClick: async () => (await save()) || false },
      ],
    });
  };

  /* -------------------------------- payment -------------------------------- */
  C.openPaymentModal = function openPaymentModal({ patientId, appointment = null, onSaved } = {}) {
    const error = inlineError();
    const amount = input({ type: 'number', min: '1', step: '50' });
    const method = select(methodOptions());
    const note = input({ placeholder: t('common.note') });
    const info = h('div', { class: 'help' }, t('common.loading'));

    (async () => {
      try {
        const fresh = await window.API.invoke('patients:get', { id: patientId });
        if (appointment) {
          const row = fresh.history.find((item) => item.id === appointment.id);
          const remaining = row ? row.balance : Math.max(0, appointment.price - appointment.paid);
          amount.value = String(remaining);
          info.textContent = `${fresh.patient.full_name} · ${t('common.price')} ${formatMoney(appointment.price, currency())} · ${t('common.due')} ${formatMoney(remaining, currency())}`;
        } else {
          const remaining = Math.max(0, Number(fresh.patient.balance) || 0);
          amount.value = String(remaining);
          info.textContent = `${fresh.patient.full_name} · ${t('patients.debt')} ${formatMoney(remaining, currency())}`;
        }
      } catch (err) {
        info.textContent = '';
        error.textContent = errorMessage(err);
      }
    })();

    const submit = async ({ print }) => {
      error.textContent = '';
      const value = Number(amount.value);
      if (!value || value <= 0) {
        error.textContent = t('error.INVALID_AMOUNT');
        return false;
      }
      try {
        let created;
        if (appointment) {
          created = await window.API.invoke('payments:add', {
            patient_id: patientId,
            appointment_id: appointment.id,
            amount: value,
            method: method.value,
            note: note.value.trim(),
          });
        } else {
          const rows = await window.API.invoke('payments:pay-debt', {
            patient_id: patientId,
            amount: value,
            method: method.value,
            note: note.value.trim(),
          });
          created = rows[0];
        }
        toast(t('common.saved'), 'ok');
        if (onSaved) onSaved(created);
        if (print && created) C.printReceipt(created.id);
        return true;
      } catch (err) {
        error.textContent = errorMessage(err);
        return false;
      }
    };

    modal({
      title: appointment ? t('agenda.addPayment') : t('patients.payDebt'),
      body: h(
        'div',
        { class: 'col' },
        info,
        field(`${t('common.amount')} (${currency()})`, amount),
        field(t('common.method'), method),
        field(t('common.note'), note),
        error,
      ),
      actions: [
        { label: t('common.cancel'), kind: 'ghost' },
        { label: t('common.save'), kind: 'primary', onClick: async () => (await submit({ print: false })) || false },
        { label: `${t('common.save')} + ${t('common.print')}`, kind: 'soft', onClick: async () => (await submit({ print: true })) || false },
      ],
    });
  };

  /* -------------------------------- expense -------------------------------- */
  C.openExpenseModal = function openExpenseModal({ expense = null, onSaved } = {}) {
    const isEdit = Boolean(expense);
    const error = inlineError();
    const category = select([]);
    const amount = input({ type: 'number', min: '1', step: '50', value: expense ? String(expense.amount) : '' });
    const day = input({ type: 'date', value: expense?.day || todayISO() });
    const label = input({ value: expense?.label || '', placeholder: t('expenses.label') });

    (async () => {
      try {
        const categories = await window.API.invoke('expenses:categories');
        fillSelect(
          category,
          categories.map((item) => ({
            value: String(item.id),
            label: window.App.language === 'ar' ? item.name_ar : item.name_fr,
          })),
          expense ? String(expense.category_id) : '',
        );
      } catch (err) {
        error.textContent = errorMessage(err);
      }
    })();

    const submit = async () => {
      error.textContent = '';
      if (!amount.value || Number(amount.value) <= 0) {
        error.textContent = t('error.INVALID_AMOUNT');
        return false;
      }
      try {
        const payload = {
          id: expense?.id,
          category_id: Number(category.value),
          amount: Number(amount.value),
          day: day.value,
          label: label.value.trim(),
        };
        if (isEdit) await window.API.invoke('expenses:update', payload);
        else await window.API.invoke('expenses:create', payload);
        toast(t('common.saved'), 'ok');
        if (onSaved) onSaved();
        return true;
      } catch (err) {
        error.textContent = errorMessage(err);
        return false;
      }
    };

    modal({
      title: isEdit ? t('common.edit') : t('expenses.new'),
      body: h(
        'div',
        { class: 'col' },
        field(t('expenses.category'), category),
        h('div', { class: 'grid two' }, field(`${t('common.amount')} (${currency()})`, amount), field(t('common.date'), day)),
        field(t('expenses.label'), label),
        error,
      ),
      actions: [
        { label: t('common.cancel'), kind: 'ghost' },
        { label: t('common.save'), kind: 'primary', onClick: async () => (await submit()) || false },
      ],
    });
  };

  /* -------------------------------- receipt -------------------------------- */
  C.printReceipt = async function printReceipt(paymentId) {
    try {
      await window.API.invoke('print:receipt', { id: paymentId });
    } catch (error) {
      if (error.code === 'PRINT_UNAVAILABLE' || error.code === 'UNKNOWN_METHOD') {
        toast(t('error.PRINT_UNAVAILABLE'), 'error');
        return;
      }
      toast(errorMessage(error), 'error');
    }
  };

  C.printDailyReport = async function printDailyReport(day) {
    try {
      await window.API.invoke('print:daily-report', { day });
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  };

  /* --------------------------- live clinic queue --------------------------- */
  C.completeAppointment = async function completeAppointment(appointment, onChanged) {
    try {
      const isToday = appointment.day === todayISO();
      if (isToday) {
        const res = await window.API.invoke('appointments:complete', { id: appointment.id });
        if (window.MiniChat) window.MiniChat.refresh({ scrollBottom: true });
        if (res?.next_patient && res.distant_count > 0) {
          toast(
            t('queue.completedAndNotifiedMany', {
              next: res.next_patient.full_name,
              n: res.distant_count,
            }),
            'ok',
          );
        } else if (res?.next_patient) {
          toast(t('queue.completedAndNotifiedOne', { next: res.next_patient.full_name }), 'ok');
        } else {
          toast(t('agenda.done'), 'ok');
        }
      } else {
        await window.API.invoke('appointments:status', { id: appointment.id, status: 'done' });
        toast(t('agenda.done'), 'ok');
      }
      if (onChanged) onChanged();
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  };

  C.cancelAppointment = async function cancelAppointment(appointment, onChanged) {
    const ok = await window.UI.confirmDialog(
      t('agenda.cancelConfirm', {
        name: appointment.full_name,
        date: window.I18N.formatDate(appointment.day),
      }),
    );
    if (!ok) return;
    try {
      await window.API.invoke('appointments:cancel', { id: appointment.id });
      if (window.MiniChat) window.MiniChat.refresh({ scrollBottom: true });
      toast(t('queue.autoRemovedToast'), 'ok');
      if (onChanged) onChanged();
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  };

  C.queueEtaBadge = function queueEtaBadge(appointment, day = todayISO()) {
    if (!appointment || appointment.status !== 'booked' || day !== todayISO()) return null;
    const ahead = Number(appointment.ahead_count ?? 0);
    const min = Number(appointment.eta_minutes ?? 0);
    if (ahead <= 0) {
      return h('span', { class: 'badge ok queue-eta' }, t('queue.currentNow'));
    }
    if (ahead === 1) {
      return h('span', { class: 'badge queue-eta' }, t('queue.nextEta', { min }));
    }
    return h('span', { class: 'badge warn queue-eta' }, t('queue.aheadEta', { n: ahead, min }));
  };

  C.queueLiveBanner = function queueLiveBanner(agendaRows = [], { day = todayISO(), onChanged } = {}) {
    if (day !== todayISO()) return null;
    const booked = agendaRows.filter((item) => item.status === 'booked');
    if (booked.length === 0) return null;

    const current = booked[0];
    const next = booked[1] || null;
    const avg = Number(window.App?.settings?.avg_session_minutes) || 20;
    const finishBtn = h(
      'button',
      {
        type: 'button',
        class: 'btn primary',
        onClick: async () => {
          finishBtn.disabled = true;
          try {
            await C.completeAppointment(current, onChanged);
          } finally {
            finishBtn.disabled = false;
          }
        },
      },
      window.Icons ? window.Icons.el('checkCircle', { size: 18 }) : '✓',
      h('span', {}, next ? t('queue.finishAndCallNext') : t('queue.finishTreatment')),
    );

    const openChatBtn = h(
      'button',
      {
        type: 'button',
        class: 'btn sm ghost',
        onClick: () => {
          if (window.MiniChat) window.MiniChat.open();
        },
      },
      window.Icons ? window.Icons.el('chat', { size: 16 }) : '',
      h('span', {}, t('chat.openBtn')),
    );

    const subtitleParts = [];
    if (next) {
      subtitleParts.push(t('queue.nextUp', { q: next.queue_number, name: next.full_name }));
      if (booked.length > 2) {
        subtitleParts.push(t('queue.waitingCount', { n: booked.length - 1, avg }));
      }
    } else {
      subtitleParts.push(t('queue.lastPatient'));
    }

    return h(
      'div',
      { class: 'queue-live-bar mb' },
      h(
        'div',
        { class: 'queue-live-info' },
        h('div', { class: 'queue current-pill num' }, `#${current.queue_number}`),
        h(
          'div',
          { class: 'who' },
          h(
            'div',
            { class: 'row wrap', style: { gap: '8px' } },
            h('span', { class: 'badge ok' }, t('queue.barTitle')),
            h('strong', { class: 'queue-live-name' }, current.full_name),
            current.treatment_name ? h('span', { class: 'muted small' }, `· ${current.treatment_name}`) : null,
          ),
          h('div', { class: 'queue-live-sub muted small' }, subtitleParts.join(' · ')),
        ),
      ),
      h('div', { class: 'row wrap', style: { gap: '8px' } }, openChatBtn, finishBtn),
    );
  };

  /* ------------------------ license & activation -------------------------- */
  C.openLicenseModal = async function openLicenseModal({ onActivated } = {}) {
    let status = window.App?.licenseStatus || null;
    try {
      status = await window.API.invoke('license:status');
      if (window.App) window.App.licenseStatus = status;
    } catch (_e) {
      status = status || { state: 'trial', machineCode: '—', daysRemaining: 7 };
    }

    const machineCode = status?.machineCode || '—';
    const keyInput = textarea({
      placeholder: t('lic.keyPlaceholder'),
      style: { fontFamily: 'monospace', minHeight: '78px', direction: 'ltr', textAlign: 'left' },
    });
    const error = inlineError();

    const statusBadgeNode =
      status?.state === 'activated'
        ? h(
            'div',
            { class: 'callout', style: { borderColor: 'var(--ok)', background: 'var(--ok-soft)' } },
            '✅ ',
            status.plan === 'LIFE'
              ? t('lic.lifetimeBanner')
              : t('lic.activatedBanner', {
                  plan: status.plan || 'PRO',
                  date: window.I18N.formatDate((status.expiresAt || '').slice(0, 10)),
                }),
          )
        : status?.state === 'expired'
          ? h('div', { class: 'allergy-alert' }, '🔒 ', t('lic.expiredBanner'))
          : h(
              'div',
              { class: 'callout' },
              '⏳ ',
              t('lic.trialBanner', { d: status?.daysRemaining ?? 7 }),
            );

    modal({
      title: t('lic.title'),
      body: h(
        'div',
        { class: 'col' },
        statusBadgeNode,
        h(
          'div',
          { class: 'card row wrap between', style: { padding: '12px 14px', gap: '10px' } },
          h(
            'div',
            {},
            h('div', { class: 'small muted' }, t('lic.machineCode')),
            h('strong', { style: { fontFamily: 'monospace', fontSize: '1.05rem', letterSpacing: '0.04em' }, dir: 'ltr' }, machineCode),
          ),
          h(
            'button',
            {
              type: 'button',
              class: 'btn sm soft',
              onClick: async () => {
                const ok = await window.API.copyText(machineCode);
                if (ok) toast(t('lic.copiedMachine'), 'ok');
              },
            },
            window.Icons ? window.Icons.el('copy', { size: 15 }) : '',
            ' ',
            t('lic.copyMachine'),
          ),
        ),
        h('div', { class: 'muted small' }, t('lic.instructions')),
        field(t('lic.enterKey'), keyInput),
        error,
      ),
      actions: [
        { label: t('common.close'), kind: 'ghost' },
        {
          label: t('lic.activateNow'),
          kind: 'primary',
          onClick: async () => {
            error.textContent = '';
            try {
              const nextStatus = await window.API.invoke('license:activate', { code: keyInput.value });
              if (window.App) window.App.licenseStatus = nextStatus;
              toast(t('lic.activatedToast'), 'ok');
              if (onActivated) onActivated(nextStatus);
              if (window.App?.rerender) await window.App.rerender();
              return true;
            } catch (err) {
              error.textContent = errorMessage(err);
              return false;
            }
          },
        },
      ],
    });
  };

  C.methodOptions = methodOptions;
  C.currency = currency;
  C.fillSelect = fillSelect;
  window.Components = C;
})();
