# RDV DZ — suivi de développement

Ce fichier est mis à jour **à chaque phase**. Il ne déclare comme fait que ce
qui est couvert par un test exécuté (`npm test` dans `platform/`).

Dernière exécution (`platform/`) : `npm test` → **191 tests, 191 réussis**
(146 API + 24 vues front + 9 parcours navigateur jsdom + 12 installateur) ; `npm run test:schema`
→ schéma conforme (version 11) ; `node scripts/check-syntax.mjs` → 69 fichiers
valides ; `npm run typecheck` → aucune erreur. Raccourci : `npm run check`.
Détail des commandes : `platform/README.md`.

## Légende

`✅ fait et testé` · `🟡 fait, dépend d'une ressource externe` ·
`⬜ à faire` · `⛔ bloqué (juridique / contrat / identifiants)`

## Phase 1 — Audit, architecture, conception

| Livrable | État | Fichier |
|---|---|---|
| Audit complet DENTARDV | ✅ | `docs/00-AUDIT.md` |
| Audit complet MEDIRDV | ✅ | `docs/00-AUDIT.md` |
| Architecture & feuille de route | ✅ | `docs/01-ARCHITECTURE.md` |
| Conception base de données | ✅ | `docs/02-DATABASE.md` |
| Spécification d'API | ✅ | `docs/03-API.md` |
| Paiements : état réel Algérie | ✅ | `docs/04-PAYMENTS.md` |
| Estimation des coûts | ✅ | `docs/05-COST.md` |
| Sécurité & conformité 18-07 | ✅ | `docs/06-SECURITY-COMPLIANCE.md` |
| Matrice de tests | ✅ | `docs/10-TEST-MATRIX.md` |

## Phase 2 — Socle backend

| Élément | État |
|---|---|
| Migrations SQL (11 fichiers) | ✅ |
| Connexion PostgreSQL **et** PGlite (dev/tests) | ✅ |
| Inscription / connexion / sessions / CSRF | ✅ |
| OTP téléphone (mode dev affiché, mode SMS = adaptateur) | 🟡 (agrégateur SMS non fourni) |
| RBAC + périmètre branches | ✅ |
| Journal d'audit | ✅ |
| Patients, médecins, cliniques, spécialités, 58 wilayas | ✅ |

## Phase 3 — Plateforme patient

| Élément | État |
|---|---|
| Recherche médecins (spécialité, wilaya, nom, téléconsultation) | ✅ |
| Profil médecin (tarifs, horaires, créneaux, avis) | ✅ |
| Moteur de réservation + verrous + anti-double | ✅ |
| Historique de statuts (9 états) | ✅ |
| Compte patient (inscription, commandes, reçus) | ✅ |
| Avis modérés | ✅ |
| Interface AR (RTL) / FR | ✅ (parité stricte des clés, testée) |
| PWA installable (manifest + service worker, coquille seule — jamais l'API en cache) | ✅ |
| Front : SPA sans dépendance ni build (`src/web/`), servie par l'API | ✅ |
| Front : échappement systématique des données serveur (test `h`/`raw`) | ✅ |
| Front : parcours connexion → réservation → paiement → reçu | ✅ |
| Front : garde de rôle par route + navigation filtrée par `body[data-role]` | ✅ |
| Front : bascule FR/AR (dir, textes, dates, montants) | ✅ |
| Front : aucune URL absolue, aucun jeton en stockage navigateur | ✅ (test) |

## Phase 4 — Opérateur & branches

| Élément | État |
|---|---|
| Tableau de bord opérateur | ✅ |
| Recherche patients/médecins, disponibilité en direct | ✅ |
| Réservation pour un patient sans compte | ✅ |
| Sources `PATIENT_WEBSITE/OPERATOR/BRANCH/WHATSAPP/OTHER` | ✅ |
| Multi-branches, managers, périmètres | ✅ |
| Cloisonnement des données médicales | ✅ (testé) |

## Phase 5 — Intégration desktop (DENTARDV / MEDIRDV)

| Élément | État |
|---|---|
| Module de synchronisation côté produit (`src/main/sync/`) | ✅ |
| Migrations SQLite additives (v3 / v2) + sauvegarde avant migration | ✅ |
| Appairage appareil + jetons + HMAC | ✅ |
| File sortante / entrante, rejeu idempotent, conflits | ✅ |
| Écran « RDV DZ » dans les préférences (désactivé par défaut) | ✅ |
| Reception d'une réservation en ligne dans le desktop | ✅ (testé bout en bout) |
| Renvoi des statuts (confirmé / terminé / absent) | ✅ |

## Phase 6 — Téléconsultation

| Élément | État |
|---|---|
| Demande, consentement, accusé « non urgent » | ✅ |
| Messages patient ↔ médecin | ✅ |
| Pièces jointes chiffrées + liens signés 5 min | ✅ |
| Réponse du médecin, demande d'information, clôture | ✅ |
| Salle vidéo (WebRTC, signalisation minimale) | 🟡 (TURN/STUN à fournir) |
| Paiement d'acte clinique | ⛔ `TELEMEDICINE_PAID_ENABLED=false` |

## Phase 7 — Paiements & commissions

| Élément | État |
|---|---|
| Interface `PaymentProvider` | ✅ |
| Adaptateur **Chargily Pay v2** (checkout + webhook signé) | ✅ (clés live manquantes) |
| Adaptateur `sandbox` explicitement simulé | ✅ |
| Adaptateur `manual` (espèces constatées) | ✅ |
| Remboursements | ✅ |
| Règles de commission configurables + grand livre | ✅ |
| Reversements (bordereaux) | ✅ calcul, virement manuel |
| Portefeuille électronique | ⛔ désactivé (agrément) |

## Phase 8 — Administration, notifications, rapports

| Élément | État |
|---|---|
| Vue d'ensemble, utilisateurs, suspension | ✅ |
| Vérification des médecins, modération des avis | ✅ |
| Notifications in-app / e-mail (adaptateur) / WhatsApp (2 modes) | ✅ / 🟡 / ✅ |
| Préférences de notification | ✅ |
| Rapports revenus, médecins, branches, remboursements | ✅ |
| Export CSV (compatible Excel) | ✅ |
| Export PDF natif | ⬜ (CSV + impression navigateur ; PDF côté serveur non requis) |

## Phase 9 — Qualité et mise en production

| Élément | État |
|---|---|
| Suite de tests automatisés | ✅ |
| Tests AR / FR | ✅ |
| Matrice de sécurité | ✅ |
| Documentation installation / déploiement | ✅ (`docs/INSTALLATION.md`) |
| Installateur double-clic Windows (`setup.bat`) + script multiplateforme (`setup.mjs`) | ✅ |
| Sauvegarde / restauration | ✅ scripts |
| `docs/09-GO-LIVE-CHECKLIST.md` | ✅ |

## Dépendances externes en attente (aucune n'est simulée silencieusement)

| Dépendance | Impact | Contournement livré |
|---|---|---|
| Contrat Chargily + clés `live_sk_` | paiement réel | sandbox étiqueté + adaptateur prêt |
| Numéro WhatsApp Business vérifié | envoi automatique | repli `wa.me` (clic-pour-discuter) |
| Agrégateur SMS algérien | OTP en production | code OTP affiché côté serveur en mode `dev` uniquement |
| Autorisation ANPDP / hébergement en Algérie | production légale | blocage du transfert transfrontalier |
| Revue juridique télémédecine | actes cliniques payants | fonction construite mais désactivée |
| Identifiants du Conseil de l'Ordre | vérification automatique | vérification manuelle tracée par un administrateur |
