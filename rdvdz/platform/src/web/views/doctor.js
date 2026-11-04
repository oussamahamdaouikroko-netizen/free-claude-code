/** Fiche médecin : présentation, tarifs, créneaux, réservation. */

import { t, getLocale } from '../i18n.js';
import * as api from '../api.js';
import { h, raw, money, initials, formatDay, formatTime, notice, emptyState } from '../ui.js';
import { bindInteractions } from './bindings.js';
import { isoDay, addDays } from '../ui.js';

/** Grille de créneaux (réutilisée par le changement de jour). */
export function renderSlots(slots) {
  if (!slots || slots.length === 0) {
    return emptyState({ icon: '📅', title: t('doctor.noSlots'), body: t('search.emptyHint') });
  }
  const byTime = (a, b) => new Date(a.starts_at) - new Date(b.starts_at);
  return String(h`
    <div class="slot-grid">
      ${raw(
        [...slots]
          .sort(byTime)
          .map(
            (slot) => h`
              <button class="slot" type="button" data-act="select-slot" data-slot-id="${slot.id}"
                      data-slot="${slot.id}" aria-pressed="false">
                ${formatTime(slot.starts_at)}
                <small>${t(`mode.${slot.mode}`)}</small>
              </button>`,
          )
          .join(''),
      )}
    </div>`);
}

export async function renderDoctor({ params, state }) {
  const [doctorId] = params;
  const data = await api.get(`/doctors/${doctorId}`);
  const ar = getLocale() === 'ar';
  const doctor = data.doctor;
  const clinic = data.clinic;
  const fee = data.fees.service_fee;

  // Le jour courant proposé contient-il des créneaux ? Sinon on avance.
  const days = [];
  for (let index = 0; index < 7; index += 1) days.push(addDays(isoDay(), index));
  const dayWithSlots = days.find((day) =>
    data.slots.some((slot) => isoDay(new Date(slot.starts_at)) === day),
  );

  const bio = ar ? doctor.bio_ar : doctor.bio_fr;
  const specialty = ar ? doctor.specialty_ar : doctor.specialty_fr;

  const slotForm = state.user
    ? state.user.role === 'PATIENT'
      ? h`
        <form data-form="booking" class="stack">
          <input type="hidden" name="slot_id" id="slot_id" value="" />
          <div class="day-tabs" role="group" aria-label="${t('doctor.chooseSlot')}">
            ${raw(
              days
                .map(
                  (day) => h`
                    <button class="day-tab" type="button" data-act="select-day" data-day="${day}"
                            data-doctor="${doctor.id}" aria-pressed="${day === (dayWithSlots ?? days[0]) ? 'true' : 'false'}">
                      ${formatDay(`${day}T12:00:00Z`)}
                    </button>`,
                )
                .join(''),
            )}
          </div>
          <div data-region="slots">
            ${raw(renderSlots(data.slots))}
          </div>
          <div class="field">
            <label for="notes">${t('doctor.notesLabel')}</label>
            <textarea id="notes" name="notes" maxlength="1000" rows="3"></textarea>
          </div>
          <div data-region="booking-summary"></div>
          <div data-region="booking-action" class="btn-row">
            <button class="btn" type="submit">${t('doctor.book')}</button>
          </div>
          <p class="muted small">${fee > 0 ? t('doctor.payRequired') : t('doctor.freeBooking')}</p>
        </form>`
      : raw(notice('info', t('errors.forbidden.body')))
    : raw(
        notice(
          'info',
          h`<a href="#/login">${t('nav.login')}</a> — ${t('auth.loginSubtitle')}`,
        ),
      );

  const reviews = data.reviews.length
    ? h`
      <ul class="list">
        ${raw(
          data.reviews
            .map(
              (review) => h`
                <li class="list-item">
                  <div class="list-item-main">
                    <p class="list-item-title">${'★'.repeat(review.rating)}${'☆'.repeat(5 - review.rating)}</p>
                    <p class="small">${review.comment}</p>
                    <div class="list-item-meta">
                      <span>${review.patient_first_name}</span>
                      <span>${formatDay(review.created_at)}</span>
                    </div>
                  </div>
                </li>`,
            )
            .join(''),
        )}
      </ul>`
    : h`<p class="muted">${t('doctor.noReviews')}</p>`;

  bindInteractions();

  return String(h`
    <div class="stack">
      <a class="small" href="#/">← ${t('nav.find')}</a>
      <div class="card">
        <div class="doctor-card" style="border:0;box-shadow:none;padding:0">
          <div class="avatar avatar-lg" aria-hidden="true">${initials(doctor.full_name)}</div>
          <div class="doctor-card-body">
            <h1>${doctor.full_name}</h1>
            <div class="doctor-specialty">${specialty ?? doctor.primary_specialty_code}</div>
            <div class="doctor-meta">
              ${doctor.verified ? h`<span class="badge badge-green">${t('search.verified')}</span>` : ''}
              ${doctor.rating_count > 0
                ? h`<span>★ ${Number(doctor.rating_avg).toFixed(1)} · ${doctor.rating_count} ${t('search.rating')}</span>`
                : ''}
              ${doctor.teleconsult_enabled ? h`<span class="badge badge-green">${t('nav.teleconsult')}</span>` : ''}
            </div>
            ${bio ? h`<p style="margin-top:12px">${bio}</p>` : ''}
          </div>
        </div>
      </div>

      <div class="grid grid-2">
        <div class="card">
          <h2>${t('doctor.fees')}</h2>
          <ul class="list">
            <li class="list-item">
              <span>${t('common.price')}</span>
              <strong>${money(data.fees.consultation)}</strong>
            </li>
            ${data.fees.teleconsultation > 0
              ? h`<li class="list-item">
                    <span>${t('nav.teleconsult')}</span>
                    <strong>${money(data.fees.teleconsultation)}</strong>
                  </li>`
              : ''}
            <li class="list-item">
              <span>${t('common.fee')}</span>
              <strong>${money(fee)}</strong>
            </li>
          </ul>
          <p class="muted small">${t('payment.secure')}</p>
        </div>

        <div class="card">
          <h2>${t('doctor.address')}</h2>
          ${clinic
            ? h`
              <p><strong>${ar ? clinic.name_ar || clinic.name_fr : clinic.name_fr}</strong></p>
              <p class="small">${clinic.address}</p>
              <p class="small muted">${clinic.commune}</p>
              ${clinic.phone ? h`<p class="mono small">${clinic.phone}</p>` : ''}`
            : h`<p class="muted">${t('common.none')}</p>`}
        </div>
      </div>

      <div class="card">
        <h2>${t('doctor.chooseSlot')}</h2>
        ${raw(slotForm)}
      </div>

      <div class="card">
        <h2>${t('doctor.reviews')}</h2>
        ${raw(reviews)}
      </div>
    </div>`);
}

/** Au montage, on n'affiche que les créneaux du jour présélectionné. */
export async function mountDoctor(root) {
  const active = root?.querySelector('[data-act="select-day"][aria-pressed="true"]');
  if (!active) return;
  const { runDay } = await import('./bindings.js');
  await runDay(active);
}

renderDoctor.onMount = mountDoctor;

export { formatDay };
