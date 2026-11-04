/**
 * Adaptateur Chargily Pay — API v2 (Algérie).
 *
 * Faits vérifiés dans la documentation publique (novembre 2026) et utilisés
 * tels quels, sans extrapolation :
 *  - base : https://pay.chargily.net/api/v2 (live) ou /test/api/v2 (test) ;
 *  - auth : en-tête `Authorization: Bearer <secret_key>` ;
 *  - création : `POST /checkouts` avec `amount` (entier, DZD), `currency:"dzd"`,
 *    `success_url`, `failure_url`, `webhook_endpoint`, `description`,
 *    `locale` ('ar'|'fr'|'en'), `metadata`, `payment_method` ;
 *  - réponse : objet `checkout` contenant `id`, `checkout_url`, `status`,
 *    `livemode` ;
 *  - statuts : pending | processing | paid | failed | canceled ;
 *  - webhook : POST JSON, en-tête `signature` = HMAC-SHA256 hexadécimal du
 *    **corps brut** calculé avec la clé secrète ; événement `checkout.paid`.
 *
 * Aucune donnée de carte ne transite par la plateforme : le patient est
 * redirigé vers la page hébergée par le prestataire.
 */

import { hmac, safeEqual } from '../../../lib/crypto.js';

const STATUS_MAP = {
  pending: 'PENDING',
  processing: 'PENDING',
  paid: 'PAID',
  failed: 'FAILED',
  canceled: 'FAILED',
};

export class ChargilyProvider {
  /**
   * @param {{ secretKey: string, baseUrl: string, webhookUrl?: string, fetchImpl?: typeof fetch }} options
   */
  constructor({ secretKey, baseUrl, webhookUrl = '', fetchImpl = globalThis.fetch }) {
    if (!secretKey) throw new Error('CHARGILY_SECRET_KEY manquante');
    this.name = 'chargily';
    this.secretKey = secretKey;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.webhookUrl = webhookUrl;
    this.livemode = !secretKey.startsWith('test_');
    this.fetch = fetchImpl;
  }

  /**
   * Crée un checkout.
   * @param {{ amount: number, description: string, successUrl: string, failureUrl: string,
   *           locale?: 'ar'|'fr', metadata?: object, paymentMethod?: 'cib'|'edahabia' }} input
   */
  async createIntent(input) {
    const body = {
      amount: Math.round(input.amount),
      currency: 'dzd',
      description: String(input.description ?? '').slice(0, 250),
      success_url: input.successUrl,
      failure_url: input.failureUrl,
      locale: input.locale === 'ar' ? 'ar' : 'fr',
      metadata: input.metadata ?? {},
    };
    if (this.webhookUrl) body.webhook_endpoint = this.webhookUrl;
    if (input.paymentMethod) body.payment_method = input.paymentMethod;

    const response = await this.fetch(`${this.baseUrl}/checkouts`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`CHARGILY_HTTP_${response.status}: ${detail.slice(0, 300)}`);
    }
    const checkout = await response.json();
    return {
      providerRef: checkout.id,
      checkoutUrl: checkout.checkout_url ?? null,
      status: STATUS_MAP[checkout.status] ?? 'PENDING',
      livemode: Boolean(checkout.livemode),
      raw: checkout,
    };
  }

  /**
   * Vérifie et normalise un webhook.
   * @param {Buffer|string} rawBody corps BRUT (jamais un objet re-sérialisé)
   * @param {Record<string, string|string[]|undefined>} headers
   * @returns {Promise<null | { eventId: string, type: string, providerRef: string, status: string,
   *            amount: number|null, currency: string|null, livemode: boolean, payload: object }>}
   */
  async verifyWebhook(rawBody, headers) {
    const signature = headers.signature;
    if (!signature || Array.isArray(signature)) return null;
    const payloadText = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody ?? '');
    const expected = hmac(this.secretKey, payloadText);
    if (!safeEqual(expected, signature)) return null;

    let event;
    try {
      event = JSON.parse(payloadText);
    } catch {
      return null;
    }
    if (!event || event.entity !== 'event' || !event.id || !event.data) return null;

    return {
      eventId: String(event.id),
      type: String(event.type ?? ''),
      providerRef: String(event.data.id ?? ''),
      status: STATUS_MAP[event.data.status] ?? 'PENDING',
      amount: event.data.amount === undefined ? null : Number(event.data.amount),
      currency: event.data.currency ? String(event.data.currency).toUpperCase() : null,
      livemode: event.data.livemode === true || event.data.livemode === 'true',
      payload: event,
    };
  }

  /** État réel côté prestataire (filet de sécurité si un webhook est perdu). */
  async fetchStatus(providerRef) {
    const response = await this.fetch(`${this.baseUrl}/checkouts/${encodeURIComponent(providerRef)}`, {
      headers: { Authorization: `Bearer ${this.secretKey}`, Accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`CHARGILY_HTTP_${response.status}`);
    const checkout = await response.json();
    return {
      status: STATUS_MAP[checkout.status] ?? 'PENDING',
      amount: Number(checkout.amount ?? 0),
      livemode: Boolean(checkout.livemode),
    };
  }

  /**
   * Expire un checkout non payé (libère proprement le verrou de créneau).
   */
  async expire(providerRef) {
    const response = await this.fetch(
      `${this.baseUrl}/checkouts/${encodeURIComponent(providerRef)}/expire`,
      { method: 'POST', headers: { Authorization: `Bearer ${this.secretKey}` } },
    );
    return response.ok;
  }

  /**
   * Remboursement : l'API v2 documentée ne publie pas d'endpoint de
   * remboursement à ce jour. On ne l'invente pas : la demande est enregistrée
   * et le remboursement doit être effectué par le prestataire (statut
   * `MANUAL_REQUIRED`), puis constaté dans l'application.
   */
  async refund() {
    return { providerRef: null, status: 'MANUAL_REQUIRED' };
  }
}
