/**
 * Starter ICD-10 (CIM-10) reference dataset & editable clinical protocols
 * for Algerian ambulatory clinics.
 *
 * IMPORTANT CLINICAL NOTICE:
 * All entries are shipped with `source = 'starter'` and `verified = 0`.
 * Practitioners can import the official WHO/MSPRH CIM-10 CSV/JSON file
 * and verify/edit every code, ALD flag, MDO flag, and clinical protocol.
 */

const ICD10_STARTER = [
  // Chronic ALD 100% (CNAS Affections de Longue Durée)
  { code: 'I10',   label_fr: 'Hypertension artérielle essentielle (primitive)', label_ar: 'ارتفاع ضغط الدم الأساسي', chapter: 'IX - Appareil circulatoire', is_chronic_ald: 1, is_notifiable: 0 },
  { code: 'E11.9', label_fr: 'Diabète sucré de type 2 sans complication', label_ar: 'داء السكري من النوع الثاني بدون مضاعفات', chapter: 'IV - Maladies endocriniennes', is_chronic_ald: 1, is_notifiable: 0 },
  { code: 'E10.9', label_fr: 'Diabète sucré de type 1 sans complication', label_ar: 'داء السكري من النوع الأول بدون مضاعفات', chapter: 'IV - Maladies endocriniennes', is_chronic_ald: 1, is_notifiable: 0 },
  { code: 'J45.9', label_fr: 'Asthme bronchique', label_ar: 'الربو القصبي', chapter: 'X - Appareil respiratoire', is_chronic_ald: 1, is_notifiable: 0 },
  { code: 'E03.9', label_fr: 'Hypothyroïdie, sans précision', label_ar: 'قصور الغدة الدرقية', chapter: 'IV - Maladies endocriniennes', is_chronic_ald: 1, is_notifiable: 0 },
  { code: 'I25.9', label_fr: 'Cardiopathie ischémique chronique', label_ar: 'اعتلال القلب الإقفاري المزمن', chapter: 'IX - Appareil circulatoire', is_chronic_ald: 1, is_notifiable: 0 },
  { code: 'I48.9', label_fr: 'Fibrillation et flutter auriculaires', label_ar: 'الرجفان الأذيني', chapter: 'IX - Appareil circulatoire', is_chronic_ald: 1, is_notifiable: 0 },
  { code: 'N18.9', label_fr: 'Insuffisance rénale chronique', label_ar: 'القصور الكلوي المزمن', chapter: 'XIV - Appareil génito-urinaire', is_chronic_ald: 1, is_notifiable: 0 },
  { code: 'G40.9', label_fr: 'Épilepsie, sans précision', label_ar: 'الصرع', chapter: 'VI - Système nerveux', is_chronic_ald: 1, is_notifiable: 0 },
  { code: 'M06.9', label_fr: 'Polyarthrite rhumatoïde', label_ar: 'التهاب المفاصل الروماتويدي', chapter: 'XIII - Système ostéo-articulaire', is_chronic_ald: 1, is_notifiable: 0 },

  // Algerian Mandatory Notifiable Diseases (MDO — Maladies à Déclaration Obligatoire)
  { code: 'A15.0', label_fr: 'Tuberculose pulmonaire confirmée', label_ar: 'السل الرئوي المؤكد', chapter: 'I - Maladies infectieuses', is_chronic_ald: 1, is_notifiable: 1 },
  { code: 'B05.9', label_fr: 'Rougeole sans complication', label_ar: 'الحصبة بدون مضاعفات', chapter: 'I - Maladies infectieuses', is_chronic_ald: 0, is_notifiable: 1 },
  { code: 'A23.9', label_fr: 'Brucellose, sans précision', label_ar: 'داء البروسيلات (الحمى المالطية)', chapter: 'I - Maladies infectieuses', is_chronic_ald: 0, is_notifiable: 1 },
  { code: 'B15.9', label_fr: 'Hépatite virale A aiguë', label_ar: 'التهاب الكبد الفيروسي الحاد أ', chapter: 'I - Maladies infectieuses', is_chronic_ald: 0, is_notifiable: 1 },
  { code: 'G00.9', label_fr: 'Méningite bactérienne, sans précision', label_ar: 'التهاب السحايا الجرثومي', chapter: 'VI - Système nerveux', is_chronic_ald: 0, is_notifiable: 1 },
  { code: 'A01.0', label_fr: 'Fièvre typhoïde', label_ar: 'حمى التيفوئيد', chapter: 'I - Maladies infectieuses', is_chronic_ald: 0, is_notifiable: 1 },
  { code: 'A37.9', label_fr: 'Coqueluche', label_ar: 'السعال الديكي', chapter: 'I - Maladies infectieuses', is_chronic_ald: 0, is_notifiable: 1 },
  { code: 'B55.1', label_fr: 'Leishmaniose cutanée', label_ar: 'داء الليشمانيات الجلدي', chapter: 'I - Maladies infectieuses', is_chronic_ald: 0, is_notifiable: 1 },

  // Common Acute & Outpatient Consultations
  { code: 'J02.9', label_fr: 'Angine aiguë (pharyngite aiguë)', label_ar: 'التهاب اللوزتين والبلعوم الحاد', chapter: 'X - Appareil respiratoire', is_chronic_ald: 0, is_notifiable: 0 },
  { code: 'J00',   label_fr: 'Rhinopharyngite aiguë (rhume banal)', label_ar: 'التهاب الأنف والبلعوم الحاد (الزكام)', chapter: 'X - Appareil respiratoire', is_chronic_ald: 0, is_notifiable: 0 },
  { code: 'J01.9', label_fr: 'Sinusite aiguë', label_ar: 'التهاب الجيوب الأنفية الحاد', chapter: 'X - Appareil respiratoire', is_chronic_ald: 0, is_notifiable: 0 },
  { code: 'H66.9', label_fr: 'Otite moyenne aiguë', label_ar: 'التهاب الأذن الوسطى الحاد', chapter: 'VIII - Oreille et mastoïde', is_chronic_ald: 0, is_notifiable: 0 },
  { code: 'J20.9', label_fr: 'Bronchite aiguë', label_ar: 'التهاب الشعب الهوائية الحاد', chapter: 'X - Appareil respiratoire', is_chronic_ald: 0, is_notifiable: 0 },
  { code: 'K21.9', label_fr: 'Reflux gastro-œsophagien (RGO)', label_ar: 'الارتجاع المعدي المريئي', chapter: 'XI - Appareil digestif', is_chronic_ald: 0, is_notifiable: 0 },
  { code: 'K29.7', label_fr: 'Gastrite aiguë ou chronique', label_ar: 'التهاب المعدة', chapter: 'XI - Appareil digestif', is_chronic_ald: 0, is_notifiable: 0 },
  { code: 'A09',   label_fr: 'Gastro-entérite aiguë présumée infectieuse', label_ar: 'التهاب المعدة والأمعاء الحاد', chapter: 'I - Maladies infectieuses', is_chronic_ald: 0, is_notifiable: 0 },
  { code: 'N39.0', label_fr: 'Infection urinaire (cystite aiguë)', label_ar: 'التهاب المسالك البولية', chapter: 'XIV - Appareil génito-urinaire', is_chronic_ald: 0, is_notifiable: 0 },
  { code: 'M54.5', label_fr: 'Lombalgie basse aiguë', label_ar: 'ألم أسفل الظهر الحاد', chapter: 'XIII - Système ostéo-articulaire', is_chronic_ald: 0, is_notifiable: 0 },
  { code: 'M54.4', label_fr: 'Lombosciatique', label_ar: 'عرق النسا القطني', chapter: 'XIII - Système ostéo-articulaire', is_chronic_ald: 0, is_notifiable: 0 },
  { code: 'D50.9', label_fr: 'Anémie par carence en fer (ferriprive)', label_ar: 'فقر الدم بعوز الحديد', chapter: 'III - Sang et organes hématopoïétiques', is_chronic_ald: 0, is_notifiable: 0 },
  { code: 'E78.5', label_fr: 'Dyslipidémie / Hypercholestérolémie', label_ar: 'اضطراب شحوم الدم', chapter: 'IV - Maladies endocriniennes', is_chronic_ald: 0, is_notifiable: 0 },
  { code: 'H10.9', label_fr: 'Conjonctivite aiguë', label_ar: 'التهاب الملتحمة الحاد', chapter: 'VII - Œil et annexes', is_chronic_ald: 0, is_notifiable: 0 },
  { code: 'L20.9', label_fr: 'Dermatite atopique (eczéma)', label_ar: 'التهاب الجلد التأتبي (الإكزيما)', chapter: 'XII - Peau et tissu cellulaire', is_chronic_ald: 0, is_notifiable: 0 },
  { code: 'L30.9', label_fr: 'Dermatite allergique / Urticaire', label_ar: 'الشرى / التهاب الجلد التحسسي', chapter: 'XII - Peau et tissu cellulaire', is_chronic_ald: 0, is_notifiable: 0 },
  { code: 'Z34.9', label_fr: 'Surveillance de grossesse normale', label_ar: 'متابعة الحمل الطبيعي', chapter: 'XXI - Facteurs influant sur la santé', is_chronic_ald: 0, is_notifiable: 0 },
  { code: 'Z00.1', label_fr: 'Examen de santé de routine de l’enfant', label_ar: 'الفحص الصحي الدوري للطفل', chapter: 'XXI - Facteurs influant sur la santé', is_chronic_ald: 0, is_notifiable: 0 },
];

module.exports = { ICD10_STARTER };
