# Phase 1 — Spécification de l'API

Base : `https://<hôte>/api/v1` · JSON UTF-8 · en-têtes `Accept-Language: ar|fr`
· authentification par **cookie de session** (`rdv_session`, HttpOnly) +
en-tête `x-csrf-token` pour toute mutation.

## 0. Conventions

| Élément | Règle |
|---|---|
| Erreur | `{ "error": { "code": "SLOT_TAKEN", "message": "…", "details": {} } }` — codes stables (`AUTH_REQUIRED`, `FORBIDDEN`, `VALIDATION`, `NOT_FOUND`, `CONFLICT`, `RATE_LIMITED`, `PAYMENT_UNVERIFIED`, `LEGAL_BLOCKED`, …) |
| Montants | entiers, **centimes de DZD** (`150000` = 1 500,00 DZD) |
| Dates | ISO-8601 UTC (`2026-11-05T09:30:00.000Z`) ; l'affichage local est fait par le client (`Africa/Algiers`) |
| Pagination | `?limit=20&cursor=…` → `{ "items": [], "next_cursor": null }` |
| Idempotence | `Idempotency-Key: <uuid>` obligatoire sur `POST /bookings`, `POST /payments/*` |
| Rôles | `SUPER_ADMIN, ADMIN, FINANCE_MANAGER, BRANCH_MANAGER, OPERATOR, DOCTOR, PATIENT` |
| Périmètre | un `OPERATOR`/`BRANCH_MANAGER` ne voit que sa branche ; un `DOCTOR` que ses patients |
| Audit | toute mutation de rendez-vous/paiement/consultation écrit `audit_logs` |
| Mode simulé | tout objet dont `livemode=false` porte `"simulated": true` |

## 1. Authentification & compte

| Méthode | Chemin | Rôle | Description |
|---|---|---|---|
| POST | `/auth/register` | public | `{full_name, phone, email?, password, role: PATIENT|DOCTOR, locale, consent}` → crée l'utilisateur (`PENDING` pour médecin), envoie un OTP |
| POST | `/auth/login` | public | `{phone|email, password}` → `Set-Cookie: rdv_session` + `{user, csrf_token}` ; verrouillage 5 échecs / 15 min |
| POST | `/auth/logout` | authentifié | révoque la session |
| GET | `/auth/me` | authentifié | utilisateur + rôles + périmètre + consentement |
| POST | `/auth/otp/request` | authentifié ou public avec `phone` | `{purpose: VERIFY|LOGIN|RESET}` → envoi SMS (ou code de test en dev) |
| POST | `/auth/otp/verify` | idem | `{phone, code, purpose}` → marque `phone_verified_at` |
| POST | `/auth/password` | authentifié | `{current, next}` |
| POST | `/auth/mfa/enable` · `/auth/mfa/disable` | authentifié | secret TOTP (optionnel) |
| GET | `/auth/sessions` · DELETE `/auth/sessions/:id` | authentifié | appareils connectés |

## 2. Référentiels (publics)

| Méthode | Chemin | Description |
|---|---|---|
| GET | `/reference/wilayas` | 58 wilayas `{code, name_ar, name_fr}` |
| GET | `/reference/specialties` | spécialités actives |
| GET | `/reference/config` | uniquement les réglages `public.*` (frais par défaut, délai de maintien, drapeaux légaux) |

## 3. Annuaire

| Méthode | Chemin | Description |
|---|---|---|
| GET | `/doctors?specialty=&wilaya=&commune=&q=&mode=&teleconsult=&limit=&cursor=` | recherche vérifiée : nom, spécialité, clinique, adresse, prochains créneaux, tarifs, badge « vérifié », note |
| GET | `/doctors/:id` | profil : clinique (photos, adresse, carte), spécialités, horaires, prochains créneaux (14 j), téléconsultation, tarifs + frais de service, avis approuvés, langues |
| GET | `/clinics/:id` | clinique + médecins actifs |
| POST | `/reviews` | `PATIENT` : `{appointment_id, rating, comment}` — uniquement si `COMPLETED`, un avis par rendez-vous, publié après modération |
| GET | `/reviews/mine` | avis du patient connecté |

