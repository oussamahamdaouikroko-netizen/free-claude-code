# DentaRDV 🦷

**Application de bureau 100 % gratuite et hors-ligne pour cabinets dentaires (Algérie).**
Agenda, dossiers patients, paiements, dépenses, rapports **et réservation automatique par WhatsApp**.

تطبيق سطح مكتب مجاني ويعمل **دون إنترنت** لعيادات الأسنان: المواعيد، ملفات المرضى،
المدفوعات، المصاريف، التقارير والحجز التلقائي عبر واتساب.

| | |
|---|---|
| Stack | Electron 38 · better-sqlite3 · HTML/CSS/JS vanilla · @whiskeysockets/baileys |
| Coût récurrent | **0 DZD** — aucun cloud, aucun abonnement, aucune API payante |
| Données | `%APPDATA%\DentaRDV\data\dentardv.sqlite` (+ sauvegarde quotidienne) |
| Plateforme | Windows 10/11 (installateur `.exe`), portable possible |
| Langues | Français + العربية (RTL), changement à chaud |

---

## 1. Démarrage rapide

```bash
cd dentardv
npm install

# Aperçu dans le navigateur (base de démonstration, mot de passe 1234)
npm run demo          # → http://localhost:4173

# Application réelle (Electron)
npm start

# Tests (65 tests, sans réseau ni téléphone)
npm test
```

> `npm run demo` sert exactement la même interface et les mêmes services que
> l'application Electron : pratique pour la mise au point et les captures.

---

## 2. Construire l'installateur Windows

### Option A — GitHub Actions (gratuit, recommandé)

Le workflow [`.github/workflows/dentardv-windows.yml`](../.github/workflows/dentardv-windows.yml)
lance les tests sur Linux puis produit `DentaRDV-Setup-1.0.0.exe` sur un runner Windows.

- **Bouton manuel** : Actions → *Build DentaRDV for Windows* → *Run workflow*
  → télécharger l'artefact `DentaRDV-Setup-windows`.
- **Release** : `git tag v1.0.0 && git push origin v1.0.0` → un Release GitHub
  est créé avec le `.exe` attaché.

### Option B — machine Windows locale

```powershell
cd dentardv
npm ci
npm test
npm run dist                              # → release\DentaRDV-Setup-1.0.0.exe
```

L'installateur n'est pas signé numériquement (certificat payant) : Windows affiche
« Application non reconnue » → **Informations complémentaires → Exécuter quand même**.

---

## 3. Ce que fait l'application

### 3.1 Robot WhatsApp (numéro dédié du cabinet)

1. Réglages → WhatsApp → **Connecter WhatsApp** → un QR code s'affiche.
2. Sur le téléphone du cabinet : WhatsApp → *Appareils connectés* → *Connecter un appareil*.
3. Le patient écrit **son nom complet** → le robot réserve **le premier jour libre**
   (selon la capacité/jour et les jours travaillés) et répond avec la date + le numéro de passage.

| Message du patient | Réponse |
|---|---|
| `Mohamed Ben Ali` | Date du 1er créneau + numéro de passage |
| `ANNULER` / `إلغاء` | Annule le rendez-vous à venir |
| `MON RDV` / `موعدي` | Rappelle date + numéro |
| `AIDE` / `مساعدة` | Menu d'aide |
| Planning complet | Message « liste d'attente » + ligne dans la liste d'attente |

**Rappels** : la veille à 17 h (heure configurable), un message est envoyé à chaque
patient du lendemain. Chaque rappel est journalisé : jamais deux fois.

**Réduction du risque de blocage** (le numéro du cabinet doit rester sain) :

- répond **uniquement** aux messages entrants, jamais de diffusion ni de groupe ;
- ignore les messages de plus de 10 minutes (pas de rattrapage massif après reconnexion) ;
- délai de frappe proportionnel au texte (4–9 s par défaut) + pause aléatoire ;
- limites : 8 réponses/h/numéro et 120/jour (configurables) ;
- 15–35 s de pause entre deux rappels, `onWhatsApp()` avant chaque envoi ;
- **impossible d'envoyer un message à froid** depuis l'application.

### 3.2 Tableau de bord du dentiste (protégé par mot de passe)

- **Agenda du jour** : file d'attente numérotée, statut (*prévu / terminé / absent*),
  report d'un patient, encaissement en un clic.
