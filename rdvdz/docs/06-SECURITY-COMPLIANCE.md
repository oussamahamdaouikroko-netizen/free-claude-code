# Sécurité, conformité et protection des données

## 1. Modèle de menaces (résumé)

| Acteur | Objectif | Contre-mesure principale |
|---|---|---|
| Curieux / scanner | trouver un accès non authentifié | allowlist de routes, `401` par défaut, aucun endpoint « debug » en production |
| Patient malveillant | lire le dossier d'un autre | autorisation objet par objet (`assertCanAccess`) + tests dédiés |
| Opérateur | voir des données médicales | sérialisation en **allowlist** : les champs de santé ne quittent jamais le module `teleconsult` |
| Médecin | voir un patient hors relation de soin | filtre SQL `doctor_id = $me` + test « médecin B ne lit pas le patient de A » |
| Attaquant réseau | rejouer / falsifier un webhook | HMAC sur le **corps brut**, horodatage ±300 s, `event_id` unique |
| Appareil desktop volé | pousser de faux rendez-vous | `device_token` haché + secret par appareil + révocation + journal |
| Utilisateur interne | effacer une trace | `audit_logs` append-only, base sans droit `UPDATE/DELETE` pour le rôle applicatif |
| Injection SQL | exfiltrer | **requêtes paramétrées uniquement** (aucune concaténation SQL), test anti-injection |
| XSS | voler la session | cookie `HttpOnly`, CSP `default-src 'self'`, gabarit `h` qui échappe **toute** interpolation (test dédié), aucun `innerHTML` construit à partir de données brutes |
| CSRF | agir à la place du patient | `SameSite=Lax` + jeton CSRF double-soumission sur toute mutation |
| Abus / déni | saturer | limites par IP + par utilisateur + par téléphone (OTP) |

## 2. Authentification et sessions

- Mots de passe : `scrypt` (N=16384, r=8, p=1), sel 16 octets aléatoire,
  comparaison `timingSafeEqual`. Politique : ≥ 10 caractères, refus des mots de
  passe les plus courants.
- Verrouillage : 5 échecs → 15 minutes (par compte **et** par IP).
- OTP : 6 chiffres, TTL 5 min, 5 tentatives, stocké **haché**, usage unique.
- Sessions : jeton aléatoire 32 octets, stocké **haché** en base, cookie
  `HttpOnly; Secure; SameSite=Lax; Path=/`, expiration glissante 7 jours,
  révocation par appareil, déconnexion globale à la demande.
- MFA TOTP optionnel pour tous les rôles d'administration (obligatoire en
  production pour `SUPER_ADMIN`/`ADMIN`/`FINANCE_MANAGER`).
- Aucun jeton dans `localStorage`, aucun secret dans le bundle front
  (vérifié par un test qui parcourt le build).

## 3. Autorisation

| Règle | Implémentation |
|---|---|
| RBAC | table `users.role` + table de permissions par route (`route.roles`) |
| Périmètre | `user_scopes` (branche, wilaya) injecté dans la clause `WHERE` de chaque requête, jamais filtré en mémoire après coup |
| Relation de soin | un médecin ne lit une consultation que si `consultation.doctor_id = me` ; un patient que si `patient_id = me` |
| Séparation des domaines | `patients` (identité) ≠ `consultations`/`medical_documents` (clinique) ≠ `payments` (finance) ; les opérateurs n'ont aucun join vers le clinique |
| Défaut | **refus** : toute route non explicitement ouverte exige une session |

## 4. Données médicales

1. **Minimisation** : la synchronisation desktop ne transporte jamais
   `allergies`, `chronic_conditions`, `prescriptions`, `medical_certificates`,
   `notes` cliniques ni `medications`.
2. **Chiffrement en transit** : TLS 1.2+ obligatoire, HSTS.
3. **Chiffrement au repos** : documents chiffrés (AES-256-GCM) avant écriture
   dans le stockage objet ; la clé vit dans l'environnement du serveur, jamais
   dans la base.
4. **Téléchargement** : lien signé HMAC, TTL 5 min, lié à l'utilisateur, usage
   unique côté journal ; `Content-Disposition: attachment`, `no-store`.
5. **Accès journalisé** : chaque lecture de document écrit une ligne
   `audit_logs` (`action='medical_document.read'`).
6. **Pas de données réelles en développement** : le jeu de démonstration est
   entièrement fictif et marqué comme tel.

## 5. WhatsApp — position ferme

