/* Dashboard — "what needs my attention today".
 *
 * Phase 1 shows the real state of the application (database, backups, recent
 * audited actions) and honest zeros for the stock/debt counters that arrive in
 * the next phases. No invented numbers.
 */
(function () {
  'use strict';

  const { h, t } = { h: window.UI.h, t: window.I18N.t };
  const Pages = window.Pages;

  function greetingName(summary) {
    const name = (summary.pharmacyName || '').trim();
    return name ? t('dashboard.welcomeNamed', { name }) : t('dashboard.welcome');
  }

  function attentionStat(options) {
    return window.UI.stat(options);
  }

  function moduleGrid(navigate) {
    const items = window.AppNav.NAV_GROUPS.flatMap((group) => group.items).filter(
      (item) => item.page !== 'dashboard',
    );
    return h(
      'div',
      { class: 'module-grid' },
      items.map((item) =>
        h(
          'button',
          {
            type: 'button',
            class: 'module-tile',
            onClick: () => navigate(item.page),
          },
          window.Icons.icon(item.icon, { size: 24 }),
          h('span', { class: 'module-name' }, t(item.label)),
          window.AppNav.IMPLEMENTED.has(item.page)
            ? window.UI.badge(t('common.open'), 'success')
            : window.UI.badge(t('common.planned'), 'warning'),
        ),
      ),
    );
  }

  function activityList(rows) {
    if (!rows.length) return window.UI.empty(t('dashboard.noActivity'));
    return h(
      'ul',
      { class: 'activity' },
      rows.map((row) => {
        const key = `audit.${row.action}`;
        const translated = t(key);
        return h(
          'li',
          { class: 'activity-item' },
          h(
            'span',
            { class: `activity-dot severity-${row.severity || 'info'}`, 'aria-hidden': 'true' },
          ),
          h(
            'div',
            { class: 'activity-body' },
            h('span', { class: 'activity-action' }, translated === key ? row.action : translated),
            h('span', { class: 'activity-time' }, window.UI.formatDateTime(row.at)),
          ),
        );
      }),
    );
  }

  Pages.dashboard = {
    titleKey: 'nav.dashboard',
    async render(container, ctx) {
      const { navigate } = ctx;
      window.UI.mount(container, window.UI.loading());

      let summary;
      try {
        summary = await window.API.invoke('dashboard:summary');
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
                onClick: () => Pages.dashboard.render(container, ctx),
              }),
            ),
          }),
        );
        return;
      }

      const blocks = [];

      blocks.push(
        h(
          'div',
          { class: 'hero' },
          h(
            'div',
            { class: 'hero-text' },
            h('h2', { class: 'hero-title' }, greetingName(summary)),
            h('p', { class: 'hero-subtitle' }, t('dashboard.subtitle')),
            h(
              'p',
              { class: 'hero-date' },
              h('span', { class: 'chip' }, t('app.today') + ' · ' + window.UI.formatDate(summary.today)),
            ),
          ),
          h(
            'div',
            { class: 'hero-actions' },
            window.UI.button(t('dashboard.backupNow'), {
              icon: 'backup',
              onClick: async (event) => {
                await window.UI.busy(event.currentTarget, async () => {
                  try {
                    await window.API.invoke('backup:create');
                    window.UI.toast(t('backup.created'), 'success');
                    await Pages.dashboard.render(container, ctx);
                  } catch (error) {
                    window.UI.toast(window.UI.errorMessage(error), 'error');
                  }
                });
              },
            }),
            window.UI.button(t('nav.settings'), {
              tone: 'ghost',
              icon: 'settings',
              onClick: () => navigate('settings'),
            }),
          ),
        ),
      );

      if (!summary.pharmacyName) {
        blocks.push(
          window.UI.card({
            className: 'card-emphasis',
            title: t('dashboard.setupTitle'),
            icon: 'info',
            body: h(
              'div',
              { class: 'setup' },
              h('p', {}, t('dashboard.setupText')),
              window.UI.button(t('dashboard.setupButton'), {
                icon: 'settings',
                onClick: () => navigate('settings'),
              }),
            ),
          }),
        );
      }

      // "What needs attention": each number is a real 0 in phase 1.
      blocks.push(
        window.UI.card({
          title: t('dashboard.tasks'),
          subtitle: t('dashboard.tasksHint'),
          icon: 'alert',
          body: h(
            'div',
            { class: 'stat-grid' },
            attentionStat({
              label: t('dashboard.expiring'),
              value: window.UI.formatNumber(summary.counters.expiringSoon),
              icon: 'clock',
              tone: summary.counters.expiringSoon ? 'warning' : 'neutral',
              hint: t('plan.phase', { phase: 2 }),
            }),
            attentionStat({
              label: t('dashboard.expired'),
              value: window.UI.formatNumber(summary.counters.expired),
              icon: 'alert',
              tone: summary.counters.expired ? 'danger' : 'neutral',
              hint: t('plan.phase', { phase: 2 }),
            }),
            attentionStat({
              label: t('dashboard.customerDebt'),
              value: window.UI.formatMoney(summary.counters.customerDebtCents),
              icon: 'personDebt',
              hint: t('plan.phase', { phase: 3 }),
            }),
            attentionStat({
              label: t('dashboard.supplierDebt'),
              value: window.UI.formatMoney(summary.counters.supplierDebtCents),
              icon: 'truckDebt',
              hint: t('plan.phase', { phase: 3 }),
            }),
          ),
        }),
      );

      // System state: database health + backups.
      const dbOk = summary.database.integrityOk;
      const backupLine = !summary.backups.enabled
        ? t('dashboard.backupOff')
        : summary.backups.due
          ? t('dashboard.backupDue')
          : t('dashboard.backupOk');

      blocks.push(
        h(
          'div',
          { class: 'grid grid-2' },
          window.UI.card({
            title: t('dashboard.system'),
            icon: 'shield',
            body: window.UI.definitionList([
              [
                t('dashboard.dbState'),
                h(
                  'span',
                  { class: `pill ${dbOk ? 'pill-ok' : 'pill-bad'}` },
                  window.Icons.icon(dbOk ? 'checkCircle' : 'alert', { size: 16 }),
                  dbOk ? t('dashboard.dbHealthy') : t('dashboard.dbProblem'),
                ),
              ],
              [t('app.schemaVersion'), `v${summary.database.schemaVersion}`],
              [t('dashboard.storage'), window.UI.formatBytes(summary.database.sizeBytes)],
              [
                t('dashboard.lastBackup'),
                summary.backups.last
                  ? window.UI.formatDateTime(summary.backups.last.created_at)
                  : t('dashboard.never'),
              ],
              [t('settings.backupKind'), backupLine],
            ]),
          }),
          window.UI.card({
            title: t('dashboard.quickActions'),
            icon: 'folder',
            body: h(
              'div',
              { class: 'quick-actions' },
              window.UI.button(t('dashboard.checkDatabase'), {
                tone: 'ghost',
                icon: 'database',
                block: true,
                onClick: async (event) => {
                  await window.UI.busy(event.currentTarget, async () => {
                    try {
                      const result = await window.API.invoke('db:integrity');
                      window.UI.toast(
                        result.ok
                          ? t('settings.integrityOk')
                          : t('settings.integrityBad', { message: result.message }),
                        result.ok ? 'success' : 'error',
                        6000,
                      );
                      await Pages.dashboard.render(container, ctx);
                    } catch (error) {
                      window.UI.toast(window.UI.errorMessage(error), 'error');
                    }
                  });
                },
              }),
              window.UI.button(t('dashboard.openData'), {
                tone: 'ghost',
                icon: 'folder',
                block: true,
                onClick: () =>
                  window.API.invoke('app:openFolder', { kind: 'data' }).catch((error) =>
                    window.UI.toast(window.UI.errorMessage(error), 'error'),
                  ),
              }),
              window.UI.button(t('dashboard.openBackups'), {
                tone: 'ghost',
                icon: 'backup',
                block: true,
                onClick: () =>
                  window.API.invoke('app:openFolder', { kind: 'backups' }).catch((error) =>
                    window.UI.toast(window.UI.errorMessage(error), 'error'),
                  ),
              }),
            ),
          }),
        ),
      );

      blocks.push(
        h(
          'div',
          { class: 'grid grid-2' },
          window.UI.card({
            title: t('dashboard.recentActivity'),
            icon: 'clock',
            body: activityList(summary.recentActivity || []),
          }),
          window.UI.card({
            title: t('dashboard.modules'),
            subtitle: t('dashboard.modulesHint'),
            icon: 'dashboard',
            body: moduleGrid(navigate),
          }),
        ),
      );

      blocks.push(
        h(
          'p',
          { class: 'footnote' },
          h('span', { class: 'chip chip-offline' }, window.Icons.icon('shield', { size: 14 }), t('app.privacy')),
          h('span', { class: 'muted' }, t('app.phase')),
        ),
      );

      window.UI.mount(container, h('div', { class: 'stack' }, blocks));
    },
  };
})();
