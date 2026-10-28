/* Settings: clinic, agenda, WhatsApp limits, backups, security. */
(function () {
  'use strict';
  const { t, formatDateTime } = window.I18N;
  const { h, clear, toast, errorMessage, input, select, field, modal } = window.UI;
  const Pages = window.Pages;

  const DAY_KEYS = ['days.sun', 'days.mon', 'days.tue', 'days.wed', 'days.thu', 'days.fri', 'days.sat'];
  const DAY_ORDER = [0, 1, 2, 3, 4, 5, 6];

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

      /* ------------------------------ clinic ------------------------------ */
      const clinicName = input({ value: settings.clinic_name || '' });
      const clinicPhone = input({ value: settings.clinic_phone || '', inputmode: 'tel' });
      const clinicAddress = input({ value: settings.clinic_address || '' });
      const doctorName = input({ value: settings.doctor_name || '', placeholder: 'Dr. …' });
      const doctorSpecialty = input({ value: settings.doctor_specialty || 'Chirurgien-Dentiste' });
      const doctorOrdre = input({ value: settings.doctor_ordre || '', placeholder: 'OMD-…' });
      const currency = input({ value: settings.currency || 'DZD', style: { maxWidth: '120px' } });
      const language = select([
        { value: 'fr', label: t('common.french') },
        { value: 'ar', label: t('common.arabic') },
      ], { value: window.App.language });

      /* ------------------------------- agenda ----------------------------- */
      const capacity = input({ type: 'number', min: '1', max: '500', value: settings.daily_capacity });
      const horizon = input({ type: 'number', min: '1', max: '365', value: settings.booking_horizon_days });
      const avgSession = input({ type: 'number', min: '5', max: '180', step: '5', value: settings.avg_session_minutes || '20' });
      const sameDay = input({ type: 'checkbox', checked: settings.allow_same_day_booking === '1' });
      const queueNotify = input({ type: 'checkbox', checked: settings.queue_notify_enabled !== '0' });
      const clinic24h = input({ type: 'checkbox', checked: settings.clinic_24h_enabled === '1' });
      const workStartHour = input({ type: 'time', value: settings.work_start_hour || '08:00' });
      const workEndHour = input({ type: 'time', value: settings.work_end_hour || '17:00' });
      const twoShiftsToggle = input({ type: 'checkbox', checked: settings.two_shifts_enabled === '1' });
      const shift2StartHour = input({ type: 'time', value: settings.shift2_start_hour || '21:00' });
      const shift2EndHour = input({ type: 'time', value: settings.shift2_end_hour || '00:00' });
      const breakToggle = input({ type: 'checkbox', checked: settings.break_enabled === '1' });
      const breakStartHour = input({ type: 'time', value: settings.break_start_hour || '12:30' });
      const breakEndHour = input({ type: 'time', value: settings.break_end_hour || '13:30' });

      const parseMins = (hhmm, fb = 0) => {
        const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})$/);
        if (!m) return fb;
        return Number.parseInt(m[1], 10) * 60 + Number.parseInt(m[2], 10);
      };
      const calcSpanMins = (sVal, eVal) => {
        const s = parseMins(sVal, 480);
        const eRaw = parseMins(eVal, 1020);
        const e = eRaw <= s ? eRaw + 1440 : eRaw;
        return Math.max(0, e - s);
      };
      const addMinsHHMM = (sVal, deltaMins) => {
        const tot = (((parseMins(sVal, 480) + Math.round(Number(deltaMins) || 0)) % 1440) + 1440) % 1440;
        return `${String(Math.floor(tot / 60)).padStart(2, '0')}:${String(tot % 60).padStart(2, '0')}`;
      };
      const calcOverlapMins = (aS, aE, bS, bE) => {
        const as = parseMins(aS, 0);
        const aeRaw = parseMins(aE, 0);
        const ae = aeRaw <= as ? aeRaw + 1440 : aeRaw;
        const bs0 = parseMins(bS, 0);
        const be0Raw = parseMins(bE, 0);
        const be0 = be0Raw <= bs0 ? be0Raw + 1440 : be0Raw;
        let tot = 0;
        for (const off of [0, 1440]) {
          const lo = Math.max(as, bs0 + off);
          const hi = Math.min(ae, be0 + off);
          if (hi > lo) tot += hi - lo;
        }
        return tot;
      };
      const fmtHours = (mins) => String(Math.round((mins / 60) * 100) / 100);

      const shift1HoursInput = input({
        type: 'number',
        min: '0.5',
        max: '24',
        step: '0.5',
        value: fmtHours(calcSpanMins(workStartHour.value, workEndHour.value)),
      });
      const shift2HoursInput = input({
        type: 'number',
        min: '0.5',
        max: '24',
        step: '0.5',
        value: fmtHours(calcSpanMins(shift2StartHour.value, shift2EndHour.value)),
      });

      const netHoursBadge = h(
        'div',
        {
          dataset: { role: 'net-hours-summary' },
          class: 'small',
          style: {
            padding: '8px 10px',
            borderRadius: '8px',
            background: 'rgba(14, 165, 233, 0.1)',
            color: '#0369a1',
            fontWeight: '700',
          },
        },
        '',
      );

      const refreshScheduleCalculations = () => {
        const s1 = calcSpanMins(workStartHour.value, workEndHour.value);
        const s2 = twoShiftsToggle.checked ? calcSpanMins(shift2StartHour.value, shift2EndHour.value) : 0;
        const gross = s1 + s2;
        const deducted = breakToggle.checked
          ? calcOverlapMins(workStartHour.value, workEndHour.value, breakStartHour.value, breakEndHour.value) +
            (twoShiftsToggle.checked
              ? calcOverlapMins(shift2StartHour.value, shift2EndHour.value, breakStartHour.value, breakEndHour.value)
              : 0)
          : 0;
        const net = Math.max(0, gross - deducted);
        netHoursBadge.textContent =
          '⏱️ ' +
          (breakToggle.checked
            ? t('settings.netHoursSummary', { net: fmtHours(net), gross: fmtHours(gross), brk: deducted })
            : t('settings.netHoursSummaryNoBreak', { net: fmtHours(net) }));
      };

      workStartHour.addEventListener('change', () => {
        shift1HoursInput.value = fmtHours(calcSpanMins(workStartHour.value, workEndHour.value));
        refreshScheduleCalculations();
      });
      workEndHour.addEventListener('change', () => {
        shift1HoursInput.value = fmtHours(calcSpanMins(workStartHour.value, workEndHour.value));
        refreshScheduleCalculations();
      });
      shift1HoursInput.addEventListener('input', () => {
        const hrs = Number.parseFloat(shift1HoursInput.value);
        if (Number.isFinite(hrs) && hrs > 0 && hrs <= 24) {
          workEndHour.value = addMinsHHMM(workStartHour.value || '08:00', hrs * 60);
          refreshScheduleCalculations();
        }
      });

      shift2StartHour.addEventListener('change', () => {
        shift2HoursInput.value = fmtHours(calcSpanMins(shift2StartHour.value, shift2EndHour.value));
        refreshScheduleCalculations();
      });
      shift2EndHour.addEventListener('change', () => {
        shift2HoursInput.value = fmtHours(calcSpanMins(shift2StartHour.value, shift2EndHour.value));
        refreshScheduleCalculations();
      });
      shift2HoursInput.addEventListener('input', () => {
        const hrs = Number.parseFloat(shift2HoursInput.value);
        if (Number.isFinite(hrs) && hrs > 0 && hrs <= 24) {
          shift2EndHour.value = addMinsHHMM(shift2StartHour.value || '21:00', hrs * 60);
          refreshScheduleCalculations();
        }
      });

      breakStartHour.addEventListener('change', refreshScheduleCalculations);
      breakEndHour.addEventListener('change', refreshScheduleCalculations);

      const shift2Box = h(
        'div',
        {
          class: 'col',
          style: {
            display: twoShiftsToggle.checked ? 'flex' : 'none',
            gap: '8px',
            padding: '10px',
            borderRadius: '8px',
            border: '1px dashed var(--border, #cbd5e1)',
          },
        },
        h(
          'div',
          { class: 'row between wrap' },
          h('strong', { class: 'small' }, '🌙 ' + t('settings.shift2Title')),
          h(
            'button',
            {
              type: 'button',
              class: 'btn sm soft',
              onClick: () => {
                workStartHour.value = '08:00';
                workEndHour.value = '17:00';
                shift1HoursInput.value = '9';
                twoShiftsToggle.checked = true;
                shift2StartHour.value = '21:00';
                shift2EndHour.value = '00:00';
                shift2HoursInput.value = '3';
                shift2Box.style.display = 'flex';
                refreshScheduleCalculations();
              },
            },
            '⚡ ' + t('settings.shift2PresetBtn'),
          ),
        ),
        h(
          'div',
          { class: 'grid', style: { gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '8px' } },
          field(t('settings.openAt'), shift2StartHour),
          field(t('settings.closeAt'), shift2EndHour),
          field(t('settings.hoursDuration'), shift2HoursInput),
        ),
      );

      twoShiftsToggle.addEventListener('change', () => {
        shift2Box.style.display = twoShiftsToggle.checked ? 'flex' : 'none';
        refreshScheduleCalculations();
      });

      const breakBox = h(
        'div',
        {
          class: 'grid two',
          style: { display: breakToggle.checked ? 'grid' : 'none' },
        },
        field(t('settings.breakFrom'), breakStartHour),
        field(t('settings.breakTo'), breakEndHour),
      );
      breakToggle.addEventListener('change', () => {
        breakBox.style.display = breakToggle.checked ? 'grid' : 'none';
        refreshScheduleCalculations();
      });

      refreshScheduleCalculations();

      const hoursBox = h(
        'div',
        {
          class: 'col',
          style: { display: clinic24h.checked ? 'none' : 'flex', gap: '10px' },
        },
        h('h3', { style: { margin: '4px 0 0', fontSize: '0.95rem' } }, '🕒 ' + t('settings.workHoursTitle')),
        netHoursBadge,
        h('strong', { class: 'small' }, '☀️ ' + t('settings.shift1Title')),
        h(
          'div',
          { class: 'grid', style: { gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '8px' } },
          field(t('settings.openAt'), workStartHour),
          field(t('settings.closeAt'), workEndHour),
          field(t('settings.hoursDuration'), shift1HoursInput),
        ),
        switchRow(t('settings.twoShiftsToggle'), h('label', { class: 'switch' }, twoShiftsToggle, h('span', {}))),
        shift2Box,
        switchRow(t('settings.doctorBreakToggle'), h('label', { class: 'switch' }, breakToggle, h('span', {}))),
        breakBox,
      );
      const badge24hHint = h(
        'div',
        {
          class: 'small',
          style: {
            display: clinic24h.checked ? 'block' : 'none',
            padding: '8px 10px',
            borderRadius: '8px',
            background: 'rgba(16, 185, 129, 0.12)',
            color: '#0f766e',
            fontWeight: '600',
          },
        },
        '🕒 ' + t('settings.clinic24hActiveHint'),
      );

      const dayButtons = DAY_ORDER.map((day) =>
        h(
          'button',
          {
            type: 'button',
            dataset: { dayIndex: String(day) },
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

      const activateAll7DaysBtn = h(
        'button',
        {
          type: 'button',
          class: 'btn sm soft',
          onClick: () => {
            DAY_ORDER.forEach((d) => working.add(d));
            dayButtons.forEach((btn) => btn.classList.add('on'));
          },
        },
        '⚡ ' + t('settings.selectAll7Days'),
      );

      clinic24h.addEventListener('change', () => {
        hoursBox.style.display = clinic24h.checked ? 'none' : 'flex';
        badge24hHint.style.display = clinic24h.checked ? 'block' : 'none';
        if (clinic24h.checked) {
          sameDay.checked = true;
          DAY_ORDER.forEach((d) => working.add(d));
          dayButtons.forEach((btn) => btn.classList.add('on'));
        }
      });

      /* ------------------------------ whatsapp ---------------------------- */
      const botLanguage = select([
        { value: 'fr', label: t('common.french') },
        { value: 'ar', label: t('common.arabic') },
      ], { value: settings.bot_language });
      const botDarija = input({ type: 'checkbox', checked: settings.bot_darija_mode === '1' });
      const botChooseDay = input({ type: 'checkbox', checked: settings.bot_choose_day_enabled !== '0' });
      const intakeEnabled = input({ type: 'checkbox', checked: settings.intake_enabled !== '0' });
      const autostartEnabled = input({ type: 'checkbox', checked: settings.autostart_enabled !== '0' });
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
            clinic_name: clinicName.value.trim() || 'Cabinet Dentaire',
            clinic_phone: clinicPhone.value.trim(),
            clinic_address: clinicAddress.value.trim(),
            doctor_name: doctorName.value.trim(),
            doctor_specialty: doctorSpecialty.value.trim() || 'Chirurgien-Dentiste',
            doctor_ordre: doctorOrdre.value.trim(),
            currency: currency.value.trim() || 'DZD',
            language: language.value,
            daily_capacity: capacity.value,
            booking_horizon_days: horizon.value,
            avg_session_minutes: avgSession.value,
            clinic_24h_enabled: clinic24h.checked ? '1' : '0',
            work_start_hour: workStartHour.value || '08:00',
            work_end_hour: workEndHour.value || '17:00',
            two_shifts_enabled: twoShiftsToggle.checked ? '1' : '0',
            shift2_start_hour: shift2StartHour.value || '21:00',
            shift2_end_hour: shift2EndHour.value || '00:00',
            break_enabled: breakToggle.checked ? '1' : '0',
            break_start_hour: breakStartHour.value || '12:30',
            break_end_hour: breakEndHour.value || '13:30',
            allow_same_day_booking: sameDay.checked ? '1' : '0',
            queue_notify_enabled: queueNotify.checked ? '1' : '0',
            working_days: [...working].sort().join(','),
            bot_language: botLanguage.value,
            bot_darija_mode: botDarija.checked ? '1' : '0',
            bot_choose_day_enabled: botChooseDay.checked ? '1' : '0',
            intake_enabled: intakeEnabled.checked ? '1' : '0',
            autostart_enabled: autostartEnabled.checked ? '1' : '0',
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
            await window.App.rerender();
          } else {
            ctx.refresh();
          }
        } catch (error) {
          toast(errorMessage(error), 'error');
        }
      };
      saveButton.addEventListener('click', save);

      /* ------------------------------ backups ----------------------------- */
      let backups = [];
      let info = {};
      let medSummary = null;
      let licStatus = null;
      let holidayList = [];
      try {
        [backups, info, medSummary, licStatus, holidayList] = await Promise.all([
          window.API.invoke('backup:list').catch(() => []),
          window.API.invoke('app:info').catch(() => ({})),
          window.API.invoke('nomenclature:summary').catch(() => null),
          window.API.invoke('license:status').catch(() => null),
          window.API.invoke('holidays:list', { includePast: false }).catch(() => []),
        ]);
      } catch (error) {
        toast(errorMessage(error), 'error');
      }

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
        h(
          'div',
          { class: 'row between mb' },
          h('span', { class: 'muted small' }, t('settings.offline')),
          saveButton,
        ),
        h(
          'div',
          { class: 'grid two', alignItems: 'start' },
          card(
            t('settings.clinic'),
            field(t('settings.clinicName'), clinicName),
            h('div', { class: 'grid two' }, field(t('settings.phone'), clinicPhone), field(t('settings.currency'), currency)),
            field(t('settings.address'), clinicAddress),
            field(t('settings.language'), language),
            h('h3', { style: { margin: '10px 0 0', fontSize: '0.95rem' } }, t('settings.doctorSection')),
            field(t('settings.doctorName'), doctorName),
            h('div', { class: 'grid two' }, field(t('settings.doctorSpecialty'), doctorSpecialty), field(t('settings.doctorOrdre'), doctorOrdre)),
          ),
          h(
            'div',
            { class: 'col' },
            card(
              t('settings.agenda'),
              switchRow(t('settings.clinic24h'), h('label', { class: 'switch' }, clinic24h, h('span', {}))),
              badge24hHint,
              hoursBox,
              h('div', { class: 'grid two' }, field(t('settings.capacity'), capacity), field(t('settings.horizon'), horizon)),
              field(t('settings.avgSession'), avgSession, t('settings.avgSessionHint')),
              field(
                t('settings.workingDays'),
                h('div', { class: 'col', style: { gap: '8px' } }, h('div', { class: 'day-toggle' }, dayButtons), h('div', {}, activateAll7DaysBtn)),
              ),
              switchRow(t('settings.sameDay'), h('label', { class: 'switch' }, sameDay, h('span', {}))),
              switchRow(t('settings.queueNotify'), h('label', { class: 'switch' }, queueNotify, h('span', {}))),
            ),
            card(
              t('holidays.title'),
              h('div', { class: 'muted small' }, t('holidays.subtitle')),
              h(
                'div',
                { class: 'row between wrap mt-s' },
                h(
                  'button',
                  {
                    type: 'button',
                    class: 'btn soft',
                    onClick: () =>
                      window.Components.openHolidayModal({
                        onSaved: () => ctx.refresh(),
                      }),
                  },
                  '🏖️ ',
                  t('holidays.addBtn'),
                ),
              ),
              holidayList.length === 0
                ? h('div', { class: 'muted small mt-s' }, t('holidays.empty'))
                : h(
                    'div',
                    { class: 'col mt-s', style: { gap: '8px' } },
                    holidayList.map((item) => {
                      const reasonBadge =
                        item.reason_type === 'sick'
                          ? h('span', { class: 'badge warn' }, '🩺 ' + t('holidays.reasonSick'))
                          : item.reason_type === 'other'
                            ? h('span', { class: 'badge gray' }, '🔒 ' + t('holidays.reasonOther'))
                            : h('span', { class: 'badge info' }, '🏖️ ' + t('holidays.reasonVacation'));
                      const dateText = item.is_single_day
                        ? t('holidays.singleDayLabel', { day: window.I18N.formatDate(item.start_day) })
                        : t('holidays.rangeLabel', {
                            start: window.I18N.formatDate(item.start_day),
                            end: window.I18N.formatDate(item.end_day),
                          });
                      return h(
                        'div',
                        {
                          class: 'row between wrap',
                          style: {
                            padding: '8px 10px',
                            border: '1px solid var(--border, #e2e8f0)',
                            borderRadius: '8px',
                            gap: '8px',
                          },
                        },
                        h(
                          'div',
                          { class: 'col', style: { gap: '4px' } },
                          h(
                            'div',
                            { class: 'row wrap', style: { gap: '6px' } },
                            reasonBadge,
                            h('strong', {}, dateText),
                            item.block_all_wa
                              ? h('span', { class: 'badge warn' }, '📵 WhatsApp')
                              : null,
                            item.booked_conflicts > 0
                              ? h(
                                  'button',
                                  {
                                    type: 'button',
                                    class: 'badge danger',
                                    style: { border: 'none', cursor: 'pointer' },
                                    onClick: () => {
                                      window.App.day = item.start_day;
                                      window.App.navigate('agenda');
                                    },
                                  },
                                  '⚠️ ' + t('holidays.conflictsWarn', { n: item.booked_conflicts }),
                                )
                              : null,
                          ),
                          item.label ? h('div', { class: 'muted small' }, item.label) : null,
                        ),
                        h(
                          'button',
                          {
                            type: 'button',
                            class: 'btn icon sm',
                            title: t('common.delete'),
                            onClick: async () => {
                              try {
                                await window.API.invoke('holidays:remove', { id: item.id });
                                toast(t('holidays.removed'), 'ok');
                                ctx.refresh();
                              } catch (err) {
                                toast(errorMessage(err), 'error');
                              }
                            },
                          },
                          '🗑️',
                        ),
                      );
                    }),
                  ),
            ),
          ),
          card(
            t('settings.whatsapp'),
            field(t('wa.botLanguage'), botLanguage),
            switchRow(t('settings.botChooseDay'), h('label', { class: 'switch' }, botChooseDay, h('span', {}))),
            switchRow(t('settings.botDarija'), h('label', { class: 'switch' }, botDarija, h('span', {}))),
            switchRow(t('settings.intakeEnabled'), h('label', { class: 'switch' }, intakeEnabled, h('span', {}))),
            switchRow(t('settings.autostart'), h('label', { class: 'switch' }, autostartEnabled, h('span', {}))),
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
              t('settings.dentalCatalogTitle'),
              h('div', { class: 'muted small' }, t('settings.dentalCatalogDesc')),
              h(
                'div',
                { class: 'info-line' },
                h('span', { class: 'k' }, t('rx.dentalOnlyBadge', { n: medSummary?.total || 620 })),
                h('strong', {}, '✓'),
              ),
            ),
            card(
              t('lic.title'),
              h(
                'div',
                { class: 'info-line' },
                h('span', { class: 'k' }, t('lic.machineCode')),
                h('strong', { style: { fontFamily: 'monospace' }, dir: 'ltr' }, licStatus?.machineCode || '—'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  class: 'btn soft',
                  onClick: () => window.Components?.openLicenseModal({}),
                },
                window.Icons ? window.Icons.el('key', { size: 17 }) : '',
                ' ',
                t('lic.activateBtn'),
              ),
            ),
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
              h('div', { class: 'muted small mt-s' }, 'DentaRDV — ' + t('app.tagline')),
            ),
          ),
        ),
      );
    },
  };
})();
