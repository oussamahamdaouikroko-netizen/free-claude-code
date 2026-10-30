# MediRDV v2.6.0 — Suite Clinique Complète Hors-Ligne pour Cabinets & Polycliniques (Algérie)

## Nouveautés de la version 2.6.0 / What's New in v2.6.0 (تحديثات الإصدار 2.6.0 — 2026-10-30)

1. **Prise en charge complète de la langue Anglaise (`English — en`) aux côtés du Français (`fr`) et de l'Arabe (`ar`)** :
   - **Interface trilingue instantanée (`Français` ↔ `العربية` ↔ `English`)** : dictionnaire médical complet de **945 clés** traduites en anglais clinique (`DICT.en`) avec parité intégrale `100 %` des clés, variables `{placeholder}` et messages d'erreur, bascule directe depuis la barre latérale, l'écran de connexion et **Réglages → Langue de l'interface** (`LTR` pour `en`/`fr`, `RTL` pour `ar`).
   - **Bot WhatsApp complet en Anglais (`bot_language = 'en'`)** : les **41 modèles** de messages WhatsApp (`messages.js`), boutons interactifs (`More dates`, `Yes, cancel appointment` / `No, keep appointment`), détection des intentions et commandes en anglais (`AVAILABLE DAYS`, `MY APPOINTMENT`, `CANCEL`, `CONFIRM`, `HELP`, `TODAY`, `TOMORROW`, `DAY AFTER TOMORROW`, jours de la semaine `Sunday`–`Saturday`), sélection dynamique des dates disponibles, formulaire pré-visite Loi 18-07 (âge, poids et symptômes facultatifs uniquement), horaires `24/7`, système à deux périodes (`2nd shift`), pause médecin (`Doctor break`) et notification de congé confidentielle (`doctor on leave`).
   - **Dates, rapports & impressions** : formatage complet des dates et jours en anglais (`Friday, 30 October 2026`), résumés d'horaires et de pauses en anglais, et attribut `<html lang="en" dir="ltr">` sur les ordonnances générées en mode anglais.
   - **Compatibilité totale des licences existantes (`MRDV-LIC-V1:`)** et conservation intégrale des **5 381 médicaments de la Nomenclature Nationale Algérienne**.

---

## Nouveautés de la version 2.5.0 (تحديثات الإصدار 2.5.0 — 2026-10-28)

1. **Gestion des congés médecin & arrêts maladie (`عطلة الطبيب / استراحة مرضية — MIGRATION_13`)** :
   - Possibilité de marquer un jour unique ou une période complète (cabinet entier ou service spécifique en polyclinique) avec motif interne confidentiel (`عطلة / Congé`, `مرض / Maladie`, `أخرى / Autre`), note optionnelle et détection non destructive des rendez-vous déjà programmés (`booked_conflicts`).
   - Blocage automatique des nouvelles réservations sur l'application bureau et sur WhatsApp pendant la période de congé, avec saut automatique vers le prochain jour ouvrable libre.
   - **Confidentialité totale sur WhatsApp** : même si le motif interne est `مرض / Maladie`, le bot WhatsApp affiche uniquement un message courtois indiquant que **le médecin est en congé (`الطبيب في عطلة` / `en congé`)** avec la date exacte de reprise (en Français, Arabe et Darija algérienne), ainsi qu'une option de pause globale des nouvelles réservations WhatsApp (`إيقاف استقبال الحجوزات الجديدة مؤقتاً`).
2. **Contrôle complet des horaires de travail, calcul du nombre d'heures, système à deux périodes (`نظام الدوامين`) & pause médecin (`فترة راحة للطبيب`)** :
   - Contrôle précis des heures de début et de fin (`من الساعة ... إلى الساعة ...`) **et** du nombre d'heures de travail (`عدد الساعات` avec calcul bidirectionnel instantané du temps net travaillé).
   - **Système à deux périodes (`نظام الدوامين`)** : prise en charge d'une seconde période quotidienne y compris jusqu'à minuit (`00:00` / `12 ليلاً`), avec préréglage rapide **`08:00 – 17:00` puis `21:00 – 00:00`**.
   - **Pause / repos du médecin (`فترة راحة للطبيب في وقت العمل`)** : fenêtre de pause configurable (ex. `12:30 – 13:30`) déduite automatiquement des heures nettes, exclue des créneaux horaires générés, protégée contre la prise de rendez-vous et affichée clairement dans le Tableau de bord, l'Agenda et les messages WhatsApp.
3. **Mode Clinique / Urgences `24/24` sans interruption (`عيادات تعمل 24/24 ساعة بدون توقف`)** :
   - Option dédiée `24/24` continu avec sélection rapide `7/7` tous les jours, capacité journalière étendue jusqu'à **500 patients/jour** et badges visuels + mention automatique `24/24` sur WhatsApp.
   - **Compatibilité totale des licences existantes (`MRDV-LIC-V1:`)** et conservation intégrale des **5 381 médicaments de la Nomenclature Nationale Algérienne**.

---

## Nouveautés de la version 2.4.0 (تحديثات الإصدار 2.4.0 — 2026-10-26)

