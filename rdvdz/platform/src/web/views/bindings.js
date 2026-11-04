/**
 * Branchements d'événements des vues.
 *
 * Tous les écouteurs sont délégués sur `document` (une seule fois) : les vues
 * peuvent remplacer leur HTML sans jamais laisser d'écouteur orphelin.
 */

import { t } from '../i18n.js';
import * as api from '../api.js';
import { toast, money, formatDate, formatTime, h, raw } from '../ui.js';
import { go, render } from '../app.js';
import { runSearch } from './search.js';
import { proceedToPayment } from './payment.js';

let bound = false;

/** Active la délégation globale (idempotent). */
export function bindInteractions() {
  if (bound) return;
  bound = true;

  document.addEventListener('submit', async (event) => {
    const form = event.target.closest('form[data-form]');
    if (!form) return;
    event.preventDefault();
    const kind = form.dataset.form;
    try {
      if (kind === 'search') await runSearch(new FormData(form));
      else if (kind === 'ops-search') {
        const q = String(new FormData(form).get('q') ?? '').trim();
        go(q ? `/ops?q=${encodeURIComponent(q)}` : '/ops');
      }
      else if (kind === 'login') await submitLogin(form);
      else if (kind === 'register') await submitRegister(form);
      else if (kind === 'booking') await submitBooking(form);
      else if (kind === 'teleconsult') await submitTeleconsult(form);
      else if (kind === 'profile') await submitProfile(form);
      else if (kind === 'password') await submitPassword(form);
      else if (kind === 'ops-patient') await submitOpsPatient(form);
      else if (kind === 'ops-booking') await submitOpsBooking(form);
      else if (kind === 'availability') await submitAvailability(form);
      else if (kind === 'settings') await submitSetting(form);
      else if (kind === 'commission') await submitCommission(form);
      else if (kind === 'time-off') await submitTimeOff(form);
    } catch (error) {
      toast(t(`errors.${error.code}`) === `errors.${error.code}` ? error.message : t(`errors.${error.code}`), 'error');
    }
  });

  document.addEventListener('click', async (event) => {
    const trigger = event.target.closest('[data-act]');
    if (!trigger) return;
    const act = trigger.dataset.act;
    try {
      if (act === 'pay') await payNow(trigger.dataset.id);
      else if (act === 'cancel-booking') await cancelBooking(trigger.dataset.id);
      else if (act === 'reschedule') await rescheduleBooking(trigger.dataset.id);
      else if (act === 'receipt') await api.openReceipt(`/bookings/${trigger.dataset.id}/receipt`);
      else if (act === 'teleconsult-room') await openVideoRoom(trigger.dataset.id);
      else if (act === 'reset-search') {
        const form = document.querySelector('form[data-form="search"]');
        form?.reset();
        await runSearch(new FormData(form));
      } else if (act === 'accept-booking') await doctorAction(trigger.dataset.id, 'confirm');
      else if (act === 'reject-booking') await doctorAction(trigger.dataset.id, 'reject');
      else if (act === 'complete-booking') await doctorAction(trigger.dataset.id, 'complete');
      else if (act === 'no-show') await doctorAction(trigger.dataset.id, 'no-show');
      else if (act === 'ops-cash') await opsCash(trigger.dataset.id);
      else if (act === 'admin-verify') await adminVerify(trigger.dataset.id);
      else if (act === 'admin-reject') await adminReject(trigger.dataset.id);
      else if (act === 'admin-suspend') await adminSuspend(trigger.dataset.id);
      else if (act === 'admin-activate') await adminActivate(trigger.dataset.id);
      else if (act === 'moderate') await moderate(trigger.dataset.id, trigger.dataset.status);
      else if (act === 'export') await exportReport(trigger.dataset.kind);
      else if (act === 'select-slot') selectSlot(trigger);
      else if (act === 'select-day') await switchDay(trigger);
      else if (act === 'export-data') await api.download('/me/export', 'mes-donnees-rdvdz.json');
      else if (act === 'delete-account') await deleteAccount();
      else if (act === 'read-all') {
        await api.post('/notifications/read-all', {}, { csrf: api.getCsrf() });
        await render();
      }
    } catch (error) {
      toast(t(`errors.${error.code}`), 'error');
    }
  });

  // Un seul créneau sélectionné à la fois.
  document.addEventListener('click', (event) => {
    const slot = event.target.closest('[data-slot-id]');
    if (!slot) return;
    document.querySelectorAll('[data-slot-id]').forEach((node) => node.setAttribute('aria-pressed', 'false'));
    slot.setAttribute('aria-pressed', 'true');
    const hidden = document.querySelector('input[name="slot_id"]');
    if (hidden) hidden.value = slot.dataset.slotId;
    const summary = document.querySelector('[data-region="booking-summary"]');
    if (summary) {
      const fee = Number(document.body.dataset.serviceFee ?? 0);
      summary.innerHTML = String(h`
        <div class="notice notice-info">
          ${fee > 0 ? t('doctor.payRequired') : t('doctor.freeBooking')}
          ${fee > 0 ? h` ${t('common.fee')} : <strong>${money(fee)}</strong>` : ''}
        </div>`);
    }
  });
}

