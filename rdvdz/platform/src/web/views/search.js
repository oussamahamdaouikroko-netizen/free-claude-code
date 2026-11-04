/** Recherche de médecins : filtres, résultats, lien vers la fiche. */

import { t, getLocale } from '../i18n.js';
import * as api from '../api.js';
import { h, raw, money, initials, emptyState, notice, formatDay } from '../ui.js';
import { bindInteractions } from './bindings.js';

/** Recherche lancée dès l'ouverture de l'écran d'accueil. */
export async function mountSearch(root) {
  if (!root) return;
  const form = root.querySelector('form[data-form="search"]');
  if (!form) return;
  await runSearch(new FormData(form));
}

/** Référentiels mis en cache pour la session (58 wilayas, spécialités). */
let reference = null;
async function loadReference() {
  if (reference) return reference;
  const [wilayas, specialties, config] = await Promise.all([
    api.get('/reference/wilayas'),
    api.get('/reference/specialties'),
    api.get('/reference/config'),
  ]);
  reference = {
    wilayas: wilayas.items,
    specialties: specialties.items,
    config,
  };
  return reference;
}

function doctorCard(doctor) {
  const ar = getLocale() === 'ar';
  const specialty = ar ? doctor.specialty_ar : doctor.specialty_fr;
  const wilaya = ar ? doctor.wilaya_ar : doctor.wilaya_fr;
  const next = doctor.next_slot ?? doctor.next_slots?.[0] ?? null;
  return String(h`
    <article class="doctor-card">
      <div class="avatar" aria-hidden="true">${initials(doctor.full_name)}</div>
      <div class="doctor-card-body">
        <h3>${doctor.full_name}</h3>
        <div class="doctor-specialty">${specialty ?? doctor.primary_specialty_code}</div>
        <div class="doctor-meta">
          ${wilaya ? h`<span>${wilaya}${doctor.commune ? ` · ${doctor.commune}` : ''}</span>` : ''}
          ${doctor.clinic_name_fr
            ? h`<span>${ar ? doctor.clinic_name_ar || doctor.clinic_name_fr : doctor.clinic_name_fr}</span>`
            : ''}
          ${doctor.teleconsult_enabled ? h`<span class="badge badge-green">${t('nav.teleconsult')}</span>` : ''}
          ${doctor.rating_count > 0
            ? h`<span>★ ${Number(doctor.rating_avg).toFixed(1)} · ${doctor.rating_count} ${t('search.rating')}</span>`
            : ''}
        </div>
        <div class="doctor-meta" style="margin-top:8px">
          <span>${t('common.price')} : <strong>${money(doctor.consultation_fee)}</strong></span>
          ${next ? h`<span>${t('search.nextSlot')} : ${formatDay(next)}</span>` : ''}
        </div>
        <div class="btn-row" style="margin-top:12px">
          <a class="btn" href="#/doctors/${doctor.id}">${t('search.view')}</a>
        </div>
      </div>
    </article>`);
}

export async function renderSearch({ params, state }) {
  void params;
  const ref = await loadReference();
  const ar = getLocale() === 'ar';
  const pending = pendingBooking();
  const welcome = state.user
    ? h`<div class="notice notice-info">${t('auth.welcome')}, ${state.user.full_name}.</div>`
    : '';

  return String(h`
    <section class="stack">
      ${raw(welcome)}
      ${raw(pending)}
      <div class="card">
        <h1>${t('search.title')}</h1>
        <p class="muted">${t('search.subtitle')}</p>
        <form class="search-bar" data-form="search" autocomplete="off">
          <div class="search-text">
            <label for="q">${t('common.search')}</label>
            <input id="q" name="q" type="search" placeholder="${t('search.placeholder')}" />
          </div>
          <div>
            <label for="specialty">${t('search.specialty')}</label>
            <select id="specialty" name="specialty">
              <option value="">${t('search.allSpecialties')}</option>
              ${raw(ref.specialties
                .map((item) => h`<option value="${item.code}">${ar ? item.name_ar : item.name_fr}</option>`)
                .join(''))}
            </select>
          </div>
          <div>
            <label for="wilaya">${t('common.wilaya')}</label>
            <select id="wilaya" name="wilaya">
              <option value="">${t('search.allWilayas')}</option>
              ${raw(ref.wilayas
                .map((item) => h`<option value="${item.code}">${item.code} — ${ar ? item.name_ar : item.name_fr}</option>`)
                .join(''))}
            </select>
          </div>
          <div>
            <label class="checkbox" for="teleconsult" style="margin-bottom:6px">
              <input id="teleconsult" name="teleconsult" type="checkbox" value="1" />
              <span class="small">${t('search.teleconsult')}</span>
            </label>
          </div>
          <button class="btn" type="submit">${t('common.search')}</button>
        </form>
      </div>

      <div data-region="results" aria-live="polite">
        <div class="skeleton"><div class="skeleton-card"></div></div>
      </div>
    </section>`);
}

/** Bandeau « paiement en attente » quand on revient d'une annulation de paiement. */
function pendingBooking() {
  const rawPending = sessionStorage.getItem('rdvdz.pending');
  if (!rawPending) return '';
  let pending;
  try {
    pending = JSON.parse(rawPending);
  } catch {
    sessionStorage.removeItem('rdvdz.pending');
    return '';
  }
  return notice(
    'warn',
    h`${t('booking.pendingPayment')} — ${t('common.reference')} <span class="mono">${pending.reference}</span>.
      <a href="#/bookings">${t('booking.title')}</a>`,
  );
}

export async function runSearch(formData) {
  const params = new URLSearchParams();
  const q = (formData.get('q') ?? '').toString().trim();
  if (q) params.set('q', q);
  const specialty = (formData.get('specialty') ?? '').toString();
  if (specialty) params.set('specialty', specialty);
  const wilaya = (formData.get('wilaya') ?? '').toString();
  if (wilaya) params.set('wilaya', wilaya);
  if (formData.get('teleconsult')) params.set('teleconsult', '1');
  params.set('limit', '20');

  const region = document.querySelector('[data-region="results"]');
  if (region) region.innerHTML = '<div class="skeleton"><div class="skeleton-card"></div></div>';

  const data = await api.get(`/doctors?${params.toString()}`);
  if (!region) return;

  if (data.items.length === 0) {
    region.innerHTML = String(emptyState({
      icon: '🩺',
      title: t('search.empty'),
      body: t('search.emptyHint'),
      action: h`<button class="btn btn-ghost" type="button" data-act="reset-search">${t('common.reset')}</button>`,
    }));
    bindInteractions();
    return;
  }

  region.innerHTML = String(h`
    <div class="toolbar">
      <strong>${data.items.length}</strong>
      <span class="muted">${t('search.results')}</span>
    </div>
    <div class="grid">${raw(data.items.map(doctorCard).join(''))}</div>`);
  bindInteractions();
}

/** Branché comme `renderSearch.onMount` (voir `app.js`). */
renderSearch.onMount = mountSearch;
