# MediRDV v2.0.0 — Suite Médicale Hors-Ligne pour Cabinets & Polycliniques (Algérie)

**MediRDV** est un logiciel de bureau Windows **100 % gratuit, 100 % hors-ligne** (à l’exception de la passerelle WhatsApp optionnelle sur le téléphone de la clinique) conçu spécialement pour les médecins spécialistes, généralistes et polycliniques multi-services en Algérie.

## Téléchargement de l’installateur Windows (`Setup.exe`)

Les installateurs Windows compilés automatiquement via GitHub Actions se trouvent dans la section **Releases** du dépôt :
- **Installateur complet Windows (64-bit NSIS)** : `MediRDV-Setup-2.0.0.exe` (ou `MediRDV-Setup-1.0.0.exe` pour la v1)
- **Version démonstration portable (sans installation, pré-remplie)** : `MediRDV-Demo-2.0.0.exe`
- Lien des versions publiées : `https://github.com/oussamahamdaouikroko-netizen/free-claude-code/releases`

Pour compiler localement sous Windows :
```bash
cd medirdv
npm ci
npm test
npm run dist        # Génère release/MediRDV-Setup-2.0.0.exe
npm run dist:demo   # Génère release/MediRDV-Demo-2.0.0.exe
```

## Architecture & Conformité Loi Algérienne 18-07

Voir [`docs/ARCHITECTURE_AND_COMPLIANCE.md`](docs/ARCHITECTURE_AND_COMPLIANCE.md) pour le détail complet des 10 migrations SQLite (`MIGRATION_1` → `MIGRATION_10`), des actions IPC sécurisées par rôle (RBAC), des sauvegardes chiffrées `AES-256-GCM` et des garanties de protection des données de santé (Loi n° 18-07).

## Avertissement Médical Obligatoire

MediRDV fournit une aide informatique à la rédaction d’ordonnances et à la détection d’alertes. Il ne remplace en aucun cas le jugement clinique du médecin ni le contrôle pharmaceutique. Les bases de démarrage cliniques (`verified = 0`) sont fournies à titre indicatif et peuvent être remplacées par import officiel CSV / JSON / XLSX depuis l’écran **Paramètres**.