/* ---------------------------------- auth ---------------------------------- */

async function submitLogin(form) {
  const data = new FormData(form);
  const result = await api.post('/auth/login', {
    identifier: String(data.get('identifier') ?? '').trim(),
    password: String(data.get('password') ?? ''),
  });
  api.setCsrf(result.csrf_token);
  const { refreshSession } = await import('../app.js');
  await refreshSession();
  toast(`${t('auth.welcome')}, ${result.user.full_name}`, 'success');
  const next = sessionStorage.getItem('rdvdz.next');
  sessionStorage.removeItem('rdvdz.next');
  go(next && next !== '/login' ? next : homeFor(result.user.role));
}

export function homeFor(role) {
  if (role === 'PATIENT') return '/bookings';
  if (role === 'DOCTOR') return '/doctor';
  if (role === 'ADMIN' || role === 'SUPER_ADMIN') return '/admin';
  return '/ops';
}

async function submitRegister(form) {
  const data = new FormData(form);
  const role = data.get('role') === 'DOCTOR' ? 'DOCTOR' : 'PATIENT';
  const payload = {
    fullName: String(data.get('fullName') ?? '').trim(),
    phone: String(data.get('phone') ?? '').trim(),
    password: String(data.get('password') ?? ''),
    locale: document.documentElement.lang === 'ar' ? 'ar' : 'fr',
    role,
    consent: data.get('consent') === 'on',
  };
  const wilaya = data.get('wilaya_code');
  if (wilaya) payload.wilayaCode = Number(wilaya);
  if (role === 'DOCTOR') {
    payload.doctor = {
      specialtyCode: String(data.get('specialtyCode') ?? 'GENERAL'),
      licenseNo: String(data.get('licenseNo') ?? '').trim() || null,
    };
  }
  await api.post('/auth/register', payload);
  // Inscription réussie : on connecte directement (le compte patient est actif).
  const login = await api.post('/auth/login', { identifier: payload.phone, password: payload.password });
  api.setCsrf(login.csrf_token);
  const { refreshSession } = await import('../app.js');
  await refreshSession();
  if (role === 'DOCTOR') {
    toast(t('auth.doctorPending'), 'success');
    go('/doctor');
  } else {
    toast(t('auth.welcome'), 'success');
    go('/bookings');
  }
}

/* -------------------------------- réservation ----------------------------- */

function selectSlot(trigger) {
  if (trigger.disabled) return;
  const form = document.querySelector('form[data-form="booking"]');
  if (form) {
    form.querySelector('#slot_id').value = trigger.dataset.slotId;
    form.querySelector('[data-region="booking-action"]').innerHTML =
      `<button class="btn" type="submit">${t('doctor.book')}</button>`;
  }
  document.querySelectorAll('[data-slot]').forEach((node) => node.setAttribute('aria-pressed', 'false'));
  trigger.setAttribute('aria-pressed', 'true');
}

