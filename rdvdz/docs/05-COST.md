# Coûts réels, limites des offres gratuites et montée en charge

> Prix constatés en novembre 2026 sur les pages publiques des fournisseurs.
> Ils changent souvent : la colonne « à vérifier » signale les montants à
> reconfirmer avant tout engagement. Aucun de ces prix n'est codé dans
> l'application.

## 1. Développement (coût réel : 0 DZD)

| Service | Offre | Limites | Verdict |
|---|---|---|---|
| GitHub (code, Actions, Releases) | Free | 2 000 min CI/mois (privé), stockage 500 Mo | suffisant |
| Node.js 22, Fastify, PGlite/PostgreSQL, front zéro dépendance | open source | — | 0 DZD |
| PGlite / PostgreSQL local | open source | — | 0 DZD pour les tests |
| Polices, icônes (SVG maison) | auto-hébergées | — | 0 DZD |
| Domaine de dev (`*.pages.dev`, `*.onrender.com`) | inclus | sous-domaine imposé | 0 DZD |

## 2. Production — hébergement « gratuit » : ce qu'il faut savoir

| Brique | Offre gratuite | Limite réelle | Risque pour un service de santé |
|---|---|---|---|
| Front | **aucun coût d'hébergement séparé** : servi par l'API existante (pas de build, pas de CDN) | nul par construction | **nul** |
| API (Render Free) | 1 instance 512 Mo | **mise en veille après 15 min** → 30–60 s de réveil ; webhooks perdus pendant la veille | **rédhibitoire** pour les webhooks de paiement |
| API (Fly.io / Koyeb free) | petite instance | crédits limités, arrêts | moyen |
| PostgreSQL (Neon/Supabase free) | 0,5 Go | quotas de calcul, pause du projet | moyen |
| Stockage objet (Cloudflare R2) | 10 Go | egress gratuit | faible |
| Sauvegardes | — | **non incluses** dans les offres gratuites | **critique** |

**Conclusion honnête : un service de santé avec paiement ne peut pas tourner
indéfiniment à 0 DZD.** Les offres gratuites servent au développement, aux
démonstrations et à la phase pilote avec des données fictives.

## 3. Budget de démarrage réaliste

| Poste | Choix recommandé | Coût mensuel estimé | À vérifier |
|---|---|---|---|
| VPS API + PostgreSQL + stockage (2 vCPU / 4 Go / 80 Go SSD, **datacenter algérien ou Maghreb**) | hébergeur local | 2 500 – 6 000 DZD | oui (ICOSNET, Smart Solutions, Algérie Télécom Cloud…) |
| Nom de domaine `.dz` | NIC.DZ | ~1 200 DZD/an | oui |
| Certificat TLS | Let's Encrypt | 0 DZD | — |
| Sauvegarde hors site (objet S3-compatible, 50 Go) | Backblaze B2 / R2 | 0 – 600 DZD | oui |
| SMS OTP (agrégateur local, ~3–6 DZD/SMS) | ex. agrégateur DZ | 1 500 DZD / 500 SMS | oui |
| WhatsApp Business Cloud | voir §5 | 0 DZD (fenêtre de service) + messages template | oui |
| **Total pilote (≈ 300 rendez-vous/mois)** | | **≈ 6 000 – 12 000 DZD/mois** | |

## 4. Contrainte légale qui prime sur le coût

La loi 18-07 modifiée par la **loi 25-11 du 24 juillet 2025** soumet tout
**transfert de données personnelles hors d'Algérie** à autorisation préalable
de l'ANPDP, et impose déclaration préalable, analyse d'impact pour les
traitements à haut risque, registre des traitements, notification des
violations et désignation d'un DPO. Les données de santé sont des données
sensibles (art. 18).

| Scénario | Conformité | Coût |
|---|---|---|
| Hébergement UE/USA (offres gratuites) | **nécessite une autorisation ANPDP** ; à éviter pour les données de santé réelles | 0 DZD mais risque juridique |
| Hébergement Algérie (VPS local ou serveur au cabinet) | conforme par défaut | 2 500 – 6 000 DZD/mois |
| Une seule origine : front servi par l'API, base + documents en Algérie | **recommandé** — pas de CDN, pas de proxy, aucun contenu médical hors du pays | 2 500 – 6 000 DZD/mois |

Recommandation : **front servi par l'API elle-même** (une origine, aucun CDN),
base + documents en Algérie. Le front étant statique et sans build, il ne crée
aucun coût d'hébergement supplémentaire.

## 5. WhatsApp Business Platform

| Élément | Réalité |
|---|---|
| Conversations de **service** (réponse dans les 24 h suivant un message du patient) | gratuites |
| Messages **template** (confirmation, rappel) hors fenêtre de service | facturés **par message**, tarif variable selon le pays et la catégorie (`utility`, `marketing`, `authentication`) |
| Vérification du numéro professionnel | gratuite, délai 1–5 jours |
| Alternative sans coût | **repli clic-pour-discuter** : `https://wa.me/213xxxxxxxxx?text=…` ouvert par le patient, aucun message automatisé, aucun risque de blocage |

Le code implémente les deux canaux et bascule automatiquement sur le repli si
`WHATSAPP_PROVIDER=click_to_chat`. Aucune automatisation non officielle n'est
utilisée (contrairement au bot Baileys présent dans les applications de
bureau, qui reste **local et inchangé**).

## 6. Commission du prestataire de paiement

| Élément | Valeur |
|---|---|
| Abonnement | plans Chargily dont une offre gratuite ; 1er mois à 0 % (à reconfirmer) |
| Commission par transaction | **variable selon le plan et le volume** — non codée en dur |
| Qui paie ? | configurable : `chargily_pay_fees_allocation = customer | merchant | split` |
| Modèle économique retenu | le coût PSP est **déduit de la commission plateforme** (paramètre `psp_fixed` dans `commission_rules`), jamais répercuté silencieusement sur le patient |

Exemple de simulation (frais de service 100 DZD, 300 réservations/mois) :

| Poste | Montant |
|---|---|
| Encaissé patients | 30 000 DZD |
| Coût PSP (hypothèse 1,5 % + 10 DZD/txn) | 3 450 DZD |
| Part branche (15 %) | 4 500 DZD |
| Part opérateur (15 %) | 4 500 DZD |
| **Marge plateforme** | **17 550 DZD** |

## 7. Montée en charge (repères)

| Volume mensuel | Infrastructure | Coût estimé |
|---|---|---|
| < 500 rendez-vous | 1 VPS 2 vCPU/4 Go, sauvegarde quotidienne | 3 000 – 6 000 DZD |
| 500 – 5 000 | 2 vCPU/8 Go + stockage 200 Go + supervision | 8 000 – 18 000 DZD |
| 5 000 – 50 000 | 2 nœuds API + PostgreSQL managé + Redis + CDN | 40 000 – 120 000 DZD |
| > 50 000 (national, 58 wilayas) | cluster, réplication, support 24/7, DPO, audit | sur devis |

## 8. Coûts à ne jamais sacrifier

1. Sauvegardes chiffrées + test de restauration mensuel.
2. TLS, en-têtes de sécurité, revue de code des flux d'argent.
3. Journal d'audit conservé 5 ans.
4. Accompagnement juridique (18-07/25-11, télémédecine, paiement).
5. Chiffrement au repos des documents médicaux.
