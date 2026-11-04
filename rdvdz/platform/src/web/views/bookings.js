/** Mes rendez-vous : à venir, historique, actions (payer, annuler, reçu). */

import { t } from '../i18n.js';
import * as api from '../api.js';
import { h, raw, money, formatDate, formatTime, statusBadge, modeLabel, emptyState, notice } from '../ui.js';
import { bindInteractions } from './bindings.js';

export function bookingRow(appointment, { actionable = true } = {}) {
  const status = appointment.status;
  const awaitingPayment = ['AWAITING_PAYMENT', 'PENDING'].includes(status);
  const canCancel = ['PENDING', 'AWAITING_PAYMENT', 'PAID', 'CONFIRMED'].includes(status);
  return String(h`
    <li class="list-item">
      <div class="list-item-main">
        <p class="list-item-title">
          ${appointment.doctor_name ?? appointment.doctor ?? ''}
          ${raw(statusBadge(status))}
        </p>
        <div class="list-item-meta">
          <span>${formatDate(appointment.starts_at)}</span>
          <span>${formatTime(appointment.starts_at)}</span>
          <span>${modeLabel(appointment.mode)}</span>
          <span class="mono">${appointment.reference}</span>
        </div>
        ${appointment.clinic_name ? h`<div class="list-item-meta"><span>${appointment.clinic_name}</span></div>` : ''}
        <div class="list-item-meta">
          <span>${t('common.price')} : ${money(appointment.price)}</span>
          <span>${t('common.fee')} : ${money(appointment.service_fee)}</span>
        </div>
      </div>
      ${actionable
        ? h`
          <div class="list-item-actions">
            ${awaitingPayment
              ? h`<button class="btn" type="button" data-act="pay" data-id="${appointment.id}">${t('booking.payNow')}</button>`
              : ''}
            ${canCancel
              ? h`<button class="btn btn-ghost" type="button" data-act="cancel-booking" data-id="${appointment.id}">${t('booking.cancel')}</button>`
              : ''}
            ${['CONFIRMED', 'COMPLETED', 'PAID'].includes(status)
              ? h`<button class="btn btn-ghost" type="button" data-act="receipt" data-id="${appointment.id}">${t('booking.receipt')}</button>`
              : ''}
          </div>`
        : ''}
    </li>`);
}

export async function renderBookings({ state }) {
  void state;
  bindInteractions();
  const data = await api.get('/bookings?limit=50');
  const items = data.items ?? [];
  const now = Date.now();
  const upcoming = items.filter(
    (item) => new Date(item.starts_at).getTime() >= now - 4 * 3600_000 && !['CANCELLED', 'COMPLETED', 'NO_SHOW'].includes(item.status),
  );
  const past = items.filter((item) => !upcoming.includes(item));

  const pending = sessionStorage.getItem('rdvdz.pending');

  return String(h`
    <div class="stack">
      <div class="card">
        <div class="card-head">
          <h1>${t('booking.title')}</h1>
          <a class="btn btn-ghost" href="#/">${t('nav.find')}</a>
        </div>
        ${pending
          ? raw(
              notice(
                'warn',
                h`${t('booking.pendingPayment')} — <a href="#/bookings">${t('booking.payNow')}</a>`,
              ),
            )
          : ''}
        <h2>${t('booking.upcoming')}</h2>
        ${upcoming.length
          ? h`<ul class="list">${raw(upcoming.map((item) => bookingRow(item)).join(''))}</ul>`
          : emptyState({
              icon: '📅',
              title: t('booking.empty'),
              body: t('search.subtitle'),
              action: h`<a class="btn" href="#/">${t('nav.find')}</a>`,
            })}
      </div>

      ${past.length
        ? h`
          <div class="card">
            <h2>${t('booking.past')}</h2>
            <ul class="list">${raw(past.map((item) => bookingRow(item, { actionable: false })).join(''))}</ul>
          </div>`
        : ''}
    </div>`);
}