async function switchDay(trigger) {
  await runDay(trigger);
}

/** Charge les créneaux d'un onglet de jour (utilisé aussi au montage). */
export async function runDay(trigger) {
  const day = trigger.dataset.day;
  document.querySelectorAll('[data-day]').forEach((node) => node.setAttribute('aria-pressed', 'false'));
  trigger.setAttribute('aria-pressed', 'true');
  const doctorId = trigger.dataset.doctor;
  const region = document.querySelector('[data-region="slots"]');
  if (!region) return;
  region.innerHTML = '<div class="skeleton"><div class="skeleton-line"></div></div>';
  const data = await api.get(`/doctors/${doctorId}/slots?from=${day}&to=${day}`);
  const { renderSlots } = await import('./doctor.js');
  region.innerHTML = renderSlots(data.items);
  const hidden = document.querySelector('input[name="slot_id"]');
  if (hidden) hidden.value = '';
}

async function submitBooking(form) {
  const data = new FormData(form);
  const slotId = String(data.get('slot_id') ?? '');
  if (!slotId) {
    toast(t('doctor.chooseSlot'), 'error');
    return;
  }
  const button = form.querySelector('button[type="submit"]');
  if (button) button.setAttribute('aria-busy', 'true');

  let result;
  try {
    result = await api.post(
      '/bookings',
      { slot_id: slotId, notes: String(data.get('notes') ?? '') },
      { csrf: api.getCsrf(), headers: { 'Idempotency-Key': api.idempotencyKey() } },
    );
  } finally {
    if (button) button.removeAttribute('aria-busy');
  }

  if (result.replayed) {
    toast(t('booking.confirmed'), 'success');
  }

  if (!result.payment_required) {
    toast(t('doctor.freeBooking'), 'success');
    go('/bookings');
    return;
  }

  // Créneau verrouillé : on enchaîne sur le paiement, avec avertissement si
  // l'utilisateur quitte la page (le verrou expire côté serveur).
  sessionStorage.setItem(
    'rdvdz.pending',
    JSON.stringify({
      appointmentId: result.appointment.id,
      reference: result.appointment.reference,
      holdExpiresAt: result.hold_expires_at,
    }),
  );
  await proceedToPayment(result.appointment.id, result.hold_expires_at);
}

/* ------------------------------- téléconsultation ------------------------- */

async function submitTeleconsult(form) {
  const data = new FormData(form);
  const result = await api.post(
    '/consultations',
    {
      doctor_id: String(data.get('doctor_id') ?? ''),
      kind: String(data.get('kind') ?? 'ASYNC_TEXT'),
      subject: String(data.get('subject') ?? '').trim(),
      symptom_summary: String(data.get('symptom_summary') ?? '').trim(),
      consent: data.get('consent') === 'on',
      emergency_ack: data.get('emergency_ack') === 'on',
    },
    { csrf: api.getCsrf() },
  );
  toast(`${t('teleconsult.title')} — ${result.consultation.reference}`, 'success');
  await render();
}

async function openVideoRoom(consultationId) {
  const room = await api.post(`/consultations/${consultationId}/video-room`, {}, { csrf: api.getCsrf() });
  // Aucun service externe : la visio réelle exige un serveur TURN configuré.
  // On affiche donc les informations de salle au lieu de prétendre établir un appel.
  toast(`${t('teleconsult.title')} — ${room.room}`, 'info');
  const box = document.querySelector('[data-region="video-room"]');
  if (box) {
    box.innerHTML = String(h`
      <div class="notice notice-info">
        <p><strong>${t('teleconsult.title')}</strong></p>
        <p class="mono">${room.room}</p>
        <p class="small">${room.note}</p>
      </div>`);
  }
}

/* ------------------------------- paiement --------------------------------- */

