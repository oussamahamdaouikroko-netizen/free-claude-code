/**
 * RDV DZ — application web (PWA).
 *
 * Choix assumés :
 *  - **aucune dépendance** (pas de React, pas de bundler) : le fichier est
 *    servi tel quel, se charge en une requête et fonctionne sur un réseau
 *    mobile lent ;
 *  - **aucun jeton en localStorage** : la session vit dans un cookie
 *    `HttpOnly`, le jeton CSRF est gardé en mémoire uniquement ;
 *  - **tout contenu injecté est échappé** (`h` / `esc`) : le HTML n'est jamais
 *    construit par concaténation de données serveur ;
 *  - les erreurs de l'API sont traduites via leur `code` stable, jamais en
 *    affichant un message technique brut.
 */

import { t, setLocale, getLocale, applyDir } from './i18n.js';
import * as api from './api.js';
import { h, esc, money, formatDate, formatTime, statusBadge, modeLabel, toast } from './ui.js';
import { renderSearch } from './views/search.js';
import { renderDoctor } from './views/doctor.js';
import { renderLogin, renderRegister } from './views/auth.js';
import { renderBookings } from './views/bookings.js';
import { renderTeleconsult } from './views/teleconsult.js';
import { renderDoctorAgenda } from './views/agenda.js';
import { renderOps } from './views/ops.js';
import { renderAdmin } from './views/admin.js';
import { renderAccount } from './views/account.js';
import { bindInteractions } from './views/bindings.js';

export const state = {
  /** @type {null | {id: string, role: string, full_name: string, phone: string, locale: string}} */
  user: null,
  csrf: null,
  identity: { patient_id: null, doctor_id: null, doctor_verified: false },
  scope: { global: false, branches: [], wilayas: [] },
  booted: false,
  cache: new Map(),
};

/* --------------------------------- session -------------------------------- */

/** Recharge la session depuis le cookie (le seul état persistant). */
export async function refreshSession() {
  try {
    const me = await api.get('/me/profile');
    state.user = { ...me.user };
    // `/me/profile` ne renvoie pas le CSRF : on le récupère via `/auth/me`.
    const auth = await api.get('/auth/me');
    state.csrf = auth.csrf_token;
    // Sans cet appel, toute mutation rejouerait après un rechargement de page
    // serait rejetée en `CSRF_INVALID` : le jeton vit en mémoire uniquement.
    api.setCsrf(auth.csrf_token);
    state.identity = auth.identity;
    state.scope = auth.scope;
  } catch {
    state.user = null;
    state.csrf = null;
    api.setCsrf(null);
    state.identity = { patient_id: null, doctor_id: null, doctor_verified: false };
    state.scope = null;
  }
  applySessionToDocument();
  return state.user;
}

function applySessionToDocument() {
  document.body.dataset.session = state.user ? 'authenticated' : 'anonymous';
  document.body.dataset.role = state.user?.role ?? '';
  document.documentElement.lang = getLocale();
  applyDir();
}

/* ---------------------------------- routes -------------------------------- */

const routes = [
  { pattern: /^\/$/, view: renderSearch, public: true, nav: 'search' },
  { pattern: /^\/doctors\/([\w-]+)$/, view: renderDoctor, public: true, nav: 'search' },
  { pattern: /^\/login$/, view: renderLogin, public: true, guestOnly: true },
  { pattern: /^\/register$/, view: renderRegister, public: true, guestOnly: true },
  { pattern: /^\/bookings$/, view: renderBookings, role: ['PATIENT'] },
  { pattern: /^\/teleconsult$/, view: renderTeleconsult, role: ['PATIENT'] },
  { pattern: /^\/doctor$/, view: renderDoctorAgenda, role: ['DOCTOR'] },
  {
    pattern: /^\/ops$/,
    view: renderOps,
    role: ['OPERATOR', 'BRANCH_MANAGER', 'ADMIN', 'SUPER_ADMIN', 'FINANCE_MANAGER'],
  },
  { pattern: /^\/admin$/, view: renderAdmin, role: ['ADMIN', 'SUPER_ADMIN'] },
  { pattern: /^\/account$/, view: renderAccount },
  { pattern: /^\/privacy$/, view: renderPrivacy, public: true },
];

