/* Application shell: authentication, navigation, language, session lock. */
(function () {
  'use strict';

  const { t, setLanguage, getLanguage } = window.I18N;
  const { h, clear, toast } = window.UI;
  const Pages = (window.Pages = window.Pages || {});

  // Icônes SVG professionnelles (js/icons.js) : lisibles à toute taille,
  // identiques en français et en arabe, et noires à l'impression.
  const NAV = [
    ['dashboard', 'dashboard', 'nav.dashboard'],
    ['agenda', 'calendar', 'nav.agenda'],
    ['patients', 'users', 'nav.patients'],
    ['treatments', 'tooth', 'nav.treatments'],
    ['expenses', 'wallet', 'nav.expenses'],
    ['reports', 'chart', 'nav.reports'],
    ['whatsapp', 'whatsapp', 'nav.whatsapp'],
    ['settings', 'settings', 'nav.settings'],
  ];

  const App = {
    version: '1.2.0', // replaced by app:info at boot (demo server / Electron)
    settings: {},
    language: getLanguage(),
    page: 'dashboard',
    day: window.UI.todayISO(),
    month: window.UI.todayISO().slice(0, 7),
    bootInfo: null,
    shell: null,
    content: null,
    pageActions: null,
  };

  let authMode = 'login';

  /* -------------------------------- helpers -------------------------------- */
  function setLanguageEverywhere(lang) {
    setLanguage(lang);
    App.language = lang;
    // Persist for the next launch (also stored in settings for WhatsApp default).
    if (App.bootInfo?.auth?.unlocked) {
      window.API.invoke('settings:set', { language: lang }).catch(() => {});
    }
  }

  function languageToggle() {
    const target = App.language === 'fr' ? 'ar' : 'fr';
    return h(
      'button',
      {
        class: 'btn ghost sm',
        title: t('common.language'),
        onClick: async () => {
          setLanguageEverywhere(target);
          // Before login there is no shell to rebuild: redraw the auth card.
          if (App.bootInfo?.auth?.unlocked) await rerender();
          else await renderAuth(authMode, App.bootInfo || {});
        },
      },
      App.language === 'fr' ? 'العربية' : 'Français',
    );
  }

  function errorText(error) {
    return window.UI.errorMessage(error);
  }

  /* ---------------------------------- auth --------------------------------- */
  function authScreen(mode, info = {}) {
    const isSetup = mode === 'setup';
    const error = h('div', { class: 'error-text' });
    const clinicInput = window.UI.input({
      placeholder: t('auth.clinicPlaceholder'),
      value: info.clinic_name || '',
      autofocus: true,
    });
    const password = window.UI.input({ type: 'password', placeholder: '••••••••', autocomplete: 'new-password' });
    const confirm = window.UI.input({ type: 'password', placeholder: '••••••••', autocomplete: 'new-password' });
    const submit = h('button', { class: 'btn primary lg block', type: 'submit' }, isSetup ? t('auth.create') : t('auth.login'));

    const form = h(
      'form',
      {
        onSubmit: async (event) => {
          event.preventDefault();
          error.textContent = '';
          if (isSetup) {
            if (password.value.length < 4) {
              error.textContent = t('auth.tooShort');
              return;
            }
            if (password.value !== confirm.value) {
              error.textContent = t('auth.mismatch');
              return;
            }
          }
          await window.UI.busy(submit, async () => {
            try {
              if (isSetup) {
                await window.API.invoke('auth:setup', {
                  password: password.value,
                  confirm: confirm.value,
                });
                await window.API.invoke('settings:set', { clinic_name: clinicInput.value.trim() || 'Cabinet Dentaire' });
              } else {
                await window.API.invoke('auth:login', { password: password.value });
              }
              await startApp();
            } catch (err) {
              error.textContent = errorText(err);
              password.value = '';
              password.focus();
            }
          });
        },
      },
      isSetup ? window.UI.field(t('auth.clinicName'), clinicInput) : null,
      window.UI.field(t('auth.password'), password, isSetup ? t('auth.passwordHint') : ''),
      isSetup ? window.UI.field(t('auth.confirmPassword'), confirm) : null,
      error,
      submit,
    );

    return h(
      'div',
      { class: 'auth' },
      h(
        'div',
        { class: 'auth-card' },
        h('div', { class: 'auth-logo' }, window.Icons ? window.Icons.el('tooth', { size: 30, stroke: 1.8 }) : '🦷'),
        h('h1', {}, isSetup ? t('auth.setupTitle') : t('auth.welcome')),
        h('p', { class: 'sub' }, isSetup ? t('auth.setupSubtitle') : t('auth.loginSubtitle')),
        form,
        h(
          'div',
          { class: 'auth-foot' },
          h('span', { class: 'small muted' }, t('app.tagline')),
          languageToggle(),
        ),
      ),
    );
  }

  async function renderAuth(mode, info = {}) {
    authMode = mode;
    if (window.MiniChat) window.MiniChat.stop();
    clear(document.body).append(authScreen(mode, info));
  }

  /* --------------------------------- shell --------------------------------- */
  function buildShell() {
    const nav = h('nav', { class: 'nav' });
    for (const [key, icon, label] of NAV) {
      nav.append(
        h(
          'button',
          {
            class: `nav-item ${App.page === key ? 'active' : ''}`,
            dataset: { page: key },
            onClick: () => App.navigate(key),
          },
          h('span', { class: 'emoji' }, window.Icons ? window.Icons.el(icon, { size: 19 }) : ''),
          h('span', { class: 'label' }, t(label)),
        ),
      );
    }

    App.pageActions = h('div', { class: 'row' });

  /**
   * Shown only in the portable demo build: the dentist must never mistake the
   * sample patients for real records (the demo runs on their own computer).
   */
  function demoBanner() {
    return h(
      'div',
      { class: 'demo-banner' },
      h('strong', {}, '🧪 ' + t('demo.banner')),
    );
  }
    App.content = h('main', { class: 'content', id: 'content' });

    const shell = h(
      'div',
      { class: 'app' },
      h(
        'aside',
        { class: 'sidebar' },
        h(
          'div',
          { class: 'brand' },
          h('div', { class: 'brand-mark' }, window.Icons ? window.Icons.el('tooth', { size: 22, stroke: 1.8 }) : '🦷'),
          h(
            'div',
            {},
            h('div', { class: 'brand-name' }, App.settings.clinic_name || 'DentaRDV'),
            h('div', { class: 'brand-sub' }, t('app.name')),
          ),
        ),
        nav,
        h(
          'div',
          { class: 'sidebar-foot' },
          h(
            'button',
            {
              class: 'btn sm',
              onClick: () => {
                setLanguageEverywhere(App.language === 'fr' ? 'ar' : 'fr');
                rerender();
              },
            },
            '🌐',
            h('span', {}, App.language === 'fr' ? 'العربية' : 'Français'),
          ),
          h(
            'button',
            {
              class: 'btn sm',
              onClick: async () => {
                await window.API.invoke('auth:lock').catch(() => {});
                await renderAuth('login', { clinic_name: App.settings.clinic_name });
              },
            },
            '🔒',
            h('span', {}, t('common.lock')),
          ),
        ),
      ),
      h(
        'div',
        { class: 'main' },
        h(
          'header',
          { class: 'topbar' },
          h(
            'div',
            {},
            h('div', { class: 'page-title', id: 'page-title' }, ''),
            h('div', { class: 'page-sub', id: 'page-sub' }, ''),
          ),
          App.pageActions,
        ),
        App.demo ? demoBanner() : null,
        App.content,
      ),
    );
    if (window.MiniChat) window.MiniChat.mount(shell);
    App.shell = shell;
    return shell;
  }

  App.setHeader = (title, subtitle = '', actions = null) => {
    const titleEl = document.getElementById('page-title');
    const subEl = document.getElementById('page-sub');
    if (titleEl) titleEl.textContent = title;
    if (subEl) subEl.textContent = subtitle;
    clear(App.pageActions);
    if (actions) {
      if (Array.isArray(actions)) App.pageActions.append(...actions);
      else App.pageActions.append(actions);
      window.UI.iconize(App.pageActions);
    }
  };

  App.navigate = (page) => {
    if (!Pages[page]) return;
    App.page = page;
    for (const button of document.querySelectorAll('.nav-item')) {
      button.classList.toggle('active', button.dataset.page === page);
    }
    App.renderPage();
  };

  App.renderPage = () => {
    clear(App.content);
    App.setHeader('', '', null);
    const page = Pages[App.page] || Pages.dashboard;
    Promise.resolve(
      page.render(App.content, {
        refresh: App.renderPage,
        navigate: App.navigate,
        setHeader: App.setHeader,
        state: App,
      }),
    ).then(() => window.UI.iconize(App.content));
  };

  async function rerender() {
    if (!App.shell || !App.bootInfo?.auth?.unlocked) return;
    try {
      App.settings = await window.API.invoke('settings:get');
    } catch (error) {
      if (error.code === 'LOCKED') return renderAuth('login', {});
      throw error;
    }
    const activePage = App.page;
    clear(document.body).append(buildShell());
    window.UI.iconize(document.body);
    App.page = activePage;
    App.navigate(activePage);
  }

  App.rerender = rerender;

  async function startApp() {
    App.bootInfo = await window.API.invoke('app:bootstrap');
    App.settings = await window.API.invoke('settings:get');
    // Respect the language saved in settings on first launch.
    const stored = localStorage.getItem('dentardv.lang');
    if (!stored && App.settings.language) setLanguage(App.settings.language);
    App.language = getLanguage();

    clear(document.body).append(buildShell());
    window.UI.iconize(document.body);

    // Default landing page: dashboard.
    App.page = 'dashboard';
    App.navigate('dashboard');
  }

  async function boot() {
    try {
      App.bootInfo = await window.API.invoke('app:bootstrap');
      const info = await window.API.invoke('app:info').catch(() => ({ version: '1.1.0' }));
      App.version = info.version || App.version;
      App.demo = Boolean(info.demo) || window.API.demo;

      if (!App.bootInfo.auth.has_password) {
        await renderAuth('setup', App.bootInfo);
      } else if (!App.bootInfo.auth.unlocked) {
        await renderAuth('login', App.bootInfo);
      } else {
        await startApp();
      }
    } catch (error) {
      clear(document.body).append(
        h(
          'div',
          { class: 'auth' },
          h(
            'div',
            { class: 'auth-card' },
            h('h1', {}, t('common.error')),
            h('p', { class: 'muted' }, errorText(error)),
            h('button', { class: 'btn primary block mt', onClick: () => location.reload() }, t('common.retry')),
          ),
        ),
      );
    }

    // Locking can happen from any screen (session timeout or LOCKED error).
    window.addEventListener('session-locked', () => {
      if (App.bootInfo?.auth?.unlocked) {
        App.bootInfo.auth.unlocked = false;
        renderAuth('login', { clinic_name: App.settings?.clinic_name });
      }
    });

    // WhatsApp & live queue events → toasts, Mini Chat sync, and active list refresh.
    App.onExternalChatUpdate = () => {
      if (!App.bootInfo?.auth?.unlocked) return;
      if (['dashboard', 'agenda', 'whatsapp'].includes(App.page)) App.renderPage();
    };
    window.API.onEvent((event) => {
      if (event?.type === 'reminders' && event.payload?.sent) {
        toast(t('wa.sentNow', { n: event.payload.sent }), 'ok');
      }
      if (event?.type === 'message') {
        if (event.payload?.action === 'cancelled') {
          toast(t('queue.autoRemovedToast'), 'ok');
        }
        if (window.MiniChat) window.MiniChat.refresh({ scrollBottom: true });
        App.onExternalChatUpdate();
      } else if (event?.type === 'chat' || event?.type === 'queue') {
        if (window.MiniChat) window.MiniChat.refresh({ scrollBottom: true });
      }
    });
    window.API.onWhatsAppStatus(() => {
      if (App.bootInfo?.auth?.unlocked && App.page === 'whatsapp') App.renderPage();
    });
  }

  window.App = App;
  document.addEventListener('DOMContentLoaded', () => {
    if (window.SFX) window.SFX.install();
    boot();
  });
})();