async function payNow(paymentId) {
  const intent = await api.post(
    '/payments/intents',
    { purpose: 'BOOKING_SERVICE_FEE', appointment_id: paymentId },
    { csrf: api.getCsrf(), headers: { 'Idempotency-Key': api.idempotencyKey() } },
  );
  await proceedToPayment(paymentId, null, intent);
}

/* ------------------------------ espace médecin ---------------------------- */

async function doctorAction(appointmentId, action) {
  const body = action === 'reject' ? { reason: prompt(t('common.reason')) ?? '' } : {};
  await api.post(`/bookings/${appointmentId}/${action}`, body, { csrf: api.getCsrf() });
  toast(t('common.confirm'), 'success');
  await render();
}

async function submitAvailability(form) {
  const data = new FormData(form);
  const hours = [];
  for (const weekday of [0, 1, 2, 3, 4, 5, 6]) {
    const opens = data.get(`opens_${weekday}`);
    const closes = data.get(`closes_${weekday}`);
    if (opens && closes) hours.push({ weekday, opens, closes });
  }
  await api.put('/me/availability', { hours }, { csrf: api.getCsrf() });
  toast(t('common.save'), 'success');
  await render();
}

async function submitTimeOff(form) {
  const data = new FormData(form);
  // `datetime-local` ne porte pas de fuseau : on l'interprète en heure
  // algérienne (UTC+1, sans heure d'été) pour obtenir un instant exact.
  const toInstant = (value) => {
    if (!value) return '';
    const local = new Date(`${String(value)}:00+01:00`);
    return Number.isNaN(local.getTime()) ? '' : local.toISOString();
  };
  await api.post(
    '/me/time-off',
    {
      starts_at: toInstant(data.get('starts_at')),
      ends_at: toInstant(data.get('ends_at')),
      reason: String(data.get('reason') ?? ''),
    },
    { csrf: api.getCsrf() },
  );
  toast(t('common.save'), 'success');
  await render();
}

/* -------------------------------- opérateur ------------------------------- */

async function submitOpsPatient(form) {
  const data = new FormData(form);
  const result = await api.post(
    '/ops/patients',
    {
      full_name: String(data.get('full_name') ?? '').trim(),
      phone: String(data.get('phone') ?? '').trim(),
      wilaya_code: Number(data.get('wilaya_code') ?? 16),
      commune: String(data.get('commune') ?? ''),
    },
    { csrf: api.getCsrf() },
  );
  toast(`${result.patient.full_name} — ${result.patient.phone}`, 'success');
  await render();
}

async function submitOpsBooking(form) {
  const data = new FormData(form);
  const result = await api.post(
    '/ops/bookings',
    {
      slot_id: String(data.get('slot_id') ?? ''),
      patient_id: String(data.get('patient_id') ?? ''),
      branch_id: String(data.get('branch_id') ?? '') || undefined,
      notes: String(data.get('notes') ?? ''),
    },
    { csrf: api.getCsrf(), headers: { 'Idempotency-Key': api.idempotencyKey() } },
  );
  toast(`${result.appointment.reference} — ${t(`status.${result.appointment.status}`)}`, 'success');
  await render();
}

async function opsCash(appointmentId) {
  const receipt = prompt('N° de reçu (facultatif)') ?? '';
  await api.post(`/ops/bookings/${appointmentId}/payment-record`, { receipt_ref: receipt }, { csrf: api.getCsrf() });
  toast(t('ops.cash'), 'success');
  await render();
}

/* --------------------------------- admin ---------------------------------- */

async function adminVerify(doctorId) {
  await api.post(`/admin/doctors/${doctorId}/verify`, {}, { csrf: api.getCsrf() });
  toast(t('admin.verify'), 'success');
  await render();
}

async function adminReject(doctorId) {
  const note = prompt(t('common.reason')) ?? '';
  if (note.length < 3) {
    toast(t('errors.VALIDATION'), 'error');
    return;
  }
  await api.post(`/admin/doctors/${doctorId}/reject`, { note }, { csrf: api.getCsrf() });
  toast(t('admin.reject'), 'success');
  await render();
}