## 4. Créneaux & réservation

| Méthode | Chemin | Rôle | Description |
|---|---|---|---|
| GET | `/doctors/:id/slots?from=&to=&mode=` | public | créneaux `OPEN` (les `HELD` non expirés sont exclus) |
| POST | `/bookings` | PATIENT | `{slot_id, mode, patient?: {full_name, phone, ...}, notes, source?}` → `AWAITING_PAYMENT` + **verrou du créneau** (`hold_expires_at = now + 10 min`) si frais > 0, sinon `PENDING`/`CONFIRMED` selon `doctor.manual_confirmation` |
| GET | `/bookings` | PATIENT/DOCTOR/OPERATOR | liste filtrée par périmètre |
| GET | `/bookings/:id` | ayants droit | détail + historique complet des statuts |
| POST | `/bookings/:id/cancel` | PATIENT (avant délai configurable), opérateur, médecin | `{reason}` → `CANCELLED`, libère le créneau, calcule l'éligibilité au remboursement |
| POST | `/bookings/:id/reschedule` | idem | `{slot_id}` : nouveau créneau réservé dans la **même transaction**, ancien libéré |
| POST | `/bookings/:id/confirm` | DOCTOR/ADMIN | `PENDING|PAID → CONFIRMED` |
| POST | `/bookings/:id/reject` | DOCTOR/ADMIN | `→ REJECTED` + motif, remboursement automatique si payé |
| POST | `/bookings/:id/complete` · `/no-show` | DOCTOR/OPERATOR | `CONFIRMED → COMPLETED|NO_SHOW` |
| GET | `/bookings/:id/receipt` | patient concerné | reçu (HTML imprimable, AR/FR) |

Règles serveur (toutes testées) :
1. `POST /bookings` verrouille le créneau (`FOR UPDATE`) ; deux appels
   concurrents → **un seul** `201`, l'autre reçoit `409 SLOT_TAKEN`.
2. Un verrou expiré (`hold_expires_at < now`) est libéré par le worker et par
   la requête elle-même avant toute nouvelle tentative.
3. `CONFIRMED` n'est atteignable qu'après un paiement **vérifié serveur**
   lorsque `service_fee > 0`.
