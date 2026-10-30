/* Application shell for MediRDV: authentication, navigation, language, session lock. */
(function () {
  'use strict';

  const { t, setLanguage, getLanguage } = window.I18N;
  const { h, clear, toast } = window.UI;
  const Pages = (window.Pages = window.Pages || {});

  const NAV = [
    ['dashboard', 'dashboard', 'nav.dashboard'],
    ['agenda', 'calendar', 'nav.agenda'],
    ['prescriptions', 'prescription', 'nav.prescriptions'],
    ['patients', 'users', 'nav.patients'],
    ['treatments', 'stethoscope', 'nav.treatments'],
    ['expenses', 'wallet', 'nav.expenses'],
    ['reports', 'chart', 'nav.reports'],
    ['whatsapp', 'whatsapp', 'nav.whatsapp'],
    ['settings', 'settings', 'nav.settings'],
  ];

  const App = {
    version: '1.0.0',
    settings: {},
    language: getLanguage(),
    page: 'dashboard',
    day: window.UI.todayISO(),
    month: window.UI.todayISO().slice(0, 7),
    bootInfo: null,
    license: null,
    licensePromptedOnce: false,
    licenseBannerSlot: null,
    shell: null,
    content: null,
    pageActions: null,
  };

  let authMode = 'login';

  function setLanguageEverywhere(lang) {
    setLanguage(lang);
    App.language = lang;
    if (App.bootInfo?.auth?.unlocked) {
      window.API.invoke('settings:set', { language: lang }).catch(() => {});
    }
  }

  function nextLanguage(lang) {
    if (lang === 'fr') return 'ar';
    if (lang === 'ar') return 'en';
    return 'fr';
  }

  function nextLanguageLabel(lang) {
    if (lang === 'fr') return 'العربية';
    if (lang === 'ar') return 'English';
    return 'Français';
  }

  function languageToggle() {
    const target = nextLanguage(App.language);
    return h(
      'button',
      {
        class: 'btn ghost sm',
        title: t('common.language'),
        onClick: async () => {
          setLanguageEverywhere(target);
          if (App.bootInfo?.auth?.unlocked) await rerender();
          else await renderAuth(authMode, App.bootInfo || {});
        },
      },
      nextLanguageLabel(App.language),
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
    const doctorInput = window.UI.input({
      placeholder: t('settings.doctorPlaceholder'),
      value: info.doctor_name || '',
    });
    const specialtyInput = window.UI.input({
      placeholder: t('settings.specialtyPlaceholder'),
      value: info.doctor_specialty || '',
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
                await window.API.invoke('settings:set', {
                  clinic_name: clinicInput.value.trim() || 'Cabinet Médical',
                  doctor_name: doctorInput.value.trim(),
                  doctor_specialty: specialtyInput.value.trim() || 'Médecine Générale',
                });
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
      isSetup ? window.UI.field(t('settings.doctorName'), doctorInput) : null,
      isSetup ? window.UI.field(t('settings.doctorSpecialty'), specialtyInput) : null,
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
        h('img', { src: 'img/icon.png', alt: 'MediRDV', class: 'auth-logo-img' }),
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
    App.licenseBannerSlot = h('div', { id: 'license-banner-slot' });

    function demoBanner() {
      return h(
        'div',
        { class: 'demo-banner' },
        h('strong', {}, '🧪 ' + t('demo.banner')),
      );
    }
    App.content = h('main', { class: 'content', id: 'content' });

    const subBrand = App.settings.doctor_name
      ? `${App.settings.doctor_name}${App.settings.doctor_specialty ? ` · ${App.settings.doctor_specialty}` : ''}`
      : t('app.name');

    const shell = h(
      'div',
      { class: 'app' },
      h(
        'aside',
        { class: 'sidebar' },
        h(
          'div',
          { class: 'brand' },
          h('img', { src: 'img/icon.png', alt: 'MediRDV', class: 'brand-logo-img' }),
          h(
            'div',
            { style: { minWidth: '0' } },
            h('div', { class: 'brand-name' }, App.settings.clinic_name || 'MediRDV'),
            h('div', { class: 'brand-sub', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, subBrand),
          ),
        ),
        nav,
        h(
          'div',
          { class: 'sidebar-foot' },
          !App.demo
            ? h(
                'button',
                {
                  class: 'btn sm',
                  onClick: () => {
                    if (window.Components?.openLicenseModal) {
                      window.Components.openLicenseModal();
                    }
                  },
                },
                '🔑',
                h('span', {}, t('license.navBtn')),
              )
            : null,
          h(
            'button',
            {
              class: 'btn sm',
              onClick: () => {
                setLanguageEverywhere(nextLanguage(App.language));
                rerender();
              },
            },
            '🌐',
            h('span', {}, nextLanguageLabel(App.language)),
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
        App.demo ? demoBanner() : App.licenseBannerSlot,
        App.content,
      ),
    );
    if (window.MiniChat) window.MiniChat.mount(shell);
    App.shell = shell;
    App.updateLicenseBanner(App.license);
    return shell;
  }

  App.updateLicenseBanner = (lic) => {
    if (!App.licenseBannerSlot || App.demo) return;
    clear(App.licenseBannerSlot);
    if (!lic) return;

    if (!lic.valid) {
      const msgKey = lic.status === 'clock_tampered' ? 'license.bannerClock' : 'license.bannerExpired';
      App.licenseBannerSlot.append(
        h(
          'div',
          {
            class: 'demo-banner',
            style: {
              background: '#fef2f2',
              borderBottom: '1px solid #fecaca',
              color: '#991b1b',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '12px',
              padding: '8px 20px',
            },
          },
          h('strong', {}, '🔒 ' + t(msgKey)),
          h(
            'button',
            {
              type: 'button',
              class: 'btn primary sm',
              onClick: () => window.Components?.openLicenseModal?.({ initialStatus: lic }),
            },
            '🔑 ' + t('license.openModalBtn'),
          ),
        ),
      );
      return;
    }

    if (lic.warning_soon) {
      App.licenseBannerSlot.append(
        h(
          'div',
          {
            class: 'demo-banner',
            style: {
              background: '#fffbeb',
              borderBottom: '1px solid #fde68a',
              color: '#92400e',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '12px',
              padding: '8px 20px',
            },
          },
          h(
            'strong',
            {},
            '⚠️ ' +
              t('license.bannerWarn', {
                days: lic.days_remaining ?? 0,
                date: lic.expires_date_dz || '',
              }),
          ),
          h(
            'button',
            {
              type: 'button',
              class: 'btn soft sm',
              onClick: () => window.Components?.openLicenseModal?.({ initialStatus: lic }),
            },
            '🔑 ' + t('license.openModalBtn'),
          ),
        ),
      );
    }
  };

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
    )
      .then(() => window.UI.iconize(App.content))
      .catch((err) => {
        console.error('[render]', err);
        clear(App.content).append(
          h(
            'div',
            { class: 'card error-text' },
            h('strong', {}, t('common.error')),
            h('div', { class: 'small muted mt-s' }, errorText(err)),
          ),
        );
      });
  };

  async function rerender() {
    if (!App.shell || !App.bootInfo?.auth?.unlocked) return;
    try {
      [App.settings, App.license] = await Promise.all([
        window.API.invoke('settings:get'),
        window.API.invoke('license:status').catch(() => App.license),
      ]);
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
    App.license = App.bootInfo.license || (await window.API.invoke('license:status').catch(() => null));
    App.settings = await window.API.invoke('settings:get');
    const stored = localStorage.getItem('medirdv.lang');
    if (!stored && App.settings.language) setLanguage(App.settings.language);
    App.language = getLanguage();

    clear(document.body).append(buildShell());
    window.UI.iconize(document.body);

    App.page = 'dashboard';
    App.navigate('dashboard');

    if (!App.demo && App.license && !App.license.valid && !App.licensePromptedOnce) {
      App.licensePromptedOnce = true;
      if (window.Components?.openLicenseModal) {
        window.Components.openLicenseModal({ initialStatus: App.license });
      }
    }
  }

  async function boot() {
    try {
      App.bootInfo = await window.API.invoke('app:bootstrap');
      App.license = App.bootInfo.license || null;
      const info = await window.API.invoke('app:info').catch(() => ({ version: '1.0.0' }));
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

    window.addEventListener('session-locked', () => {
      if (App.bootInfo?.auth?.unlocked) {
        App.bootInfo.auth.unlocked = false;
        renderAuth('login', { clinic_name: App.settings?.clinic_name });
      }
    });

    App.onExternalChatUpdate = () => {
      if (!App.bootInfo?.auth?.unlocked) return;
      if (['dashboard', 'agenda', 'patients', 'whatsapp'].includes(App.page)) App.renderPage();
    };
    let lastAutoCancelToastId = 0;
    window.API.onEvent((event) => {
      if (event?.type === 'open_license_modal') {
        if (window.Components?.openLicenseModal) {
          window.Components.openLicenseModal({ initialStatus: event.payload || null });
        }
        return;
      }
      if (event?.type === 'license_changed') {
        App.license = event.payload || App.license;
        App.updateLicenseBanner(App.license);
        if (App.bootInfo?.auth?.unlocked) App.renderPage();
        return;
      }
      if (event?.type === 'license_warning') {
        App.license = event.payload || App.license;
        App.updateLicenseBanner(App.license);
        if (event.payload?.days_remaining) {
          toast(
            t('license.bannerWarn', {
              days: event.payload.days_remaining,
              date: event.payload.expires_date_dz || '',
            }),
            'warn',
          );
        }
        return;
      }
      if (event?.type === 'reminders' && event.payload?.sent) {
        toast(t('wa.sentNow', { n: event.payload.sent }), 'ok');
      }
      if (event?.type === 'appointment_changed') {
        if (event.payload?.action === 'cancelled') {
          const cid = event.payload?.appointment?.id || Date.now();
          if (cid !== lastAutoCancelToastId) {
            lastAutoCancelToastId = cid;
            toast(t('queue.autoRemovedToast'), 'ok');
          }
        }
        if (window.MiniChat) window.MiniChat.refresh({ scrollBottom: true });
        App.onExternalChatUpdate();
      } else if (event?.type === 'message') {
        if (event.payload?.action === 'cancelled') {
          const cid = event.payload?.appointment?.id || 0;
          if (!cid || cid !== lastAutoCancelToastId) {
            lastAutoCancelToastId = cid || Date.now();
            toast(t('queue.autoRemovedToast'), 'ok');
          }
        }
        if (window.MiniChat) window.MiniChat.refresh({ scrollBottom: true });
        App.onExternalChatUpdate();
      } else if (event?.type === 'chat' || event?.type === 'queue' || event?.type === 'intake') {
        if (window.MiniChat) window.MiniChat.refresh({ scrollBottom: true });
        if (event?.type === 'queue' || event?.type === 'intake') App.onExternalChatUpdate();
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
