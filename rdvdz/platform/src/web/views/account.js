/** Mon compte : profil, notifications, droits des personnes (loi 18-07). */

import { t, getLocale } from '../i18n.js';
import * as api from '../api.js';
import { h, raw, notice, emptyState, formatDay } from '../ui.js';
import { bindInteractions } from './bindings.js';

export async function renderAccount({ state }) {
  bindInteractions();
  const ar = getLocale() === 'ar';
  const [profile, notifications, preferences, wilayas] = await Promise.all([
    api.get('/me/profile'),
    api.get('/notifications'),
    api.get('/notifications/preferences'),
    api.get('/reference/wilayas'),
  ]);

  const user = profile.user;
  const patient = profile.patient;
  const channels = ['IN_APP', 'WHATSAPP', 'EMAIL', 'SMS'];

  const notificationRows = (notifications.items ?? [])
    .map(
      (item) => h`
        <li class="list-item">
          <div class="list-item-main">
            <p class="list-item-title">${item.body || item.template_code}</p>
            <div class="list-item-meta">
              <span>${formatDay(item.created_at)}</span>
              <span>${item.read_at ? '✓' : '•'}</span>
            </div>
          </div>
        </li>`,
    )
    .join('');

  const preferenceRows = channels
    .map((channel) => {
      const entries = (preferences.items ?? []).filter((item) => item.channel === channel);
      const enabled = entries.filter((item) => item.enabled).length;
      return String(h`
        <tr>
          <td>${channel}</td>
          <td>${enabled}/${entries.length}</td>
        </tr>`);
    })
    .join('');

  return String(h`
    <div class="stack">
      <div class="card">
        <div class="card-head">
          <h1>${t('account.title')}</h1>
          <span class="badge badge-grey">${user.role}</span>
        </div>
        <form data-form="profile" class="stack">
          <div class="field">
            <label for="full_name">${t('common.name')}</label>
            <input id="full_name" name="full_name" type="text" value="${user.full_name}" required
                   minlength="3" maxlength="160" />
          </div>
          <div class="field">
            <label>${t('common.phone')}</label>
            <input type="text" value="${user.phone}" readonly disabled />
            <div class="field-hint">${t('common.phone')} — ${t('common.required')}</div>
          </div>
          <div class="grid grid-2">
            <div class="field">
              <label for="wilaya_code">${t('common.wilaya')}</label>
              <select id="wilaya_code" name="wilaya_code">
                ${raw(
                  wilayas.items
                    .map(
                      (w) => h`<option value="${w.code}" ${patient?.wilaya_code === w.code ? 'selected' : ''}>
                        ${w.code} — ${ar ? w.name_ar : w.name_fr}
                      </option>`,
                    )
                    .join(''),
                )}
              </select>
            </div>
            <div class="field">
              <label for="commune">${t('common.commune')}</label>
              <input id="commune" name="commune" type="text" maxlength="120" value="${patient?.commune ?? ''}" />
            </div>
          </div>
          <div class="field">
            <label for="locale">Langue</label>
            <select id="locale" name="locale">
              <option value="fr" ${user.locale === 'fr' ? 'selected' : ''}>Français</option>
              <option value="ar" ${user.locale === 'ar' ? 'selected' : ''}>العربية</option>
            </select>
          </div>
          <button class="btn" type="submit">${t('common.save')}</button>
        </form>
      </div>

      <div class="grid grid-2">
        <div class="card">
          <h2>${t('account.notifications')}</h2>
          <div class="table-wrap">
            <table>
              <thead><tr><th>Canal</th><th>Actifs</th></tr></thead>
              <tbody>${raw(preferenceRows)}</tbody>
            </table>
          </div>
          ${notificationRows
            ? h`<ul class="list" style="margin-top:14px">${raw(notificationRows)}</ul>
                <button class="btn btn-ghost" type="button" data-act="read-all">${t('common.confirm')}</button>`
            : emptyState({ icon: '🔔', title: t('common.none'), body: t('account.notifications') })}
        </div>

        <div class="card">
          <h2>${t('account.password')}</h2>
          <form data-form="password" class="stack">
            <div class="field">
              <label for="currentPassword">${t('account.currentPassword')}</label>
              <input id="currentPassword" name="currentPassword" type="password" required
                     autocomplete="current-password" maxlength="128" />
            </div>
            <div class="field">
              <label for="newPassword">${t('account.newPassword')}</label>
              <input id="newPassword" name="newPassword" type="password" required minlength="10"
                     autocomplete="new-password" maxlength="128" />
            </div>
            <button class="btn" type="submit">${t('common.save')}</button>
          </form>
        </div>
      </div>

      <div class="card">
        <h2>${t('account.privacy')}</h2>
        ${raw(
          notice(
            'info',
            h`${t('footer.data')} — ${t('footer.legal')}`,
          ),
        )}
        <div class="btn-row">
          <button class="btn btn-ghost" type="button" data-act="export-data">${t('account.export')}</button>
          <button class="btn btn-danger" type="button" data-act="delete-account">${t('account.delete')}</button>
        </div>
      </div>
    </div>`);
}
