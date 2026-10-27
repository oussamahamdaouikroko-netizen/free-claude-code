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

### Nouveautés 2.1.0 — Choix du Jour & de la Date sur WhatsApp + File par Date & Verrouillage Strict du Tour

- **Choix dynamique du jour et de la date sur WhatsApp (FR / AR / Darija)** :
  le robot WhatsApp propose désormais automatiquement la liste numérotée (`1..5`)
  des jours et dates réellement disponibles en temps réel selon les réservations
  du cabinet (`daily_capacity`, `working_days`, `allow_same_day_booking`,
  `booking_horizon_days`), avec le nombre exact de places restantes par jour,
  pagination (`0` / `المزيد` / `PLUS`), saisie directe de date (`JJ/MM`,
  `JJ/MM/AAAA`, `AAAA-MM-JJ`), commande `JOURS DISPONIBLES` / `الأيام المتاحة`,
  et re-proposition automatique si la dernière place est prise au bureau entre-temps.
- **Onglet Patients (`خانة المرضى`) organisé par Jours & Dates** :
  séparation claire des patients en cartes chronologiques distinctes par jour et
  date (`Aujourd'hui`, `Demain`, `Après-demain`, dates futures, dates passées et
  dossiers sans RDV programmé), avec filtre rapide par date et 4 vues dédiées
  (`Par jours & dates`, `Patients d'aujourd'hui`, `Tous`, `Débiteurs`).
- **Verrouillage strict des dates futures et de l'ordre de passage (`#1` avant `#2`)** :
  impossibilité absolue pour le secrétariat (côté interface et côté serveur) de
  marquer un patient réservé à une date future (ex. demain ou après-demain) comme
  examiné/terminé ou absent avant le jour de son rendez-vous (avec bouton direct
  pour déplacer le RDV à aujourd'hui si le patient se présente tôt), et blocage du
  passage hors tour dans la file d'aujourd'hui tant qu'un patient précédent non
  urgent est encore en attente (`#1` avant `#2`).
- **Compatibilité totale des licences existantes** :
  les postes déjà activés sous `DentaRDV` restent 100% activés sans nouvelle clé.

### Nouveautés 2.0.0 — Édition Chirurgien-Dentiste Complète

- **Ordonnances Dentaires (`Ordonnances` A4 / A5 + QR de vérification)** :
  rédaction rapide avec dent/secteur FDI (`11–48`, arcades, dents de sagesse),
  modes d'affichage *Marque + DCI*, *Marque seule* ou *DCI seule*, mention
  *Non substituable*, conseils post-opératoires et radiographies dentaires
  (*Panoramique OPT*, *CBCT 3D*, *Rétro-alvéolaire*).
- **Catalogue Médicamenteux 100% Dédié aux Chirurgiens-Dentistes** :
  plus de 620 spécialités et génériques bucco-dentaires algériens filtrés
  exclusivement pour l'odonto-stomatologie (antibiotiques dentaires, antalgiques,
  AINS & corticoïdes, bains de bouche & gels buccaux, antifongiques/antiviraux
  buccaux, anesthésiques locaux & hémostatiques, gastroprotection IPP), avec
  recherche bilingue FR/AR, équivalents génériques et 7 protocoles dentaires prêts.
- **Sécurité Clinique & Calculateur Pédiatrique (`mg/kg/j`)** :
  détection en temps réel des allergies croisées (Pénicillines, AINS…),
  interactions médicamenteuses, doublons de molécule et calcul automatique des
  suspensions pédiatriques (*Amoxicilline*, *Augmentin*, *Paracétamol*).
- **Certificats Médicaux Dentaires** : *Arrêt de travail*, *Certificat
  bucco-dentaire*, *Certificat scolaire* et *Certificat général* avec QR signé.
- **WhatsApp Intelligent v2 (FR / AR / Darija)** :
  distinction salutations vs nom complet, sessions persistantes, confirmation
  en 2 étapes avant annulation + délai anti-abus de 30 min, confirmation de
  présence (`CONFIRMER` / `تأكيد`), questionnaire pré-visite optionnel conforme
  à la **Loi 18-07** (*Âge*, *Poids* et *motif dentaire*), reconnexion
  automatique exponentielle et icône dans la barre des tâches Windows.
- **Essai Gratuit 7 Jours & Activation Hors-Ligne** :
  clé d'activation cryptographique Ed25519 liée au poste, 100% sans Internet,
  avec passage en *Mode Lecture Seule* à l'expiration (aucune perte de données).

### Nouveautés 1.2.0

- **Mini-chat intégré (`Messages & File`)** : fenêtre flottante dans le coin de
  l'écran affichant en direct les confirmations de rendez-vous, les annulations
  et les appels de tour, avec compteur de non-lus et filtres rapides.
- **Retrait automatique à l'annulation** : dès qu'un patient annule sur WhatsApp
  (`إلغاء` / `ANNULER`) ou depuis l'accueil, il disparaît automatiquement de la
  liste active et le compteur d'attente des patients suivants se recalcule.
- **Bouton « Soin terminé · Appeler le suivant » pour la secrétaire** : en un
  clic, le patient actuel passe en *Terminé*, le patient suivant reçoit
  immédiatement l'alerte *« C'est votre tour ! / حان دوركم الآن »*, et les
  patients plus loin dans la file reçoivent le nombre de personnes restantes
  avant eux ainsi que le temps d'attente estimé (selon la durée moyenne réglable
  dans *Réglages → Agenda*).

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