async function adminSuspend(userId) {
  const reason = prompt(t('common.reason')) ?? '';
  await api.post(`/admin/users/${userId}/suspend`, { reason }, { csrf: api.getCsrf() });
  await render();
}

async function adminActivate(userId) {
  await api.post(`/admin/users/${userId}/activate`, {}, { csrf: api.getCsrf() });
  await render();
}

async function moderate(reviewId, status) {
  await api.post(`/admin/reviews/${reviewId}/moderate`, { status }, { csrf: api.getCsrf() });
  await render();
}

async function exportReport(kind) {
  await api.download(`/reports/${kind}/export`, `rdvdz-${kind}.csv`);
}

async function submitSetting(form) {
  const data = new FormData(form);
  const key = String(data.get('key') ?? '');
  const rawValue = String(data.get('value') ?? '');
  let value;
  try {
    value = JSON.parse(rawValue);
  } catch {
    value = rawValue;
  }
  await api.put(`/admin/settings/${encodeURIComponent(key)}`, { value }, { csrf: api.getCsrf() });
  toast(t('common.save'), 'success');
  await render();
}

async function submitCommission(form) {
  const data = new FormData(form);
  await api.post(
    '/admin/commission-rules',
    {
      scope: String(data.get('scope') ?? 'BOOKING_FEE'),
      platform_pct: Number(data.get('platform_pct') ?? 0),
      branch_pct: Number(data.get('branch_pct') ?? 0),
      operator_pct: Number(data.get('operator_pct') ?? 0),
      psp_fixed: Number(data.get('psp_fixed') ?? 0),
    },
    { csrf: api.getCsrf() },
  );
  toast(t('common.save'), 'success');
  await render();
}

/* --------------------------------- compte --------------------------------- */

async function submitProfile(form) {
  const data = new FormData(form);
  const body = { full_name: String(data.get('full_name') ?? '').trim() };
  const wilaya = data.get('wilaya_code');
  if (wilaya) body.wilaya_code = Number(wilaya);
  const commune = String(data.get('commune') ?? '').trim();
  if (commune) body.commune = commune;
  body.locale = String(data.get('locale') ?? 'fr');
  await api.put('/me/profile', body, { csrf: api.getCsrf() });
  toast(t('common.save'), 'success');
  await render();
}

async function submitPassword(form) {
  const data = new FormData(form);
  await api.post(
    '/auth/password',
    {
      currentPassword: String(data.get('currentPassword') ?? ''),
      newPassword: String(data.get('newPassword') ?? ''),
    },
    { csrf: api.getCsrf() },
  );
  toast(t('common.save'), 'success');
  form.reset();
}

async function deleteAccount() {
  if (!confirm(t('account.deleteConfirm'))) return;
  await api.post('/me/delete', {}, { csrf: api.getCsrf() });
  toast(t('account.delete'), 'success');
}

/* --------------------------------- divers --------------------------------- */

async function cancelBooking(appointmentId) {
  if (!confirm(t('booking.cancelConfirm'))) return;
  const reason = prompt(t('booking.cancelReason')) ?? '';
  const result = await api.post(`/bookings/${appointmentId}/cancel`, { reason }, { csrf: api.getCsrf() });
  if (result.refund?.eligible) {
    toast(`${t('booking.cancel')} — ${money(result.refund.amount)}`, 'success');
  } else {
    toast(t('booking.cancel'), 'success');
  }
  await render();
}

async function rescheduleBooking(appointmentId) {
  const slotId = prompt('Identifiant du nouveau créneau') ?? '';
  if (!slotId) return;
  await api.post(`/bookings/${appointmentId}/reschedule`, { slot_id: slotId }, { csrf: api.getCsrf() });
  toast(t('booking.reschedule'), 'success');
  await render();
}

export { formatDate, formatTime };
