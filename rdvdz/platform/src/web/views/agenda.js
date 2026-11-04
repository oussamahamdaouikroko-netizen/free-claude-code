/** Espace médecin : agenda du jour, statuts, disponibilités, congés. */

import { t, getLocale } from '../i18n.js';
import * as api from '../api.js';
import {
  h,
  raw,
  money,
  formatTime,
  formatDay,
  statusBadge,
  modeLabel,
  emptyState,
  notice,
  isoDay,
} from '../ui.js';
import { bindInteractions } from './bindings.js';

const WEEKDAYS = [0, 1, 2, 3, 4, 5];
const WEEKDAY_LABEL = {
  fr: ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'],
  ar: ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'],
};

function appointmentRow(appointment) {
  const actions = [];
  if (appointment.status === 'CONFIRMED') {
    actions.push(
      h`<button class="btn" type="button" data-act="complete-booking" data-id="${appointment.id}">${t('status.COMPLETED')}</button>`,
      h`<button class="btn btn-ghost" type="button" data-act="no-show" data-id="${appointment.id}">${t('status.NO_SHOW')}</button>`,
    );
  }
  if (appointment.status === 'PENDING') {
    actions.push(
      h`<button class="btn" type="button" data-act="accept-booking" data-id="${appointment.id}">${t('common.confirm')}</button>`,
      h`<button class="btn btn-danger" type="button" data-act="reject-booking" data-id="${appointment.id}">${t('admin.reject')}</button>`,
    );
  }
  return String(h`
    <li class="list-item">
      <div class="list-item-main">
        <p class="list-item-title">
          ${formatTime(appointment.starts_at)} — ${appointment.patient_name} ${raw(statusBadge(appointment.status))}
        </p>
        <div class="list-item-meta">
          <span>${modeLabel(appointment.mode)}</span>
          <span class="mono">${appointment.reference}</span>
          ${appointment.patient_phone ? h`<span class="mono">${appointment.patient_phone}</span>` : ''}
        </div>
      </div>
      <div class="list-item-actions">${raw(actions.join(''))}</div>
    </li>`);
}

export async function renderDoctorAgenda({ state }) {
  bindInteractions();
  const lang = getLocale() === 'ar' ? 'ar' : 'fr';
  const today = isoDay();
  const [profile, schedule, availability] = await Promise.all([
    api.get('/me/profile'),
    api.get(`/doctor/schedule?day=${today}`),
    api.get('/me/availability'),
  ]);

  const doctor = profile.doctor ?? {};
  const verified = doctor.verified;

  const hoursByDay = new Map((availability.hours ?? []).map((entry) => [Number(entry.weekday), entry]));
  const hoursForm = h`
    <form data-form="availability" class="stack">
      <p class="muted small">${t('doctor.availability')}</p>
      ${raw(
        WEEKDAYS.map(
          (weekday) => h`
            <div class="grid grid-3" style="align-items:end;gap:8px">
              <div class="field" style="margin:0">
                <label>${WEEKDAY_LABEL[lang][weekday]}</label>
                <span class="muted small">${weekday}</span>
              </div>
              <div class="field" style="margin:0">
                <label for="opens_${weekday}">${t('common.from')}</label>
                <input id="opens_${weekday}" name="opens_${weekday}" type="time"
                       value="${hoursByDay.get(weekday)?.opens ?? ''}" />
              </div>
              <div class="field" style="margin:0">
                <label for="closes_${weekday}">${t('common.to')}</label>
                <input id="closes_${weekday}" name="closes_${weekday}" type="time"
                       value="${hoursByDay.get(weekday)?.closes ?? ''}" />
              </div>
            </div>`,
        ).join(''),
      )}
      <button class="btn" type="submit">${t('common.save')}</button>
    </form>`;

  const timeOff = availability.time_off ?? [];

  return String(h`
    <div class="stack">
      ${verified ? '' : raw(notice('warn', t('auth.doctorPending')))}
      <div class="card">
        <div class="card-head">
          <div>
            <h1>${t('doctor.dashboard')}</h1>
            <p class="muted small">${state.user.full_name} · ${formatDay(`${today}T12:00:00Z`)}</p>
          </div>
          <div class="pill-row">
            <span class="badge badge-grey">${t('common.price')} : ${money(doctor.consultation_fee)}</span>
            <span class="badge badge-grey">${doctor.slot_minutes} ${t('common.time')}.</span>
          </div>
        </div>
        <h2>${t('doctor.todaySchedule')}</h2>
        ${schedule.items.length
          ? h`<ul class="list">${raw(schedule.items.map(appointmentRow).join(''))}</ul>`
          : emptyState({ icon: '🗓️', title: t('doctor.noAppointments'), body: t('doctor.chooseSlot') })}
      </div>

      <div class="grid grid-2">
        <div class="card">
          <h2>${t('doctor.availability')}</h2>
          ${raw(hoursForm)}
        </div>
        <div class="card">
          <h2>${t('doctor.timeOff')}</h2>
          <form data-form="time-off" class="stack">
            <div class="field">
              <label for="starts_at">${t('common.date')} — début</label>
              <input id="starts_at" name="starts_at" type="datetime-local" required />
            </div>
            <div class="field">
              <label for="ends_at">${t('common.date')} — fin</label>
              <input id="ends_at" name="ends_at" type="datetime-local" required />
            </div>
            <div class="field">
              <label for="reason">${t('common.reason')}</label>
              <input id="reason" name="reason" type="text" maxlength="200" />
            </div>
            <button class="btn btn-ghost" type="submit">${t('common.save')}</button>
          </form>
          ${timeOff.length
            ? h`<ul class="list" style="margin-top:14px">${raw(
                timeOff
                  .map(
                    (entry) => h`
                      <li class="list-item">
                        <div class="list-item-main">
                          <p class="list-item-title">${formatDay(entry.starts_at)}</p>
                          <div class="list-item-meta"><span>${entry.reason || t('common.none')}</span></div>
                        </div>
                      </li>`,
                  )
                  .join(''),
              )}</ul>`
            : ''}
        </div>
      </div>
    </div>`);
}