- **Patients** : dossier, téléphone, notes, historique complet des visites, dettes.
- **Soins & tarifs** : catalogue par défaut (prix du marché algérien, modifiable),
  prix **librement ajustable sur chaque rendez-vous** (l'historique ne bouge jamais).
- **Paiements partiels** et **dettes** : acompte, paiement par visite, ou règlement
  d'une dette — imputé automatiquement sur les visites les plus anciennes.
- **Dépenses** : matériel, loyer, salaires, laboratoire, électricité, transport,
  publicité… avec catégories extensibles.
- **Rapports** : journalier (caisse du jour) et mensuel (série par jour, meilleur jour,
  moyenne, dépenses par catégorie), **impression** du rapport et **reçu de paiement**.
- **Réglages** : capacité/jour, jours travaillés, nom du cabinet, devise (DZD),
  sauvegarde automatique + restauration, changement de mot de passe.

Toute la monnaie est gérée en **DZD** avec arrondi au centime.

### 3.3 Sauvegardes

- Snapshot **quotidien** via `VACUUM INTO` (cohérent même pendant l'utilisation).
- Rétention configurable (30 par défaut), export manuel vers un fichier.
- **Restauration** : vérifie l'intégrité (`PRAGMA integrity_check`), crée une copie de
  sécurité `before-restore-*.sqlite`, puis remplace la base et recharge l'interface.

---

## 4. Architecture

```
dentardv/
├── src/main/                  processus principal Electron
│   ├── index.js               démarrage, fenêtre, cycle de vie
│   ├── ipc.js                 canal IPC unique + garde d'authentification
│   ├── handlers.js            couche d'actions sans Electron (réutilisée par la démo)
│   ├── print.js               reçus / rapports (fenêtre cachée + imprimante)
│   ├── db/                    schéma, migrations (user_version), seed
│   ├── services/              métier : patients, agenda, paiements, dépenses,
│   │                          rapports, réglages, auth, sauvegardes
│   ├── utils/                 dates (ISO local), erreurs, téléphones
│   └── whatsapp/              transport Baileys · intents · bot · messages FR/AR
├── src/preload/index.js       pont contextBridge (API minimale)
├── src/renderer/              UI vanilla : 8 écrans, i18n FR/AR, RTL
├── demo/server.js             serveur d'aperçu navigateur (mêmes handlers)
├── tests/                     65 tests node:test (dont smoke test du renderer)
├── scripts/after-pack.js      correctif better-sqlite3 pour l'app packagée
└── electron-builder.yml       cible NSIS x64
```

**Règles de conception**

- Aucun accès Internet à l'exécution (sauf le lien WhatsApp choisi par le cabinet).
- Le renderer n'a **aucun accès** à Node : `contextIsolation`, `sandbox`,
  `nodeIntegration: false`, CSP stricte, allowlist d'actions IPC.
- Une seule connexion SQLite synchrone (better-sqlite3) : pas de course, pas de ORM.
- Les paiements sont **immuables** : une erreur se corrige en supprimant la ligne,
  le solde est toujours recalculé par somme.
- Les prix des rendez-vous sont des **copies** : modifier le catalogue ne réécrit pas
  l'histoire.
- Chaque action sensible passe par `auth.requireUnlocked()` (session de 30 min).

---

## 5. Tests

```bash
npm test     # 65 tests, ~20 s, sans réseau ni téléphone
```

| Fichier | Couverture |
|---|---|
| `dates.test.js` | dates ISO locales, années bissextiles, formats FR/AR |
| `booking.test.js` | capacité, jours travaillés, file, doublons, horizon, prix |
| `payments-reports.test.js` | acomptes, dettes FIFO, reçus, rapports jour/mois |
| `bot.test.js` | intentions FR/AR, réservation, annulation, liste d'attente |
| `whatsapp-transport.test.js` | JID, rate-limit, délais, anti-doublon, rappels |
| `auth-backup.test.js` | mot de passe (scrypt), sauvegarde, restauration, purge |
| `appointment-edit.test.js` | prix modifiable, garde-fou « prix < encaissé », liste d'attente |
| `whatsapp-guard.test.js` | messages éphémères, réactions/éditions ignorées, backlog ancien |
| `i18n.test.js` | clés FR/AR synchronisées, codes d'erreur traduits |
| `packaging.test.js` | config electron-builder, hook afterPack, workflow GitHub Actions |
| `electron-main.test.js` | démarrage du main process (stub Electron), IPC, sécurité |
| `renderer.smoke.test.js` | l'UI réelle (jsdom) : 8 écrans, modales, RTL, verrouillage |

---

## 6. Licence & limites connues

MIT (voir [`LICENSE`](../LICENSE)).

- L'API WhatsApp n'est pas officielle : une automatisation, même prudente, reste
  contraire aux CGU de WhatsApp. Utiliser un **numéro dédié**, jamais le numéro personnel.
- Les rappels ne sont envoyés que si l'application est ouverte à l'heure prévue.
- L'installateur n'est pas signé (pas de certificat payant).
- L'import d'un historique ancien se fait via `historical: true` (capacité ignorée).
