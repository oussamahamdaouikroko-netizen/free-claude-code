# TASKS.md — plan de travail détaillé

Chaque tâche est cochée seulement quand elle est **implémentée et couverte par
un test**. Les identifiants `T-xx` sont utilisés dans les messages de commit.

## 0. Préparation

- [x] T-00 Lire et exécuter les suites DENTARDV (100 ✅) et MEDIRDV (103 ✅)
- [x] T-01 Rédiger l'audit (`docs/00-AUDIT.md`)
- [x] T-02 Rédiger l'architecture, le schéma, l'API, les coûts, la sécurité
- [x] T-03 Créer l'arborescence `rdvdz/platform`

## 1. Base de données

- [x] T-10 Migrations `001_reference_data` → `010_views`
- [x] T-11 Exécuteur de migrations (PGlite **et** `pg`) + table `schema_migrations`
- [x] T-12 Jeu de démonstration fictif (`scripts/seed-demo.mjs`)
- [x] T-13 Vues de reporting (`v_revenue_daily`, `v_doctor_earnings`, `v_branch_performance`)

## 2. Socle API

- [x] T-20 Configuration par variables d'environnement + validation au démarrage
- [x] T-21 Erreurs normalisées (`AppError` + codes stables)
- [x] T-22 Cryptographie : scrypt, HMAC, jetons, comparaison à temps constant
- [x] T-23 Sessions (cookie HttpOnly) + jeton CSRF double-soumission
- [x] T-24 RBAC + périmètre + `audit_logs`
- [x] T-25 Limitation de débit (IP + utilisateur + téléphone)
- [x] T-26 En-têtes de sécurité + CORS restreint
- [x] T-27 `/health`, `/ready`

## 3. Identité

- [x] T-30 Inscription patient / médecin (consentement versionné)
- [x] T-31 Connexion, verrouillage 5 échecs, déconnexion, sessions
- [x] T-32 OTP téléphone (haché, TTL 5 min, 5 essais)
- [x] T-33 Changement de mot de passe, MFA TOTP (optionnel)
- [x] T-34 Droits des personnes : export, rectification, suppression logique

## 4. Annuaire

- [x] T-40 Référentiels (58 wilayas, spécialités)
- [x] T-41 Recherche médecins (spécialité, wilaya, texte, téléconsultation)
- [x] T-42 Profil médecin public + avis approuvés
- [x] T-43 Horaires, congés, génération de créneaux
- [x] T-44 Vérification d'un médecin par un administrateur

## 5. Réservation

- [x] T-50 Création de réservation + verrou (10 min) + frais de service
- [x] T-51 Transition de statut centralisée + historique
- [x] T-52 Anti-double réservation (transaction + contrainte unique)
- [x] T-53 Annulation, reprogrammation, refus, complétion, absence
- [x] T-54 Libération des verrous expirés (worker)
- [x] T-55 Confirmation conditionnée au paiement vérifié
- [x] T-56 Reçu imprimable AR/FR

## 6. Espace médecin

- [x] T-60 Profil, tarifs, téléconsultation
- [x] T-61 Disponibilités et congés
- [x] T-62 Agenda du jour, statistiques

## 7. Téléconsultation

- [x] T-70 Demande + consentement + accusé d'urgence
- [x] T-71 Messages, acceptation, refus, demande d'information, réponse, clôture
- [x] T-72 Téléversement chiffré + téléchargement par lien signé
- [x] T-73 Cloisonnement (autre patient / autre médecin / opérateur → 403)
- [x] T-74 Salle vidéo (identifiant signé, TURN à configurer)

## 8. Paiements

- [x] T-80 Interface `PaymentProvider` + registre
- [x] T-81 Adaptateur Chargily v2 (checkout, statut, webhook HMAC, remboursement)
- [x] T-82 Adaptateur sandbox étiqueté + adaptateur manual
- [x] T-83 Webhook : corps brut, signature, idempotence, montant/devise
- [x] T-84 Remboursements partiels et totaux
- [x] T-85 Règles de commission + écritures (`commissions`)
- [x] T-86 Reversements et bordereaux

## 9. Opérateur, branches, admin

- [x] T-90 Tableau de bord opérateur
- [x] T-91 Réservation au nom d'un patient sans compte
- [x] T-92 Branches, managers, opérateurs, périmètre
- [x] T-93 Admin : utilisateurs, vérification, modération, réglages, audit
- [x] T-94 Cloisonnement médical des opérateurs (allowlist)

## 10. Synchronisation desktop

- [x] T-100 Migrations SQLite additives (DentaRDV v3, MediRDV v2)
- [x] T-101 Client de synchronisation (handshake, pull, push, heartbeat)
- [x] T-102 File sortante persistante + rejeu + journal
- [x] T-103 Application des réservations entrantes via les services existants
- [x] T-104 Conflits journalisés, jamais écrasés
- [x] T-105 Écran de configuration dans les préférences (désactivé par défaut)
- [x] T-106 Tests de bout en bout contre l'API réelle (PGlite)

## 11. Notifications

- [x] T-110 Modèles AR/FR par événement et par canal
- [x] T-111 In-app, e-mail (adaptateur), WhatsApp officiel + repli `wa.me`
- [x] T-112 Préférences par utilisateur
- [x] T-113 Anti-doublon (`dedupe_key`)

## 12. Interface

- [x] T-120 Design system (couleurs médicales, typographie, états)
- [x] T-121 PWA patient (recherche, profil, réservation, compte)
- [x] T-122 Console opérateur
- [x] T-123 Espace médecin
- [x] T-124 Tableau de bord admin
- [x] T-125 AR (RTL) / FR, bascule persistée
- [x] T-126 États vides, chargement, erreurs, confirmations
- [x] T-127 Front sans dépendance ni build (`src/web/`, modules ES + CSS maison, servi par l'API)
- [x] T-128 PWA : `manifest.webmanifest`, icône, `robots.txt`, service worker coquille (API jamais en cache)
- [x] T-129 Parcours de bout en bout dans un vrai DOM (jsdom) : accueil, recherche, connexion, rôles, bascule AR, déconnexion

## 13. Qualité

- [x] T-130 Suite de tests back-end (auth, RBAC, réservation, paiement, téléconsultation, sync, rapports)
- [x] T-131 Tests de concurrence (réservation simultanée)
- [x] T-132 Tests de sécurité (webhook forgé, injection, XSS, lien expiré)
- [x] T-133 Tests d'interface (rendu AR/FR, absence de secret dans le build)
- [x] T-136 Installateur double-clic (`setup.bat` → `setup.mjs`) : vérifications, secrets générés, base, migrations, démo, démarrage, port occupé expliqué
- [x] T-137 `build-exe.mjs` : production d'un `setup.exe` autonome (à exécuter sous Windows, refusé ailleurs)
- [x] T-135 Tests du front : échappement `h`/`raw`, parité des clés FR/AR, absence d'URL absolue, aucun jeton en stockage
- [x] T-134 `docs/10-TEST-MATRIX.md` à jour

## Restant, explicitement hors de portée sans ressources externes

- [ ] T-200 Clés live Chargily + contrat marchand
- [ ] T-201 Numéro WhatsApp Business vérifié + modèles approuvés
- [ ] T-202 Agrégateur SMS + expéditeur validé
- [ ] T-203 Autorisation ANPDP + hébergement algérien
- [ ] T-204 Revue juridique télémédecine (débloque `TELEMEDICINE_PAID_ENABLED`)
- [ ] T-205 Serveur TURN pour la vidéo en conditions réelles
