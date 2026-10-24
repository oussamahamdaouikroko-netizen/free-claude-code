## DentaRDV

Application de bureau **100% hors-ligne** pour cabinets dentaires — agenda, patients,
paiements, dépenses, rapports et réservation automatique par WhatsApp.

تطبيق سطح مكتب يعمل **دون إنترنت** لعيادات الأسنان: المواعيد، المرضى، المدفوعات،
المصاريف، التقارير والحجز التلقائي عبر واتساب.

### Installation (Windows 10/11)

1. Téléchargez `DentaRDV-Setup-*.exe`.
2. Lancez-le. Windows peut afficher « Application non reconnue » : cliquez sur
   **Informations complémentaires → Exécuter quand même**.
   L'installeur n'est pas signé — normal pour une application gratuite.
3. Au premier lancement, créez le mot de passe du cabinet.
4. WhatsApp → **Connecter WhatsApp** → scannez le QR code avec le téléphone du cabinet.

### Données

- Tout est stocké localement dans `%APPDATA%\DentaRDV\data` (`dentardv.sqlite`).
- Une sauvegarde automatique est créée chaque jour dans `data\backups`.
- Aucun compte, aucun abonnement, aucune connexion cloud.
- En cas de problème, le fichier `data\dentardv.log` contient tout l'historique
  technique (version, erreurs, WhatsApp) — il suffit de l'envoyer au support.
  Son chemin exact est affiché dans **Réglages → À propos**.

### Nouveautés 1.1.0

- **Export Google Sheets / Excel** : depuis *Rapports*, un vrai classeur `.xlsx`
  est créé **sur l'ordinateur**, sans Internet. Il s'ouvre directement dans
  Google Sheets (Google Drive → *Ouvrir avec → Google Sheets*), Excel ou
  LibreOffice. Trois formats : la **période affichée** (jour ou mois), **tout le
  cabinet** (patients, dettes, rendez-vous, paiements, dépenses, soins), ou un
  simple **copier-coller** du tableau (Ctrl+V dans une feuille Google).
  Les en-têtes sont figés, les dates sont de vraies dates et les montants au
  format monétaire : les filtres et les sommes fonctionnent immédiatement.
- **Nouvelle interface** inspirée de macOS : cartes blanches, coins arrondis,
  ombres douces, barre translucide, bascules segmentées, interrupteurs iOS.
- **Icônes professionnelles** : plus d'emoji — 47 icônes SVG dessinées dans
  l'application (aucune police, aucun téléchargement), identiques en français
  et en arabe, lisibles à l'impression.
- **Sons discrets** : clic, validation, erreur, ouverture — générés par le
  système, sans fichier audio. Désactivables dans *Réglages → Interface*.
- **Animations** courtes et sobres (apparition, compteurs, graphique), coupées
  automatiquement si Windows est réglé sur « réduire les animations ».
- Les rapports gardent le même contenu : le tableau de bord, l'agenda, les
  dossiers et WhatsApp ne changent pas.

### Nouveautés 1.0.1 (correctif)

- **Le robot répond enfin à tous les patients.** WhatsApp envoie maintenant
  certains messages avec un identifiant LID (`@lid`) au lieu du numéro de
  téléphone : ils étaient ignorés. Les deux formats sont traités, et le numéro
  est retrouvé automatiquement (`remoteJidAlt` puis table de correspondance).
- Les messages arrivés pendant une coupure ou une mise en veille de l'ordinateur
  (rejoués par WhatsApp) sont traités s'ils ont moins de 10 minutes, au lieu
  d'être perdus.
- Nouveaux compteurs dans **Réglages → WhatsApp** : *Messages reçus*, *Réponses
  envoyées*, *Dernier message reçu* et *Dernier message ignoré* avec sa raison
  (groupe, doublon, message trop ancien, limite atteinte…). Plus de silence
  inexpliqué.
- Corrigé : l'agenda de démonstration plantait le vendredi (jour de fermeture).

### Nouveautés 1.0.0

- Réservation WhatsApp : nom complet → premier jour libre + numéro de passage,
  `إلغاء` / `ANNULER` et `موعدي` / `MON RDV`, rappel la veille.
- Agenda numéroté, dossiers patients, soins tarifés, paiements partiels et dettes
  (filtre **Tous / Débiteurs**), dépenses par catégorie, rapports jour/mois.
- Interface arabe (RTL) / française commutable à chaud, installateur FR + AR.

### Gabarit

Le message de réservation est envoyé uniquement en réponse à un message reçu.
Aucun envoi de masse n'est possible depuis l'application.

---
DentaRDV — MIT License