4. Chaque transition écrit `appointment_status_history` (jamais d'écrasement).

## 5. Espace médecin

| Méthode | Chemin | Description |
|---|---|---|
| GET | `/doctor/profile` · PUT `/doctor/profile` | bio, tarifs, téléconsultation, langues |
| GET | `/doctor/availability` · PUT `/doctor/availability` | `{weekdays:[{weekday, opens, closes, break_start, break_end}], slot_minutes}` |
| POST | `/doctor/time-off` · DELETE `/doctor/time-off/:id` | congés / blocages |
| POST | `/doctor/slots/generate` | génère les créneaux `[from, to]` sans doublon (`ON CONFLICT DO NOTHING`) |
| POST | `/doctor/slots/:id/block` · `/unblock` | indisponibilité ponctuelle |
| GET | `/doctor/schedule?day=` | agenda du jour / semaine |
| GET | `/doctor/stats?from=&to=` | rendez-vous, présence, consultations, revenus estimés |

## 6. Téléconsultation

| Méthode | Chemin | Rôle | Description |
|---|---|---|---|
| POST | `/consultations` | PATIENT | `{doctor_id, kind, symptom_summary, consent, emergency_ack}` ; refusé si `telemedicine.enabled=false` (`409 LEGAL_BLOCKED`) |
| GET | `/consultations` | patient/médecin | liste selon le rôle |
| GET | `/consultations/:id` | ayants droit | détail + messages + documents (métadonnées seulement) |
| POST | `/consultations/:id/accept` · `/reject` · `/request-info` · `/answer` · `/close` | DOCTOR | transitions contrôlées ; `answer` enregistre la réponse du médecin, `close` fige le dossier |
| POST | `/consultations/:id/messages` | patient/médecin | message texte |
| POST | `/consultations/:id/documents` | patient/médecin | `multipart/form-data` (pdf/jpg/png/webp/heic, ≤ 10 Mo), `sha256` calculé, stockage privé |
| GET | `/documents/:id/link` | ayants droit | `{url, expires_at}` lien signé HMAC (5 min) |
| GET | `/documents/:id?token=` | — | flux binaire, `Content-Disposition: attachment`, `no-store` |
| POST | `/consultations/:id/video-room` | patient/médecin | crée/renvoie un identifiant de salle WebRTC signé (TURN à configurer) |

Garde-fous médicaux (non négociables dans le code) :
- bandeau « service non urgent » + numéros d'urgence (`14`, `021 23 50 50`) ;
- `emergency_ack` obligatoire pour soumettre ;
- aucun document « ordonnance » généré automatiquement (le médecin seul
  téléverse un document signé) ;
- refus possible à tout moment (`reject` + motif) ;
- aucune suggestion diagnostique automatisée dans le produit.

## 7. Paiements

| Méthode | Chemin | Rôle | Description |
|---|---|---|---|
| POST | `/payments/intents` | PATIENT/OPERATOR | `{purpose, appointment_id?, consultation_id?, provider?}` → `{payment_id, status, checkout_url?, simulated}` |
| GET | `/payments` · `/payments/:id` | ayants droit | historique, jamais de données de carte (aucune n'est collectée) |
| POST | `/webhooks/chargily` | Chargily | **corps brut** + en-tête `signature` (HMAC-SHA256 du secret) ; 403 si invalide ; idempotent par `event.id` |
| POST | `/payments/:id/sandbox-pay` | DEV uniquement | simule un paiement réussi **si** `PAYMENTS_SANDBOX=1` ; marque `livemode=false, simulated=true` |
| POST | `/payments/:id/refund` | FINANCE_MANAGER/ADMIN | `{amount, reason}` ≤ montant payé |
| GET | `/payments/:id/receipt` | patient | reçu |

Règle absolue : un `payment.status` ne devient `PAID` que par
`payments.verifyWebhook()` (signature valide + montant + devise + référence
connus). Un retour navigateur `?success=1` ne prouve **rien** et ne change
aucun statut.

## 8. Opérateur & branches

| Méthode | Chemin | Rôle | Description |
|---|---|---|---|
| GET | `/ops/dashboard` | OPERATOR+ | réservations totales/jour/en attente/confirmées/annulées, recettes, commissions opérateur/branche, médecins disponibles |
| GET | `/ops/doctors?specialty=&wilaya=&q=` | OPERATOR+ | médecins du périmètre + disponibilité en direct |
| GET | `/ops/patients?q=` | OPERATOR+ | recherche **sans donnée médicale** (nom, téléphone, ville) |
| POST | `/ops/patients` | OPERATOR+ | crée un patient **sans compte** |
| POST | `/ops/bookings` | OPERATOR+ | réservation pour un patient, `source = OPERATOR|BRANCH` |
| POST | `/ops/bookings/:id/payment-record` | OPERATOR+ | encaisse une réservation hors ligne (espèces constatées, traçable) |

Les opérateurs n'ont **aucun** accès aux `consultations`, `medical_documents`
ni aux champs de santé : la sérialisation est une allowlist, pas un filtre.

## 9. Branches & administration

| Méthode | Chemin | Rôle |
|---|---|---|
| GET/POST | `/branches` | ADMIN |
| PATCH | `/branches/:id` | ADMIN |
| POST | `/branches/:id/operators` `{user_id}` · DELETE `…/:user_id` | ADMIN/BRANCH_MANAGER |
| POST | `/branches/:id/doctors` `{doctor_id, commission_pct}` | ADMIN |
| GET | `/branches/:id/performance` | ADMIN/BRANCH_MANAGER |
| GET | `/admin/overview` | ADMIN |
| GET | `/admin/users?role=&status=&q=` · POST `/admin/users/:id/suspend|activate` | ADMIN |
| GET | `/admin/doctors/pending` · POST `/admin/doctors/:id/verify` · `/reject` | ADMIN |
| GET | `/admin/reviews?status=` · POST `/admin/reviews/:id/moderate` | ADMIN |
| GET/PUT | `/admin/settings` | ADMIN (clés `booking.*`, `fees.*`, `commission.*`, `telemedicine.*`) |
| GET | `/admin/audit-logs?entity=&actor=&from=&to=` | ADMIN |
| GET | `/admin/desktop-devices` · POST `/admin/desktop-devices/:id/revoke` | ADMIN |

## 10. Synchronisation desktop (DENTARDV / MEDIRDV)

Authentification : `Authorization: Device <device_id>.<secret>` + en-tête
`x-signature` = HMAC-SHA256(body, device.secret) + `x-timestamp` (±300 s).

| Méthode | Chemin | Description |
|---|---|---|
| POST | `/desktop/handshake` | `{product, clinic_uuid?, name, version}` → `{device_id, secret, server_time, config}` (secret affiché **une seule fois**) |
| GET | `/desktop/pull?cursor=` | `{bookings[], cancellations[], consultation_requests[], cursor}` |
| POST | `/desktop/push` | `{outbox:[{entity, local_id, remote_id, operation, payload}], cursor}` → `{accepted[], conflicts[], cursor}` |
| POST | `/desktop/heartbeat` | `{version, pending, last_error}` → met à jour `last_seen_at` |
| POST | `/desktop/conflicts/:id/resolve` | ADMIN : `{resolution}` |

Entités synchronisées (allowlist stricte) : `appointment`, `patient_identity`
(nom/téléphone uniquement), `payment_note`, `consultation_request`.
**Jamais** : `medications`, `prescriptions`, `medical_certificates`,
`allergies`, `chronic_conditions`, `notes` cliniques.

## 11. Notifications, rapports, divers

| Méthode | Chemin | Description |
|---|---|---|
| GET | `/notifications` · POST `/notifications/:id/read` · `/read-all` | in-app |
| GET/PUT | `/notifications/preferences` | par événement × canal |
| GET | `/reports/revenue?from=&to=&format=json|csv` | ADMIN/FINANCE |
| GET | `/reports/doctors?from=&to=` | ADMIN/FINANCE |
| GET | `/reports/branches?from=&to=` | ADMIN/FINANCE/BRANCH_MANAGER |
| GET | `/reports/refunds` | FINANCE |
| GET | `/health` · `/ready` | supervision |
| POST | `/webhooks/whatsapp` | WhatsApp Cloud API : vérification `hub.challenge`, signature `X-Hub-Signature-256` |

## 12. Codes d'erreur métier principaux

| Code | HTTP | Sens |
|---|---|---|
| `AUTH_REQUIRED` | 401 | session absente/expirée |
| `CSRF_INVALID` | 403 | jeton CSRF manquant/invalide |
| `FORBIDDEN` | 403 | rôle ou périmètre insuffisant |
| `VALIDATION` | 422 | schéma invalide (`details.fields`) |
| `SLOT_TAKEN` | 409 | créneau déjà réservé/verrouillé |
| `HOLD_EXPIRED` | 410 | verrou de paiement expiré |
| `PAYMENT_UNVERIFIED` | 409 | tentative de confirmer sans webhook vérifié |
| `PAYMENT_AMOUNT_MISMATCH` | 409 | montant du webhook ≠ intention |
| `LEGAL_BLOCKED` | 409 | fonction désactivée (télémédecine payante, portefeuille) |
| `SANDBOX_DISABLED` | 403 | `/sandbox-pay` hors environnement de test |
| `RATE_LIMITED` | 429 | quota dépassé |
| `DEVICE_UNAUTHORIZED` | 401 | appareil révoqué / signature invalide |
| `CONFLICT` | 409 | conflit de synchronisation |
