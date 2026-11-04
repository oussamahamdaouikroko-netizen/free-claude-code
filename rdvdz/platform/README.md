# RDV DZ — plateforme (API + front)

Monolithe Node.js 22 / Fastify 5 : API `/api/v1`, front PWA servi par le même
processus, base PostgreSQL (production) ou PGlite/WASM (développement, tests).

## Démarrage rapide (sans serveur de base)

**Installation en un clic** : `setup.bat` (Windows) ou `node setup.mjs` — voir
`docs/INSTALLATION.md`. Manuellement :

```bash
cd platform
npm install
cp .env.example .env.local     # puis générer APP_SECRET et STORAGE_ENCRYPTION_KEY
npm run migrate                # applique les migrations 001 → 011
npm run seed                   # données de démonstration (JAMAIS en production)
npm start                      # http://localhost:8080
```

`src/env.js` charge `.env`, `.env.local` puis `.env.<NODE_ENV>` **sans jamais
écraser** une variable déjà définie dans le shell. Aucun paquet `dotenv`.

Comptes de démonstration créés par `npm run seed` (mot de passe
`Demo#2026-Demo`, à changer immédiatement sur tout environnement partagé) :

| Téléphone | Rôle |
|---|---|
| `+213555000001` | SUPER_ADMIN |
| `+213555000002` | FINANCE_MANAGER |
| `+213555000003` | BRANCH_MANAGER |
| `+213555000004` | OPERATOR |
| `+213555000101…0103` | DOCTOR |
| `+213555000201…0203` | PATIENT |

Les paiements sont en mode `sandbox` **étiqueté comme simulé** ; aucune donnée
réelle ne doit transiter par cet environnement.

## Vérification

```bash
npm run check       # tout : 191 tests + syntaxe + schéma + types
npm test            # 191 tests (API + front) sur PGlite en mémoire
npm run test:schema # cohérence migrations ↔ code
npm run typecheck   # tsc --noEmit (checkJs désactivé : le code est du JS pur)
node scripts/check-syntax.mjs  # `node --check` sur les 69 fichiers livrés
```

`checkJs` est volontairement à `false` : le code est du JavaScript exécuté tel
quel, avec des annotations JSDoc documentaires ; `tsc` sert à contrôler la
configuration et les types ambiants, pas à bloquer sur des unions `unknown`.

Les tests du front tournent aussi hors navigateur :

- `tests/web.test.js` — rendu de chaque vue avec un DOM minimal et un `fetch`
  branché sur l'application réelle ; vérifie l'échappement HTML, la parité
  FR/AR, l'absence de secret et d'URL tierce, la CSP, le cache du service worker.
- `tests/web-e2e.test.js` — parcours complet dans un vrai DOM (jsdom) :
  navigation par hash, connexion, garde de rôle, bascule AR, déconnexion.

## Structure

```
src/
  config.js        configuration validée au démarrage (refuse de démarrer sinon)
  env.js           chargement .env sans dépendance
  db.js            pilote PostgreSQL / PGlite, migrations, transactions
  app.js           assemblage Fastify (sécurité, routes API, front en dernier)
  server.js        point d'entrée + worker (verrous expirés, rappels)
  lib/             crypto, erreurs, http, audit, rate-limit, sécurité, sessions
  modules/         auth, directory, booking, finance, payments, teleconsult,
                   notifications, desktop-sync, reports, settings
  routes/          auth, directory, bookings, consultations, payments, ops,
                   admin, desktop, me, web (fichiers statiques)
  web/             front : index.html, app.css, app.js, api.js, i18n.js,
                   ui.js, views/*.js, sw.js, manifest.webmanifest
packages/db/migrations/  SQL numérotées 001 → 011
scripts/           migrate, seed-demo, check-schema, check-syntax
tests/             node:test (aucun framework externe)
```

## Choix structurants

- **Aucune étape de build front** : modules ES natifs + CSS maison. Une seule
  origine (pas de CORS), CSP `default-src 'self'`, aucun CDN, aucune police
  distante — contrainte forte pour un réseau mobile lent.
- **Aucun jeton en `localStorage`** : session en cookie `HttpOnly`, jeton CSRF
  en mémoire, renvoyé par `/auth/me` après chaque rechargement.
- **Échappement par défaut** : le gabarit `h` échappe toute interpolation ;
  `raw()` est réservé au HTML produit par le code lui-même.
- **Le service worker ne met jamais une réponse d'API en cache** : sur un poste
  partagé, un cache hors ligne pourrait afficher les données d'un autre compte.
- **Migrations SQL rejouables**, pas d'ORM ; requêtes 100 % paramétrées.
- **Paiements** : interface `PaymentProvider` avec adaptateurs `chargily`,
  `manual`, `sandbox` — le mode simulé est affiché comme tel dans l'interface.
