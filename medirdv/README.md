# MediRDV — Gestion de Cabinets Médicaux & Polycliniques (Algérie)

Application de bureau **100 % hors-ligne** (Windows `.exe`) dédiée à **toutes les spécialités médicales et polycliniques multi-services en Algérie** : Médecine Générale, Cardiologie, Ophtalmologie, Orthopédie, Pédiatrie, Gynécologie, ORL, Dermatologie, Gastro-entérologie, Neurologie, Urologie, etc.

- **Zéro abonnement, zéro serveur externe** : toutes les données patients restent stockées localement sur l’ordinateur de la clinique (`medirdv.sqlite` — conformité Loi 18-07).
- **Bilingue Français / العربية (RTL)** en un clic.
- **Identité complète de la clinique & du médecin** : Nom de la clinique, Wilaya & adresse, Téléphone, Nom du médecin, Spécialité médicale et N° du Conseil de l’Ordre.
- **Cliniques Multi-Services (`عيادة متعددة المصالح`)** : Gestion de plusieurs départements/services médicaux avec files d’attente indépendantes et sélection automatique du service par le patient sur WhatsApp.
- **Ordonnances Médicales (`وصفة طبية`) & Nomenclature Algérienne** :
  - Catalogue local hors-ligne de médicaments commercialisés en Algérie (extensible par le médecin).
  - Rédaction rapide (posologie, moment de prise, durée, constantes vitales, bilan biologique/radiologique, conseils) + impression A4 officielle avec en-tête du cabinet et du médecin.
  - Alerte automatique d’allergies médicamenteuses, ordonnances types réutilisables, renouvellement en 1 clic et certificats médicaux imprimables.
- **Robot WhatsApp sécurisé (QR Code)** : réponses uniquement aux messages entrants, délais humains et plafonds anti-blocage.
- **Caisse, Dettes, Dépenses, Sauvegardes locales & Export `.xlsx` hors-ligne**.

## Commandes utiles

```bash
npm ci
npm test
npm start          # Lancer l'application Electron
npm run demo:web   # Aperçu web interactif avec données de démonstration
npm run dist:win   # Générer l'installateur Windows MediRDV-Setup-1.0.0.exe
npm run dist:demo  # Générer la démo portable MediRDV-Demo-1.0.0.exe
```
