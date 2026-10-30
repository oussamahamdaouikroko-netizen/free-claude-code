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
    const birth = input({ type: 'date', value: patient?.birth_date && patient.birth_date.length === 10 ? patient.birth_date : '' });
    const gender = select(
      [
        { value: '', label: '—' },
        { value: 'f', label: t('patients.female') },
        { value: 'm', label: t('patients.male') },
      ],
      { value: patient?.gender || '' },
    );
    const bloodGroup = select(
      ['', 'O+', 'O-', 'A+', 'A-', 'B+', 'B-', 'AB+', 'AB-'].map((bg) => ({
        value: bg,
        label: bg || '—',
      })),
      { value: patient?.blood_group || '' },
    );
    const allergies = input({
      value: patient?.allergies || '',
      placeholder: t('patients.allergiesPlaceholder'),
    });
    const chronic = input({
      value: patient?.chronic_conditions || '',
      placeholder: t('patients.chronicPlaceholder'),
    });
    const chifa = input({ value: patient?.chifa_number || '', placeholder: t('emr.chifa') });
    const nss = input({ value: patient?.nss || '', placeholder: t('emr.nss') });
    const insuranceSel = select(
      ['none', 'CNAS', 'CASNOS', 'other', 'free'].map((k) => ({
        value: k,
        label: t(`billing.ins_${k}`),
      })),
      { value: patient?.insurance_type || 'none' },
    );
    const wilaya = input({ value: patient?.wilaya || '', placeholder: 'Alger / Oran / Constantine…' });
    const commune = input({ value: patient?.commune || '', placeholder: t('emr.commune') });
    const occupation = input({ value: patient?.occupation || '', placeholder: t('emr.occupation') });
    const marital = input({ value: patient?.marital_status || '', placeholder: t('emr.maritalStatus') });
    const emgName = input({ value: patient?.emergency_contact_name || '', placeholder: t('emr.emergencyName') });
    const emgPhone = input({ value: patient?.emergency_contact_phone || '', placeholder: '05 55 …' });
    const guardName = input({ value: patient?.legal_guardian_name || '', placeholder: t('emr.guardianName') });
    const guardPhone = input({ value: patient?.legal_guardian_phone || '', placeholder: '05 55 …' });
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
          chifa_number: chifa.value.trim(),
          nss: nss.value.trim(),
          insurance_type: insuranceSel.value || 'none',
          wilaya: wilaya.value.trim(),
          commune: commune.value.trim(),
          occupation: occupation.value.trim(),
          marital_status: marital.value.trim(),
          emergency_contact_name: emgName.value.trim(),
          emergency_contact_phone: emgPhone.value.trim(),
          legal_guardian_name: guardName.value.trim(),
          legal_guardian_phone: guardPhone.value.trim(),
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
        h('div', { class: 'grid two' }, field(t('patients.name'), name), field(t('common.phone'), phone)),
        h(
          'div',
          { class: 'grid three' },
          field(t('patients.birth'), birth),
          field(t('patients.gender'), gender),
          field(t('patients.bloodGroup'), bloodGroup),
        ),
        field('⚠️ ' + t('patients.allergies'), allergies),
        field(t('patients.chronic'), chronic),
        field(t('billing.insuranceType'), insuranceSel),
        h('div', { class: 'grid two' }, field(t('emr.chifa'), chifa), field(t('emr.nss'), nss)),
        h('div', { class: 'grid two' }, field(t('emr.wilaya'), wilaya), field(t('emr.commune'), commune)),
        h('div', { class: 'grid two' }, field(t('emr.occupation'), occupation), field(t('emr.maritalStatus'), marital)),
        h('div', { class: 'grid two' }, field(t('emr.emergencyName'), emgName), field(t('emr.emergencyPhone'), emgPhone)),
        h('div', { class: 'grid two' }, field(t('emr.guardianName'), guardName), field(t('emr.guardianPhone'), guardPhone)),
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
  C.openAppointmentModal = function openAppointmentModal({ day, patientId, departmentId, onSaved } = {}) {
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
    const deptSelect = select([{ value: '', label: t('dept.none') }]);
    const deptFieldWrap = h('div', { class: 'hidden' }, field(t('dept.select'), deptSelect));
    const treatmentSelect = select([{ value: '', label: t('agenda.noTreatment') }]);
    const priceInput = input({ type: 'number', min: '0', step: '50', value: '0' });
    const dateInput = input({ type: 'date', value: targetDay, min: todayISO() });
    const dayInfo = h('div', { class: 'help' }, '');
    const notes = input({ placeholder: t('agenda.notes') });

    let treatments = [];
    let depts = [];

    const selectedDeptId = () => (deptSelect.value ? Number(deptSelect.value) : null);

    const updateDayInfo = async () => {
      if (!dateInput.value) return;
      try {
        const info = await window.API.invoke('appointments:day-info', {
          day: dateInput.value,
          department_id: selectedDeptId(),
        });
        if (info.holiday) dayInfo.textContent = '🏖️ ' + t('agenda.doctorOnLeave');
        else if (!info.working) dayInfo.textContent = t('agenda.notWorking');
        else if (info.left <= 0) dayInfo.textContent = t('agenda.dayFull', { cap: info.capacity });
        else dayInfo.textContent = t('dash.capacityLeft', { n: info.left, cap: info.capacity });
      } catch (err) {
        dayInfo.textContent = errorMessage(err);
      }
    };

    const applyTreatmentPrice = () => {
      const chosen = treatments.find((item) => String(item.id) === treatmentSelect.value);
      if (chosen) {
        priceInput.value = String(chosen.default_price);
      } else {
        const chosenDept = depts.find((d) => String(d.id) === deptSelect.value);
        if (chosenDept && chosenDept.consultation_fee > 0) {
          priceInput.value = String(chosenDept.consultation_fee);
        }
      }
    };

    patientSelect.addEventListener('change', () => {
      newPatientBox.classList.toggle('hidden', patientSelect.value !== '__new__');
    });
    deptSelect.addEventListener('change', () => {
      if (!treatmentSelect.value) applyTreatmentPrice();
      updateDayInfo();
    });
    treatmentSelect.addEventListener('change', applyTreatmentPrice);
    dateInput.addEventListener('change', updateDayInfo);

    (async () => {
      try {
        const [list, catalog, activeDepts, nextFree] = await Promise.all([
          window.API.invoke('patients:list', { limit: 800 }),
          window.API.invoke('treatments:list'),
          window.API.invoke('departments:list').catch(() => []),
          window.API.invoke('appointments:next-free-day', { departmentId: departmentId || null }).catch(() => null),
        ]);
        treatments = catalog;
        depts = activeDepts || [];
        if (depts.length > 0) {
          deptFieldWrap.classList.remove('hidden');
          const defaultDept = departmentId ? String(departmentId) : String(depts[0].id);
          fillSelect(
            deptSelect,
            [{ value: '', label: t('dept.none') }].concat(
              depts.map((d) => ({
                value: String(d.id),
                label: `${window.App.language === 'ar' ? d.name_ar || d.name_fr : d.name_fr}${d.doctor_name ? ` — ${d.doctor_name}` : ''}`,
              })),
            ),
            defaultDept,
          );
          const initDept = depts.find((d) => String(d.id) === defaultDept);
          if (initDept && initDept.consultation_fee > 0) {
            priceInput.value = String(initDept.consultation_fee);
          }
        }
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
          department_id: selectedDeptId(),
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
        deptFieldWrap,
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
  C.rescheduleDialog = function rescheduleDialog(appointment, onDone) {
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
              if (onDone) onDone();
            } catch (err) {
              error.textContent = errorMessage(err);
              return false;
            }
            return true;
          },
        },
      ],
    });
  };

  C.completeAppointment = async function completeAppointment(appointment, onChanged) {
    try {
      const today = todayISO();
      if (appointment.day > today) {
        toast(t('error.APPOINTMENT_FUTURE_DAY'), 'error');
        return;
      }
      const isToday = appointment.day === today;
      if (isToday && appointment.is_current_turn === false) {
        toast(t('error.QUEUE_OUT_OF_TURN'), 'error');
        return;
      }
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

  C.departmentLabel = function departmentLabel(row) {
    if (!row) return '';
    const isAr = window.App?.language === 'ar';
    return isAr
      ? row.dept_name_ar || row.dept_name_fr || row.department_name || ''
      : row.dept_name_fr || row.department_name || row.dept_name_ar || '';
  };

  C.printPrescription = async function printPrescription(rxId, { previewFirst = true } = {}) {
    try {
      const { html } = await window.API.invoke('prescriptions:html', { id: rxId });
      const triggerSystemPrint = async () => {
        const res = await window.API.invoke('print:prescription', { id: rxId });
        if (res?.fallback && res.html) window.API.printHtml(res.html);
      };
      if (!previewFirst) {
        await triggerSystemPrint();
        return;
      }
      const frame = h('iframe', { class: 'ordonnance-preview-frame' });
      frame.srcdoc = html;
      modal({
        title: t('rx.previewTitle'),
        wide: true,
        body: frame,
        actions: [
          { label: t('common.close'), kind: 'ghost' },
          {
            label: '🖨️ ' + t('rx.printNow'),
            kind: 'primary',
            onClick: async () => {
              await triggerSystemPrint();
              return false;
            },
          },
        ],
      });
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  C.printCertificate = async function printCertificate(certId, { previewFirst = true } = {}) {
    try {
      const { html } = await window.API.invoke('certificates:html', { id: certId });
      const triggerSystemPrint = async () => {
        const res = await window.API.invoke('print:certificate', { id: certId });
        if (res?.fallback && res.html) window.API.printHtml(res.html);
      };
      if (!previewFirst) {
        await triggerSystemPrint();
        return;
      }
      const frame = h('iframe', { class: 'ordonnance-preview-frame' });
      frame.srcdoc = html;
      modal({
        title: t('rx.previewTitle'),
        wide: true,
        body: frame,
        actions: [
          { label: t('common.close'), kind: 'ghost' },
          {
            label: '🖨️ ' + t('rx.printNow'),
            kind: 'primary',
            onClick: async () => {
              await triggerSystemPrint();
              return false;
            },
          },
        ],
      });
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  function formatAgeBadge(ageYears) {
    if (ageYears === null || ageYears === undefined || ageYears === '') return '';
    const num = Number(ageYears);
    if (!Number.isFinite(num) || num <= 0) return '';
    if (num < 2) return t('intake.ageUnitMonths', { n: Math.round(num * 12) });
    return t('intake.ageUnitYears', { n: Math.round(num * 10) / 10 });
  }

  /* ------------------------- pre-visit intake UI ------------------------- */
  C.intakeBadge = function intakeBadge(appointment) {
    if (!appointment || !appointment.intake_id) return null;
    const isApplied = appointment.intake_status === 'applied';
    const compactMetrics = [];
    const ageLabel = formatAgeBadge(appointment.intake_age_years);
    if (ageLabel) compactMetrics.push(ageLabel);
    if (appointment.intake_weight_kg) compactMetrics.push(`${appointment.intake_weight_kg} kg`);

    const summaryParts = [...compactMetrics];
    if (appointment.intake_complaint) summaryParts.push(appointment.intake_complaint);
    if (appointment.intake_allergies) summaryParts.push(`⚠ ${appointment.intake_allergies}`);
    const tooltip = summaryParts.join(' · ') || t(isApplied ? 'intake.badgeApplied' : 'intake.badgePending');
    const badgeLabel = compactMetrics.length
      ? `${compactMetrics.join(' · ')} (${t(isApplied ? 'intake.badgeApplied' : 'intake.badgePending')})`
      : t(isApplied ? 'intake.badgeApplied' : 'intake.badgePending');

    return h(
      'button',
      {
        type: 'button',
        class: `badge ${isApplied ? 'ok' : 'warn'}`,
        style: { cursor: 'pointer', border: '0', display: 'inline-flex', alignItems: 'center', gap: '4px' },
        title: tooltip,
        onClick: (ev) => {
          ev.stopPropagation();
          if (window.openPatientFile) window.openPatientFile(appointment.patient_id);
        },
      },
      window.Icons ? window.Icons.el('clipboard', { size: 13 }) : '',
      h('span', {}, badgeLabel),
    );
  };

  C.openIntakeModal = function openIntakeModal({ patient, appointmentId = null, intakeRow = null, applyOnSave = false, onSaved } = {}) {
    const isEdit = Boolean(intakeRow);
    const err = inlineError();

    const ageIn = input({
      type: 'number',
      step: '0.5',
      min: '0.1',
      max: '130',
      value: intakeRow?.age_years ?? '',
      placeholder: '32',
      autofocus: true,
    });
    const weightIn = input({
      type: 'number',
      step: '0.1',
      min: '0.3',
      max: '400',
      value: intakeRow?.weight_kg ?? '',
      placeholder: '72.0',
    });
    const heightIn = input({
      type: 'number',
      step: '0.5',
      min: '30',
      max: '250',
      value: intakeRow?.height_cm ?? '',
      placeholder: '170',
    });
    const bmiDisplay = h('div', { class: 'badge', style: { marginTop: '6px' } }, '—');
    const updateBmi = () => {
      const w = Number.parseFloat(weightIn.value);
      const hm = Number.parseFloat(heightIn.value) / 100;
      if (Number.isFinite(w) && Number.isFinite(hm) && w > 0 && hm >= 0.3) {
        bmiDisplay.textContent = `${t('intake.bmi')} : ${(w / (hm * hm)).toFixed(1)}`;
      } else {
        bmiDisplay.textContent = `${t('intake.bmi')} : —`;
      }
    };
    weightIn.addEventListener('input', updateBmi);
    heightIn.addEventListener('input', updateBmi);
    updateBmi();

    const complaintIn = textarea({ value: intakeRow?.chief_complaint || '', placeholder: t('intake.complaint') });
    const durationIn = input({ value: intakeRow?.symptom_duration || '', placeholder: 'Ex. 3 jours' });
    const medsIn = input({ value: intakeRow?.current_medications || '', placeholder: t('intake.currentMeds') });
    const allergiesIn = input({ value: intakeRow?.known_allergies || '', placeholder: t('intake.knownAllergies') });
    const chronicIn = input({ value: intakeRow?.chronic_conditions || '', placeholder: t('intake.chronic') });
    const bpIn = input({ value: intakeRow?.last_blood_pressure || '', placeholder: '120/80' });
    const glyIn = input({ value: intakeRow?.last_glycemia || '', placeholder: '0.95 g/L' });

    const triOptions = () => [
      { value: '', label: '—' },
      { value: '0', label: t('common.no') },
      { value: '1', label: t('common.yes') },
    ];
    const smokerSel = select(triOptions(), {
      value: intakeRow?.smoker === 1 ? '1' : intakeRow?.smoker === 0 ? '0' : '',
    });
    const pregSel = select(triOptions(), {
      value: intakeRow?.is_pregnant === 1 ? '1' : intakeRow?.is_pregnant === 0 ? '0' : '',
    });
    const breastSel = select(triOptions(), {
      value: intakeRow?.is_breastfeeding === 1 ? '1' : intakeRow?.is_breastfeeding === 0 ? '0' : '',
    });

    const consentBox = h('input', { type: 'checkbox', checked: isEdit ? true : false });
    const consentRow = !isEdit
      ? h(
          'label',
          { class: 'row', style: { gap: '8px', cursor: 'pointer', marginTop: '6px' } },
          consentBox,
          h('span', { class: 'small' }, t('intake.consentLabel')),
        )
      : null;

    const showFemaleFields = !patient?.gender || patient.gender === 'f';

    const buildPatch = () => ({
      age_years: ageIn.value.trim() === '' ? null : ageIn.value.trim(),
      weight_kg: weightIn.value.trim() === '' ? null : weightIn.value.trim(),
      height_cm: heightIn.value.trim() === '' ? null : heightIn.value.trim(),
      chief_complaint: complaintIn.value.trim(),
      symptom_duration: durationIn.value.trim(),
      current_medications: medsIn.value.trim(),
      known_allergies: allergiesIn.value.trim(),
      chronic_conditions: chronicIn.value.trim(),
      last_blood_pressure: bpIn.value.trim(),
      last_glycemia: glyIn.value.trim(),
      smoker: smokerSel.value === '' ? null : Number(smokerSel.value),
      is_pregnant: showFemaleFields ? (pregSel.value === '' ? null : Number(pregSel.value)) : null,
      is_breastfeeding: showFemaleFields ? (breastSel.value === '' ? null : Number(breastSel.value)) : null,
    });

    const submit = async () => {
      err.textContent = '';
      try {
        if (!isEdit && !consentBox.checked) {
          err.textContent = t('error.INTAKE_CONSENT_REQUIRED');
          return false;
        }
        let res;
        if (isEdit && applyOnSave) {
          res = await window.API.invoke('intake:confirm', {
            id: intakeRow.id,
            edits: buildPatch(),
            reviewed_by: window.App?.settings?.doctor_name || 'doctor',
          });
          toast(t('intake.appliedToast'), 'ok');
        } else if (isEdit) {
          res = await window.API.invoke('intake:update', {
            id: intakeRow.id,
            patch: buildPatch(),
          });
          toast(t('common.saved'), 'ok');
        } else {
          res = await window.API.invoke('intake:create', {
            patient_id: patient.id,
            appointment_id: appointmentId || null,
            source: 'manual',
            consent: true,
            ...buildPatch(),
          });
          toast(t('common.saved'), 'ok');
        }
        if (onSaved) onSaved(res);
        return true;
      } catch (e) {
        err.textContent = errorMessage(e);
        return false;
      }
    };

    modal({
      title: `${isEdit ? t('intake.modalTitleEdit') : t('intake.modalTitleNew')} · ${patient?.full_name || ''}`,
      wide: true,
      body: h(
        'div',
        { class: 'col' },
        h(
          'div',
          { class: 'grid three', style: { alignItems: 'end' } },
          field(t('intake.ageYears'), ageIn),
          field(t('intake.weightKg'), weightIn),
          field(t('intake.heightCm'), heightIn),
        ),
        bmiDisplay,
        h('div', { class: 'grid two' }, field(t('intake.complaint'), complaintIn), field(t('intake.duration'), durationIn)),
        h('div', { class: 'grid two' }, field(t('intake.currentMeds'), medsIn), field(t('intake.knownAllergies'), allergiesIn)),
        field(t('intake.chronic'), chronicIn),
        h(
          'div',
          { class: 'grid three' },
          field(t('intake.lastBp'), bpIn),
          field(t('intake.lastGlycemia'), glyIn),
          field(t('intake.smoker'), smokerSel),
        ),
        showFemaleFields
          ? h('div', { class: 'grid two' }, field(t('intake.pregnant'), pregSel), field(t('intake.breastfeeding'), breastSel))
          : null,
        consentRow,
        err,
      ),
      actions: [
        { label: t('common.cancel'), kind: 'ghost' },
        {
          label: isEdit && applyOnSave ? t('intake.confirmApply') : t('common.save'),
          kind: 'primary',
          onClick: async () => (await submit()) || false,
        },
      ],
    });
  };

  C.printInvoice = async function printInvoice(invoiceId) {
    const res = await window.API.invoke('print:invoice', { id: invoiceId });
    if (res?.html) {
      modal({
        title: t('billing.invoices'),
        wide: true,
        body: h('iframe', { srcdoc: res.html, style: { width: '100%', height: '72vh', border: '1px solid var(--line)', borderRadius: '8px' } }),
        actions: [{ label: t('common.close') }],
      });
    }
  };

  C.openInvoiceModal = async function openInvoiceModal({ patient, appointment = null, onSaved } = {}) {
    const acts = await window.API.invoke('treatments:list', { include_inactive: false }).catch(() => []);
    const actSel = select(
      [{ value: '', label: '—' }].concat(acts.map((a) => ({ value: String(a.id), label: `${a.name_fr} (${a.default_price})` }))),
    );
    const insSel = select(
      ['none', 'CNAS', 'CASNOS', 'other', 'free'].map((k) => ({ value: k, label: t(`billing.ins_${k}`) })),
      { value: patient?.insurance_type || 'none' },
    );
    const priceIn = input({ type: 'number', min: '0', value: String(appointment?.price || acts[0]?.default_price || 1500) });
    const discIn = input({ type: 'number', min: '0', value: '0' });
    const paidIn = input({ type: 'number', min: '0', value: '0' });
    const methodSel = select(methodOptions());
    const previewBox = h('div', { class: 'card small col', style: { gap: '4px' } });

    async function refreshPreview() {
      const prev = await window.API.invoke('billing:preview', {
        treatment_id: actSel.value ? Number(actSel.value) : null,
        price: Number(priceIn.value) || 0,
        insurance_type: insSel.value,
        discount_amount: Number(discIn.value) || 0,
      }).catch(() => null);
      if (!prev) return;
      previewBox.replaceChildren(
        h('div', { class: 'row between' }, h('span', {}, t('billing.insuredShare')), h('strong', {}, formatMoney(prev.insured_share, currency()))),
        h('div', { class: 'row between' }, h('span', {}, t('billing.patientShare')), h('strong', {}, formatMoney(prev.patient_share, currency()))),
      );
      paidIn.value = String(prev.patient_share);
    }

    actSel.addEventListener('change', () => {
      const a = acts.find((x) => String(x.id) === actSel.value);
      if (a) priceIn.value = String(insSel.value === 'none' ? a.price_private : a.price_insured);
      refreshPreview();
    });
    insSel.addEventListener('change', refreshPreview);
    priceIn.addEventListener('input', refreshPreview);
    discIn.addEventListener('input', refreshPreview);
    refreshPreview();

    modal({
      title: `${t('billing.newInvoice')} · ${patient?.full_name || ''}`,
      body: h(
        'div',
        { class: 'col' },
        field(t('common.treatment'), actSel),
        h('div', { class: 'grid two' }, field(t('billing.insuranceType'), insSel), field(t('common.price'), priceIn)),
        h('div', { class: 'grid two' }, field(t('billing.discount'), discIn), field(t('billing.paidNow'), paidIn)),
        field(t('common.method'), methodSel),
        previewBox,
      ),
      actions: [
        { label: t('common.cancel'), kind: 'ghost' },
        {
          label: t('common.save'),
          kind: 'primary',
          onClick: async () => {
            const inv = await window.API.invoke('billing:invoice-create', {
              patient_id: patient?.id,
              appointment_id: appointment?.id || null,
              treatment_id: actSel.value ? Number(actSel.value) : null,
              price: Number(priceIn.value) || 0,
              insurance_type: insSel.value,
              discount_amount: Number(discIn.value) || 0,
              paid_amount: Number(paidIn.value) || 0,
              method: methodSel.value,
            });
            toast(`${inv.invoice_number} — ${t('common.saved')}`, 'ok');
            if (onSaved) onSaved(inv);
          },
        },
      ],
    });
  };

  /* ---------------- Secretary one-click payment confirmation ------------- */
  C.canConfirmPayment = function canConfirmPayment() {
    const role = window.App?.bootInfo?.auth?.user?.role || 'admin';
    return role === 'admin' || role === 'secretary';
  };

  C.openQuickAmountConfirmModal = function openQuickAmountConfirmModal({
    appointment,
    commonAmounts = [1000, 1500, 2000, 2500, 3000],
    onConfirmed,
  } = {}) {
    const error = inlineError();
    const amountIn = input({ type: 'number', min: '1', step: '50', placeholder: '1500' });
    let closeHandle = null;

    const submitAmount = async (val) => {
      error.textContent = '';
      const num = Number(val);
      if (!Number.isFinite(num) || num <= 0) {
        error.textContent = t('error.INVALID_AMOUNT');
        return false;
      }
      try {
        const res = await window.API.invoke('secretary:confirm-payment', {
          appointment_id: appointment.id,
          amount: num,
        });
        toast(t('pay.confirmedToast'), 'ok');
        if (onConfirmed) onConfirmed(res);
        if (closeHandle && typeof closeHandle.close === 'function') closeHandle.close();
        return true;
      } catch (err) {
        error.textContent = errorMessage(err);
        return false;
      }
    };

    const presetRow = h(
      'div',
      { class: 'row wrap', style: { gap: '8px' } },
      ...commonAmounts.map((amt) =>
        h(
          'button',
          {
            type: 'button',
            class: 'btn sm soft',
            onClick: () => submitAmount(amt),
          },
          formatMoney(amt, currency()),
        ),
      ),
    );

    closeHandle = modal({
      title: `${t('pay.askAmountTitle')} · ${appointment.full_name || ''}`,
      body: h(
        'div',
        { class: 'col' },
        h('div', { class: 'help' }, t('pay.askAmountHelp')),
        presetRow,
        field(`${t('common.amount')} (${currency()})`, amountIn),
        error,
      ),
      actions: [
        { label: t('common.cancel'), kind: 'ghost' },
        {
          label: t('common.confirm'),
          kind: 'primary',
          onClick: async () => (await submitAmount(amountIn.value)) || false,
        },
      ],
    });
  };

  C.confirmPaymentButton = function confirmPaymentButton(appointment, onChanged) {
    if (!appointment || !C.canConfirmPayment()) return null;
    const settled =
      Boolean(appointment.is_paid) ||
      (Number(appointment.price) > 0 && Number(appointment.paid) >= Number(appointment.price) - 0.009);

    if (settled) {
      return h(
        'button',
        {
          type: 'button',
          class: 'btn sm soft sec-paid-badge',
          disabled: true,
        },
        '💰 ' + t('pay.paidBadge'),
      );
    }

    if (appointment.status === 'cancelled') return null;

    const btn = h(
      'button',
      {
        type: 'button',
        class: 'btn sm primary sec-mark-paid-btn',
        onClick: async () => {
          if (btn.disabled) return;
          btn.disabled = true;
          try {
            const res = await window.API.invoke('secretary:confirm-payment', {
              appointment_id: appointment.id,
            });
            btn.textContent = '💰 ' + t('pay.paidBadge');
            btn.className = 'btn sm soft sec-paid-badge';
            toast(t('pay.confirmedToast'), 'ok');
            if (onChanged) onChanged(res);
          } catch (err) {
            if (err && err.code === 'AMOUNT_REQUIRED') {
              btn.disabled = false;
              C.openQuickAmountConfirmModal({
                appointment,
                commonAmounts: err.details?.common_amounts || [1000, 1500, 2000, 2500, 3000],
                onConfirmed: (res) => {
                  btn.disabled = true;
                  btn.textContent = '💰 ' + t('pay.paidBadge');
                  btn.className = 'btn sm soft sec-paid-badge';
                  if (onChanged) onChanged(res);
                },
              });
              return;
            }
            btn.disabled = false;
            toast(errorMessage(err), 'error');
          }
        },
      },
      '✅ ' + t('pay.markPaid'),
    );
    return btn;
  };

  /* --------------------------- license activation -------------------------- */
  C.openLicenseModal = async function openLicenseModal({ initialStatus = null, onActivated } = {}) {
    if (document.querySelector('.license-modal-root')) return;

    let status = initialStatus;
    try {
      if (!status) status = await window.API.invoke('license:status');
    } catch (_err) {
      status = { status: 'unlicensed', valid: false, machine_id: '—' };
    }

    const statusBadge = h('div', { class: 'badge' });
    const renderStatusBadge = (st) => {
      if (!st) return;
      if (st.valid) {
        statusBadge.className = 'badge ok';
        statusBadge.textContent =
          '✅ ' +
          t('license.statusActive', {
            date: st.expires_date_dz || '—',
            days: st.days_remaining ?? 0,
          });
      } else if (st.status === 'clock_tampered') {
        statusBadge.className = 'badge err';
        statusBadge.textContent = '⏰ ' + t('license.statusClock');
      } else if (st.status === 'expired') {
        statusBadge.className = 'badge err';
        statusBadge.textContent =
          '⛔ ' + t('license.statusExpired', { date: st.expires_date_dz || '—' });
      } else {
        statusBadge.className = 'badge warn';
        statusBadge.textContent = '🔒 ' + t('license.statusUnlicensed');
      }
    };
    renderStatusBadge(status);

    const machineBox = input({
      value: status?.machine_id || '—',
      readonly: true,
      dir: 'ltr',
      style: { fontFamily: 'monospace', fontWeight: '700', letterSpacing: '1px' },
    });

    const copyBtn = h(
      'button',
      {
        type: 'button',
        class: 'btn soft sm',
        onClick: async () => {
          const val = status?.machine_id || machineBox.value || '';
          if (!val || val === '—') return;
          try {
            await window.API.invoke('app:copy-text', { text: val });
          } catch (_err) {
            if (navigator.clipboard && navigator.clipboard.writeText) {
              await navigator.clipboard.writeText(val).catch(() => {});
            }
          }
          toast(t('license.copiedToast'), 'ok');
        },
      },
      '📋 ' + t('license.copyMachine'),
    );

    const codeArea = textarea({
      rows: 3,
      dir: 'ltr',
      placeholder: t('license.codePlaceholder'),
      style: { fontFamily: 'monospace', letterSpacing: '0.5px' },
    });

    const error = inlineError();
    let busyActivating = false;

    modal({
      title: '🔑 ' + t('license.title'),
      body: h(
        'div',
        { class: 'col license-modal-root' },
        field(t('license.statusLabel'), statusBadge),
        field(
          t('license.machineId'),
          h('div', { class: 'row', style: { gap: '8px' } }, machineBox, copyBtn),
          t('license.machineHint'),
        ),
        field(t('license.codeLabel'), codeArea, t('license.renewNote')),
        error,
      ),
      actions: [
        { label: t('common.close'), kind: 'ghost' },
        {
          label: '✅ ' + t('license.activateBtn'),
          kind: 'primary',
          onClick: async () => {
            if (busyActivating) return false;
            error.textContent = '';
            const raw = String(codeArea.value || '').trim();
            if (!raw) {
              error.textContent = t('error.MALFORMED_CODE');
              return false;
            }
            busyActivating = true;
            try {
              const nextStatus = await window.API.invoke('license:activate', { code: raw });
              status = nextStatus;
              renderStatusBadge(nextStatus);
              if (window.App) {
                window.App.license = nextStatus;
                if (typeof window.App.updateLicenseBanner === 'function') {
                  window.App.updateLicenseBanner(nextStatus);
                }
                if (window.App.bootInfo?.auth?.unlocked) {
                  window.App.renderPage();
                }
              }
              toast(
                t('license.activatedToast', { date: nextStatus.expires_date_dz || '' }),
                'ok',
              );
              if (onActivated) onActivated(nextStatus);
              return true;
            } catch (err) {
              error.textContent = errorMessage(err);
              return false;
            } finally {
              busyActivating = false;
            }
          },
        },
      ],
    });
  };

  /* ------------------------ doctor holiday / sick day ---------------------- */
  C.openHolidayModal = function openHolidayModal({ defaultDay, departmentId = null, departments = [], onSaved } = {}) {
    const baseDay = defaultDay || todayISO();
    const startInput = input({ type: 'date', value: baseDay, min: todayISO() });
    const endInput = input({ type: 'date', value: baseDay, min: todayISO() });
    startInput.addEventListener('change', () => {
      if (!endInput.value || endInput.value < startInput.value) {
        endInput.value = startInput.value;
      }
      endInput.min = startInput.value;
    });

    const reasonSelect = select(
      [
        { value: 'vacation', label: '🏖️ ' + t('holidays.reasonVacation') },
        { value: 'sick', label: '🩺 ' + t('holidays.reasonSick') },
        { value: 'other', label: '🔒 ' + t('holidays.reasonOther') },
      ],
      { value: 'vacation' },
    );

    const activeDepts = Array.isArray(departments) ? departments.filter((d) => d.active !== 0) : [];
    const deptSelect = select(
      [{ value: '', label: t('holidays.allClinic') }].concat(
        activeDepts.map((d) => ({
          value: String(d.id),
          label: window.App?.language === 'ar' ? d.name_ar || d.name_fr : d.name_fr,
        })),
      ),
      { value: departmentId ? String(departmentId) : '' },
    );

    const noteInput = input({ placeholder: t('holidays.noteLabel') });
    const blockWaBox = input({ type: 'checkbox', checked: false });
    const error = inlineError();

    modal({
      title: '🏖️ ' + t('holidays.title'),
      body: h(
        'div',
        { class: 'col' },
        h(
          'div',
          { class: 'grid two' },
          field(t('holidays.startDay'), startInput),
          field(t('holidays.endDay'), endInput),
        ),
        activeDepts.length > 0 ? field(t('dept.select'), deptSelect) : null,
        field(t('holidays.reason'), reasonSelect, t('holidays.privacyHint')),
        field(t('holidays.noteLabel'), noteInput),
        h(
          'div',
          { class: 'row between', style: { gap: '12px', paddingTop: '4px' } },
          h('span', { class: 'small' }, t('holidays.blockAllWa')),
          h('label', { class: 'switch' }, blockWaBox, h('span', {})),
        ),
        error,
      ),
      actions: [
        { label: t('common.cancel'), kind: 'ghost' },
        {
          label: t('common.save'),
          kind: 'primary',
          onClick: async () => {
            error.textContent = '';
            try {
              const saved = await window.API.invoke('holidays:create', {
                start_day: startInput.value,
                end_day: endInput.value || startInput.value,
                department_id: deptSelect.value ? Number(deptSelect.value) : null,
                reason_type: reasonSelect.value,
                label: noteInput.value.trim(),
                block_all_wa: blockWaBox.checked,
              });
              toast(t('holidays.added'), 'ok');
              if (onSaved) onSaved(saved);
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
