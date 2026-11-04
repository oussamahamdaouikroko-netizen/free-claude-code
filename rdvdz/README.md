# RDV DZ

Prise de rendez-vous médicaux en Algérie : annuaire de médecins, réservation en
ligne, console pour les cliniques, téléconsultation encadrée, paiements tracés.
AR/FR, pensé pour un usage sur téléphone avec un réseau lent.

## Démarrer (Windows)

Double-cliquez sur **`setup.bat`**, choisissez `1`. Le navigateur s'ouvre sur
`http://localhost:8080`.

## Démarrer (Linux / macOS)

```bash
node setup.mjs
```

Détails, comptes de démonstration et dépannage : **[`docs/INSTALLATION.md`](docs/INSTALLATION.md)**.

## Contenu du dossier

| Dossier | Rôle |
|---|---|
| `platform/` | API + interface web (Node.js, aucune étape de build) |
| `docs/` | architecture, base de données, API, paiements, sécurité, tests, mise en production |
| `desktop/` | pont de synchronisation avec DENTARDV / MEDIRDV |
| `setup.mjs` · `setup.bat` | installateur |
| `build-exe.mjs` | fabrication d'un `setup.exe` autonome (sous Windows) |

## Vérifier

```bash
cd platform && npm run check
```

188 tests : API, vues, parcours navigateur, installateur, schéma, syntaxe, types.

## État du projet

`docs/STATUS.md` dit ce qui est fait **et testé**, ce qui dépend d'une ressource
externe (clés Chargily, WhatsApp Business, autorisation ANPDP) et ce qui reste
bloqué. `docs/09-GO-LIVE-CHECKLIST.md` liste ce qu'il faut avant une vraie mise
en production.

> Les données fournies par l'installateur sont **fictives** et les paiements sont
> en mode **simulé**, clairement étiqueté dans l'interface.
