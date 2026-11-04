-- 001_reference_data.sql — wilayas, spécialités, réglages, paramètres publics
-- Idempotent et additif.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version      integer PRIMARY KEY,
  name         text NOT NULL,
  applied_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wilayas (
  code      integer PRIMARY KEY CHECK (code BETWEEN 1 AND 58),
  name_ar   text NOT NULL,
  name_fr   text NOT NULL
);

CREATE TABLE IF NOT EXISTS specialties (
  code      text PRIMARY KEY,
  name_ar   text NOT NULL,
  name_fr   text NOT NULL,
  active    boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS system_settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_by  uuid,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO wilayas (code, name_ar, name_fr) VALUES
  (1,'أدرار','Adrar'),(2,'الشلف','Chlef'),(3,'الأغواط','Laghouat'),(4,'أم البواقي','Oum El Bouaghi'),
  (5,'باتنة','Batna'),(6,'بجاية','Béjaïa'),(7,'بسكرة','Biskra'),(8,'بشار','Béchar'),
  (9,'البليدة','Blida'),(10,'البويرة','Bouira'),(11,'تمنراست','Tamanrasset'),(12,'تبسة','Tébessa'),
  (13,'تلمسان','Tlemcen'),(14,'تيارت','Tiaret'),(15,'تيزي وزو','Tizi Ouzou'),(16,'الجزائر','Alger'),
  (17,'الجلفة','Djelfa'),(18,'جيجل','Jijel'),(19,'سطيف','Sétif'),(20,'سعيدة','Saïda'),
  (21,'سكيكدة','Skikda'),(22,'سيدي بلعباس','Sidi Bel Abbès'),(23,'عنابة','Annaba'),(24,'قالمة','Guelma'),
  (25,'قسنطينة','Constantine'),(26,'المدية','Médéa'),(27,'مستغانم','Mostaganem'),(28,'المسيلة','M''Sila'),
  (29,'معسكر','Mascara'),(30,'ورقلة','Ouargla'),(31,'وهران','Oran'),(32,'البيض','El Bayadh'),
  (33,'إليزي','Illizi'),(34,'برج بوعريريج','Bordj Bou Arréridj'),(35,'بومرداس','Boumerdès'),
  (36,'الطارف','El Tarf'),(37,'تندوف','Tindouf'),(38,'تيسمسيلت','Tissemsilt'),(39,'الوادي','El Oued'),
  (40,'خنشلة','Khenchela'),(41,'سوق أهراس','Souk Ahras'),(42,'تيبازة','Tipaza'),(43,'ميلة','Mila'),
  (44,'عين الدفلى','Aïn Defla'),(45,'النعامة','Naâma'),(46,'عين تموشنت','Aïn Témouchent'),
  (47,'غرداية','Ghardaïa'),(48,'غليزان','Relizane'),(49,'تيميمون','Timimoun'),
  (50,'برج باجي مختار','Bordj Badji Mokhtar'),(51,'أولاد جلال','Ouled Djellal'),(52,'بني عباس','Béni Abbès'),
  (53,'عين صالح','In Salah'),(54,'عين قزام','In Guezzam'),(55,'تقرت','Touggourt'),(56,'جانت','Djanet'),
  (57,'المغير','El M''Ghair'),(58,'المنيعة','El Meniaa')
ON CONFLICT (code) DO NOTHING;

INSERT INTO specialties (code, name_ar, name_fr) VALUES
  ('DENT','طب الأسنان','Dentaire'),
  ('GENERAL','الطب العام','Médecine générale'),
  ('CARDIO','أمراض القلب','Cardiologie'),
  ('OPHTHALMO','طب العيون','Ophtalmologie'),
  ('DERMA','الأمراض الجلدية','Dermatologie'),
  ('PEDIATRIE','طب الأطفال','Pédiatrie'),
  ('GYNECO','أمراض النساء','Gynécologie'),
  ('ORL','الأنف والأذن والحنجرة','ORL'),
  ('ORTHO','جراحة العظام','Orthopédie'),
  ('GASTRO','أمراض الجهاز الهضمي','Gastro-entérologie'),
  ('NEURO','أمراض الأعصاب','Neurologie'),
  ('URO','المسالك البولية','Urologie'),
  ('ENDO','الغدد الصماء','Endocrinologie'),
  ('PSY','الطب النفسي','Psychiatrie'),
  ('PNEUMO','أمراض الصدر','Pneumologie'),
  ('RHUMATO','أمراض الروماتيزم','Rhumatologie'),
  ('CHIRURGIE','الجراحة العامة','Chirurgie générale'),
  ('RADIO','الأشعة','Radiologie'),
  ('BIOLOGIE','البيولوجيا الطبية','Biologie médicale'),
  ('KINE','العلاج الطبيعي','Kinésithérapie')
ON CONFLICT (code) DO NOTHING;

INSERT INTO system_settings (key, value) VALUES
  ('public.service_fee',            '{"amount": 10000, "currency": "DZD"}'::jsonb),
  ('public.default_commission',     '{"booking": {"platform_pct": 60, "branch_pct": 15, "operator_pct": 15, "psp_fixed": 1000}, "teleconsult": {"platform_pct": 15}}'::jsonb),
  ('public.telemedicine',           '{"enabled": true, "paid_enabled": false, "notice_ar": "هذه الخدمة ليست خدمة طوارئ. في حالة خطر، اتصلوا فورا بالرقم 14.", "notice_fr": "Ce service n''est pas un service d''urgence. En cas de danger, appelez le 14."}'::jsonb),
  ('public.booking',                '{"hold_ttl_minutes": 10, "cancellation_notice_hours": 24, "slot_minutes": 20, "horizon_days": 60, "refund_pct_before_notice": 100, "refund_pct_late": 0}'::jsonb),
  ('public.wallet',                 '{"enabled": false, "reason_ar": "المحفظة غير متاحة بعد.", "reason_fr": "Portefeuille non disponible."}'::jsonb),
  ('public.brand',                  '{"name": "RDV DZ", "primary": "#0B63C5", "accent": "#0E9F6E"}'::jsonb)
ON CONFLICT (key) DO NOTHING;
