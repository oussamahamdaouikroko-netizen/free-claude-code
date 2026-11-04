# Installation

## Windows — double-clic

1. Décompressez l'archive **en entier** (ne lancez pas le fichier depuis le ZIP).
2. Double-cliquez sur **`setup.bat`**.
3. Choisissez `1` (installer et démarrer la démo).
4. Le navigateur s'ouvre sur `http://localhost:8080`.

Le script fait tout : vérifie Node.js, installe les dépendances, génère les
secrets, crée la base locale, applique les migrations, charge les données de
démonstration, vérifie le schéma, puis démarre. `Ctrl+C` arrête le serveur.

Aucun serveur de base de données à installer : PGlite (PostgreSQL compilé en
WebAssembly) tourne dans le processus Node.

### Si Node.js manque

`setup.bat` le détecte, ouvre la page de téléchargement officielle et vous
demande de relancer après installation. Prenez la version **LTS**, options par
défaut (`.msi`), et acceptez l'ajout au `PATH`.

### Ce que le script modifie

| Chemin | Contenu |
|---|---|
| `platform/node_modules/` | dépendances (recréable) |
| `platform/.env.local` | secrets générés **pour cette machine**, ignoré par Git |
| `platform/.data/` | base de démonstration + futur stockage des documents |

Rien n'est écrit hors du dossier du projet. Pas de service Windows, pas de clé
de registre, pas de tâche planifiée.

## Linux / macOS

```bash
node setup.mjs              # menu
node setup.mjs --yes        # installation complète + démarrage
node setup.mjs --no-start   # installer sans démarrer
node setup.mjs --check      # vérifier sans rien modifier
node setup.mjs --reset      # effacer la base de démo et réinstaller
```

Même logique que sous Windows : le `.bat` ne fait qu'appeler `setup.mjs`.

## En ligne de commande, à la main

```bash
cd platform
npm install
cp .env.example .env.local     # puis renseigner APP_SECRET et STORAGE_ENCRYPTION_KEY
npm run migrate
npm run seed
npm start
```

## Comptes de démonstration

Mot de passe : `Demo#2026-Demo` — **données fictives, paiements simulés**.

| Téléphone | Rôle |
|---|---|
| `+213555000201` | patient |
| `+213555000101` | médecin |
| `+213555000004` | opérateur |
| `+213555000003` | responsable de branche |
| `+213555000002` | responsable financier |
| `+213555000001` | administrateur |

## Vérifier l'installation

```bash
cd platform
npm run check     # 191 tests + syntaxe + schéma + types (≈ 40 s)
```

Le script d'installation exécute déjà `check-schema` et `check-syntax` ; la suite
complète de tests n'est lancée qu'à la demande, pour ne pas imposer 40 secondes
à chaque installation.

## Problèmes courants

| Message | Cause | Solution |
|---|---|---|
| `Node.js ... trop ancien` | version < 20.11 | installer la LTS |
| `Le port 8080 est déjà utilisé` | autre logiciel ou copie du projet | fermer l'autre programme, ou changer `PORT=` dans `platform/.env.local` |
| `Le dossier platform/ est introuvable` | archive décompressée partiellement | re-décompresser le dossier entier |
| `EACCES` / `EPERM` sous Windows | antivirus ou dossier protégé | déplacer le projet dans `C:\Users\<vous>\Documents\rdvdz` |
| `npm` introuvable alors que Node est installé | `PATH` non rechargé | fermer la fenêtre et rouvrir `setup.bat` |

### En cas d'échec : `setup-error.log`

À chaque erreur, l'installateur écrit **`setup-error.log`** dans le dossier
`rdvdz/` (à côté de `setup.bat`), et le `.bat` le réaffiche à l'écran — une
fenêtre `cmd` défile trop vite pour lire un message. Ce fichier contient la
sortie complète, la version de Node, le système et l'erreur exacte. Envoyez-le
pour obtenir de l'aide. Il est supprimé automatiquement après une installation
réussie.

## Ce que le script ne fait **pas**

- Il n'installe pas Node.js à votre place (il vous y conduit).
- Il ne configure pas les identifiants réels : Chargily, WhatsApp Business, SMS,
  autorisation ANPDP. Ce sont des dépendances externes, décrites dans
  `docs/STATUS.md` et bloquantes pour une mise en production réelle — voir
  `docs/09-GO-LIVE-CHECKLIST.md`.
- Il ne déploie pas sur un serveur : il prépare un poste de travail ou une
  démonstration.

## Produire un `setup.exe`

Le `setup.bat` couvre le besoin sur Windows. Si vous voulez un exécutable unique
(à distribuer à des collègues sans leur fournir Node.js), il faut le fabriquer
**sur Windows** :

```powershell
npm i -g @yao-pkg/pkg
cd rdvdz
node build-exe.mjs
# → dist/rdvdz-setup.exe
```

L'exe embarque Node + l'installateur. Il ne remplace pas le dossier du projet :
placez-le à côté de `platform/`. `build-exe.mjs` refuse de s'exécuter hors
Windows, parce qu'un binaire Windows non testé ne vaut pas mieux qu'un `.bat`.

**Rappel** : le `.bat` et le `.exe` font la même chose. Le `.bat` a l'avantage
d'être lisible, modifiable et vérifiable par les tests du dépôt.
