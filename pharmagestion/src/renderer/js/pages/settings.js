/* Settings and backups — the only Phase 1 screen that writes data.
 *
 * Everything here is deliberately explicit: each group has its own Save button,
 * errors are shown in the selected language, and destructive actions (restore)
 * always ask for confirmation and create a safety copy first.
 */
(function () {
  'use strict';

  const { h, toast } = window.UI;
  const { t } = window.I18N;
  const Pages = window.Pages;

  function saveButton(label) {
    return window.UI.button(label || t('common.save'), { type: 'submit', icon: 'check' });
  }

  function section(title, icon, body, subtitle) {
    return window.UI.card({ title, icon, subtitle, body });
  }

  async function persist(values, button, onDone) {
    await window.UI.busy(button, async () => {
      try {
        const all = await window.API.invoke('settings:set', { values });
        if (window.App) window.App.settings = all;
        toast(t('settings.savedOk'), 'success');
        if (typeof onDone === 'function') await onDone(all);
      } catch (error) {
        toast(window.UI.errorMessage(error), 'error', 7000);
      }
    });
  }

  function identityCard(settings, ctx) {
    const name = window.UI.input({
      value: settings.pharmacy_name,
      placeholder: t('settings.pharmacyNamePlaceholder'),
      maxlength: 120,
      id: 'set-pharmacy-name',
    });
    const pharmacist = window.UI.input({
      value: settings.pharmacist_name,
      placeholder: t('settings.pharmacistPlaceholder'),
      maxlength: 120,
      id: 'set-pharmacist',
    });
    const phone = window.UI.input({
      value: settings.pharmacy_phone,
      placeholder: t('settings.phonePlaceholder'),
      maxlength: 40,
      type: 'tel',
      dir: 'ltr',
      id: 'set-phone',
    });
    const address = window.UI.input({
      value: settings.pharmacy_address,
      placeholder: t('settings.addressPlaceholder'),
      maxlength: 240,
      id: 'set-address',
    });

    const form = h(
      'form',
      {
        class: 'form',
        onSubmit: async (event) => {
          event.preventDefault();
          await persist(
            {
              pharmacy_name: name.value,
              pharmacist_name: pharmacist.value,
              pharmacy_phone: phone.value,
              pharmacy_address: address.value,
            },
            event.submitter,
            async () => renderPage(ctx),
          );
        },
      },
      h(
        'div',
        { class: 'form-grid' },
        window.UI.field(t('settings.pharmacyName'), name),
        window.UI.field(t('settings.pharmacistName'), pharmacist, null, { className: 'optional' }),
        window.UI.field(t('settings.phone'), phone),
        window.UI.field(t('settings.address'), address),
      ),
      h('div', { class: 'form-actions' }, saveButton()),
    );

    return section(
      t('settings.identity'),
      'shield',
      form,
      t('settings.identityHint'),
    );
  }

  function languageCard(ctx) {
    const current = window.I18N.getLanguage();
    const make = (code, label, dirLabel) =>
      h(
        'button',
        {
          type: 'button',
          class: `lang-option${current === code ? ' is-active' : ''}`,
          'aria-pressed': current === code ? 'true' : 'false',
          onClick: async () => {
            if (current === code) return;
            await window.AppNav.switchLanguage(code);
          },
        },
        h('span', { class: 'lang-option-label', dir: code === 'ar' ? 'rtl' : 'ltr' }, label),
        h('span', { class: 'lang-option-dir' }, dirLabel),
      );

    return section(
      t('settings.languageSection'),
      'globe',
      h(
        'div',
        { class: 'lang-options' },
        make('fr', 'Français', 'LTR'),
        make('ar', 'العربية', 'RTL'),
        h('p', { class: 'field-hint' }, t('settings.languageHint')),
      ),
    );
  }

  function alertsCard(settings, ctx) {
    const first = window.UI.input({ type: 'number', min: 1, max: 3650, value: settings.expiry_threshold_1 });
    const second = window.UI.input({ type: 'number', min: 1, max: 3650, value: settings.expiry_threshold_2 });
    const third = window.UI.input({ type: 'number', min: 1, max: 3650, value: settings.expiry_threshold_3 });
    const lowStock = window.UI.input({ type: 'number', min: 0, max: 100000, value: settings.low_stock_threshold });
    const allowNegative = window.UI.checkbox(t('settings.allowNegative'), settings.allow_negative_stock);

    const form = h(
      'form',
      {
        class: 'form',
        onSubmit: async (event) => {
          event.preventDefault();
          await persist(
            {
              expiry_threshold_1: Number(first.value),
              expiry_threshold_2: Number(second.value),
              expiry_threshold_3: Number(third.value),
              low_stock_threshold: Number(lowStock.value),
              allow_negative_stock: allowNegative.input.checked,
            },
            event.submitter,
            async () => renderPage(ctx),
          );
        },
      },
      h(
        'div',
        { class: 'form-grid form-grid-3' },
        window.UI.field(t('settings.threshold1'), first),
        window.UI.field(t('settings.threshold2'), second),
        window.UI.field(t('settings.threshold3'), third),
      ),
      h('p', { class: 'field-hint' }, t('settings.expiryHint')),
      h(
        'div',
        { class: 'form-grid' },
        window.UI.field(t('settings.lowStock'), lowStock),
      ),
      h(
        'div',
        { class: 'stack-tight' },
        allowNegative,
        h('p', { class: 'field-hint' }, t('settings.allowNegativeHint')),
      ),
      h('div', { class: 'form-actions' }, saveButton()),
    );

    return section(t('settings.expirySection'), 'clock', form);
  }

  function backupPolicyCard(settings, ctx) {
    const enabled = window.UI.checkbox(t('settings.backupEnabled'), settings.backup_enabled);
    const keep = window.UI.input({ type: 'number', min: 1, max: 365, value: settings.backup_keep });

    const form = h(
      'form',
      {
        class: 'form',
        onSubmit: async (event) => {
          event.preventDefault();
          await persist(
            {
              backup_enabled: enabled.input.checked,
              backup_keep: Number(keep.value),
            },
            event.submitter,
            async () => renderPage(ctx),
          );
        },
      },
      h(
        'div',
        { class: 'stack-tight' },
        enabled,
        h('p', { class: 'field-hint' }, t('settings.backupEnabledHint')),
      ),
      h('div', { class: 'form-grid' }, window.UI.field(t('settings.backupKeep'), keep)),
      h('div', { class: 'form-actions' }, saveButton()),
    );

    return section(t('settings.backupSection'), 'backup', form);
  }

  function backupActionsCard(backups, ctx) {
    // The main process returns the absolute path of each snapshot; the restore
    // handler only accepts files inside the backups folder (or a file the
    // pharmacist explicitly picked in the native dialog).
    const restoreNow = async (row) => {
      const confirmed = await window.UI.confirm({
        title: t('settings.restoreConfirmTitle'),
        message: t('settings.restoreConfirmText', { name: row.name }),
        confirmLabel: t('settings.restore'),
        cancelLabel: t('common.cancel'),
        danger: true,
      });
      if (!confirmed) return;
      try {
        await window.API.invoke('backup:restore', { file: row.path });
        toast(t('settings.restoreDone'), 'success', 6000);
      } catch (error) {
        toast(window.UI.errorMessage(error), 'error', 8000);
      }
    };

    const table = window.UI.table({
      columns: [
        { key: 'created_at', label: t('settings.backupDate'), render: (row) => window.UI.formatDateTime(row.created_at) },
        { key: 'name', label: t('settings.backupName'), render: (row) => h('code', { class: 'mono' }, row.name) },
        {
          key: 'kind',
          label: t('settings.backupKind'),
          render: (row) => window.UI.badge(t(`backup.kind.${row.kind}`), row.kind === 'auto' ? 'neutral' : 'info'),
        },
        { key: 'size', label: t('settings.backupSize'), render: (row) => window.UI.formatBytes(row.size) },
        {
          key: 'actions',
          label: t('common.actions'),
          render: (row) =>
            window.UI.button(t('settings.restore'), {
              tone: 'ghost',
              size: 'sm',
              icon: 'restore',
              onClick: () => restoreNow(row),
            }),
        },
      ],
      rows: backups,
      empty: t('settings.noBackups'),
    });

    return section(
      t('settings.backupsList'),
      'restore',
      h(
        'div',
        { class: 'stack' },
        h(
          'div',
          { class: 'row-actions' },
          window.UI.button(t('settings.backupNow'), {
            icon: 'backup',
            onClick: async (event) => {
              await window.UI.busy(event.currentTarget, async () => {
                try {
                  await window.API.invoke('backup:create');
                  toast(t('backup.created'), 'success');
                  await renderPage(ctx);
                } catch (error) {
                  toast(window.UI.errorMessage(error), 'error');
                }
              });
            },
          }),
          window.UI.button(t('settings.exportBackup'), {
            tone: 'ghost',
            icon: 'file',
            onClick: async (event) => {
              await window.UI.busy(event.currentTarget, async () => {
                try {
                  const result = await window.API.invoke('backup:export');
                  if (result.canceled) toast(t('backup.canceled'), 'info', 2500);
                  else toast(`${t('backup.exported')} · ${result.file}`, 'success', 8000);
                } catch (error) {
                  toast(window.UI.errorMessage(error), 'error', 8000);
                }
              });
            },
          }),
          window.UI.button(t('settings.restoreFromFile'), {
            tone: 'ghost',
            icon: 'folder',
            onClick: async (event) => {
              await window.UI.busy(event.currentTarget, async () => {
                try {
                  const chosen = await window.API.invoke('backup:choose');
                  if (chosen.canceled) {
                    toast(t('backup.canceled'), 'info', 2500);
                    return;
                  }
                  if (!chosen.integrityOk) {
                    toast(window.UI.errorMessage({ code: 'BACKUP_CORRUPT' }), 'error', 8000);
                    return;
                  }
                  if (chosen.tooNew) {
                    toast(window.UI.errorMessage({ code: 'BACKUP_TOO_NEW' }), 'error', 8000);
                    return;
                  }
                  const confirmed = await window.UI.confirm({
                    title: t('settings.restoreConfirmTitle'),
                    message: t('settings.restoreConfirmText', { name: chosen.name }),
                    confirmLabel: t('settings.restore'),
                    cancelLabel: t('common.cancel'),
                    danger: true,
                  });
                  if (!confirmed) return;
                  await window.API.invoke('backup:restore', { file: chosen.file });
                  toast(t('settings.restoreDone'), 'success', 6000);
                } catch (error) {
                  toast(window.UI.errorMessage(error), 'error', 8000);
                }
              });
            },
          }),
        ),
        h('p', { class: 'field-hint' }, t('settings.restoreWarning')),
        table,
      ),
    );
  }

  function diagnosticsCard(info, stats, ctx) {
    const resultBox = h('div', { class: 'diagnostic-result', 'aria-live': 'polite' });

    const checkButton = window.UI.button(t('settings.integrityCheck'), {
      icon: 'database',
      tone: 'soft',
      onClick: async (event) => {
        await window.UI.busy(event.currentTarget, async () => {
          try {
            const result = await window.API.invoke('db:integrity');
            window.UI.mount(
              resultBox,
              h(
                'div',
                { class: `notice ${result.ok ? 'notice-ok' : 'notice-bad'}` },
                window.Icons.icon(result.ok ? 'checkCircle' : 'alert', { size: 20 }),
                h('div', {}, result.ok
                  ? t('settings.integrityOk')
                  : t('settings.integrityBad', { message: result.message || '—' })),
              ),
            );
          } catch (error) {
            window.UI.mount(
              resultBox,
              h('div', { class: 'notice notice-bad' }, window.UI.errorMessage(error)),
            );
          }
        });
      },
    });

    const openFolder = (kind) =>
      window.API.invoke('app:openFolder', { kind }).catch((error) =>
        toast(window.UI.errorMessage(error), 'error'),
      );

    return section(
      t('settings.maintenance'),
      'database',
      h(
        'div',
        { class: 'stack' },
        h(
          'div',
          { class: 'row-actions' },
          checkButton,
          window.UI.button(t('settings.openDataFolder'), {
            tone: 'ghost',
            icon: 'folder',
            onClick: () => openFolder('data'),
          }),
          window.UI.button(t('settings.openBackupFolder'), {
            tone: 'ghost',
            icon: 'backup',
            onClick: () => openFolder('backups'),
          }),
          window.UI.button(t('settings.openLogFile'), {
            tone: 'ghost',
            icon: 'file',
            onClick: () => openFolder('log'),
          }),
        ),
        resultBox,
        h('h3', { class: 'subhead' }, t('settings.databaseInfo')),
        window.UI.definitionList([
          [t('app.dataFolder'), h('code', { class: 'mono' }, info.dataDir)],
          [t('app.databaseFile'), h('code', { class: 'mono' }, info.databaseFile || '—')],
          [t('app.schemaVersion'), `v${stats.schemaVersion} / v${stats.latestSchemaVersion}`],
          [t('dashboard.storage'), window.UI.formatBytes(stats.sizeBytes)],
          [t('dashboard.dbState'), stats.foreignKeys ? 'foreign_keys = ON' : 'foreign_keys = OFF'],
          [t('app.electron'), `${info.electron || '—'} · ${info.platform || '—'}`],
        ]),
        h('p', { class: 'field-hint' }, t('settings.privacyNote')),
      ),
    );
  }

  function auditCard(entries) {
    return section(
      t('settings.auditTitle'),
      'clock',
      h(
        'div',
        { class: 'stack' },
        h('p', { class: 'field-hint' }, t('settings.auditHint')),
        window.UI.table({
          columns: [
            { key: 'at', label: t('common.date'), render: (row) => window.UI.formatDateTime(row.at) },
            {
              key: 'action',
              label: t('common.details'),
              render: (row) => {
                const key = `audit.${row.action}`;
                const translated = t(key);
                return translated === key ? row.action : translated;
              },
            },
            {
              key: 'severity',
              label: t('common.status'),
              render: (row) =>
                window.UI.badge(
                  row.severity,
                  row.severity === 'critical' ? 'danger' : row.severity === 'warning' ? 'warning' : 'neutral',
                ),
            },
          ],
          rows: entries,
          empty: t('settings.noAudit'),
        }),
      ),
    );
  }

  async function renderPage(ctx) {
    const container = ctx.container;
    window.UI.mount(container, window.UI.loading());
    let data;
    try {
      const [settings, backups, audit, stats, info] = await Promise.all([
        window.API.invoke('settings:all'),
        window.API.invoke('backup:list'),
        window.API.invoke('audit:list', { limit: 20 }),
        window.API.invoke('db:stats'),
        window.API.invoke('app:info'),
      ]);
      data = { settings, backups, audit, stats, info };
    } catch (error) {
      window.UI.mount(
        container,
        window.UI.card({
          title: t('error.title'),
          body: h(
            'div',
            { class: 'error-box' },
            h('p', {}, window.UI.errorMessage(error)),
            window.UI.button(t('common.retry'), {
              icon: 'refresh',
              onClick: () => renderPage(ctx),
            }),
          ),
        }),
      );
      return;
    }

    const { settings, backups, audit, stats, info } = data;
    if (window.App) window.App.settings = settings;

    window.UI.mount(
      container,
      h(
        'div',
        { class: 'stack' },
        h('p', { class: 'page-subtitle' }, t('settings.subtitle')),
        identityCard(settings, { ...ctx, container }),
        languageCard({ ...ctx, container }),
        alertsCard(settings, { ...ctx, container }),
        backupPolicyCard(settings, { ...ctx, container }),
        backupActionsCard(backups, { ...ctx, container }),
        diagnosticsCard(info, stats, { ...ctx, container }),
        auditCard(audit),
      ),
    );
  }

  Pages.settings = {
    titleKey: 'nav.settings',
    render(container, ctx) {
      return renderPage({ ...ctx, container });
    },
  };
})();
