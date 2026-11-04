/** Paiement : redirection vers le prestataire, ou simulation explicitement étiquetée. */

import { t } from '../i18n.js';
import * as api from '../api.js';
import { toast, money, h } from '../ui.js';
import { go } from '../app.js';

/**
 * Enchaîne une intention de paiement.
 *
 * Trois cas réels :
 *  1. Chargily configuré → on redirige le navigateur vers `checkout_url`
 *     (aucune donnée bancaire ne touche notre site) ;
 *  2. paiement `manual` → instruction d'encaissement au guichet ;
 *  3. sandbox → bouton de simulation, avec bandeau « SIMULATION ».
 *
 * @param {string} appointmentId
 * @param {string|null} holdExpiresAt
 * @param {{payment_id: string, checkout_url: ?string, simulated: boolean, instructions?: object}} [existing]
 */
export async function proceedToPayment(appointmentId, holdExpiresAt, existing = null) {
  const intent =
    existing ??
    (await api.post(
      '/payments/intents',
      { purpose: 'BOOKING_SERVICE_FEE', appointment_id: appointmentId },
      { csrf: api.getCsrf(), headers: { 'Idempotency-Key': api.idempotencyKey() } },
    ));

  if (intent.checkout_url && !intent.simulated && /^https:\/\//.test(intent.checkout_url)) {
    // Redirection externe : l'URL provient du prestataire et a été validée en
    // HTTPS par le serveur (`checkout_url` d'un checkout Chargily).
    window.location.assign(intent.checkout_url);
    return intent;
  }

  if (intent.simulated) {
    renderSimulation(intent, holdExpiresAt);
    return intent;
  }

  const instructions = intent.instructions?.fr ?? intent.instructions?.['fr'] ?? '';
  toast(instructions || t('payment.secure'), 'info');
  go('/bookings');
  return intent;
}

function renderSimulation(intent, holdExpiresAt) {
  const host = document.createElement('div');
  host.className = 'card';
  host.setAttribute('role', 'dialog');
  host.setAttribute('aria-modal', 'true');
  host.innerHTML = String(h`
    <h2>${t('booking.pendingPayment')}</h2>
    <div class="notice notice-warn">
      <strong>${t('payment.simulated')}</strong>
    </div>
    <p class="muted small">
      ${holdExpiresAt ? `${t('booking.holdNote')} ${new Date(holdExpiresAt).toLocaleTimeString()}` : ''}
    </p>
    <p>${t('common.total')} : <strong>${money(intent.amount)}</strong></p>
    <div class="btn-row">
      <button class="btn" type="button" data-simulate-pay>${t('booking.payNow')}</button>
      <a class="btn btn-ghost" href="#/bookings">${t('common.cancel')}</a>
    </div>`);

  document.getElementById('view').prepend(host);
  host.scrollIntoView({ behavior: 'smooth', block: 'start' });

  host.querySelector('[data-simulate-pay]').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await api.post(`/payments/${intent.payment_id}/sandbox-pay`, {}, { csrf: api.getCsrf() });
      sessionStorage.removeItem('rdvdz.pending');
      toast(t('booking.confirmed'), 'success');
      go('/bookings');
    } catch (error) {
      button.disabled = false;
      toast(t(`errors.${error.code}`), 'error');
    }
  });
}
