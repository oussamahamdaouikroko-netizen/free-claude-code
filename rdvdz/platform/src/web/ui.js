/**
 * Petits utilitaires d'interface : échappement HTML, formatage, badges, toasts.
 *
 * Sécurité : `h` est un gabarit balisé qui échappe **toute** interpolation,
 * sauf si la valeur est explicitement marquée comme sûre avec `raw()`. C'est
 * ce qui empêche une donnée patient (nom, note) de devenir du HTML.
 */

import { t, getLocale } from './i18n.js';

/**
 * HTML déjà sûr.
 *
 * C'est une sous-classe de `String` : elle se comporte comme une chaîne
 * partout (`===` non, mais `includes`, `+`, `join`, `innerHTML` oui), tout en
 * restant *identifiable*. Indispensable pour que `${h`<span>…</span>`}`
 * imbriqué dans un autre gabarit **ne soit pas ré-échappé** (double
 * échappement = badges et liens affichés en clair).
 */
export class SafeHtml extends String {
  get [Symbol.toStringTag]() {
    return 'SafeHtml';
  }
}

const SAFE = Symbol('safe-html');

/** Marque une chaîne comme déjà sûre (HTML généré par nos soins uniquement). */
export function raw(html) {
  const safe = new SafeHtml(String(html ?? ''));
  safe[SAFE] = true;
  return safe;
}

const ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Échappe une valeur pour insertion dans du HTML (texte ou attribut). */
export function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, (char) => ESCAPES[char]);
}

function renderValue(value) {
  if (value === null || value === undefined || value === false) return '';
  if (value instanceof SafeHtml || (typeof value === 'object' && value[SAFE])) return String(value.value ?? value);
  if (Array.isArray(value)) return value.map(renderValue).join('');
  return esc(value);
}

/**
 * Gabarit HTML avec échappement automatique.
 * @example h`<p>${patientName}</p>`
 */
export function h(strings, ...values) {
  let out = '';
  strings.forEach((chunk, index) => {
    out += chunk;
    if (index < values.length) out += renderValue(values[index]);
  });
  return raw(out);
}

/* --------------------------------- formats -------------------------------- */

/** Montant : l'API raisonne en centimes, l'affichage en dinars. */
export function money(centimes, { withCurrency = true } = {}) {
  const value = Number(centimes ?? 0) / 100;
  const formatted = value.toLocaleString(getLocale() === 'ar' ? 'ar-DZ' : 'fr-FR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return withCurrency ? `${formatted} ${t('common.currency')}` : formatted;
}

/** Date longue et lisible (fuseau Algérie UTC+1). */
export function formatDate(iso, { withWeekday = true } = {}) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(getLocale() === 'ar' ? 'ar-DZ' : 'fr-FR', {
    ...(withWeekday ? { weekday: 'long' } : {}),
    day: '2-digit',
    month: 'long',
    year: 'numeric',
    timeZone: 'Africa/Algiers',
  });
}

/** Heure locale algérienne (HH:MM). */
export function formatTime(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  // `hour12: false` est indispensable : selon la version d'ICU, `fr-DZ` bascule
  // sinon en 12 h (« 09:00 AM ») pour un rendez-vous médical.
  return date.toLocaleTimeString(getLocale() === 'ar' ? 'ar-DZ' : 'fr-FR', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Africa/Algiers',
  });
}

/** Date courte pour les en-têtes de section. */
export function formatDay(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  return date.toLocaleDateString(getLocale() === 'ar' ? 'ar-DZ' : 'fr-FR', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    timeZone: 'Africa/Algiers',
  });
}

/** Date ISO (AAAA-MM-JJ) dans le fuseau algérien, pour les filtres. */
export function isoDay(date = new Date()) {
  const shifted = new Date(date.getTime() + 60 * 60_000); // UTC+1
  return shifted.toISOString().slice(0, 10);
}

export function addDays(iso, days) {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Initiales pour l'avatar (« Dr Karim Boudiaf » → « KB »). */
export function initials(name) {
  const cleaned = String(name ?? '')
    .replace(/^(dr|pr|د\.?|دكتور)\s+/i, '')
    .trim();
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

/* ---------------------------------- badges -------------------------------- */

const STATUS_TONE = {
  CONFIRMED: 'green',
  COMPLETED: 'blue',
  PAID: 'green',
  ANSWERED: 'green',
  ACCEPTED: 'blue',
  IN_PROGRESS: 'blue',
  REQUESTED: 'grey',
  PENDING: 'amber',
  AWAITING_PAYMENT: 'amber',
  AWAITING_PATIENT: 'amber',
  CANCELLED: 'grey',
  CLOSED: 'grey',
  NO_SHOW: 'red',
  REJECTED: 'red',
  REFUNDED: 'grey',
  ACTIVE: 'green',
  SUSPENDED: 'red',
  PENDING_REVIEW: 'amber',
  APPROVED: 'green',
};

/** Badge de statut traduit et coloré (jamais de couleur seule : le texte porte l'info). */
export function statusBadge(status) {
  const label = t(`status.${status}`);
  const text = label === `status.${status}` ? String(status ?? '') : label;
  const tone = STATUS_TONE[status] ?? 'grey';
  return h`<span class="badge badge-${tone}">${text}</span>`;
}

export function modeLabel(mode) {
  const label = t(`mode.${mode}`);
  return label === `mode.${mode}` ? String(mode ?? '') : label;
}

export function kindLabel(kind) {
  const label = t(`kind.${kind}`);
  return label === `kind.${kind}` ? String(kind ?? '') : label;
}

/* ---------------------------------- toasts -------------------------------- */

/** Affiche un message éphémère accessible. */
export function toast(message, type = 'info') {
  const container = document.getElementById('toasts');
  if (!container) return;
  const node = document.createElement('div');
  node.className = `toast toast-${type}`;
  node.textContent = message;
  container.append(node);
  const timeout = type === 'error' ? 8000 : 4500;
  setTimeout(() => node.remove(), timeout);
}

/* --------------------------------- fragments ------------------------------ */

export function emptyState({ icon = '📭', title, body, action = '' }) {
  return h`
    <div class="empty">
      <div class="empty-icon" aria-hidden="true">${icon}</div>
      <h3>${title}</h3>
      <p>${body}</p>
      ${action ? raw(action) : ''}
    </div>`;
}

export function notice(kind, message) {
  return h`<div class="notice notice-${kind}" role="${kind === 'error' ? 'alert' : 'status'}">${message}</div>`;
}

/** Bloc d'erreur de formulaire (messages par champ du code VALIDATION). */
export function fieldError(fields, name) {
  const value = fields?.[name];
  if (!value) return '';
  return h`<div class="field-error">${String(value)}</div>`;
}

export function spinnerRow(colspan) {
  return h`<tr><td colspan="${colspan}" class="muted center">${t('common.loading')}</td></tr>`;
}
