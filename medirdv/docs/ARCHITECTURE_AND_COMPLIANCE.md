# MediRDV v2.0.0 — Architecture, Migrations, Sécurité & Conformité Loi 18-07

## 1. Principes d’Architecture
- **100 % Hors-Ligne & Souveraineté des Données** : Base SQLite locale unique (`medirdv.sqlite` en mode `WAL`, `foreign_keys = ON`) avec vérification d’intégrité `PRAGMA quick_check` au démarrage. Aucune télémétrie, aucun serveur cloud tiers.
- **Passerelle IPC à Liste Blanche & RBAC** : Canal unique `medirdv:invoke` protégé par session + matrice de permissions à 5 rôles (`admin`, `doctor`, `secretary`, `nurse`, `accountant`).
- **Bilingue Français / Arabe RTL Complet** : Parité stricte des clés et variables `{placeholder}` entre `DICT.fr` et `DICT.ar` vérifiée automatiquement par `tests/i18n.test.js` et `tests/printing-i18n.test.js`.

## 2. Historique des Migrations SQLite (`SCHEMA_VERSION = 10`)
- `MIGRATION_1` *(intacte)* : Schéma initial v1.0.0 (`settings`, `departments`, `patients`, `treatments`, `appointments`, `payments`, `expenses`, `medications`, `prescriptions`, `medical_certificates`, `chat_events`).
- `MIGRATION_2` : Pré-consultation WhatsApp & accueil (`patient_intake`, `patient_weight_history`).
- `MIGRATION_3` : Sécurité de prescription (`dose_rules`, `interaction_pairs`, `contraindications`, `allergy_class_rules`, `controlled_rules`, `prescription_safety_audits`).
- `MIGRATION_4` : Nomenclature Nationale Algérienne (`medications` étendue + index plein texte `medications_fts`).
- `MIGRATION_5` : CIM-10 / ICD-10 (`icd10`, `icd10_fts`, `prescription_diagnoses`, protocoles médicaux).
- `MIGRATION_6` : Dossier Médical Électronique (`consultations`, `patient_documents`, `lab_orders`, `lab_results`, `imaging_orders`, `vaccine_schedule`, `patient_vaccinations`, `pregnancy_episodes`, `pregnancy_visits`).
- `MIGRATION_7` : Facturation conventionnée CNAS/CASNOS & Rapport Z (`invoice_counters`, `invoices`, `invoice_items`, `payment_refunds`).
- `MIGRATION_8` : Utilisateurs RBAC, chaîne d’audit SHA-256 & consentements Loi 18-07 (`users`, `audit_log`, `patient_consents`).
- `MIGRATION_9` : Créneaux horaires, fériés algériens, stock médical, salles & RH/paie (`clinic_closures`, `clinic_rooms`, `inventory_items`, `inventory_movements`, `treatment_consumables`, `staff_members`, `staff_attendance`, `staff_payroll`).
- `MIGRATION_10` : Impression A4/A5, hachage QR de vérification sans contenu médical & documents cliniques (`clinical_documents`).

## 3. Conformité à la Loi Algérienne n° 18-07
1. **Consentement explicite horodaté** avant toute collecte WhatsApp (`patient_intake.consent_at`) et registre `patient_consents`.
2. **Séparation stricte** entre données déclarées par le patient (badge *Non vérifié*) et dossier médical validé par le médecin.
3. **Chiffrement fort** : `scrypt` pour les mots de passe/PIN, `AES-256-GCM` pour le chiffrement au repos et les sauvegardes chiffrées avec test automatique de restauration.
4. **Traçabilité infalsifiable** : Journal `audit_log` chaîné par empreinte `SHA-256` (`prev_hash` → `entry_hash`).
5. **Zéro donnée patient dans les journaux techniques** (`sanitizeLogText` masque automatiquement les numéros algériens et identifiants WhatsApp) et **zéro donnée médicale dans les QR codes imprimés** (`MRDV:<TYPE>:<ID>:<HASH>`).
6. **Droits d’accès, de portabilité et d’effacement** : Export JSON complet (`privacy:export`) et anonymisation irréversible (`privacy:anonymize`) préservant uniquement les totaux comptables légaux.
