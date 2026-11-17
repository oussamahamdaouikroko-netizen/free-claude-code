/* Settings: clinic & doctor identity, multi-department manager, agenda, WhatsApp, backups, security. */
(function () {
  'use strict';
  const { t, formatDateTime, formatMoney } = window.I18N;
  const { h, clear, toast, errorMessage, input, select, textarea, field, modal } = window.UI;
  const Pages = window.Pages;

  const DAY_KEYS = ['days.sun', 'days.mon', 'days.tue', 'days.wed', 'days.thu', 'days.fri', 'days.sat'];
  const DAY_ORDER = [0, 1, 2, 3, 4, 5, 6];

  const SPECIALTY_SUGGESTIONS = [
    'Médecine Générale / طب عام',
    'Cardiologie / أمراض القلب والشرايين',
    'Ophtalmologie / طب وجراحة العيون',
    'Orthopédie & Traumatologie / جراحة العظام والمفاصل',
    'Pédiatrie / طب الأطفال',
    'Gynécologie-Obstétrique / طب النساء والتوليد',
    'ORL / أنف وأذن وحنجرة',
    'Dermatologie / الأمراض الجلدية',
    'Gastro-entérologie / أمراض الجهاز الهضمي',
    'Endocrinologie-Diabétologie / السكري والغدد الصماء',
    'Pneumologie & Allergologie / الأمراض الصدرية والحساسية',
    'Neurologie / طب الأعصاب',
    'Urologie / جراحة المسالك البولية',
    'Médecine Interne / الطب الداخلي',
    'Rhumatologie / أمراض المفاصل والروماتيزم',
    'Polyclinique Multi-Spécialités / عيادة متعددة الاختصاصات',
  ];

  function switchInput(checked, onChange) {
    const toggle = h('input', { type: 'checkbox', checked });
    toggle.addEventListener('change', () => onChange(toggle.checked));
    return h('label', { class: 'switch' }, toggle, h('span', {}));
  }

  function switchRow(label, control) {
    return h('div', { class: 'switch-row' }, h('span', { class: 'strong' }, label), control);
  }

  function card(title, ...children) {
    return h('div', { class: 'card' }, h('h2', { class: 'card-title' }, title), h('div', { class: 'col' }, ...children));
  }

  function openDepartmentModal({ dept = null, onSaved } = {}) {
    const isEdit = Boolean(dept);
    const nameFr = input({ value: dept?.name_fr || '', placeholder: 'Ex. Cardiologie', autofocus: true });
    const nameAr = input({ value: dept?.name_ar || '', placeholder: 'مثال: مصلحة أمراض القلب والشرايين' });
    const specialty = input({ value: dept?.specialty || '', placeholder: 'Ex. Cardiologie & Écho-Doppler' });
    const doctorName = input({ value: dept?.doctor_name || '', placeholder: 'Ex. Dr. Kaddour Mehdi' });
    const room = input({ value: dept?.room || '', placeholder: 'Ex. Étage 1 — Salle 102' });
    const fee = input({ type: 'number', min: '0', step: '100', value: String(dept?.consultation_fee ?? 2500) });
    const cap = input({ type: 'number', min: '1', max: '200', value: String(dept?.daily_capacity ?? 15) });
    const instructions = textarea({ value: dept?.instructions || '', placeholder: t('dept.instructionsHint') });
    const err = h('div', { class: 'error-text' });

    const deptDays = new Set(
      String(dept?.working_days || window.App.settings.working_days || '0,1,2,3,4')
        .split(',')
        .filter(Boolean)
        .map(Number),
    );
    const dayBtns = DAY_ORDER.map((d) =>
      h(
        'button',
        {
          type: 'button',
          class: deptDays.has(d) ? 'on' : '',
          onClick: (ev) => {
            if (deptDays.has(d)) deptDays.delete(d);
            else deptDays.add(d);
            ev.currentTarget.classList.toggle('on', deptDays.has(d));
          },
        },
        t(DAY_KEYS[d]),
      ),
    );

    modal({
      title: isEdit ? t('dept.edit') : t('dept.add'),
      wide: true,
      body: h(
        'div',
        { class: 'col' },
        h('div', { class: 'grid two' }, field(t('dept.nameFr'), nameFr), field(t('dept.nameAr'), nameAr)),
        h('div', { class: 'grid two' }, field(t('dept.doctor'), doctorName), field(t('dept.specialty'), specialty)),
        h(
          'div',
          { class: 'grid three' },
          field(t('dept.room'), room),
          field(`${t('dept.fee')} (${window.App.settings.currency || 'DZD'})`, fee),
          field(t('dept.capacity'), cap),
        ),
        field(t('settings.workingDays'), h('div', { class: 'day-toggle' }, dayBtns)),
        field(t('dept.instructions'), instructions),
        err,
      ),
      actions: [
        { label: t('common.cancel'), kind: 'ghost' },
        {
          label: t('common.save'),
          kind: 'primary',
          onClick: async () => {
            err.textContent = '';
            try {
              const payload = {
                id: dept?.id,
                name_fr: nameFr.value.trim(),
                name_ar: nameAr.value.trim(),
                specialty: specialty.value.trim(),
                doctor_name: doctorName.value.trim(),
                room: room.value.trim(),
                consultation_fee: Number(fee.value) || 0,
                daily_capacity: Number(cap.value) || 15,
                working_days: [...deptDays].sort().join(',') || '0,1,2,3,4',
                instructions: instructions.value.trim(),
              };
              if (isEdit) await window.API.invoke('departments:update', payload);
              else await window.API.invoke('departments:create', payload);
              toast(t('common.saved'), 'ok');
              if (onSaved) onSaved();
              return true;
            } catch (e) {
              err.textContent = errorMessage(e);
              return false;
            }
          },
        },
      ],
    });
  }

  function passwordDialog() {
    const current = input({ type: 'password', placeholder: '••••••••' });
    const next = input({ type: 'password', placeholder: '••••••••' });
    const confirm = input({ type: 'password', placeholder: '••••••••' });
    const error = h('div', { class: 'error-text' });
    modal({
      title: t('settings.changePassword'),
      body: h(
        'div',
        { class: 'col' },
        field(t('auth.currentPassword'), current),
        field(t('auth.newPassword'), next),
        field(t('auth.confirmPassword'), confirm),
        error,
      ),
      actions: [
        { label: t('common.cancel'), kind: 'ghost' },
        {
          label: t('common.save'),
          kind: 'primary',
          onClick: async () => {
            error.textContent = '';
            if (next.value.length < 4) {
              error.textContent = t('auth.tooShort');
              return false;
            }
            if (next.value !== confirm.value) {
              error.textContent = t('auth.mismatch');
              return false;
            }
            try {
              await window.API.invoke('auth:change-password', {
                current: current.value,
                next: next.value,
                confirm: confirm.value,
              });
              toast(t('auth.passwordChanged'), 'ok');
              return true;
            } catch (err) {
              error.textContent = errorMessage(err);
              return false;
            }
          },
        },
      ],
    });
  }

  function bytes(size) {
    if (size > 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
    return `${Math.max(1, Math.round(size / 1024))} KB`;
  }

  Pages.settings = {
    async render(root, ctx) {
      const settings = window.App.settings;
      ctx.setHeader(t('settings.title'), t('settings.subtitle'));

      const working = new Set(String(settings.working_days || '').split(',').filter(Boolean).map(Number));

      /* --------------------- clinic & doctor identity --------------------- */
      const clinicName = input({ value: settings.clinic_name || '', placeholder: t('auth.clinicPlaceholder') });
      const doctorName = input({ value: settings.doctor_name || '', placeholder: t('settings.doctorPlaceholder') });
      const specialtyListId = 'medirdv-specialty-datalist';
      const doctorSpecialty = input({
        value: settings.doctor_specialty || '',
        placeholder: t('settings.specialtyPlaceholder'),
        list: specialtyListId,
      });
      const specialtyDatalist = h(
        'datalist',
        { id: specialtyListId },
        SPECIALTY_SUGGESTIONS.map((item) => h('option', { value: item })),
      );
      const doctorOrdre = input({ value: settings.doctor_ordre || '', placeholder: 'Ex. ALG-24819' });
      const clinicWilaya = input({ value: settings.clinic_wilaya || '', placeholder: t('settings.wilayaPlaceholder') });
      const clinicAddress = input({ value: settings.clinic_address || '' });
      const clinicPhone = input({ value: settings.clinic_phone || '', inputmode: 'tel' });
      const currency = input({ value: settings.currency || 'DZD', style: { maxWidth: '120px' } });
      const language = select([
        { value: 'fr', label: t('common.french') },
        { value: 'ar', label: t('common.arabic') },
      ], { value: window.App.language });

      /* ------------------------------- agenda ----------------------------- */
      const capacity = input({ type: 'number', min: '1', max: '200', value: settings.daily_capacity });
      const horizon = input({ type: 'number', min: '1', max: '365', value: settings.booking_horizon_days });
      const avgSession = input({ type: 'number', min: '5', max: '180', step: '5', value: settings.avg_session_minutes || '15' });
      const sameDay = input({ type: 'checkbox', checked: settings.allow_same_day_booking === '1' });
      const queueNotify = input({ type: 'checkbox', checked: settings.queue_notify_enabled !== '0' });
      const dayButtons = DAY_ORDER.map((day) =>
        h(
          'button',
          {
            type: 'button',
            class: working.has(day) ? 'on' : '',
            onClick: (event) => {
              const button = event.currentTarget;
              if (working.has(day)) working.delete(day);
              else working.add(day);
              button.classList.toggle('on', working.has(day));
            },
          },
          t(DAY_KEYS[day]),
        ),
      );

      /* ------------------------------ whatsapp ---------------------------- */
      const botLanguage = select([
        { value: 'fr', label: t('common.french') },
        { value: 'ar', label: t('common.arabic') },
      ], { value: settings.bot_language });
      const reminderEnabled = input({ type: 'checkbox', checked: settings.reminder_enabled === '1' });
      const reminderHour = input({ type: 'number', min: '0', max: '23', value: settings.reminder_hour, style: { maxWidth: '100px' } });
      const minDelay = input({ type: 'number', min: '1500', max: '60000', step: '500', value: settings.send_min_delay_ms, style: { maxWidth: '140px' } });
      const maxDelay = input({ type: 'number', min: '2000', max: '120000', step: '500', value: settings.send_max_delay_ms, style: { maxWidth: '140px' } });
      const perHour = input({ type: 'number', min: '1', max: '60', value: settings.max_replies_per_hour, style: { maxWidth: '100px' } });
      const perDay = input({ type: 'number', min: '1', max: '500', value: settings.max_replies_per_day, style: { maxWidth: '110px' } });

      /* ------------------------------- save ------------------------------- */
      const saveButton = h('button', { class: 'btn primary lg' }, '💾 ', t('common.save'));

      const save = async () => {
        try {
          const payload = {
            clinic_name: clinicName.value.trim() || 'Cabinet Médical',
            doctor_name: doctorName.value.trim(),
            doctor_specialty: doctorSpecialty.value.trim(),
            doctor_ordre: doctorOrdre.value.trim(),
            clinic_wilaya: clinicWilaya.value.trim(),
            clinic_address: clinicAddress.value.trim(),
            clinic_phone: clinicPhone.value.trim(),
            currency: currency.value.trim() || 'DZD',
            language: language.value,
            daily_capacity: capacity.value,
            booking_horizon_days: horizon.value,
            avg_session_minutes: avgSession.value,
            allow_same_day_booking: sameDay.checked ? '1' : '0',
            queue_notify_enabled: queueNotify.checked ? '1' : '0',
            working_days: [...working].sort().join(','),
            bot_language: botLanguage.value,
            reminder_enabled: reminderEnabled.checked ? '1' : '0',
            reminder_hour: reminderHour.value,
            send_min_delay_ms: minDelay.value,
            send_max_delay_ms: maxDelay.value,
            max_replies_per_hour: perHour.value,
            max_replies_per_day: perDay.value,
          };
          await window.API.invoke('settings:set', payload);
          window.App.settings = await window.API.invoke('settings:get');
          toast(t('settings.saved'), 'ok');
          if (language.value !== window.App.language) {
            window.I18N.setLanguage(language.value);
            window.App.language = language.value;
          }
          await window.App.rerender();
        } catch (error) {
          toast(errorMessage(error), 'error');
        }
      };
      saveButton.addEventListener('click', save);

      /* ------------------- departments & backups -------------------------- */
      let backups = [];
      let info = {};
      let depts = [];
      try {
        [backups, info, depts] = await Promise.all([
          window.API.invoke('backup:list').catch(() => []),
          window.API.invoke('app:info').catch(() => ({})),
          window.API.invoke('departments:list', { include_inactive: true }).catch(() => []),
        ]);
      } catch (error) {
        toast(errorMessage(error), 'error');
      }

      const activeDeptsCount = depts.filter((d) => d.active).length;

      const departmentsCard = h(
        'div',
        { class: 'card mb' },
        h(
          'div',
          { class: 'row between wrap mb-s' },
          h(
            'div',
            {},
            h('h2', { class: 'card-title', style: { margin: '0' } }, '🏥 ' + t('dept.title')),
            h('div', { class: 'muted small' }, t('dept.subtitle')),
          ),
          h(
            'div',
            { class: 'row wrap' },
            activeDeptsCount >= 2 ? h('span', { class: 'badge ok' }, t('dept.waBadge', { n: activeDeptsCount })) : null,
            h(
              'button',
              {
                type: 'button',
                class: 'btn primary',
                onClick: () => openDepartmentModal({ onSaved: () => ctx.refresh() }),
              },
              '＋ ',
              t('dept.add'),
            ),
          ),
        ),
        depts.length === 0
          ? h('div', { class: 'muted small', style: { padding: '8px 0' } }, t('dept.empty'))
          : h(
              'div',
              { class: 'table-wrap mt-s' },
              h(
                'table',
                { class: 'list' },
                h(
                  'thead',
                  {},
                  h(
                    'tr',
                    {},
                    h('th', {}, t('dept.select')),
                    h('th', {}, t('dept.doctor')),
                    h('th', {}, t('dept.room')),
                    h('th', { class: 'num' }, t('dept.fee')),
                    h('th', { class: 'num' }, t('dept.capacity')),
                    h('th', {}, t('common.status')),
                    h('th', { class: 'actions' }, ''),
                  ),
                ),
                h(
                  'tbody',
                  {},
                  depts.map((d) =>
                    h(
                      'tr',
                      {},
                      h(
                        'td',
                        {},
                        h('div', { class: 'strong' }, window.App.language === 'ar' ? d.name_ar || d.name_fr : d.name_fr),
                        h('div', { class: 'small muted' }, d.specialty || (window.App.language === 'ar' ? d.name_fr : d.name_ar) || ''),
                      ),
                      h('td', {}, d.doctor_name || '—'),
                      h('td', { class: 'small' }, d.room || '—'),
                      h('td', { class: 'num' }, formatMoney(d.consultation_fee, settings.currency || 'DZD')),
                      h('td', { class: 'num' }, String(d.daily_capacity)),
                      h(
                        'td',
                        {},
                        switchInput(Boolean(d.active), async (checked) => {
                          await window.API.invoke('departments:update', { id: d.id, active: checked ? 1 : 0 });
                          ctx.refresh();
                        }),
                      ),
                      h(
                        'td',
                        { class: 'actions' },
                        h(
                          'button',
                          {
                            class: 'btn icon sm',
                            title: t('common.edit'),
                            onClick: () => openDepartmentModal({ dept: d, onSaved: () => ctx.refresh() }),
                          },
                          '✏️',
                        ),
                        h(
                          'button',
                          {
                            class: 'btn icon sm ghost',
                            title: t('common.delete'),
                            onClick: async () => {
                              const ok = await window.UI.confirmDialog(
                                t('dept.deleteConfirm', { name: window.App.language === 'ar' ? d.name_ar || d.name_fr : d.name_fr }),
                              );
                              if (!ok) return;
                              await window.API.invoke('departments:remove', { id: d.id });
                              toast(t('common.deleted'), 'ok');
                              ctx.refresh();
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

      const backupAuto = switchInput(settings.backup_enabled === '1', async (checked) => {
        try {
          await window.API.invoke('settings:set', { backup_enabled: checked ? '1' : '0' });
          window.App.settings.backup_enabled = checked ? '1' : '0';
          toast(t('common.saved'), 'ok');
        } catch (error) {
          toast(errorMessage(error), 'error');
        }
      });

      const backupTable = h(
        'div',
        { class: 'table-wrap mt-s' },
        backups.length === 0
          ? h('div', { class: 'muted small' }, t('settings.noBackups'))
          : h(
              'table',
              { class: 'list' },
              h('thead', {}, h('tr', {}, h('th', {}, t('common.date')), h('th', {}, 'Taille'), h('th', { class: 'actions' }, ''))),
              h(
                'tbody',
                {},
                backups.map((entry) =>
                  h(
                    'tr',
                    {},
                    h('td', { class: 'small' }, formatDateTime(entry.created_at.slice(0, 19).replace('T', ' '))),
                    h('td', { class: 'small' }, bytes(entry.size)),
                    h(
                      'td',
                      { class: 'actions' },
                      h(
                        'button',
                        {
                          class: 'btn sm',
                          onClick: async () => {
                            const ok = await window.UI.confirmDialog(t('settings.restoreConfirm'));
                            if (!ok) return;
                            try {
                              await window.API.invoke('backup:restore', { file: entry.path });
                              toast(t('settings.restoreDone'), 'ok');
                            } catch (error) {
                              toast(errorMessage(error), 'error');
                            }
                          },
                        },
                        '↩️ ' + t('settings.restore'),
                      ),
                    ),
                  ),
                ),
              ),
            ),
      );

      const backupActions = h(
        'div',
        { class: 'row wrap mt-s' },
        h(
          'button',
          {
            class: 'btn primary',
            onClick: async (event) => {
              const button = event.currentTarget;
              button.disabled = true;
              try {
                await window.API.invoke('backup:create');
                toast(t('settings.backupDone'), 'ok');
                ctx.refresh();
              } catch (error) {
                toast(errorMessage(error), 'error');
              } finally {
                button.disabled = false;
              }
            },
          },
          '💾 ', t('settings.backupNow'),
        ),
        h(
          'button',
          {
            class: 'btn',
            onClick: async () => {
              try {
                const result = await window.API.invoke('backup:export');
                if (result?.ok) toast(t('settings.backupDone'), 'ok');
              } catch (error) {
                toast(errorMessage(error), 'error');
              }
            },
          },
          '📤 ', t('settings.export'),
        ),
        h(
          'button',
          {
            class: 'btn',
            onClick: async () => {
              const ok = await window.UI.confirmDialog(t('settings.restoreConfirm'));
              if (!ok) return;
              try {
                const result = await window.API.invoke('backup:restore-dialog');
                if (result?.canceled) return;
                toast(t('settings.restoreDone'), 'ok');
              } catch (error) {
                toast(errorMessage(error), 'error');
              }
            },
          },
          '↩️ ', t('settings.restore'),
        ),
        h('button', { class: 'btn ghost', onClick: () => window.API.invoke('backup:reveal') }, '📂 ', t('settings.openFolder')),
      );

      /* ------------------------------- render ----------------------------- */
      clear(root).append(
        specialtyDatalist,
        h(
          'div',
          { class: 'row between mb' },
          h('span', { class: 'muted small' }, t('settings.offline')),
          saveButton,
        ),
        departmentsCard,
        h(
          'div',
          { class: 'grid two', alignItems: 'start' },
          card(
            t('settings.clinic'),
            field(t('settings.clinicName'), clinicName),
            h('div', { class: 'grid two' }, field(t('settings.doctorName'), doctorName), field(t('settings.doctorSpecialty'), doctorSpecialty)),
            h('div', { class: 'grid two' }, field(t('settings.wilaya'), clinicWilaya), field(t('settings.doctorOrdre'), doctorOrdre)),
            field(t('settings.address'), clinicAddress),
            h('div', { class: 'grid two' }, field(t('settings.phone'), clinicPhone), field(t('settings.currency'), currency)),
            field(t('settings.language'), language),
            h('div', { class: 'muted small' }, '🖨️ ' + t('settings.ordonnanceNote')),
          ),
          card(
            t('settings.agenda'),
            h('div', { class: 'grid two' }, field(t('settings.capacity'), capacity), field(t('settings.horizon'), horizon)),
            field(t('settings.avgSession'), avgSession, t('settings.avgSessionHint')),
            field(t('settings.workingDays'), h('div', { class: 'day-toggle' }, dayButtons)),
            switchRow(t('settings.sameDay'), h('label', { class: 'switch' }, sameDay, h('span', {}))),
            switchRow(t('settings.queueNotify'), h('label', { class: 'switch' }, queueNotify, h('span', {}))),
          ),
          card(
            t('settings.whatsapp'),
            field(t('wa.botLanguage'), botLanguage),
            switchRow(t('settings.reminderEnabled'), h('label', { class: 'switch' }, reminderEnabled, h('span', {}))),
            field(t('settings.reminderHour'), reminderHour),
            h('div', { class: 'muted small' }, t('settings.reminderNote')),
            h('h3', { style: { margin: '10px 0 0', fontSize: '0.95rem' } }, t('settings.antiban')),
            h('div', { class: 'grid two' }, field(t('settings.minDelay'), minDelay), field(t('settings.maxDelay'), maxDelay)),
            h('div', { class: 'grid two' }, field(t('settings.maxPerHour'), perHour), field(t('settings.maxPerDay'), perDay)),
          ),
          h(
            'div',
            { class: 'col' },
            card(
              t('settings.backups'),
              switchRow(t('settings.backupEnabled'), backupAuto),
              h('div', { class: 'muted small' }, t('settings.backupHint')),
              h('div', { class: 'info-line' }, h('span', { class: 'k' }, t('settings.lastBackup')), h('strong', {}, settings.last_backup_at ? formatDateTime(settings.last_backup_at) : '—')),
              backupActions,
              backupTable,
            ),
            card(
              t('settings.interface'),
              switchRow(
                t('settings.sounds'),
                (() => {
                  const box = h('input', { type: 'checkbox', checked: window.SFX ? window.SFX.isEnabled() : false });
                  box.addEventListener('change', () => {
                    window.SFX.setEnabled(box.checked);
                    toast(t('common.saved'), 'ok');
                  });
                  return h('label', { class: 'switch' }, box, h('span', {}));
                })(),
              ),
              h('div', { class: 'muted small' }, t('settings.soundsHint')),
              h(
                'button',
                {
                  class: 'btn mt-s',
                  onClick: () => {
                    if (window.SFX) window.SFX.success();
                  },
                },
                window.Icons ? window.Icons.el('bell', { size: 17 }) : '🔔',
                h('span', {}, t('settings.testSound')),
              ),
            ),
            card(
              t('settings.security'),
              (() => {
                const button = h('button', { class: 'btn', onClick: passwordDialog }, t('settings.changePassword'));
                if (window.Icons) window.Icons.decorate(button, 'lock', { size: 17 });
                return button;
              })(),
            ),
            card(
              t('settings.about'),
              h('div', { class: 'info-line' }, h('span', { class: 'k' }, t('settings.version')), h('strong', {}, window.App.version)),
              h('div', { class: 'info-line' }, h('span', { class: 'k' }, t('settings.dataLocation')), h('span', { class: 'small', style: { wordBreak: 'break-all' } }, info.dataDir || '—')),
              info.logFile
                ? h('div', { class: 'info-line' }, h('span', { class: 'k' }, t('settings.logFile')), h('span', { class: 'small', style: { wordBreak: 'break-all' } }, info.logFile))
                : null,
              h('button', { class: 'btn ghost sm', onClick: () => window.API.invoke('app:open-data-folder') }, '📂 ', t('settings.openFolder')),
              h('div', { class: 'muted small mt-s' }, 'MediRDV — ' + t('app.tagline')),
            ),
          ),
        ),
      );
    },
  };
})();
