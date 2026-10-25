/* Bilingual interface dictionary (French / Arabic) + runtime switching.
 *
 * Rules:
 *  - every visible string lives here, never inside a page module;
 *  - French and Arabic must have exactly the same keys (tests/i18n.test.js);
 *  - Arabic switches the whole document to dir="rtl", French to dir="ltr";
 *  - no string is built by concatenating translated fragments, so a future
 *    translator can rewrite any sentence without touching the code.
 */
(function () {
  'use strict';

  const fr = {
    /* ---------------------------------- app --------------------------------- */
    'app.name': 'PharmaGestion DZ',
    'app.tagline': 'Gestion de pharmacie · 100 % hors ligne',
    'app.offline': 'Fonctionne sans internet',
    'app.version': 'Version',
    'app.phase': 'Phase 1 — socle de l’application',
    'app.dataFolder': 'Dossier des données',
    'app.databaseFile': 'Fichier de base de données',
    'app.logFile': 'Journal technique',
    'app.schemaVersion': 'Version de la base',
    'app.electron': 'Electron',
    'app.platform': 'Système',
    'app.today': 'Aujourd’hui',
    'app.privacy': 'Toutes les données restent sur cet ordinateur.',

    /* --------------------------------- common -------------------------------- */
    'common.save': 'Enregistrer',
    'common.saving': 'Enregistrement…',
    'common.saved': 'Enregistré',
    'common.cancel': 'Annuler',
    'common.close': 'Fermer',
    'common.confirm': 'Confirmer',
    'common.yes': 'Oui',
    'common.no': 'Non',
    'common.add': 'Ajouter',
    'common.edit': 'Modifier',
    'common.delete': 'Supprimer',
    'common.search': 'Rechercher…',
    'common.loading': 'Chargement…',
    'common.retry': 'Réessayer',
    'common.refresh': 'Actualiser',
    'common.error': 'Une erreur est survenue',
    'common.actions': 'Actions',
    'common.details': 'Détails',
    'common.status': 'Statut',
    'common.none': 'Aucun',
    'common.all': 'Tous',
    'common.today': 'Aujourd’hui',
    'common.back': 'Retour',
    'common.next': 'Suivant',
    'common.optional': 'facultatif',
    'common.required': 'Champ obligatoire',
    'common.open': 'Ouvrir',
    'common.copy': 'Copier',
    'common.copied': 'Copié',
    'common.date': 'Date',
    'common.amount': 'Montant',
    'common.total': 'Total',
    'common.note': 'Note',
    'common.export': 'Exporter',
    'common.import': 'Importer',
    'common.language': 'Langue',
    'common.french': 'Français',
    'common.arabic': 'العربية',
    'common.currency': 'DA',
    'common.bytes': 'octets',
    'common.kb': 'Ko',
    'common.mb': 'Mo',
    'common.planned': 'Prévu',
    'common.notYet': 'Pas encore disponible',
    'common.notAvailableYet': 'Cette page n’existe pas.',
    'common.empty': 'Rien à afficher pour le moment.',
    'common.unknown': 'Inconnu',
    'common.yesShort': 'Oui',
    'common.noShort': 'Non',

    /* ------------------------------- navigation ------------------------------ */
    'nav.dashboard': 'Tableau de bord',
    'nav.stock': 'Médicaments et stock',
    'nav.stock.short': 'Médicaments et stock',
    'nav.purchases': 'Achats et entrées',
    'nav.sales': 'Ventes et sorties',
    'nav.customer_debts': 'Dettes clients',
    'nav.supplier_debts': 'Dettes fournisseurs',
    'nav.expiry': 'Alertes de péremption',
    'nav.import_export': 'Importer / exporter',
    'nav.reports': 'Rapports',
    'nav.settings': 'Réglages et sauvegardes',
    'nav.section.main': 'Travail quotidien',
    'nav.section.money': 'Argent et dettes',
    'nav.section.tools': 'Outils',

    /* -------------------------------- dashboard ------------------------------ */
    'dashboard.title': 'Tableau de bord',
    'dashboard.subtitle': 'Ce qui demande votre attention aujourd’hui.',
    'dashboard.welcome': 'Bienvenue',
    'dashboard.welcomeNamed': 'Bienvenue, {name}',
    'dashboard.setupTitle': 'Première utilisation',
    'dashboard.setupText':
      'Indiquez le nom de la pharmacie et choisissez la langue dans les réglages. Tout reste sur cet ordinateur.',
    'dashboard.setupButton': 'Ouvrir les réglages',
    'dashboard.tasks': 'À faire aujourd’hui',
    'dashboard.tasksHint': 'Les alertes apparaîtront ici dès la phase 2 (stock et lots).',
    'dashboard.expiring': 'Lots proches de la péremption',
    'dashboard.expired': 'Lots périmés',
    'dashboard.lowStock': 'Produits en stock faible',
    'dashboard.customerDebt': 'Dettes clients',
    'dashboard.supplierDebt': 'Dettes fournisseurs',
    'dashboard.totalStock': 'Valeur du stock',
    'dashboard.noAlerts': 'Aucune alerte pour le moment.',
    'dashboard.quickActions': 'Actions rapides',
    'dashboard.backupNow': 'Sauvegarder maintenant',
    'dashboard.checkDatabase': 'Vérifier la base',
    'dashboard.openBackups': 'Ouvrir le dossier des sauvegardes',
    'dashboard.openData': 'Ouvrir le dossier des données',
    'dashboard.system': 'État de l’application',
    'dashboard.dbState': 'Base de données',
    'dashboard.dbHealthy': 'Saine',
    'dashboard.dbProblem': 'Problème détecté',
    'dashboard.lastBackup': 'Dernière sauvegarde',
    'dashboard.never': 'Jamais',
    'dashboard.backupDue': 'Une sauvegarde est due aujourd’hui',
    'dashboard.backupOk': 'Sauvegarde à jour',
    'dashboard.backupOff': 'Sauvegardes automatiques désactivées',
    'dashboard.recentActivity': 'Dernières actions',
    'dashboard.noActivity': 'Aucune action enregistrée pour le moment.',
    'dashboard.modules': 'Modules de l’application',
    'dashboard.modulesHint': 'Le socle est en place ; chaque module arrive à sa phase.',
    'dashboard.storage': 'Espace utilisé',
    'dashboard.checkedAt': 'Vérifié à {time}',

    /* --------------------------- planned sections ---------------------------- */
    'plan.title': 'Bientôt disponible',
    'plan.subtitle': 'Cette partie est prévue et n’est pas encore active.',
    'plan.why': 'Pourquoi c’est important',
    'plan.what': 'Ce que fera cet écran',
    'plan.status': 'État',
    'plan.phase': 'Phase {phase}',
    'plan.backToDashboard': 'Retour au tableau de bord',

    'plan.stock.1': 'Catalogue des médicaments (nom arabe et français, code-barres).',
    'plan.stock.2': 'Plusieurs lots par médicament, chacun avec sa propre date de péremption.',
    'plan.stock.3': 'Historique complet des entrées et des sorties, sans écrasement.',
    'plan.stock.4': 'Recherche rapide par nom ou par code-barres.',
    'plan.stock.why': 'Un médicament peut avoir plusieurs lots avec des dates différentes.',

    'plan.purchases.1': 'Créer une facture d’achat avec ses lignes.',
    'plan.purchases.2': 'Enregistrer le fournisseur, le numéro de facture et les prix d’achat.',
    'plan.purchases.3': 'Rattacher chaque entrée à un lot précis.',
    'plan.purchases.4': 'Total des achats par période.',
    'plan.purchases.why': 'Un achat mal saisi fausse le stock et la marge.',

    'plan.sales.1': 'Vendre en choisissant le lot, pour un stock exact.',
    'plan.sales.2': 'Distinguer vente, retour, périmé, abîmé et correction manuelle.',
    'plan.sales.3': 'Motif obligatoire pour toute correction de stock.',
    'plan.sales.4': 'Empêcher un stock négatif sans confirmation du responsable.',
    'plan.sales.why': 'Une sortie de stock n’est pas toujours une vente.',

    'plan.customer_debts.1': 'Nom du client, montant initial et date.',
    'plan.customer_debts.2': 'Paiements partiels avec date et note.',
    'plan.customer_debts.3': 'Reste à payer calculé automatiquement.',
    'plan.customer_debts.4': 'Total des dettes clients affiché séparément.',
    'plan.customer_debts.why': 'Le carnet de dettes doit être fiable et retrouvable.',

    'plan.supplier_debts.1': 'Factures fournisseurs et dates d’échéance.',
    'plan.supplier_debts.2': 'Paiements partiels et historique.',
    'plan.supplier_debts.3': 'Reste à payer par fournisseur.',
    'plan.supplier_debts.4': 'Total des dettes fournisseurs séparé des clients.',
    'plan.supplier_debts.why': 'Savoir ce que la pharmacie doit évite les ruptures.',

    'plan.expiry.1': 'Alertes à 90, 60 et 30 jours (seuils modifiables).',
    'plan.expiry.2': 'Calcul à partir de la date de chaque lot, jamais du catalogue.',
    'plan.expiry.3': 'Une seule alerte par lot et par seuil.',
    'plan.expiry.4': 'Rapport des lots périmés avec valeur perdue.',
    'plan.expiry.why': 'Un produit périmé est une perte sèche et un risque pour le client.',

    'plan.import_export.1': 'Assistant d’import CSV et Excel : aperçu puis correspondance des colonnes.',
    'plan.import_export.2': 'Détection des doublons et rapport d’erreurs.',
    'plan.import_export.3': 'Historique des imports et fichier d’origine conservé.',
    'plan.import_export.4': 'Export du stock et des dettes au format CSV / Excel.',
    'plan.import_export.why':
      'Reprendre les données de votre logiciel actuel sans tout retaper. La compatibilité CHIFA ne sera annoncée qu’après un essai sur un vrai fichier exporté.',

    'plan.reports.1': 'Totaux des achats et des ventes par période.',
    'plan.reports.2': 'Valeur du stock et coût des marchandises vendues.',
    'plan.reports.3': 'Marge estimée, pertes sur périmés et stock proche de la péremption.',
    'plan.reports.4': 'Export CSV / Excel compatible tableur.',
    'plan.reports.why': 'Des chiffres justes, sans vocabulaire comptable compliqué.',

    /* -------------------------------- settings ------------------------------- */
    'settings.title': 'Réglages et sauvegardes',
    'settings.subtitle': 'Identité de la pharmacie, alertes, sauvegardes et diagnostic.',
    'settings.identity': 'Identité de la pharmacie',
    'settings.identityHint': 'Ces informations apparaissent sur les rapports et les exports.',
    'settings.pharmacyName': 'Nom de la pharmacie',
    'settings.pharmacyNamePlaceholder': 'Ex. Pharmacie El Nour',
    'settings.pharmacistName': 'Nom du pharmacien',
    'settings.pharmacistPlaceholder': 'Ex. Dr. Karim Benali',
    'settings.phone': 'Téléphone',
    'settings.phonePlaceholder': 'Ex. 0555 12 34 56',
    'settings.address': 'Adresse',
    'settings.addressPlaceholder': 'Ex. Rue Didouche Mourad, Alger',
    'settings.languageSection': 'Langue de l’application',
    'settings.languageHint': 'Le changement est immédiat et s’applique à tout l’écran.',
    'settings.expirySection': 'Alertes de péremption',
    'settings.expiryHint':
      'Nombre de jours avant la péremption. Les trois valeurs doivent être décroissantes (90 > 60 > 30).',
    'settings.threshold1': 'Première alerte (jours)',
    'settings.threshold2': 'Deuxième alerte (jours)',
    'settings.threshold3': 'Troisième alerte (jours)',
    'settings.stockSection': 'Stock',
    'settings.lowStock': 'Seuil de stock faible (unités)',
    'settings.allowNegative': 'Autoriser un stock négatif avec confirmation',
    'settings.allowNegativeHint':
      'Chaque dépassement est enregistré dans le journal d’audit. À laisser désactivé si possible.',
    'settings.backupSection': 'Sauvegardes automatiques',
    'settings.backupEnabled': 'Sauvegarde automatique quotidienne',
    'settings.backupEnabledHint': 'Une copie par jour, conservée dans le dossier des données.',
    'settings.backupKeep': 'Nombre de sauvegardes conservées',
    'settings.backupNow': 'Sauvegarder maintenant',
    'settings.restore': 'Restaurer une sauvegarde',
    'settings.restoreFromFile': 'Choisir un fichier de sauvegarde…',
    'settings.restoreWarning':
      'La restauration remplace les données actuelles. Une copie de sécurité est créée automatiquement avant.',
    'settings.restoreConfirmTitle': 'Restaurer cette sauvegarde ?',
    'settings.restoreConfirmText':
      'Les données actuelles seront remplacées par « {name} ». Une copie de sécurité sera conservée.',
    'settings.restoreDone': 'Sauvegarde restaurée. L’application va se recharger.',
    'settings.exportBackup': 'Enregistrer une copie ailleurs',
    'settings.backupsList': 'Sauvegardes disponibles',
    'settings.backupName': 'Fichier',
    'settings.backupDate': 'Créée le',
    'settings.backupSize': 'Taille',
    'settings.backupKind': 'Type',
    'settings.noBackups': 'Aucune sauvegarde pour le moment.',
    'settings.maintenance': 'Diagnostic et maintenance',
    'settings.integrityCheck': 'Vérifier l’intégrité de la base',
    'settings.integrityOk': 'Base saine : aucune erreur détectée.',
    'settings.integrityBad': 'Un problème a été détecté : {message}',
    'settings.databaseInfo': 'Informations techniques',
    'settings.openDataFolder': 'Ouvrir le dossier des données',
    'settings.openBackupFolder': 'Ouvrir le dossier des sauvegardes',
    'settings.openLogFile': 'Ouvrir le dossier du journal',
    'settings.privacyNote':
      'Aucune donnée n’est envoyée sur internet. Les noms et téléphones des clients ne sont jamais écrits dans le journal technique.',
    'settings.auditTitle': 'Journal d’audit',
    'settings.auditHint': 'Les dernières actions sensibles, sans données personnelles.',
    'settings.noAudit': 'Aucune action enregistrée.',
    'settings.savedOk': 'Réglages enregistrés.',
    'settings.savedLanguage': 'Langue enregistrée.',
    'settings.unsavedHint': 'Modifications non enregistrées',

    /* -------------------------------- backups -------------------------------- */
    'backup.kind.auto': 'Automatique',
    'backup.kind.manual': 'Manuelle',
    'backup.kind.pre-update': 'Avant mise à jour',
    'backup.kind.before-restore': 'Avant restauration',
    'backup.kind.external': 'Externe',
    'backup.created': 'Sauvegarde créée',
    'backup.exported': 'Copie enregistrée',
    'backup.canceled': 'Opération annulée',

    /* --------------------------------- audit --------------------------------- */
    'audit.backup.create': 'Sauvegarde manuelle',
    'audit.backup.restore': 'Restauration d’une sauvegarde',
    'audit.backup.export': 'Export d’une copie de la base',
    'audit.settings.language': 'Changement de langue',
    'audit.settings.update': 'Modification des réglages',

    /* --------------------------------- errors -------------------------------- */
    'error.title': 'Opération impossible',
    'error.INVALID_AMOUNT': 'Montant invalide.',
    'error.INVALID_QUANTITY': 'Quantité invalide : indiquez un nombre entier.',
    'error.INVALID_PERCENT': 'Pourcentage invalide.',
    'error.INVALID_AUDIT_ACTION': 'Action d’audit invalide.',
    'error.INVALID_SETTING_KEY': 'Réglage inconnu.',
    'error.INVALID_SETTING_VALUE': 'Valeur invalide pour ce réglage.',
    'error.INVALID_THRESHOLDS': 'Les seuils doivent être décroissants : 90, puis 60, puis 30.',
    'error.INVALID_DATE': 'Date invalide.',
    'error.INVALID_VALUE': 'Valeur invalide.',
    'error.INVALID_ID': 'Identifiant invalide.',
    'error.INVALID_FILE': 'Fichier non pris en charge.',
    'error.INVALID_TARGET': 'Dossier inconnu.',
    'error.INVALID_PAYLOAD': 'Données envoyées invalides.',
    'error.BACKUP_NOT_FOUND': 'Fichier de sauvegarde introuvable.',
    'error.BACKUP_CORRUPT': 'Ce fichier de sauvegarde est illisible ou endommagé.',
    'error.BACKUP_TOO_NEW':
      'Cette sauvegarde vient d’une version plus récente de l’application. Installez d’abord cette version.',
    'error.BACKUP_NOT_READY': 'Le module de sauvegarde n’est pas prêt.',
    'error.BACKUP_DESTINATION_REQUIRED': 'Choisissez un emplacement pour la copie.',
    'error.BACKUP_BEFORE_UPGRADE_FAILED':
      'La copie de sécurité avant mise à jour a échoué. Aucune donnée n’a été modifiée.',
    'error.RESTORE_FAILED': 'La restauration a échoué. La base précédente a été conservée.',
    'error.RESTORE_NOT_APPROVED': 'Choisissez le fichier de sauvegarde depuis l’application.',
    'error.DATABASE_NOT_OPEN': 'La base de données n’est pas ouverte.',
    'error.SCHEMA_TOO_NEW':
      'Cette base a été créée par une version plus récente. Installez la nouvelle version.',
    'error.MIGRATION_FAILED': 'La mise à jour de la base a échoué. Vos données sont intactes.',
    'error.MIGRATION_INVALID': 'Migration invalide : contactez le support avec le journal technique.',
    'error.IPC_ALREADY_REGISTERED': 'Le pont de communication a déjà été initialisé.',
    'error.UNKNOWN_METHOD': 'Action inconnue.',
    'error.UNTRUSTED_SENDER': 'Origine de la demande non autorisée.',
    'error.DIALOG_UNAVAILABLE': 'Fenêtre de sélection indisponible.',
    'error.OPEN_FOLDER_FAILED': 'Impossible d’ouvrir ce dossier.',
    'error.TEXT_TOO_LONG': 'Texte trop long à copier.',
    'error.INTERNAL_ERROR': 'Erreur interne. Consultez le journal technique.',
    'error.OFFLINE': 'L’application n’est pas connectée à son processus principal.',
  };

  const ar = {
    /* ---------------------------------- app --------------------------------- */
    'app.name': 'فارما جيستيون',
    'app.tagline': 'تسيير الصيدلية · يعمل دون إنترنت',
    'app.offline': 'يعمل دون اتصال بالإنترنت',
    'app.version': 'الإصدار',
    'app.phase': 'المرحلة 1 — أساس التطبيق',
    'app.dataFolder': 'مجلد البيانات',
    'app.databaseFile': 'ملف قاعدة البيانات',
    'app.logFile': 'السجل التقني',
    'app.schemaVersion': 'إصدار قاعدة البيانات',
    'app.electron': 'إلكترون',
    'app.platform': 'النظام',
    'app.today': 'اليوم',
    'app.privacy': 'كل البيانات تبقى على هذا الحاسوب.',

    /* --------------------------------- common -------------------------------- */
    'common.save': 'حفظ',
    'common.saving': 'جارٍ الحفظ…',
    'common.saved': 'تم الحفظ',
    'common.cancel': 'إلغاء',
    'common.close': 'إغلاق',
    'common.confirm': 'تأكيد',
    'common.yes': 'نعم',
    'common.no': 'لا',
    'common.add': 'إضافة',
    'common.edit': 'تعديل',
    'common.delete': 'حذف',
    'common.search': 'بحث…',
    'common.loading': 'جارٍ التحميل…',
    'common.retry': 'إعادة المحاولة',
    'common.refresh': 'تحديث',
    'common.error': 'حدث خطأ',
    'common.actions': 'إجراءات',
    'common.details': 'التفاصيل',
    'common.status': 'الحالة',
    'common.none': 'لا شيء',
    'common.all': 'الكل',
    'common.today': 'اليوم',
    'common.back': 'رجوع',
    'common.next': 'التالي',
    'common.optional': 'اختياري',
    'common.required': 'حقل إلزامي',
    'common.open': 'فتح',
    'common.copy': 'نسخ',
    'common.copied': 'تم النسخ',
    'common.date': 'التاريخ',
    'common.amount': 'المبلغ',
    'common.total': 'المجموع',
    'common.note': 'ملاحظة',
    'common.export': 'تصدير',
    'common.import': 'استيراد',
    'common.language': 'اللغة',
    'common.french': 'Français',
    'common.arabic': 'العربية',
    'common.currency': 'دج',
    'common.bytes': 'بايت',
    'common.kb': 'ك.ب',
    'common.mb': 'م.ب',
    'common.planned': 'مخطط له',
    'common.notYet': 'غير متوفر بعد',
    'common.notAvailableYet': 'هذه الصفحة غير موجودة.',
    'common.empty': 'لا شيء لعرضه حالياً.',
    'common.unknown': 'غير معروف',
    'common.yesShort': 'نعم',
    'common.noShort': 'لا',

    /* ------------------------------- navigation ------------------------------ */
    'nav.dashboard': 'لوحة المتابعة',
    'nav.stock': 'الأدوية والمخزون',
    'nav.stock.short': 'الأدوية والمخزون',
    'nav.purchases': 'المشتريات وإدخال المخزون',
    'nav.sales': 'المبيعات وإخراج المخزون',
    'nav.customer_debts': 'ديون العملاء',
    'nav.supplier_debts': 'ديون الموردين',
    'nav.expiry': 'تنبيهات انتهاء الصلاحية',
    'nav.import_export': 'الاستيراد والتصدير',
    'nav.reports': 'التقارير',
    'nav.settings': 'الإعدادات والنسخ الاحتياطي',
    'nav.section.main': 'العمل اليومي',
    'nav.section.money': 'الأموال والديون',
    'nav.section.tools': 'أدوات',

    /* -------------------------------- dashboard ------------------------------ */
    'dashboard.title': 'لوحة المتابعة',
    'dashboard.subtitle': 'ما يحتاج إلى انتباهك اليوم.',
    'dashboard.welcome': 'مرحباً',
    'dashboard.welcomeNamed': 'مرحباً، {name}',
    'dashboard.setupTitle': 'أول استخدام',
    'dashboard.setupText':
      'أدخل اسم الصيدلية واختر اللغة من الإعدادات. كل شيء يبقى على هذا الحاسوب.',
    'dashboard.setupButton': 'فتح الإعدادات',
    'dashboard.tasks': 'مهام اليوم',
    'dashboard.tasksHint': 'ستظهر التنبيهات هنا ابتداءً من المرحلة 2 (المخزون والدفعات).',
    'dashboard.expiring': 'دفعات قاربت على الانتهاء',
    'dashboard.expired': 'دفعات منتهية الصلاحية',
    'dashboard.lowStock': 'منتجات بمخزون منخفض',
    'dashboard.customerDebt': 'ديون العملاء',
    'dashboard.supplierDebt': 'ديون الموردين',
    'dashboard.totalStock': 'قيمة المخزون',
    'dashboard.noAlerts': 'لا توجد تنبيهات حالياً.',
    'dashboard.quickActions': 'إجراءات سريعة',
    'dashboard.backupNow': 'نسخ احتياطي الآن',
    'dashboard.checkDatabase': 'فحص قاعدة البيانات',
    'dashboard.openBackups': 'فتح مجلد النسخ الاحتياطية',
    'dashboard.openData': 'فتح مجلد البيانات',
    'dashboard.system': 'حالة التطبيق',
    'dashboard.dbState': 'قاعدة البيانات',
    'dashboard.dbHealthy': 'سليمة',
    'dashboard.dbProblem': 'تم اكتشاف مشكلة',
    'dashboard.lastBackup': 'آخر نسخة احتياطية',
    'dashboard.never': 'أبداً',
    'dashboard.backupDue': 'يلزم إجراء نسخة احتياطية اليوم',
    'dashboard.backupOk': 'النسخة الاحتياطية محدّثة',
    'dashboard.backupOff': 'النسخ التلقائي معطّل',
    'dashboard.recentActivity': 'آخر الإجراءات',
    'dashboard.noActivity': 'لا يوجد أي إجراء مسجل حالياً.',
    'dashboard.modules': 'أقسام التطبيق',
    'dashboard.modulesHint': 'الأساس جاهز، وكل قسم يأتي في مرحلته.',
    'dashboard.storage': 'المساحة المستعملة',
    'dashboard.checkedAt': 'تم الفحص في {time}',

    /* --------------------------- planned sections ---------------------------- */
    'plan.title': 'قريباً',
    'plan.subtitle': 'هذا القسم مخطط له ولم يُنشَّط بعد.',
    'plan.why': 'لماذا هذا مهم',
    'plan.what': 'ما ستقوم به هذه الشاشة',
    'plan.status': 'الحالة',
    'plan.phase': 'المرحلة {phase}',
    'plan.backToDashboard': 'العودة إلى لوحة المتابعة',

    'plan.stock.1': 'بطاقة تعريف الدواء بالاسم العربي والفرنسي والرمز الشريطي.',
    'plan.stock.2': 'عدة دفعات لكل دواء، لكل دفعة تاريخ انتهاء خاص بها.',
    'plan.stock.3': 'سجل كامل للإدخالات والإخراجات دون محو أي حركة.',
    'plan.stock.4': 'بحث سريع بالاسم أو بالرمز الشريطي.',
    'plan.stock.why': 'قد يكون للدواء الواحد عدة دفعات بتواريخ انتهاء مختلفة.',

    'plan.purchases.1': 'تسجيل فاتورة شراء مع سطورها.',
    'plan.purchases.2': 'حفظ المورد ورقم الفاتورة وأسعار الشراء.',
    'plan.purchases.3': 'ربط كل إدخال بدفعة محددة.',
    'plan.purchases.4': 'مجموع المشتريات حسب الفترة.',
    'plan.purchases.why': 'أي خطأ في الشراء يفسد المخزون والهامش.',

    'plan.sales.1': 'البيع باختيار الدفعة لضبط المخزون بدقة.',
    'plan.sales.2': 'التمييز بين البيع والمرتجع والمنتهي والتالف والتصحيح اليدوي.',
    'plan.sales.3': 'سبب إلزامي لكل تصحيح في المخزون.',
    'plan.sales.4': 'منع المخزون السالب إلا بموافقة صريحة من المسؤول.',
    'plan.sales.why': 'ليس كل إخراج من المخزون عملية بيع.',

    'plan.customer_debts.1': 'اسم العميل والمبلغ الأصلي والتاريخ.',
    'plan.customer_debts.2': 'دفعات جزئية مع التاريخ والملاحظة.',
    'plan.customer_debts.3': 'حساب المبلغ المتبقي تلقائياً.',
    'plan.customer_debts.4': 'عرض مجموع ديون العملاء منفصلاً.',
    'plan.customer_debts.why': 'دفتر الديون يجب أن يكون موثوقاً ويسهل الرجوع إليه.',

    'plan.supplier_debts.1': 'فواتير الموردين وتواريخ الاستحقاق.',
    'plan.supplier_debts.2': 'دفعات جزئية وسجل كامل.',
    'plan.supplier_debts.3': 'المبلغ المتبقي لكل مورد.',
    'plan.supplier_debts.4': 'مجموع ديون الموردين منفصل عن العملاء.',
    'plan.supplier_debts.why': 'معرفة ما على الصيدلية من ديون يمنع انقطاع السلع.',

    'plan.expiry.1': 'تنبيهات عند 90 و60 و30 يوماً (قابلة للتعديل).',
    'plan.expiry.2': 'الحساب من تاريخ كل دفعة، لا من بطاقة الدواء.',
    'plan.expiry.3': 'تنبيه واحد لكل دفعة ولكل حد.',
    'plan.expiry.4': 'تقرير بالدفعات المنتهية وقيمتها المفقودة.',
    'plan.expiry.why': 'الدواء المنتهي خسارة كاملة وخطر على المريض.',

    'plan.import_export.1': 'معالج استيراد CSV وExcel: معاينة ثم ربط الأعمدة.',
    'plan.import_export.2': 'كشف التكرار وتقرير بالأخطاء.',
    'plan.import_export.3': 'سجل عمليات الاستيراد مع حفظ الملف الأصلي.',
    'plan.import_export.4': 'تصدير المخزون والديون بصيغة CSV / Excel.',
    'plan.import_export.why':
      'نقل بيانات برنامجك الحالي دون إعادة كتابة كل شيء. لن نعلن التوافق مع CHIFA إلا بعد تجربة ملف تصدير حقيقي.',

    'plan.reports.1': 'مجموع المشتريات والمبيعات حسب الفترة.',
    'plan.reports.2': 'قيمة المخزون وتكلفة البضاعة المباعة.',
    'plan.reports.3': 'الهامش التقديري وخسائر الانتهاء وقيمة ما قارب على الانتهاء.',
    'plan.reports.4': 'تصدير CSV / Excel متوافق مع الجداول.',
    'plan.reports.why': 'أرقام صحيحة دون مصطلحات محاسبية معقدة.',

    /* -------------------------------- settings ------------------------------- */
    'settings.title': 'الإعدادات والنسخ الاحتياطي',
    'settings.subtitle': 'هوية الصيدلية والتنبيهات والنسخ الاحتياطي والفحص.',
    'settings.identity': 'هوية الصيدلية',
    'settings.identityHint': 'تظهر هذه المعلومات في التقارير والملفات المصدرة.',
    'settings.pharmacyName': 'اسم الصيدلية',
    'settings.pharmacyNamePlaceholder': 'مثال: صيدلية النور',
    'settings.pharmacistName': 'اسم الصيدلي',
    'settings.pharmacistPlaceholder': 'مثال: د. كريم بن علي',
    'settings.phone': 'الهاتف',
    'settings.phonePlaceholder': 'مثال: 0555 12 34 56',
    'settings.address': 'العنوان',
    'settings.addressPlaceholder': 'مثال: شارع ديدوش مراد، الجزائر',
    'settings.languageSection': 'لغة التطبيق',
    'settings.languageHint': 'التغيير فوري ويطبق على كل الشاشة.',
    'settings.expirySection': 'تنبيهات انتهاء الصلاحية',
    'settings.expiryHint': 'عدد الأيام قبل انتهاء الصلاحية. يجب أن تكون القيم تنازلية (90 ثم 60 ثم 30).',
    'settings.threshold1': 'التنبيه الأول (أيام)',
    'settings.threshold2': 'التنبيه الثاني (أيام)',
    'settings.threshold3': 'التنبيه الثالث (أيام)',
    'settings.stockSection': 'المخزون',
    'settings.lowStock': 'حد المخزون المنخفض (وحدات)',
    'settings.allowNegative': 'السماح بمخزون سالب بعد التأكيد',
    'settings.allowNegativeHint': 'كل تجاوز يُسجَّل في سجل التدقيق. الأفضل إبقاؤه معطلاً.',
    'settings.backupSection': 'النسخ الاحتياطي التلقائي',
    'settings.backupEnabled': 'نسخة احتياطية تلقائية يومياً',
    'settings.backupEnabledHint': 'نسخة واحدة كل يوم، محفوظة في مجلد البيانات.',
    'settings.backupKeep': 'عدد النسخ المحفوظة',
    'settings.backupNow': 'نسخ احتياطي الآن',
    'settings.restore': 'استعادة نسخة احتياطية',
    'settings.restoreFromFile': 'اختيار ملف نسخة احتياطية…',
    'settings.restoreWarning':
      'الاستعادة تستبدل البيانات الحالية. يتم إنشاء نسخة أمان تلقائياً قبل ذلك.',
    'settings.restoreConfirmTitle': 'استعادة هذه النسخة؟',
    'settings.restoreConfirmText': 'سيتم استبدال البيانات الحالية بـ «{name}». وستُحفظ نسخة أمان.',
    'settings.restoreDone': 'تمت الاستعادة. سيُعاد تحميل التطبيق.',
    'settings.exportBackup': 'حفظ نسخة في مكان آخر',
    'settings.backupsList': 'النسخ المتوفرة',
    'settings.backupName': 'الملف',
    'settings.backupDate': 'تاريخ الإنشاء',
    'settings.backupSize': 'الحجم',
    'settings.backupKind': 'النوع',
    'settings.noBackups': 'لا توجد نسخ احتياطية حالياً.',
    'settings.maintenance': 'الفحص والصيانة',
    'settings.integrityCheck': 'فحص سلامة قاعدة البيانات',
    'settings.integrityOk': 'القاعدة سليمة: لم يُكتشف أي خطأ.',
    'settings.integrityBad': 'تم اكتشاف مشكلة: {message}',
    'settings.databaseInfo': 'معلومات تقنية',
    'settings.openDataFolder': 'فتح مجلد البيانات',
    'settings.openBackupFolder': 'فتح مجلد النسخ الاحتياطية',
    'settings.openLogFile': 'فتح مجلد السجل',
    'settings.privacyNote':
      'لا تُرسل أي بيانات إلى الإنترنت. أسماء العملاء وأرقام هواتفهم لا تُكتب أبداً في السجل التقني.',
    'settings.auditTitle': 'سجل التدقيق',
    'settings.auditHint': 'آخر الإجراءات الحساسة، دون بيانات شخصية.',
    'settings.noAudit': 'لا يوجد أي إجراء مسجل.',
    'settings.savedOk': 'تم حفظ الإعدادات.',
    'settings.savedLanguage': 'تم حفظ اللغة.',
    'settings.unsavedHint': 'تغييرات غير محفوظة',

    /* -------------------------------- backups -------------------------------- */
    'backup.kind.auto': 'تلقائية',
    'backup.kind.manual': 'يدوية',
    'backup.kind.pre-update': 'قبل التحديث',
    'backup.kind.before-restore': 'قبل الاستعادة',
    'backup.kind.external': 'خارجية',
    'backup.created': 'تم إنشاء نسخة احتياطية',
    'backup.exported': 'تم حفظ النسخة',
    'backup.canceled': 'تم إلغاء العملية',

    /* --------------------------------- audit --------------------------------- */
    'audit.backup.create': 'نسخة احتياطية يدوية',
    'audit.backup.restore': 'استعادة نسخة احتياطية',
    'audit.backup.export': 'تصدير نسخة من قاعدة البيانات',
    'audit.settings.language': 'تغيير اللغة',
    'audit.settings.update': 'تعديل الإعدادات',

    /* --------------------------------- errors -------------------------------- */
    'error.title': 'تعذر تنفيذ العملية',
    'error.INVALID_AMOUNT': 'المبلغ غير صحيح.',
    'error.INVALID_QUANTITY': 'الكمية غير صحيحة: أدخل عدداً صحيحاً.',
    'error.INVALID_PERCENT': 'النسبة المئوية غير صحيحة.',
    'error.INVALID_AUDIT_ACTION': 'إجراء تدقيق غير صحيح.',
    'error.INVALID_SETTING_KEY': 'إعداد غير معروف.',
    'error.INVALID_SETTING_VALUE': 'قيمة غير صحيحة لهذا الإعداد.',
    'error.INVALID_THRESHOLDS': 'يجب أن تكون الحدود تنازلية: 90 ثم 60 ثم 30.',
    'error.INVALID_DATE': 'تاريخ غير صحيح.',
    'error.INVALID_VALUE': 'قيمة غير صحيحة.',
    'error.INVALID_ID': 'معرّف غير صحيح.',
    'error.INVALID_FILE': 'ملف غير مدعوم.',
    'error.INVALID_TARGET': 'مجلد غير معروف.',
    'error.INVALID_PAYLOAD': 'بيانات مرسلة غير صحيحة.',
    'error.BACKUP_NOT_FOUND': 'ملف النسخة الاحتياطية غير موجود.',
    'error.BACKUP_CORRUPT': 'ملف النسخة الاحتياطية غير مقروء أو تالف.',
    'error.BACKUP_TOO_NEW': 'هذه النسخة من إصدار أحدث من التطبيق. ثبّت ذلك الإصدار أولاً.',
    'error.BACKUP_NOT_READY': 'وحدة النسخ الاحتياطي غير جاهزة.',
    'error.BACKUP_DESTINATION_REQUIRED': 'اختر مكاناً لحفظ النسخة.',
    'error.BACKUP_BEFORE_UPGRADE_FAILED': 'فشل إنشاء نسخة الأمان قبل التحديث. لم تتغير أي بيانات.',
    'error.RESTORE_FAILED': 'فشلت الاستعادة. تم الاحتفاظ بقاعدة البيانات السابقة.',
    'error.RESTORE_NOT_APPROVED': 'اختر ملف النسخة الاحتياطية من داخل التطبيق.',
    'error.DATABASE_NOT_OPEN': 'قاعدة البيانات غير مفتوحة.',
    'error.SCHEMA_TOO_NEW': 'هذه القاعدة أُنشئت بإصدار أحدث. ثبّت الإصدار الجديد.',
    'error.MIGRATION_FAILED': 'فشل تحديث قاعدة البيانات. بياناتك سليمة.',
    'error.MIGRATION_INVALID': 'ترحيل غير صحيح: اتصل بالدعم مع السجل التقني.',
    'error.IPC_ALREADY_REGISTERED': 'تم تهيئة جسر الاتصال مسبقاً.',
    'error.UNKNOWN_METHOD': 'إجراء غير معروف.',
    'error.UNTRUSTED_SENDER': 'مصدر الطلب غير مسموح.',
    'error.DIALOG_UNAVAILABLE': 'نافذة الاختيار غير متوفرة.',
    'error.OPEN_FOLDER_FAILED': 'تعذر فتح هذا المجلد.',
    'error.TEXT_TOO_LONG': 'النص طويل جداً للنسخ.',
    'error.INTERNAL_ERROR': 'خطأ داخلي. راجع السجل التقني.',
    'error.OFFLINE': 'التطبيق غير متصل بعملية التشغيل الرئيسية.',
  };

  const DICTIONARIES = { fr, ar };
  const LANGUAGES = [
    { code: 'fr', label: 'Français', dir: 'ltr', short: 'FR' },
    { code: 'ar', label: 'العربية', dir: 'rtl', short: 'ع' },
  ];

  let current = 'fr';
  const listeners = new Set();

  function isLanguage(code) {
    return Object.prototype.hasOwnProperty.call(DICTIONARIES, code);
  }

  /** Translate `key`, replacing {name} placeholders. Unknown keys are visible. */
  function t(key, variables) {
    const dictionary = DICTIONARIES[current] || DICTIONARIES.fr;
    let value = dictionary[key];
    if (value === undefined) value = DICTIONARIES.fr[key];
    if (value === undefined) return key;
    if (!variables) return value;
    return value.replace(/\{(\w+)\}/g, (match, name) =>
      Object.prototype.hasOwnProperty.call(variables, name) ? String(variables[name]) : match,
    );
  }

  function dirOf(language) {
    return language === 'ar' ? 'rtl' : 'ltr';
  }

  function getLanguage() {
    return current;
  }

  function dir() {
    return dirOf(current);
  }

  /** Apply <html lang dir>, so the browser mirrors layout and form controls. */
  function applyToDocument() {
    if (typeof document === 'undefined' || !document.documentElement) return;
    const root = document.documentElement;
    root.setAttribute('lang', current);
    root.setAttribute('dir', dir());
    root.dataset.language = current;
  }

  /**
   * Change language and notify subscribers.
   * @param {'fr'|'ar'} language
   * @param {{silent?: boolean}} [options]
   */
  function setLanguage(language, options = {}) {
    const next = isLanguage(language) ? language : 'fr';
    const changed = next !== current;
    current = next;
    applyToDocument();
    if (!options.silent && changed) {
      for (const listener of listeners) {
        try {
          listener(current);
        } catch (error) {
          console.error('[i18n] listener failed', error);
        }
      }
    }
    return current;
  }

  function onChange(listener) {
    if (typeof listener !== 'function') return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  /** Number formatting that follows the language (Arabic uses Latin digits). */
  function formatNumber(value, options = {}) {
    const number = Number(value) || 0;
    const locale = current === 'ar' ? 'fr-DZ' : 'fr-DZ';
    try {
      return new Intl.NumberFormat(locale, options).format(number);
    } catch (error) {
      return String(number);
    }
  }

  window.I18N = {
    t,
    setLanguage,
    getLanguage,
    dir,
    dirOf,
    isLanguage,
    applyToDocument,
    onChange,
    formatNumber,
    languages: LANGUAGES,
    dictionaries: DICTIONARIES,
    keys: () => Object.keys(DICTIONARIES.fr).sort(),
  };
})();
