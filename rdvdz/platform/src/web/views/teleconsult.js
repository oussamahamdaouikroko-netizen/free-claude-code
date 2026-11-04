/**
 * Téléconsultation côté patient.
 *
 * L'écran affiche l'état réel de la fonctionnalité : si elle est désactivée
 * côté serveur (`LEGAL_BLOCKED`), le formulaire n'est pas proposé — on ne
 * laisse jamais croire qu'un acte clinique est possible quand il ne l'est pas.
 */

import { t } from '../i18n.js';
import * as api from '../api.js';
import { h, raw, formatDay, statusBadge, kindLabel, emptyState, notice } from '../ui.js';
import { bindInteractions } from './bindings.js';

export async function renderTeleconsult({ state }) {
  void state;
  bindInteractions();
  const [config, list] = await Promise.all([
    api.get('/teleconsult/config'),
    api.get('/consultations?limit=50'),
  ]);

  const enabled = config.enabled;
  const noticeAr = document.documentElement.lang === 'ar' ? config.noticeAr : config.noticeFr;

  const rows = (list.items ?? []).map(
    (item) => h`
      <li class="list-item">
        <div class="list-item-main">
          <p class="list-item-title">${item.doctor_name} ${raw(statusBadge(item.status))}</p>
          <div class="list-item-meta">
            <span>${kindLabel(item.kind)}</span>
            <span class="mono">${item.reference}</span>
            <span>${formatDay(item.created_at)}</span>
          </div>
          <div class="list-item-meta"><span>${item.subject}</span></div>
        </div>
        <div class="list-item-actions">
          ${item.kind === 'VIDEO_SCHEDULED'
            ? h`<button class="btn btn-ghost" type="button" data-act="teleconsult-room" data-id="${item.id}">
                  ${t('teleconsult.title')}
                </button>`
            : ''}
        </div>
      </li>`,
  );

  // Choix du médecin : on propose ceux qui acceptent la téléconsultation.
  let doctorOptions = [];
  if (enabled) {
    const doctors = await api.get('/doctors?teleconsult=1&limit=30');
    doctorOptions = doctors.items ?? [];
  }

  const form = enabled
    ? h`
      <form data-form="teleconsult" class="stack">
        <div class="field">
          <label for="doctor_id">${t('common.doctor')}</label>
          <select id="doctor_id" name="doctor_id" required>
            ${raw(
              doctorOptions
                .map(
                  (doctor) => h`<option value="${doctor.id}">${doctor.full_name} — ${
                    document.documentElement.lang === 'ar' ? doctor.specialty_ar : doctor.specialty_fr
                  }</option>`,
                )
                .join(''),
            )}
          </select>
        </div>
        <div class="field">
          <label for="kind">${t('teleconsult.kind')}</label>
          <select id="kind" name="kind">
            ${raw(
              ['ASYNC_TEXT', 'DOCUMENT_REVIEW', 'VIDEO_SCHEDULED', 'FOLLOW_UP']
                .map((kind) => h`<option value="${kind}">${kindLabel(kind)}</option>`)
                .join(''),
            )}
          </select>
        </div>
        <div class="field">
          <label for="subject">${t('teleconsult.subject')}</label>
          <input id="subject" name="subject" type="text" required minlength="3" maxlength="200" />
        </div>
        <div class="field">
          <label for="symptom_summary">${t('teleconsult.summary')}</label>
          <textarea id="symptom_summary" name="symptom_summary" required minlength="10" maxlength="4000"
                    rows="5"></textarea>
        </div>
        <label class="checkbox">
          <input type="checkbox" name="consent" required />
          <span>${t('teleconsult.consent')}</span>
        </label>
        <label class="checkbox">
          <input type="checkbox" name="emergency_ack" required />
          <span>${t('teleconsult.emergency')}</span>
        </label>
        <div class="btn-row">
          <button class="btn" type="submit">${t('teleconsult.submit')}</button>
        </div>
      </form>`
    : notice('warn', t('teleconsult.disabled'));

  return String(h`
    <div class="stack">
      ${raw(notice('warn', noticeAr || t('teleconsult.notice')))}
      ${config.paidEnabled ? '' : raw(notice('info', t('teleconsult.paidBlocked')))}
      <div class="card">
        <h1>${t('teleconsult.title')}</h1>
        ${raw(form)}
      </div>
      <div class="card">
        <h2>${t('teleconsult.mine')}</h2>
        <div data-region="video-room"></div>
        ${rows.length
          ? h`<ul class="list">${raw(rows.join(''))}</ul>`
          : emptyState({ icon: '💬', title: t('teleconsult.empty'), body: t('doctor.noReviews') })}
      </div>
    </div>`);
}