| Usage | Autorisé ? | Mise en œuvre |
|---|---|---|
| API WhatsApp Business officielle (templates approuvés) | oui | `providers/whatsapp/official.js` |
| Repli clic-pour-discuter (`wa.me`) | oui | `providers/whatsapp/clickToChat.js` — le **patient** envoie, aucun automatisme |
| Automatisation non officielle (Baileys, etc.) sur la plateforme | **non** | interdit explicitement (test de contrat vérifiant l'absence de dépendance) |
| Envoi de contenu médical détaillé par WhatsApp | **non** | seuls l'heure, la date, le nom du médecin et la référence transitent ; message « ne répondez pas avec vos données médicales » |
| Groupes, publipostage | non | — |

Le bot Baileys **des applications de bureau** reste en place (fonctionnalité
existante, décision du propriétaire), mais il est isolé du réseau plateforme :
il ne reçoit et n'envoie rien vers l'API centrale.

## 6. Conformité loi 18-07 (modifiée par la loi 25-11 du 24 juillet 2025)

| Obligation | Statut dans le produit |
|---|---|
| Déclaration préalable à l'ANPDP | **à faire par l'exploitant** — documenté dans `docs/09-GO-LIVE-CHECKLIST.md` |
| Consentement exprès (patient) | écran de consentement versionné (`patients.consent_version`, `consent_at`), horodaté et auditable |
| Registre des traitements | `docs/REGISTRE-TRAITEMENTS.md` fourni (modèle à compléter) |
| DPO désigné | champ de configuration + checklist |
| Analyse d'impact (traitements à haut risque) | modèle AIPD fourni (`docs/AIPD-TEMPLATE.md`) |
| Notification des violations | procédure documentée (§8) |
| Droits des personnes (accès, rectification, opposition, effacement) | endpoints `GET /me/export`, `POST /me/rectify`, `POST /me/delete` ; suppression logique + purge planifiée |
| Transfert hors Algérie | **bloqué par défaut** : `ALLOW_CROSS_BORDER=false` désactive tout envoi de données vers un service externe ; documentation de la contrainte dans la config |
| Sécurité et confidentialité | §2–§4 |

## 7. Journalisation et audit

- `audit_logs` : acteur, rôle, action, entité, id, IP, user-agent, horodatage,
  détails JSON. Aucune modification possible par l'application.
- `payment_events` : journal brut des webhooks (conservé 5 ans).
- `desktop_sync_log` : chaque push/pull, conflit et erreur.
- Logs applicatifs JSON sans données personnelles sensibles (téléphone masqué :
  `+2136•••••78`).
- Aucun mot de passe, jeton, OTP ou clé secrète ne peut apparaître dans un log
  (filtre + test).

## 8. Procédure en cas de violation de données

1. Détection (alerte) → **confinement** (révocation des sessions et appareils).
2. Registre de l'incident (`docs/INCIDENT-LOG.md`), horodatage.
3. Analyse d'impact et identification des personnes concernées.
4. Notification à l'ANPDP **sans délai** et information des personnes si un
   risque élevé existe.
5. Mesures correctives, revue post-incident, mise à jour de l'AIPD.

## 9. Tests de sécurité automatisés (livrés)

| Test | Vérifie |
|---|---|
| `auth.test` | hachage, verrouillage, expiration de session, OTP usage unique |
| `rbac.test` | matrice complète route × rôle (403 attendus) |
| `booking-concurrency.test` | 20 réservations simultanées sur 1 créneau → 1 gagnant |
| `payments-webhook.test` | signature fausse rejetée, rejeu idempotent, montant falsifié rejeté |
| `teleconsult-access.test` | un autre patient → 403, un autre médecin → 403, opérateur → 403 |
| `documents.test` | lien signé expiré rejeté, chemin traversé rejeté, type MIME non autorisé rejeté |
| `desktop-sync.test` | signature d'appareil invalide rejetée, rejeu d'un push idempotent |
| `front-secrets.test` | aucun secret dans le build front |
| `injection.test` | payload SQL/XSS dans chaque champ texte → stocké littéralement, jamais exécuté |

## 10. Durcissement du déploiement

- En-têtes : `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: same-origin`, `Permissions-Policy` minimal,
  `Content-Security-Policy` (pas d'`unsafe-inline` côté API ; le front autorise
  uniquement ses propres bundles).
- Pas d'exposition de `X-Powered-By`, pas de route de documentation publique en
  production.
- PostgreSQL : rôle applicatif limité (`SELECT/INSERT/UPDATE` sur les tables
  métier, `INSERT` seul sur `audit_logs`), aucun `SUPERUSER`.
- Secrets par variables d'environnement, `.env` ignoré par Git, exemple fourni
  sans valeur réelle.
- Rotation : secrets d'appareil à la révocation, clé de signature des liens,
  clés PSP au changement de contrat.
- Sauvegardes chiffrées, restauration testée mensuellement.

## 11. Ce qui reste sous responsabilité de l'exploitant (non logiciel)

1. Déclaration/autorisation ANPDP et désignation d'un DPO.
2. Hébergement en Algérie (ou autorisation de transfert).
3. Revue juridique du cadre de la télémédecine et des actes facturés.
4. Contrat avec le prestataire de paiement (KYC) et obligations fiscales.
5. Vérification des diplômes/inscriptions à l'Ordre des médecins référencés.
6. Politique de conservation signée avec les cliniques.
