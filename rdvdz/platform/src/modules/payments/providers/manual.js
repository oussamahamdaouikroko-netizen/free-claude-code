/**
 * Adaptateur MANUEL — encaissement constaté (espèces, virement CCP/BaridiMob).
 *
 * Réalité algérienne : une grande partie des frais est réglée en espèces au
 * guichet d'une branche. Cet adaptateur ne prétend PAS vérifier un paiement en
 * ligne : il enregistre une constatation humaine tracée (qui a encaissé,
 * quand, sur quel reçu), qui reste distincte d'un paiement vérifié par un
 * prestataire. `livemode = true` car l'argent est réel, mais
 * `verification = 'MANUAL'` apparaît dans l'interface et les rapports.
 */

export class ManualProvider {
  constructor() {
    this.name = 'manual';
    this.livemode = true;
    this.verification = 'MANUAL';
  }

  async createIntent(input) {
    const ref = `manual_${Date.now().toString(36)}`;
    return {
      providerRef: ref,
      checkoutUrl: null,
      status: 'PENDING',
      livemode: true,
      verification: 'MANUAL',
      instructions: {
        fr: 'Paiement en espèces ou virement constaté par un opérateur. Un reçu interne est généré.',
        ar: 'الدفع نقدا أو بتحويل يثبته موظف الاستقبال. يتم إصدار وصل داخلي.',
      },
      amount: Math.round(input.amount),
    };
  }

  async verifyWebhook() {
    return null;
  }

  async fetchStatus() {
    return { status: 'PENDING', livemode: true };
  }

  async refund() {
    return { providerRef: null, status: 'MANUAL_REQUIRED' };
  }
}
