# Matrice de tests

Chaque ligne correspond à un test **exécuté** dans `platform/` (`npm test`).
Aucun élément n'est déclaré « fait » sans une ligne ici.

Dernière exécution : **188 tests, 188 réussis**, `npm run test:schema` conforme
(version de schéma 11).

```bash
cd platform && npm run check  # tests + syntaxe + schéma + types
npm test                      # tests seuls
node tests/web.test.js        # un seul fichier
```

## 1. Répartition

| Fichier | Tests | Couvre |
|---|---|---|
| `tests/health.test.js` | 9 | démarrage, `/health`, `/ready`, en-têtes de sécurité, 404 JSON |
| `tests/auth.test.js` | 14 | inscription, OTP, connexion, sessions, CSRF, verrouillage |
| `tests/bookings.test.js` | 15 | créneaux, verrou anti-double, statuts, annulation, reçus |
| `tests/teleconsult.test.js` | 20 | consentement, messages, pièces jointes, liens signés, salle vidéo |
| `tests/payments.test.js` | 28 | intentions, webhook signé, idempotence, sandbox, remboursements |
| `tests/reports.test.js` | 19 | revenus réels vs simulés, exports CSV, commissions |
| `tests/admin.test.js` | 26 | vérification médecins, suspension, réglages, audit, périmètre |
| `tests/desktop-sync.test.js` | 15 | appairage, HMAC, pull/push, conflits, rejeu |
| `tests/web.test.js` | 24 | rendu des vues front, échappement, i18n, sécurités navigateur |
| `tests/web-e2e.test.js` | 9 | parcours complet dans un vrai DOM (jsdom) |
| `tests/setup.test.js` | 9 | installateur : zéro dépendance, version minimale cohérente, `.bat` sans logique dupliquée |

## 2. Sécurité (front compris)

| Risque | Test |
|---|---|
| XSS par donnée serveur | `web.test.js` — « le gabarit échappe les valeurs non sûres » : `<script>`, guillemets, fragment `h` imbriqué non ré-échappé |
| Secret ou URL tierce dans le front | `web.test.js` — « aucun fichier du front ne contient de secret ni d'URL absolue » |
| Script inline / CSP | `web.test.js` — « le HTML servi porte une CSP stricte » (aucun `<script>` sans `src`, aucun `onclick=`) |
| Fuite de données via le cache hors ligne | `web.test.js` — « le service worker ne met jamais en cache une réponse d'API » |
| Jeton en stockage navigateur | `web.test.js` — « aucun jeton n'est écrit dans le stockage du navigateur » (`credentials: 'same-origin'` exigé) |
| Accès à une route d'administration | `web-e2e.test.js` — « un patient ne peut pas ouvrir l'administration » |
| Script front figé en cache (correctif impossible à livrer) | `web.test.js` — « les fichiers du front sans empreinte ne sont jamais figés en cache » |
| Injection SQL | `bookings.test.js` / `admin.test.js` — requêtes paramétrées, charge utile `' OR 1=1` |
| Webhook forgé / rejoué | `payments.test.js` — HMAC invalide → 401, `event_id` dupliqué → idempotent |
| Lien de document expiré ou falsifié | `teleconsult.test.js` — 410 `LINK_EXPIRED` |
| Périmètre de branche | `admin.test.js` — opérateur hors périmètre → 403 |

## 3. Conformité 18-07 / 25-11

| Exigence | Test |
|---|---|
| Aucune donnée médicale visible par un opérateur | `web.test.js` — « la console opérateur ne présente aucune donnée médicale » |
| Consentement explicite avant téléconsultation, mention « non urgent » | `web.test.js` + `teleconsult.test.js` |
| Mentions légales et droits des personnes dans l'interface | `web.test.js` — inscription, « mon compte » (export, suppression) |
| Transfert transfrontalier bloqué par défaut | `admin.test.js` — réglages `public.*`, refus hors allowlist |
| Traçabilité des actions sensibles | `admin.test.js` — `audit_logs` écrits pour vérification/suspension |

## 4. Interface AR / FR

| Exigence | Test |
|---|---|
| Parité stricte des clés (aucun texte non traduit) | `web.test.js` — « le dictionnaire arabe est complet » |
| Toute clé appelée par une vue existe en FR **et** en AR | `web.test.js` — « toute clé utilisée par les vues existe… » |
| Codes d'erreur API traduits dans les deux langues | `web.test.js` — 19 codes vérifiés |
| Bascule FR/AR, direction `rtl`/`ltr` | `web-e2e.test.js` — « la bascule FR/AR inverse la direction » |
| Formats locaux (montants DZD, heures 24 h, fuseau Algérie) | `web.test.js` — montants, dates, initiales |
| Aucun texte technique affiché (`undefined`, `NaN`, `[object Object]`) | `web-e2e.test.js` — « aucune trace de données techniques » |

## 5. Parcours de bout en bout

| Parcours | Test |
|---|---|
| Accueil : recherche + 58 wilayas chargées depuis l'API | `web-e2e.test.js` #1 |
| Navigation par hash (vues, URL, état stable) | `web-e2e.test.js` #2 |
| Route protégée sans session → redirection connexion | `web-e2e.test.js` #3 |
| Connexion patient → « Mes rendez-vous » + `body[data-role]` | `web-e2e.test.js` #4 |
| Déconnexion → session effacée côté client et serveur | `web-e2e.test.js` #8 |
| Administration : tableaux réels, séparation réel / simulé | `web.test.js` + `web-e2e.test.js` #6 |

## 6. Ce qui n'est **pas** couvert automatiquement

| Point | Raison | Vérification |
|---|---|---|
| Rendu visuel (pixels, régressions CSS) | aucun navigateur graphique dans l'environnement de test | revue manuelle + `docs/09-GO-LIVE-CHECKLIST.md` |
| Service worker en conditions réelles (installe, cache froid) | nécessite une origine HTTPS servie par un navigateur | `sw.js` vérifié statiquement + test manuel listé dans la checklist |
| WhatsApp officiel, SMS, Chargily live | identifiants externes absents | adaptateurs désactivés, états dans `STATUS.md` |
| WebRTC distant (TURN) | infrastructure non fournie | salle et signalisation testées côté API |
