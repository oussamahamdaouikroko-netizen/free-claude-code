/** Administration : vue d'ensemble, vérifications, utilisateurs, audit, réglages. */

import { t } from '../i18n.js';
import * as api from '../api.js';
import {
  h,
  raw,
  money,
  formatDate,
  statusBadge,
  emptyState,
  notice,
} from '../ui.js';
import { bindInteractions } from './bindings.js';

export async function renderAdmin({ state }) {
  bindInteractions();
  const [overview, pending, users, reviews, audit, devices, rules] = await Promise.all([
    api.get('/admin/overview'),
    api.get('/admin/doctors/pending'),
    api.get('/admin/users?limit=20'),
    api.get('/admin/reviews?status=PENDING'),
    api.get('/admin/audit-logs?limit=20'),
    api.get('/admin/desktop-devices'),
    api.get('/admin/commission-rules'),
  ]);

  const pendingRows = pending.items
    .map(
      (doctor) => h`
        <li class="list-item">
          <div class="list-item-main">
            <p class="list-item-title">${doctor.full_name}</p>
            <div class="list-item-meta">
              <span class="mono">${doctor.phone}</span>
              <span>${doctor.specialty_fr}</span>
              <span class="mono">${doctor.license_no ?? '—'}</span>
              <span>${formatDate(doctor.created_at, { withWeekday: false })}</span>
            </div>
          </div>
          <div class="list-item-actions">
            <button class="btn" type="button" data-act="admin-verify" data-id="${doctor.id}">${t('admin.verify')}</button>
            <button class="btn btn-danger" type="button" data-act="admin-reject" data-id="${doctor.id}">
              ${t('admin.reject')}
            </button>
          </div>
        </li>`,
    )
    .join('');

  const userRows = users.items
    .map(
      (user) => h`
        <tr>
          <td>${user.full_name}</td>
          <td><span class="badge badge-grey">${user.role}</span></td>
          <td class="mono">${user.phone}</td>
          <td>${raw(statusBadge(user.status))}</td>
          <td>${formatDate(user.created_at, { withWeekday: false })}</td>
          <td class="right">
            ${user.status === 'ACTIVE'
              ? h`<button class="btn btn-ghost" type="button" data-act="admin-suspend" data-id="${user.id}">${t('admin.suspend')}</button>`
              : h`<button class="btn btn-ghost" type="button" data-act="admin-activate" data-id="${user.id}">${t('admin.activate')}</button>`}
          </td>
        </tr>`,
    )
    .join('');

  const reviewRows = reviews.items
    .map(
      (review) => h`
        <li class="list-item">
          <div class="list-item-main">
            <p class="list-item-title">${review.doctor_name} — ${'★'.repeat(review.rating)}</p>
            <p class="small">${review.comment}</p>
            <div class="list-item-meta"><span>${review.patient_name}</span></div>
          </div>
          <div class="list-item-actions">
            <button class="btn" type="button" data-act="moderate" data-status="APPROVED" data-id="${review.id}">
              ${t('admin.approve')}
            </button>
            <button class="btn btn-danger" type="button" data-act="moderate" data-status="REJECTED" data-id="${review.id}">
              ${t('admin.rejectReview')}
            </button>
          </div>
        </li>`,
    )
    .join('');

  const auditRows = audit.items
    .map(
      (entry) => h`
        <tr>
          <td class="mono">${entry.created_at?.slice(0, 19).replace('T', ' ')}</td>
          <td><span class="mono">${entry.action}</span></td>
          <td>${entry.entity ?? ''}</td>
          <td class="mono small">${String(entry.entity_id ?? '').slice(0, 8)}</td>
          <td class="mono small">${entry.ip ?? ''}</td>
        </tr>`,
    )
    .join('');

  const deviceRows = devices.items
    .map(
      (device) => h`
        <tr>
          <td>${device.product}</td>
          <td>${device.name || '—'}</td>
          <td>${device.doctor_name ?? '—'}</td>
          <td>${device.last_seen_at ? formatDate(device.last_seen_at, { withWeekday: false }) : '—'}</td>
          <td>${device.pending}</td>
          <td>${device.revoked_at ? statusBadge('SUSPENDED') : statusBadge('ACTIVE')}</td>
        </tr>`,
    )
    .join('');

  const ruleRows = rules.items
    .map(
      (rule) => h`
        <tr>
          <td>${rule.scope}</td>
          <td>${Number(rule.platform_pct)} %</td>
          <td>${Number(rule.branch_pct)} %</td>
          <td>${Number(rule.operator_pct)} %</td>
          <td>${rule.psp_fixed}</td>
          <td>${rule.active ? statusBadge('ACTIVE') : '—'}</td>
        </tr>`,
    )
    .join('');

  return String(h`
    <div class="stack">
      <div class="card">
        <div class="card-head">
          <h1>${t('admin.title')}</h1>
          <button class="btn btn-ghost" type="button" data-act="export" data-kind="overview">
            ${t('admin.reportExport')}
          </button>
        </div>
        <div class="grid grid-4">
          <div class="stat">
            <div class="stat-label">${t('common.patient')}</div>
            <div class="stat-value">${overview.patients}</div>
          </div>
          <div class="stat">
            <div class="stat-label">${t('common.doctor')}</div>
            <div class="stat-value">${overview.doctors.verified}/${overview.doctors.total}</div>
            <div class="stat-sub">${t('search.verified')}</div>
          </div>
          <div class="stat">
            <div class="stat-label">${t('ops.bookings')}</div>
            <div class="stat-value">${overview.bookings.total}</div>
            <div class="stat-sub">${overview.conversion.rate} %</div>
          </div>
          <div class="stat">
            <div class="stat-label">CA réel</div>
            <div class="stat-value">${money(overview.revenue.confirmed_revenue)}</div>
            <div class="stat-sub">Simulation : ${money(overview.revenue.simulated_revenue)}</div>
          </div>
        </div>
      </div>

      <div class="card">
        <h2>${t('admin.pending')}</h2>
        ${pendingRows
          ? h`<ul class="list">${raw(pendingRows)}</ul>`
          : emptyState({ icon: '✅', title: t('common.none'), body: t('admin.pending') })}
      </div>

      <div class="card">
        <h2>${t('admin.reviews')}</h2>
        ${reviewRows
          ? h`<ul class="list">${raw(reviewRows)}</ul>`
          : emptyState({ icon: '⭐', title: t('common.none'), body: t('doctor.noReviews') })}
      </div>

      <div class="card">
        <h2>${t('admin.users')}</h2>
        <div class="table-wrap">
          <table>
            <thead><tr>
              <th>${t('common.name')}</th>
              <th>Rôle</th>
              <th>${t('common.phone')}</th>
              <th>${t('common.status')}</th>
              <th>${t('common.date')}</th>
              <th></th>
            </tr></thead>
            <tbody>${raw(userRows)}</tbody>
          </table>
        </div>
      </div>

      <div class="grid grid-2">
        <div class="card">
          <h2>${t('admin.commissions')}</h2>
          <div class="table-wrap">
            <table>
              <thead><tr>
                <th>Portée</th><th>Plateforme</th><th>Branche</th><th>Opérateur</th><th>PSP (c.)</th><th></th>
              </tr></thead>
              <tbody>${raw(ruleRows)}</tbody>
            </table>
          </div>
          <form data-form="commission" class="stack" style="margin-top:16px">
            <div class="field">
              <label for="scope">Portée</label>
              <select id="scope" name="scope">
                <option value="BOOKING_FEE">BOOKING_FEE</option>
                <option value="TELECONSULT">TELECONSULT</option>
              </select>
            </div>
            <div class="grid grid-3" style="gap:8px">
              <div class="field"><label for="platform_pct">%</label><input id="platform_pct" name="platform_pct" type="number" min="0" max="100" required /></div>
              <div class="field"><label for="branch_pct">%</label><input id="branch_pct" name="branch_pct" type="number" min="0" max="100" value="0" /></div>
              <div class="field"><label for="operator_pct">%</label><input id="operator_pct" name="operator_pct" type="number" min="0" max="100" value="0" /></div>
            </div>
            <div class="field">
              <label for="psp_fixed">PSP (centimes)</label>
              <input id="psp_fixed" name="psp_fixed" type="number" min="0" value="0" />
            </div>
            <button class="btn" type="submit">${t('common.save')}</button>
          </form>
        </div>

        <div class="card">
          <h2>${t('admin.devices')}</h2>
          ${deviceRows
            ? h`<div class="table-wrap"><table>
                <thead><tr>
                  <th>Produit</th><th>Nom</th><th>${t('common.doctor')}</th>
                  <th>Vu le</th><th>File</th><th>État</th>
                </tr></thead>
                <tbody>${raw(deviceRows)}</tbody>
              </table></div>`
            : emptyState({ icon: '🖥️', title: t('common.none'), body: t('admin.devices') })}
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <h2>${t('admin.audit')}</h2>
          <button class="btn btn-ghost" type="button" data-act="export" data-kind="revenue">
            ${t('admin.reportExport')}
          </button>
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr>
              <th>${t('common.date')}</th><th>Action</th><th>Objet</th><th>ID</th><th>IP</th>
            </tr></thead>
            <tbody>${raw(auditRows)}</tbody>
          </table>
        </div>
        ${raw(notice('info', `Connecté en tant que ${state.user.full_name} (${state.user.role}).`))}
      </div>
    </div>`);
}
