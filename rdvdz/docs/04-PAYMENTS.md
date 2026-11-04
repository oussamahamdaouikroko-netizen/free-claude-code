# Paiements en Algérie — état vérifié et architecture d'adaptation

> Ces informations ont été vérifiées dans la documentation publique de
> Chargily Pay (API v2) le 4 novembre 2026. **Aucun autre fournisseur n'est
> documenté publiquement de manière exploitable ici** ; il n'est donc pas
> inventé.

## 1. Ce qui existe réellement

| Acteur | Rôle | Accès développeur | Ce que le code fait |
|---|---|---|---|
| **Chargily Pay (API v2)** | agrégateur agréé permettant d'accepter **CIB (SATIM)** et **EDAHABIA (Algérie Poste)** | documentation publique, clés `test_sk_…` / `live_sk_…`, webhooks signés | **adaptateur complet livré** (`providers/chargily.js`) |
| **SATIM / CIB** | réseau carte bancaire | accès réservé aux commerçants avec contrat, via banque | pas d'intégration directe (pas de documentation publique) |
| **Algérie Poste / EDAHABIA** | réseau carte postale | accès via contrat, ou via agrégateur | idem |
| Espèces / virement CCP / BaridiMob | pratique dominante en Algérie | — | adaptateur **`manual`** : encaissement **constaté** par un opérateur, tracé et non « vérifié automatiquement » |
| Portefeuille électronique interne | — | exige agrément / partenariat financier | **désactivé** (`WALLET_ENABLED=false`), interface présente, aucun solde stocké |

## 2. Détails vérifiés de Chargily Pay v2

| Élément | Valeur observée |
|---|---|
| Base URL (test) | `https://pay.chargily.net/test/api/v2` (prod : `https://pay.chargily.net/api/v2`) |
| Authentification | `Authorization: Bearer <secret_key>` |
| Créer un paiement | `POST /checkouts` → objet `checkout` avec `id`, `checkout_url`, `status` |
| Champs utiles | `amount` (**entier**, DZD), `currency: "dzd"`, `success_url`, `failure_url`, `webhook_endpoint`, `description`, `locale ∈ {ar,en,fr}`, `metadata`, `payment_method` (CIB / EDAHABIA), `chargily_pay_fees_allocation ∈ {customer,merchant,split}` |
| Statuts de checkout | `pending`, `processing`, `paid`, `failed`, `canceled` |
| Récupérer | `GET /checkouts/{id}` |
| Expirer | `POST /checkouts/{id}/expire` |
| Webhook | `POST` JSON, en-tête **`signature`** = HMAC-SHA256 hexadécimal du **corps brut** avec la clé secrète ; événements `checkout.paid`, `checkout.failed`, … ; répondre `200` |
| Mode test | l'objet porte `livemode: false` |
| Frais | premier mois 0 %, puis plans (dont une offre gratuite) : **à vérifier au moment du contrat**, non codés en dur |

Conséquences directes dans le code :

- la vérification se fait **sur le corps brut** (`reply.rawBody`), jamais sur un
  objet re-sérialisé — sinon la signature ne correspond pas ;
- `event.id` est stocké dans `payment_events.provider_event_id UNIQUE` pour
  garantir l'idempotence (Chargily peut rejouer un webhook) ;
- `livemode` est propagé jusqu'à l'interface : tout ce qui est `false` affiche
  **« SIMULATION — aucun argent réel »**.

## 3. Interface d'adaptateur (indépendante du moteur de réservation)

```ts
interface PaymentProvider {
  readonly name: 'chargily' | 'manual' | 'sandbox';
  readonly livemode: boolean;
  /** Crée une intention ; renvoie une URL de paiement si le PSP en fournit une. */
  createIntent(input: CreateIntentInput): Promise<{ providerRef: string; checkoutUrl: string | null; status: PaymentStatus }>;
  /** Vérifie un webhook : signature + montant + devise + référence. */
  verifyWebhook(raw: Buffer, headers: Record<string, string>): Promise<VerifiedEvent | null>;
  /** Récupère l'état réel côté PSP (filet de sécurité si un webhook est perdu). */
  fetchStatus(providerRef: string): Promise<PaymentStatus>;
  /** Remboursement (si le PSP le permet ; sinon statut manuel tracé). */
  refund(providerRef: string, amount: number, reason: string): Promise<{ providerRef: string | null; status: 'PROCESSED' | 'MANUAL_REQUIRED' }>;
}
```

`booking` et `teleconsult` ne connaissent que cette interface. Ajouter un
fournisseur = un fichier + une ligne de registre, **sans toucher** au moteur de
réservation.

## 4. Règles financières implémentées

1. Aucun `PAID` sans `verifyWebhook()` réussi (signature + montant + devise).
2. `idempotency_key` unique : deux créations concurrentes → une seule
   intention.
3. Verrou de créneau maintenu pendant le paiement (`HOLD_TTL = 10 min`),
   libéré automatiquement à expiration (`HOLD_EXPIRED`).
4. Remboursement ≤ montant payé, statut `REFUNDED` + écritures compensatoires
   dans `commissions` (`REVERSED`).
5. Le chiffre d'affaires n'inclut que `status='PAID' AND livemode=true`.
6. Toute opération financière écrit `audit_logs` **et** `payment_events`.
7. Aucune donnée de carte n'est reçue, stockée ou journalisée (redirection
   vers la page du PSP) — donc aucun périmètre PCI côté plateforme.

## 5. Répartition des recettes (exemple du brief, configurable)

Frais de service 100 DZD : plateforme 60 % · branche 15 % · opérateur 15 % ·
coût PSP 10 % (plafonné au coût réel constaté).

Téléconsultation 1 000 DZD : médecin 85 % · plateforme 15 %
(`commission_rules.scope='TELECONSULT'`, modifiable par l'administrateur,
historique conservé par `effective_from`).

Toutes ces valeurs vivent en base (`commission_rules`), jamais dans le code.

## 6. Ce qui reste bloqué et pourquoi

| Élément | Bloqué par | Comportement livré |
|---|---|---|
| Paiement live Chargily | contrat marchand + `live_sk_…` + compte vérifié | adaptateur prêt ; `PAYMENTS_PROVIDER=sandbox` par défaut en dev |
| CIB/EDAHABIA en direct | contrat bancaire, pas de doc publique | non implémenté (aucune invention) |
| Portefeuille (wallet) | agrément financier | `WALLET_ENABLED=false`, écran explicite |
| Reversements automatiques aux médecins | contrat + KYC | calcul + bordereau + export ; virement manuel tracé |
| Facturation fiscale | obligations fiscales algériennes | reçu interne numéroté ; mention « non valable comme facture fiscale » |
