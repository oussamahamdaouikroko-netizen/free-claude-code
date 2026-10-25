/* Application shell: boot, navigation, language switch, page routing.
 *
 * Phase 1 shows the full navigation in both languages. The dashboard and the
 * settings screen are functional; the other eight sections render an honest
 * "planned" screen describing what they will do, instead of pretending to
 * work with empty tables.
 */
(function () {
  'use strict';

  const { t, setLanguage, getLanguage } = window.I18N;
  const { h, clear, toast } = window.UI;
  const Pages = (window.Pages = window.Pages || {});

  const NAV_GROUPS = [
    {
      key: 'main',
      items: [
        { page: 'dashboard', icon: 'dashboard', label: 'nav.dashboard' },
        { page: 'stock', icon: 'pill', label: 'nav.stock' },
        { page: 'purchases', icon: 'cartIn', label: 'nav.purchases' },
        { page: 'sales', icon: 'cartOut', label: 'nav.sales' },
        { page: 'expiry', icon: 'clock', label: 'nav.expiry' },
      ],
    },
    {
      key: 'money',
      items: [
        { page: 'customer_debts', icon: 'personDebt', label: 'nav.customer_debts' },
        { page: 'supplier_debts', icon: 'truckDebt', label: 'nav.supplier_debts' },
      ],
    },
    {
      key: 'tools',
      items: [
        { page: 'import_export', icon: 'importExport', label: 'nav.import_export' },
        { page: 'reports', icon: 'chart', label: 'nav.reports' },
        { page: 'settings', icon: 'settings', label: 'nav.settings' },
      ],
    },
  ];

  /** Pages implemented in Phase 1; the others are honest placeholders. */
  const IMPLEMENTED = new Set(['dashboard', 'settings']);
  const DEFAULT_PAGE = 'dashboard';

  const App = {
    page: DEFAULT_PAGE,
    info: null,
    settings: null,
    shell: null,
    content: null,
    navList: null,
    titleNode: null,
    languageButton: null,
    booted: false,
  };

  function allNavItems() {
    return NAV_GROUPS.flatMap((group) => group.items);
  }

  function isKnownPage(page) {
    return allNavItems().some((item) => item.page === page);
  }

  /* --------------------------------- language ------------------------------- */

  function languageToggle() {
    const next = getLanguage() === 'fr' ? 'ar' : 'fr';
    return h(
      'button',
      {
        class: 'btn btn-ghost lang-toggle',
        type: 'button',
        title: t('common.language'),
        'aria-label': t('common.language'),
        onClick: () => switchLanguage(next),
      },
      window.Icons.icon('globe', { size: 18 }),
      h('span', {}, next === 'ar' ? 'العربية' : 'Français'),
    );
  }

  async function switchLanguage(language) {
    if (language === getLanguage()) return;
    setLanguage(language);
    if (App.settings) App.settings.language = language;
    // Persist through the main process; a failure must not block the UI change.
    window.API.invoke('settings:language', { language })
      .then(() => toast(t('settings.savedLanguage'), 'success', 2000))
      .catch((error) => toast(window.UI.errorMessage(error), 'error'));
    renderShell();
    await renderPage(App.page);
  }

  /* ---------------------------------- shell --------------------------------- */

  function renderShell() {
    const root = document.getElementById('app');
    clear(root);

    const navList = h('nav', { class: 'nav', 'aria-label': t('common.language') });
    for (const group of NAV_GROUPS) {
      navList.appendChild(h('p', { class: 'nav-section' }, t(`nav.section.${group.key}`)));
      for (const item of group.items) {
        const active = item.page === App.page;
        navList.appendChild(
          h(
            'button',
            {
              class: `nav-item${active ? ' is-active' : ''}`,
              type: 'button',
              'data-page': item.page,
              'aria-current': active ? 'page' : null,
              onClick: () => navigate(item.page),
            },
            window.Icons.icon(item.icon, { size: 20 }),
            h('span', { class: 'nav-label' }, t(item.label)),
            IMPLEMENTED.has(item.page)
              ? null
              : h('span', { class: 'nav-dot', title: t('common.planned'), 'aria-hidden': 'true' }),
          ),
        );
      }
    }

    const version = App.info ? App.info.version : '';
    const sidebar = h(
      'aside',
      { class: 'sidebar' },
      h(
        'div',
        { class: 'brand' },
        h('img', { class: 'brand-logo', src: 'img/icon.png', alt: '', width: '40', height: '40' }),
        h(
          'div',
          { class: 'brand-text' },
          h('strong', { class: 'brand-name' }, t('app.name')),
          h('span', { class: 'brand-tagline' }, t('app.tagline')),
        ),
      ),
      navList,
      h(
        'div',
        { class: 'sidebar-foot' },
        h('span', { class: 'chip chip-offline' }, window.Icons.icon('shield', { size: 14 }), t('app.offline')),
        version ? h('span', { class: 'sidebar-version' }, `${t('app.version')} ${version}`) : null,
      ),
    );

    const titleNode = h('h1', { class: 'page-title' }, '');
    const content = h('div', { class: 'content', id: 'content' });
    const main = h(
      'main',
      { class: 'main' },
      h(
        'header',
        { class: 'topbar' },
        h('div', { class: 'topbar-titles' }, titleNode),
        h('div', { class: 'topbar-actions' }, languageToggle()),
      ),
      content,
    );

    root.appendChild(h('div', { class: 'app-shell' }, sidebar, main));

    App.shell = root;
    App.navList = navList;
    App.content = content;
    App.titleNode = titleNode;
    updateActiveNav();
  }

  function updateActiveNav() {
    if (!App.navList) return;
    for (const button of App.navList.querySelectorAll('.nav-item')) {
      const active = button.dataset.page === App.page;
      button.classList.toggle('is-active', active);
      if (active) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    }
  }

  /* --------------------------------- routing -------------------------------- */

  function pageFromHash() {
    const raw = (window.location.hash || '').replace(/^#\/?/, '').trim();
    return isKnownPage(raw) ? raw : null;
  }

  function navigate(page, options = {}) {
    const target = isKnownPage(page) ? page : DEFAULT_PAGE;
    App.page = target;
    if (!options.silent) {
      const hash = `#/${target}`;
      if (window.location.hash !== hash) window.location.hash = hash;
    }
    updateActiveNav();
    return renderPage(target);
  }

  async function renderPage(page) {
    const definition = Pages[page] || Pages.notFound;
    if (!definition) {
      window.UI.mount(App.content, window.UI.empty(t('common.notAvailableYet')));
      return;
    }
    App.titleNode.textContent = t(definition.titleKey || 'nav.dashboard');
    document.title = `${t(definition.titleKey || 'app.name')} — ${t('app.name')}`;

    const container = h('div', { class: 'page' });
    window.UI.mount(App.content, container);
    try {
      await definition.render(container, { app: App, navigate });
    } catch (error) {
      console.error(`[page] ${page} failed`, error);
      window.UI.mount(
        container,
        window.UI.card({
          title: t('error.title'),
          tone: 'danger',
          body: h(
            'div',
            { class: 'error-box' },
            h('p', {}, window.UI.errorMessage(error)),
            h(
              'div',
              { class: 'row-actions' },
              window.UI.button(t('common.retry'), {
                icon: 'refresh',
                onClick: () => renderPage(page),
              }),
            ),
          ),
        }),
      );
    }
    window.scrollTo({ top: 0 });
  }

  /* ---------------------------------- boot ---------------------------------- */

  async function boot() {
    const root = document.getElementById('app');
    window.I18N.applyToDocument();
    window.UI.mount(root, window.UI.loading());

    try {
      const [info, settings] = await Promise.all([
        window.API.invoke('app:info'),
        window.API.invoke('settings:all'),
      ]);
      App.info = info;
      App.settings = settings;
      setLanguage(settings.language === 'ar' ? 'ar' : 'fr', { silent: true });
      window.I18N.applyToDocument();
    } catch (error) {
      console.error('[boot] failed', error);
      window.UI.mount(
        root,
        h(
          'div',
          { class: 'boot-error' },
          h('h1', {}, t('app.name')),
          h('p', {}, window.UI.errorMessage(error)),
          window.UI.button(t('common.retry'), { icon: 'refresh', onClick: () => boot() }),
        ),
      );
      return;
    }

    renderShell();

    window.API.onEvent((event) => {
      if (!event || !event.type) return;
      if (event.type === 'database-upgraded') {
        toast(`${t('app.schemaVersion')}: ${event.from} → ${event.to}`, 'info', 6000);
      }
    });

    if (!window.__pharmagestionHashBound) {
      window.addEventListener('hashchange', () => {
        const page = pageFromHash();
        if (page && page !== App.page) navigate(page, { silent: true });
      });
      window.__pharmagestionHashBound = true;
    }

    App.booted = true;
    await navigate(pageFromHash() || DEFAULT_PAGE, { silent: true });
  }

  Pages.notFound = {
    titleKey: 'error.title',
    render: (container) => window.UI.mount(container, window.UI.empty(t('common.notAvailableYet'))),
  };

  /** Factory used by the sections that are not implemented yet. */
  Pages.planned = function planned(definition) {
    return {
      titleKey: definition.titleKey,
      render(container) {
        const bullets = definition.points.map((key) => t(key));
        container.appendChild(
          h(
            'div',
            { class: 'page-head' },
            h('p', { class: 'page-subtitle' }, t('plan.subtitle')),
          ),
        );
        container.appendChild(
          h(
            'div',
            { class: 'grid grid-2' },
            window.UI.card({
              title: t('plan.what'),
              icon: 'checkCircle',
              body: window.UI.list(bullets),
            }),
            window.UI.card({
              title: t('plan.why'),
              icon: 'info',
              body: h('p', { class: 'card-text' }, t(definition.whyKey)),
            }),
          ),
        );
        container.appendChild(
          window.UI.card({
            title: t('plan.status'),
            icon: 'clock',
            body: h(
              'div',
              { class: 'planned-status' },
              window.UI.badge(t('plan.phase', { phase: definition.phase }), 'warning'),
              h('p', { class: 'muted' }, t('common.notYet')),
              window.UI.button(t('plan.backToDashboard'), {
                tone: 'soft',
                icon: 'dashboard',
                onClick: () => navigate('dashboard'),
              }),
            ),
          }),
        );
      },
    };
  };

  window.App = App;
  window.AppNav = { NAV_GROUPS, IMPLEMENTED, navigate, boot, renderPage, switchLanguage };

  document.addEventListener('DOMContentLoaded', () => {
    boot().catch((error) => console.error('[boot] unhandled', error));
  });
})();
