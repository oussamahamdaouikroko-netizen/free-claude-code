# Checklist de mise en production

À dérouler dans l'ordre. Chaque case doit être cochée **avec une preuve**
(commande exécutée, capture, ticket, document signé). Une case non cochée est
un blocage, pas une recommandation.

## 0. Pré-requis juridiques et contractuels

- [ ] Autorisation **ANPDP** obtenue pour le traitement (loi 18-07 mod. 25-11).
- [ ] Hébergement des données de santé **en Algérie** (aucun transfert
      transfrontalier) — vérifié dans `docs/05-COST.md` §4.
- [ ] Revue juridique de l'acte de télémédecine : si validée, activer
      `TELEMEDICINE_PAID_ENABLED=true`, sinon laisser `false`.
- [ ] Contrat marchand **Chargily Pay** signé, clés `live_sk_` en coffre.
- [ ] Numéro **WhatsApp Business** vérifié (ou décision assumée de rester en
      repli `wa.me`).
- [ ] Registre de traitement et politique de rétention validés (durées
      d'archivage des dossiers).

## 1. Configuration

- [ ] `APP_SECRET` ≥ 48 octets aléatoires, unique par environnement
      (`node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`).
- [ ] `STORAGE_ENCRYPTION_KEY` 32 octets, distincte de `APP_SECRET`, sauvegardée
      hors ligne (sa perte rend les pièces jointes illisibles).
- [ ] `NODE_ENV=production`, `COOKIE_SECURE=true`, `OTP_DEBUG=false`.
- [ ] `DB_DRIVER=pg` + `DATABASE_URL` (PGlite réservé au dev et aux tests).
- [ ] `ALLOW_CROSS_BORDER=false`, `WALLET_ENABLED=false`.
- [ ] `PAYMENTS_PROVIDER` = `chargily` (jamais `sandbox` en production) et
      `PAYMENTS_SANDBOX_ALLOWED=false`.
- [ ] `TELEMEDICINE_ENABLED` selon la décision juridique.
- [ ] `.env` **absent** du dépôt et du serveur en clair (variables d'injection).
- [ ] HTTPS terminé en amont, HSTS actif, redirection 80 → 443.

## 2. Base de données

- [ ] `npm run migrate` → version de schéma **11**.
- [ ] `npm run test:schema` → « schéma conforme ».
- [ ] Rôle applicatif PostgreSQL **sans** `UPDATE`/`DELETE` sur `audit_logs`.
- [ ] Sauvegarde quotidienne + **restauration testée** (pas seulement planifiée).
- [ ] `SELECT count(*) FROM settings WHERE key LIKE 'public.%'` → 6 réglages.
- [ ] **Aucune donnée de démonstration** : `scripts/seed-demo.js` n'a pas été
      exécuté (il insère des comptes `Demo#2026-Demo`).
- [ ] `SELECT * FROM users WHERE phone LIKE '+2135550000%'` → 0 ligne.

## 3. Vérifications applicatives (avec preuve)

- [ ] `cd platform && npm test` → **191/191**.
- [ ] `curl -s https://<hôte>/api/v1/health` → `{"status":"ok"}`.
- [ ] `curl -sI https://<hôte>/` → CSP `default-src 'self'`, `X-Frame-Options`,
      `Referrer-Policy`, `X-Content-Type-Options`.
- [ ] `/admin`, `/ops`, `/bookings` **non indexés** (`robots.txt` servi et
      bloque bien la racine des zones privées).
- [ ] Webhook Chargily joignable **uniquement** avec une signature valide :
      envoyer un POST non signé → `401`.
- [ ] Test réel d'un paiement en mode test Chargily, puis d'un remboursement.
- [ ] Envoi réel d'un message WhatsApp de confirmation et d'un rappel.
- [ ] Attestation d'accessibilité : navigation clavier, contrastes, RTL arabe.

## 4. Interface (revue manuelle, non automatisée)

- [ ] Module ES servis sans erreur console (Chrome, Firefox, Safari, Android).
- [ ] PWA installable : manifest lu, icône affichée, `sw.js` actif en HTTPS.
- [ ] **Le service worker ne sert pas de données API hors ligne** : couper le
      réseau, recharger, vérifier qu'aucune donnée patient n'apparaît.
- [ ] Bascule FR/AR : `dir=rtl`, tous les textes traduits, chiffres lisibles.
- [ ] Parcours complet au téléphone : recherche → créneau → paiement → reçu.
- [ ] Parcours opérateur : recherche patient → réservation au guichet → encaissement.
- [ ] Parcours médecin : agenda du jour, congés, confirmation d'un rendez-vous.
- [ ] Impression d'un reçu (mise en page `@media print`).

## 5. Exploitation

- [ ] Journal d'audit consultable et non modifiable.
- [ ] Alertes : erreurs 5xx, échecs de webhook, files de synchronisation bloquées.
- [ ] Rotation des secrets documentée (sessions invalidées proprement).
- [ ] Procédure d'incident : qui prévient l'ANPDP, dans quel délai, avec quel
      modèle de notification.
- [ ] Coordonnées de support affichées (téléphone + WhatsApp) et testées.
- [ ] Plan de reprise : RPO/RTO écrits, testés une fois.

## 6. Après la mise en production

- [ ] Surveiller 24 h : 5xx, latence p95, échecs de paiement, files sync.
- [ ] Vérifier le premier rendez-vous réel de bout en bout (patient + clinique).
- [ ] Archiver les preuves de cette checklist avec la version déployée.