function currentPath() {
  const hash = window.location.hash.replace(/^#/, '');
  return hash || '/';
}

/** Navigation programmatique (garde le hash pour le bouton retour). */
export function go(path) {
  if (currentPath() === path) {
    void render();
    return;
  }
  window.location.hash = path;
}

function viewNode() {
  return document.getElementById('view');
}

/** Indique un chargement accessible. */
function setLoading(on) {
  const view = viewNode();
  if (on) {
    view.setAttribute('aria-busy', 'true');
    view.innerHTML = `
      <div class="skeleton">
        <div class="skeleton-line w40"></div>
        <div class="skeleton-line"></div>
        <div class="skeleton-card"></div>
      </div>`;
  } else {
    view.removeAttribute('aria-busy');
  }
}

/** Rendu complet de la vue courante. */
export async function render() {
  const path = currentPath();
  const route = routes.find((candidate) => candidate.pattern.test(path));

  updateNav(route);

  if (!route) {
    viewNode().innerHTML = renderNotFound();
    return;
  }

  if (route.public !== true && !state.user) {
    sessionStorage.setItem('rdvdz.next', path);
    go('/login');
    return;
  }
  if (route.guestOnly && state.user) {
    go('/bookings');
    return;
  }
  if (route.role && !route.role.includes(state.user.role)) {
    // On force la cohérence de l'affichage : sans cela, un rôle inattendu
    // laisserait la barre de navigation dans l'état de la session précédente.
    applySessionToDocument();
    viewNode().innerHTML = String(h`
      <div class="card">
        <h1 data-i18n="errors.forbidden.title">${t('errors.forbidden.title')}</h1>
        <p class="muted" data-i18n="errors.forbidden.body">${t('errors.forbidden.body')}</p>
        <a class="btn" href="#/bookings" data-i18n="common.back">${t('common.back')}</a>
      </div>`);
    return;
  }

  const match = path.match(route.pattern);
  setLoading(true);
  try {
    const html = await route.view({ params: match ? match.slice(1) : [], state, go });
    viewNode().innerHTML = html;
    translateStatic();
    // Certaines vues complètent leur contenu après le premier rendu (appels
    // réseau dépendants des filtres) : `onMount` est optionnel.
    await route.view.onMount?.(viewNode());
  } catch (error) {
    // Trace technique en console uniquement : l'utilisateur voit un code stable.
    console.error('[rdvdz] rendu', path, error);
    // Parcours utilisateur non bloquant : un ménage de l'URL malformée
    // (`#/doctors/undefined`) ne doit pas laisser un écran mort.
    viewNode().innerHTML = renderError(error);
  } finally {
    setLoading(false);
  }
}

function updateNav(route) {
  document.querySelectorAll('[data-nav]').forEach((link) => {
    if (route && link.dataset.nav === route.nav) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
}

/** Traduit les nœuds portant `data-i18n` (utile après un changement de langue). */
export function translateStatic(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((node) => {
    const key = node.dataset.i18n;
    const value = t(key);
    if (value && value !== key) node.textContent = value;
  });
  root.querySelectorAll('[data-i18n-placeholder]').forEach((node) => {
    const value = t(node.dataset.i18nPlaceholder);
    if (value) node.setAttribute('placeholder', value);
  });
  root.querySelectorAll('[data-i18n-label]').forEach((node) => {
    const value = t(node.dataset.i18nLabel);
    if (value) node.setAttribute('aria-label', value);
  });
}

/* -------------------------------- vues d'erreur --------------------------- */

export function renderError(error) {
  const code = error?.code ?? 'INTERNAL_ERROR';
  const known = t(`errors.${code}`);
  const message = known && known !== `errors.${code}` ? known : t('errors.INTERNAL_ERROR');
  return String(h`
    <div class="card">
      <div class="notice notice-error">
        <strong>${t('common.error')}</strong>
        <div>${esc(message)}</div>
      </div>
      <p class="muted small">${t('common.code')}: <span class="mono">${esc(code)}</span></p>
      <button class="btn btn-ghost" type="button" data-action="reload">${t('common.retry')}</button>
    </div>`);
}

export function renderNotFound() {
  return String(h`
    <div class="empty">
      <div class="empty-icon" aria-hidden="true">🔍</div>
      <h3>${t('errors.NOT_FOUND')}</h3>
      <p>${t('nav.find')}</p>
      <a class="btn" href="#/">${t('nav.find')}</a>
    </div>`);
}

export function renderPrivacy() {
  const ar = getLocale() === 'ar';
  return String(h`
    <div class="card">
      <h1>${ar ? 'حماية المعطيات الشخصية' : 'Protection des données personnelles'}</h1>
      <p>${ar
        ? 'تُعالج معطياتكم الصحية وفق القانون 18-07 المعدّل بالقانون 25-11. تُستضاف المعطيات في الجزائر ولا تُنقل إلى الخارج بدون ترخيص مسبق من السلطة الوطنية (ANPDP).'
        : 'Vos données de santé sont traitées conformément à la loi 18-07, modifiée par la loi 25-11. Elles sont hébergées en Algérie et ne font l’objet d’aucun transfert à l’étranger sans autorisation préalable de l’ANPDP.'}</p>
      <ul>
        <li>${ar ? 'الغرض: تسيير المواعيد والاستشارات عن بعد.' : 'Finalité : gestion des rendez-vous et téléconsultations.'}</li>
        <li>${ar ? 'المدة: مدة الحساب ثم المدة القانونية للأرشفة.' : 'Durée : vie du compte puis durées légales d’archivage.'}</li>
        <li>${ar ? 'حقوقكم: الولوج، التصحيح، الحذف، والاعتراض.' : 'Vos droits : accès, rectification, suppression, opposition.'}</li>
        <li>${ar ? 'لا تُرسل أي معطيات طبية عبر واتساب.' : 'Aucune donnée médicale ne transite par WhatsApp.'}</li>
      </ul>
      <a class="btn btn-ghost" href="#/account">${ar ? 'إدارة معطياتي' : 'Gérer mes données'}</a>
    </div>`);
}

/* ----------------------------------- boot --------------------------------- */

async function boot() {
  applyDir();
  translateStatic();
  await refreshSession();
  window.addEventListener('hashchange', () => {
    void render();
  });
  bindGlobalActions();
  bindInteractions();
  registerServiceWorker();
  await render();
  state.booted = true;
}

function bindGlobalActions() {
  document.addEventListener('click', async (event) => {
    const trigger = event.target.closest('[data-action]');
    if (!trigger) return;

    const action = trigger.dataset.action;
    if (action === 'reload') {
      await render();
      return;
    }
    if (action === 'toggle-lang') {
      setLocale(getLocale() === 'ar' ? 'fr' : 'ar');
      applyDir();
      translateStatic();
      await render();
      return;
    }
    if (action === 'logout') {
      try {
        await api.post('/auth/logout', {}, { csrf: state.csrf });
      } catch {
        /* une session déjà expirée n'est pas une erreur pour l'utilisateur */
      }
      state.user = null;
      state.csrf = null;
      applySessionToDocument();
      toast(t('auth.loggedOut'), 'success');
      go('/');
      return;
    }
    if (action === 'print') {
      window.print();
    }
  });

  // Un cache local sert uniquement de repli quand le réseau tombe.
  window.addEventListener('offline', () => toast(t('errors.OFFLINE'), 'error'));
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol !== 'https:' && location.hostname !== 'localhost' && !location.hostname.endsWith('.e2b.app')) {
    return; // pas de SW hors contexte sécurisé
  }
  navigator.serviceWorker.register('/sw.js').catch(() => {
    /* un SW indisponible ne doit jamais empêcher l'application de fonctionner */
  });
}

export { go as navigate, t, esc, money, formatDate, formatTime, statusBadge, modeLabel };

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  void boot();
}
