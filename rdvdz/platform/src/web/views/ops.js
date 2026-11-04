/**
 * Console opérateur / branche.
 *
 * Cloisonnement rappelé dans l'interface : un opérateur ne voit que sa branche,
 * et **aucune donnée médicale** ne lui est présentée (ni note, ni symptôme).
 */

import { t, getLocale } from '../i18n.js';
import * as api from '../api.js';
import {
  h,
  raw,
  money,
  formatTime,
  formatDate,
  statusBadge,
  modeLabel,
  emptyState,
  notice,
  isoDay,
} from '../ui.js';
import { bindInteractions } from './bindings.js';

export async function renderOps({ state }) {
  bindInteractions();
  const ar = getLocale() === 'ar';
  const [dashboard, branches, todays, wilayas] = await Promise.all([
    api.get('/ops/dashboard'),
    api.get('/branches'),
    api.get('/bookings?limit=30&from=' + isoDay()),
    api.get('/reference/wilayas'),
  ]);

  const search = new URLSearchParams(window.location.hash.split('?')[1] ?? '');
  const patientQuery = search.get('q') ?? '';
  const patients = patientQuery
    ? (await api.get(`/ops/patients?q=${encodeURIComponent(patientQuery)}`)).items
    : [];

  const selectedPatient = search.get('patient') ?? '';
  const branchId = branches.items[0]?.id ?? '';
  const doctors = await api.get('/ops/doctors?limit=20');

  const branchNotice =
    branches.items.length === 0 ? notice('warn', t('ops.noBranch')) : '';

  const patientRows = patients
    .map(
      (patient) => h`
        <li class="list-item">
          <div class="list-item-main">
            <p class="list-item-title">${patient.full_name}</p>
            <div class="list-item-meta">
              <span class="mono">${patient.phone}</span>
              <span>${patient.wilaya_code ?? ''}</span>
            </div>
          </div>
          <div class="list-item-actions">
            <a class="btn btn-ghost" href="#/ops?patient=${patient.id}">
              ${selectedPatient === patient.id ? t('common.yes') : t('ops.book')}
            </a>
          </div>
        </li>`,
    )
    .join('');

  const bookingRows = (todays.items ?? [])
    .map(
      (item) => h`
        <tr>
          <td>${formatDate(item.starts_at, { withWeekday: false })} ${formatTime(item.starts_at)}</td>
          <td>${item.patient_name ?? item.patient ?? ''}</td>
          <td>${item.doctor_name ?? ''}</td>
          <td>${raw(statusBadge(item.status))}</td>
          <td>${modeLabel(item.mode)}</td>
          <td class="mono">${item.reference}</td>
          <td class="right">
            ${['AWAITING_PAYMENT', 'PENDING'].includes(item.status)
              ? h`<button class="btn btn-ghost" type="button" data-act="ops-cash" data-id="${item.id}">${t('ops.cash')}</button>`
              : ''}
          </td>
        </tr>`,
    )
    .join('');

  return String(h`
    <div class="stack">
      ${raw(branchNotice)}
      <div class="card">
        <div class="card-head">
          <h1>${t('ops.title')}</h1>
          <span class="badge badge-grey">${branches.items.map((b) => b.name).join(' · ') || '—'}</span>
        </div>
        <div class="grid grid-4">
          <div class="stat">
            <div class="stat-label">${t('ops.bookings')}</div>
            <div class="stat-value">${dashboard.bookings.total}</div>
          </div>
          <div class="stat">
            <div class="stat-label">${t('common.today')}</div>
            <div class="stat-value">${dashboard.bookings.today}</div>
          </div>
          <div class="stat">
            <div class="stat-label">${t('status.PENDING')}</div>
            <div class="stat-value">${dashboard.bookings.pending}</div>
          </div>
          <div class="stat">
            <div class="stat-label">${t('status.CONFIRMED')}</div>
            <div class="stat-value">${dashboard.bookings.confirmed}</div>
          </div>
        </div>
        <div class="grid grid-3" style="margin-top:16px">
          <div class="stat">
            <div class="stat-label">${t('common.total')} réel</div>
            <div class="stat-value">${money(dashboard.revenue.confirmed_revenue)}</div>
          </div>
          <div class="stat">
            <div class="stat-label">${t('booking.pendingPayment')}</div>
            <div class="stat-value">${money(dashboard.revenue.pending_amount)}</div>
          </div>
          <div class="stat">
            <div class="stat-label">Simulation</div>
            <div class="stat-value">${money(dashboard.revenue.simulated_revenue)}</div>
            <div class="stat-sub">${t('payment.simulated')}</div>
          </div>
        </div>
      </div>

      <div class="grid grid-2">
        <div class="card">
          <h2>${t('ops.patients')}</h2>
          <form data-form="ops-search">
            <div class="field">
              <label for="q">${t('ops.searchPatient')}</label>
              <input id="q" name="q" type="search" value="${patientQuery}" />
            </div>
            <button class="btn btn-ghost" type="submit">${t('common.search')}</button>
          </form>
          ${patientRows ? h`<ul class="list">${raw(patientRows)}</ul>` : ''}

          <h3 style="margin-top:20px">${t('ops.newPatient')}</h3>
          <form data-form="ops-patient" class="stack">
            <div class="field">
              <label for="full_name">${t('common.name')}</label>
              <input id="full_name" name="full_name" type="text" required minlength="3" maxlength="160" />
            </div>
            <div class="field">
              <label for="phone">${t('common.phone')}</label>
              <input id="phone" name="phone" type="tel" required maxlength="30" placeholder="0550 12 34 56" />
            </div>
            <div class="field">
              <label for="wilaya_code">${t('common.wilaya')}</label>
              <select id="wilaya_code" name="wilaya_code">
                ${raw(
                  wilayas.items
                    .map((w) => h`<option value="${w.code}" ${w.code === 39 ? 'selected' : ''}>${w.code} — ${ar ? w.name_ar : w.name_fr}</option>`)
                    .join(''),
                )}
              </select>
            </div>
            <div class="field">
              <label for="commune">${t('common.commune')}</label>
              <input id="commune" name="commune" type="text" maxlength="120" />
            </div>
            <button class="btn" type="submit">${t('ops.newPatient')}</button>
          </form>
        </div>

        <div class="card">
          <h2>${t('ops.book')}</h2>
          ${selectedPatient
            ? h`
              <form data-form="ops-booking" class="stack">
                <input type="hidden" name="patient_id" value="${selectedPatient}" />
                <input type="hidden" name="branch_id" value="${branchId}" />
                <div class="field">
                  <label for="slot_id">${t('doctor.chooseSlot')}</label>
                  <select id="slot_id" name="slot_id" required>
                    ${raw(
                      (doctors.items ?? [])
                        .flatMap((doctor) =>
                          (doctor.next_slots ?? []).map(
                            (slot) =>
                              h`<option value="${slot.id}">
                                  ${doctor.full_name} — ${formatDate(slot, { withWeekday: false })} ${formatTime(slot)}
                                </option>`,
                          ),
                        )
                        .join(''),
                    )}
                  </select>
                </div>
                <div class="field">
                  <label for="notes">${t('common.notes')}</label>
                  <input id="notes" name="notes" type="text" maxlength="500" />
                </div>
                <button class="btn" type="submit">${t('ops.book')}</button>
              </form>`
            : notice('info', t('ops.searchPatient'))}
        </div>
      </div>

      <div class="card">
        <h2>${t('ops.bookings')}</h2>
        ${bookingRows
          ? h`<div class="table-wrap"><table>
              <thead><tr>
                <th>${t('common.date')}</th>
                <th>${t('common.patient')}</th>
                <th>${t('common.doctor')}</th>
                <th>${t('common.status')}</th>
                <th>${t('common.time')}</th>
                <th>${t('common.reference')}</th>
                <th></th>
              </tr></thead>
              <tbody>${raw(bookingRows)}</tbody>
            </table></div>`
          : emptyState({ icon: '📋', title: t('booking.empty'), body: t('doctor.noAppointments') })}
      </div>
    </div>`);
}