1. **Sélection dynamique du jour et de la date disponibles sur WhatsApp (`اختيار اليوم والتاريخ المتاح عبر واتساب`)** :
   - Lors de la prise de rendez-vous WhatsApp (cabinet individuel ou polyclinique multi-services, mode file d'attente ou créneaux horaires), le bot affiche automatiquement une **liste numérotée des prochains jours ouvrables disponibles** avec le **nombre exact de places restantes** calculé en temps réel depuis la base SQLite locale (en excluant automatiquement les jours complets, les week-ends non ouvrés et les jours fériés / congés enregistrés).
   - Le patient choisit simplement par **numéro** (`1`, `2`, `٢`…), demande les dates suivantes (`0`, `المزيد`, `PLUS`), ou écrit directement une **date** (`JJ/MM`, `JJ/MM/AAAA`, `AAAA-MM-JJ`, `غدا`, `demain`, nom du jour).
   - **Protection anti-collision en temps réel** : si la dernière place d'une date vient d'être prise au secrétariat, le bot en informe poliment le patient et rafraîchit instantanément les dates libres restantes.
   - **Commande directe & réglage flexible** : nouvelle commande `الأيام المتاحة` / `JOURS DISPONIBLES` et option dans **Paramètres → WhatsApp** pour activer/désactiver le choix de la date et ajuster le nombre de jours affichés par message (`3–14`).
   - **Compatibilité totale des licences existantes (`MRDV-LIC-V1:`)** : aucune réactivation requise lors de la mise à jour sur un poste déjà activé.

---

## Nouveautés de la version 2.1.1 (تحديثات الإصدار 2.1.1 — 2026-10-25)

1. **Validation stricte des noms WhatsApp & blocage des salutations comme nom (`MIGRATION_11`)** : Les salutations (`مرحبا`, `السلام عليكم`, `Bonjour`, `Salut`, `hello`, `/start`, etc.) et entrées non valides (chiffres, liens, émojis, mot unique, symboles, messages vocaux/images/autocollants) ne sont plus jamais enregistrées comme nom de patient. Le bot accueille l’utilisateur avec un exemple clair (`Oussama Hamdaoui` / `أسامة حمداوي`), conserve l’état `await_full_name` dans SQLite (`bot_sessions`) même après redémarrage, et accepte les vrais noms composés ou contenant des sous-chaînes (`سلامة محمد`, `هلال بن أحمد`, `Jean-Pierre Dupont`). Inclut `scripts/migrate-invalid-names.js` (`--dry-run` / `--apply`).
2. **Recherche de médicaments 100 % insensible à la casse, aux accents, aux variantes arabes et aux tirets** : Normalisation unifiée (`normalizeSearch` + colonne indexée `medications.name_normalized`), équivalence tiret/espace (`doli-prane` ↔ `doli prane`), unification arabe (`أ/إ/آ → ا`, `ى → ي`, `ة → ه`, sans tashkeel ni tatweel), requêtes SQL paramétrées avec échappement `LIKE` (`%`, `_`), et classement des correspondances exactes/préfixes avant les correspondances partielles.

---

## Nouveautés de la version 2.1.0 (تحديثات الإصدار 2.1.0 — 2026-10-25)

1. **Base officielle complète de 5 381 médicaments algériens intégrée d’office** : Les **5 381 spécialités pharmaceutiques algériennes** (nom commercial, DCI, dosage, conditionnement, laboratoire, pays, numéro d’enregistrement, statut générique/princeps, liste réglementaire) sont désormais embarquées hors-ligne dès l’installation et ajoutées automatiquement aux bases existantes avec recherche instantanée FTS5 (`< 10 ms`).
2. **Discussion WhatsApp pré-consultation simplifiée (Âge + Poids + Symptômes optionnels)** : Saisie rapide de **l’âge (`العمر`)** et du **poids (`الوزن`)** pour tous les patients afin d’aider immédiatement le médecin, avec possibilité optionnelle d’indiquer brièvement des symptômes — suppression des questions longues (taille, durée, traitements, allergies/pénicilline, antécédents).
3. **Alerte WhatsApp automatique d’approche du tour (`قرب دورك`)** : Le bot WhatsApp prévient automatiquement les patients en attente lorsque leur passage approche et leur indique exactement **combien de patients restent devant eux** ainsi que le temps d’attente estimé.
4. **Suppression automatique immédiate lors d’une annulation WhatsApp (`إلغاء` / `ANNULER`)** : Dès qu’un patient annule sur WhatsApp, il est retiré instantanément et sans intervention manuelle de la liste d’attente du jour, de l’agenda et de l’écran salle d’attente, tout en mettant à jour les patients suivants dans la file.

---

Correctif `v2.0.1` : correction d’un problème d’affichage de la page **Paramètres / الإعدادات** sous Chromium/Windows (`InvalidCharacterError` lors du rendu du sélecteur de format papier `A5/A4`). Toutes les cartes de configuration s’affichent désormais intégralement en Français et en Arabe RTL.

Mise à niveau majeure en **10 phases** de **MediRDV** (`SCHEMA_VERSION = 10`, migration automatique sans aucune perte depuis `v1.0.0`) — **100 % gratuit, 100 % hors-ligne (hors connecteur WhatsApp existant), données stockées exclusivement en Algérie sur le poste de la clinique (conformité Loi algérienne n° 18-07)**.

## Nouveautés majeures de la version 2.0.0

1. **Pré-consultation WhatsApp & Accueil (`MIGRATION_2`)** : Collecte optionnelle avec consentement explicite Loi 18-07 (poids, taille, IMC automatique, motif, traitements en cours, allergies déclarées, grossesse/allaitement conditionnels). Aucune donnée déclarée par le patient n’écrase le dossier médical vérifié avant validation explicite du médecin (*Confirmer & appliquer*).
2. **Sécurité de Prescription & Aide à la Décision Clinique (`MIGRATION_3`)** : Calculateur pédiatrique `mg/kg` et `ml/prise` avec plafond adulte et formule affichée, interactions médicamenteuses (`contraindicated` bloquant sauf justification tracée, `avoid`/`caution`), contre-indications terrain (grossesse, allaitement, insuffisance rénale/hépatique, asthme, ulcère, G6PD), allergies croisées par classe, doublons de DCI et règles substances contrôlées. *Avertissement : aide à la décision uniquement ; bases de démarrage marquées `verified=0` importables en CSV/JSON.*
3. **Nomenclature Nationale Algérienne (`MIGRATION_4`)** : Importateur CSV/XLSX MIPH + script CLI (`scripts/import-nomenclature.js`), recherche plein texte FTS5 instantanée (> 5 000 médicaments), PPA, tarif de référence, remboursement Chifa, substitution générique, mode d’impression Marque / DCI / Les deux, et impression en toutes lettres pour psychotropes/stupéfiants.
4. **Diagnostics CIM-10 (ICD-10) & Protocoles (`MIGRATION_5`)** : Recherche FTS5 FR/AR, multi-diagnostics par ordonnance, drapeaux ALD 100 % & maladies à déclaration obligatoire (MDO), protocoles cliniques éditables et statistiques épidémiologiques.
5. **Dossier Médical Électronique Structuré — DME (`MIGRATION_6`)** : Identité algérienne étendue (N° Chifa, NSS, Wilaya/Commune, tuteur), consultations SOAP + constantes, pièces jointes locales sécurisées, bilans biologiques (drapeaux d’anomalie) & imagerie, calendrier vaccinal algérien PEV, suivi de grossesse (DDR → DPA + SA), courbes de croissance OMS et frise chronologique unifiée.
6. **Facturation Conventionnée CNAS / CASNOS & Rapport Z (`MIGRATION_7`)** : Répartition automatique Part Caisse / Ticket modérateur patient, factures séquentielles annuelles sans rupture (`FAC-YYYY-00001`) avec mentions fiscales algériennes (`RC`, `NIF`, `NIS`, `AI`), avoirs/remboursements, clôture journalière de caisse (Rapport Z) et export bordereaux CSV / Excel `.xlsx`.
7. **Utilisateurs, Rôles RBAC, Audit SHA-256 & Loi 18-07 (`MIGRATION_8`)** : 5 rôles (`admin`, `doctor`, `secretary`, `nurse`, `accountant`) avec migration transparente du mot de passe existant, verrouillage après tentatives échouées + code PIN rapide, journal d’audit infalsifiable chaîné SHA-256, sauvegardes chiffrées `AES-256-GCM` avec test automatique de restauration, copie USB vérifiée, zéro donnée patient dans les journaux applicatifs, export portable et anonymisation Loi 18-07.
8. **Planification Avancée, Fériés Algériens, Stock & Paie (`MIGRATION_9`)** : Mode créneaux horaires par service en parallèle du mode file d’attente, jours fériés nationaux algériens (dont Yennayer 12 janvier) + fêtes religieuses lunaires / congés, confirmation WhatsApp (`CONFIRMER` / `تأكيد`), écran salle d’attente anonyme (initiales Loi 18-07), gestion du stock médical (seuils, péremption, déstockage auto par acte), salles/équipements et gestion du personnel / paie reliée aux dépenses.
9. **Impression A4/A5, QR de Vérification & Darija (`MIGRATION_10`)** : Formats A4/A5, option papier pré-imprimé (sans en-tête), signature/cachet téléversable, QR SVG hors-ligne contenant uniquement le jeton de vérification (`MRDV:...`, zéro donnée médicale), lettres d’orientation, comptes-rendus, certificats sport/scolaire/vaccination, demandes de bilan/imagerie, isolation `<bdi dir="ltr">` bilingue FR/AR et option WhatsApp en Darija algérienne.

> **Avis de sécurité médicale / تنبيه طبي هام** : MediRDV est un outil local d’aide à la gestion et à l’aide à la décision clinique. Les jeux de données cliniques initiaux (`source='starter'`, `verified=0`) doivent être vérifiés ou remplacés par les référentiels officiels (Nomenclature MIPH, CIM-10) sous la responsabilité exclusive du médecin prescripteur et du pharmacien.
