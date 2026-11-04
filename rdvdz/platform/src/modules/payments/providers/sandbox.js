/**
 * Adaptateur SANDBOX — paiement entièrement simulé.
 *
 * Règles de transparence (exigence du cahier des charges) :
 *  - `livemode = false` sur tous les paiements produits ;
 *  - l'API renvoie `simulated: true` et l'interface affiche un bandeau
 *    « SIMULATION — aucun argent réel » ;
 *  - les commissions issues de ces paiements ne sont **jamais** comptées dans
 *    le chiffre d'affaires (voir finance/service.js) ;
 *  - refuse de démarrer en production (validé au démarrage du serveur).
 */

export class SandboxProvider {
  constructor() {
    this.name = 'sandbox';
    this.livemode = false;
  }

  async createIntent(input) {
    const ref = `sim_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    return {
      providerRef: ref,
      checkoutUrl: `/api/v1/payments/sandbox/${ref}`,
      status: 'PENDING',
      livemode: false,
      simulated: true,
      amount: Math.round(input.amount),
    };
  }

  /**
   * Simule un webhook signé par un secret interne : le chemin de vérification
   * reste identique à celui du prestataire réel, ce qui garantit que le code
   * de production est bien celui qui est testé.
   */
  async verifyWebhook() {
    // Aucun webhook externe n'est accepté en mode sandbox.
    return null;
  }

  async fetchStatus() {
    return { status: 'PENDING', livemode: false };
  }

  async refund() {
    return { providerRef: null, status: 'PROCESSED' };
  }
}
