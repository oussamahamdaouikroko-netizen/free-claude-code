/**
 * Registre des prestataires de paiement.
 *
 * Ajouter un fournisseur = créer un adaptateur respectant l'interface
 * `PaymentProvider` puis l'enregistrer ici. Le moteur de réservation n'est
 * jamais modifié.
 */

import { config } from '../../config.js';
import { Errors } from '../../lib/errors.js';
import { ChargilyProvider } from './providers/chargily.js';
import { SandboxProvider } from './providers/sandbox.js';
import { ManualProvider } from './providers/manual.js';

/** @typedef {{ name: string, livemode: boolean,
 *   createIntent: Function, verifyWebhook: Function, fetchStatus: Function, refund: Function }} PaymentProvider */

let overrides = {};

/** Remplace un fournisseur (utilisé par les tests). */
export function setProviderForTests(name, provider) {
  overrides[name] = provider;
}

export function resetProviders() {
  overrides = {};
}

/**
 * Renvoie le fournisseur demandé.
 * @param {'chargily'|'sandbox'|'manual'} [name] défaut : configuration
 * @returns {PaymentProvider}
 */
export function getProvider(name = config.payments.provider) {
  if (overrides[name]) return overrides[name];

  if (name === 'chargily') {
    if (!overrides.chargily && !config.payments.chargily.secretKey) {
      throw Errors.conflict('PROVIDER_UNAVAILABLE', 'Chargily non configuré (CHARGILY_SECRET_KEY)');
    }
    return overrides.chargily || new ChargilyProvider(config.payments.chargily);
  }
  if (name === 'manual') return new ManualProvider();
  if (name === 'sandbox') {
    if (!config.payments.sandboxAllowed) {
      throw Errors.forbidden('Sandbox désactivé (PAYMENTS_SANDBOX_ALLOWED=false)');
    }
    return new SandboxProvider();
  }
  throw Errors.conflict('PROVIDER_UNKNOWN', `Fournisseur inconnu: ${name}`);
}

/** Liste des fournisseurs disponibles et de leur état réel. */
export function providerCatalog() {
  return [
    {
      name: 'chargily',
      label: 'Chargily Pay (CIB / EDAHABIA)',
      live: Boolean(config.payments.chargily.secretKey),
      modes: ['test', 'live'],
    },
    { name: 'manual', label: 'Espèces / virement constaté', live: true, modes: ['manual'] },
    {
      name: 'sandbox',
      label: 'Simulation (développement uniquement)',
      live: false,
      modes: ['simulated'],
    },
  ];
}
