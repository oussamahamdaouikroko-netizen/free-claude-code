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

### Gabarit

Le message de réservation est envoyé uniquement en réponse à un message reçu.
Aucun envoi de masse n'est possible depuis l'application.

---
DentaRDV — MIT License
