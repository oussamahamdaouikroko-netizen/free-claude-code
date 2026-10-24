'use strict';
/**
 * French / Arabic reply templates for the MediRDV WhatsApp bot.
 *
 * Supports both solo specialist cabinets and multi-department polyclinics
 * (numbered department menu + department-specific doctor, room & instructions).
 */

const { formatLong } = require('../utils/dates');

const money = (value, currency = 'DZD') =>
  `${Number(value).toLocaleString('fr-DZ', { maximumFractionDigits: 2 })} ${currency}`;

/** Human-friendly wait duration ("20 min", "1 h 20 min" / "20 دقيقة", "ساعة و20 دقيقة"). */
function formatDuration(minutes, lang = 'fr') {
  const m = Math.max(0, Math.round(Number(minutes) || 0));
  if (lang === 'ar') {
    if (m <= 0) return 'الآن';
    if (m < 60) return `${m} دقيقة`;
    const hours = Math.floor(m / 60);
    const rem = m % 60;
    const hourText =
      hours === 1 ? 'ساعة' : hours === 2 ? 'ساعتين' : hours <= 10 ? `${hours} ساعات` : `${hours} ساعة`;
    return rem === 0 ? hourText : `${hourText} و${rem} دقيقة`;
  }
  if (m <= 0) return 'maintenant';
  if (m < 60) return `${m} min`;
  const hours = Math.floor(m / 60);
  const rem = m % 60;
  return rem === 0 ? `${hours} h` : `${hours} h ${rem} min`;
}

/** Human-friendly count of patients remaining ahead in the queue. */
function formatPatientsAhead(ahead, lang = 'fr') {
  const n = Math.max(0, Math.round(Number(ahead) || 0));
  if (lang === 'ar') {
    if (n === 0) return 'لا أحد قبلكم';
    if (n === 1) return 'مريض واحد (1)';
    if (n === 2) return 'مريضان (2)';
    if (n <= 10) return `${n} مرضى`;
    return `${n} مريضا`;
  }
  if (n === 0) return 'aucun patient';
  return n === 1 ? '1 patient' : `${n} patients`;
}

function formatDepartmentList(departments = [], lang = 'fr', currency = 'DZD') {
  return departments
    .map((d, idx) => {
      const label = lang === 'ar' ? (d.name_ar || d.name_fr) : (d.name_fr || d.name_ar);
      const details = [];
      if (d.doctor_name) details.push(d.doctor_name);
      if (d.room) details.push(d.room);
      if (Number(d.consultation_fee) > 0) details.push(money(d.consultation_fee, currency));
      return `${idx + 1}. ${label}${details.length ? ` — ${details.join(' · ')}` : ''}`;
    })
    .join('\n');
}

const t = {
  fr: {
    help: (s, { departments } = {}) =>
      `Bonjour et bienvenue au ${s.clinic}. 👋\n` +
      (s.doctor ? `${s.doctor}${s.specialty ? ` — ${s.specialty}` : ''}\n` : '') +
      (s.address ? `📍 ${s.address}\n` : '') +
      `\n` +
      (Array.isArray(departments) && departments.length >= 2
        ? `Services disponibles :\n${formatDepartmentList(departments, 'fr', s.currency)}\n\n` +
          `Pour prendre un rendez-vous, envoyez votre nom complet (ou le numéro du service).\n\n`
        : `Pour prendre un rendez-vous, envoyez simplement votre nom complet (prénom et nom).\n\n`) +
      `Commandes :\n` +
      `• ANNULER — annuler votre rendez-vous\n` +
      `• MON RDV — consulter votre rendez-vous\n\n` +
      `Merci.`,

    askName: (s) =>
      `Bienvenue au ${s.clinic}. 🙏\nEnvoyez votre nom complet (prénom + nom) ` +
      `pour réserver le premier créneau disponible.`,

    chooseDepartment: (s, { name, departments }) =>
      `🏥 Bonjour ${name}, veuillez choisir le service médical souhaité en envoyant son numéro :\n\n` +
      `${formatDepartmentList(departments, 'fr', s.currency)}\n\n` +
      `Répondez uniquement par le numéro du service (ex : 1).`,

    askNameForDepartment: (s, { department }) =>
      `🏥 Service sélectionné : ${department}.\n` +
      `Envoyez maintenant votre nom complet (prénom et nom) pour confirmer le rendez-vous.`,

    invalidDepartmentChoice: (s, { departments }) =>
      `Numéro de service invalide. Merci d'envoyer un numéro entre 1 et ${departments.length} :\n\n` +
      `${formatDepartmentList(departments, 'fr', s.currency)}`,

    booked: (s, { name, day, queue, department, doctor, room, instructions }) =>
      `✅ Rendez-vous confirmé\n\n` +
      `Patient : ${name}\n` +
      (department ? `Service : ${department}\n` : '') +
      (doctor ? `Médecin : ${doctor}\n` : '') +
      (room ? `Salle : ${room}\n` : '') +
      `Date : ${formatLong(day, 'fr')}\n` +
      `Numéro de passage : ${queue}\n` +
      (instructions ? `\n📌 Consignes : ${instructions}\n` : '') +
      `\n${s.clinic}` +
      (s.address ? `\n📍 ${s.address}` : '') +
      `\nPour annuler, envoyez : ANNULER\n\n` +
      `📋 Souhaitez-vous préparer votre fiche pré-consultation (poids, symptômes, allergies) pour aider le médecin ?\n` +
      `🔒 Vos réponses restent strictement confidentielles au cabinet (Loi 18-07).\n` +
      `Répondez OUI pour commencer ou NON pour ignorer.`,

    alreadyBooked: (s, { day, queue, department }) =>
      `Vous avez déjà un rendez-vous` +
      (department ? ` (${department})` : '') +
      ` le ${formatLong(day, 'fr')} (numéro ${queue}).\n\nPour l'annuler, envoyez : ANNULER`,

    myAppointment: (s, { day, queue, department, room, treatment, ahead, etaMinutes }) =>
      `📅 Votre rendez-vous\n\n` +
      (department ? `Service : ${department}\n` : '') +
      (room ? `Salle : ${room}\n` : '') +
      `Date : ${formatLong(day, 'fr')}\n` +
      `Numéro de passage : ${queue}\n` +
      (treatment ? `Motif / Acte : ${treatment}\n` : '') +
      (ahead === 0
        ? `État : c'est votre tour maintenant.\n`
        : ahead > 0
          ? `Avant vous : ${formatPatientsAhead(ahead, 'fr')} (~${formatDuration(etaMinutes, 'fr')})\n`
          : '') +
      `\nPour l'annuler, envoyez : ANNULER`,

    noAppointment: () =>
      `Vous n'avez aucun rendez-vous en cours.\nEnvoyez votre nom complet pour réserver.`,

    cancelled: (s, { day }) =>
      `✅ Votre rendez-vous du ${formatLong(day, 'fr')} a bien été annulé.\n` +
      `Envoyez votre nom complet si vous souhaitez reprendre un rendez-vous.`,

    nothingToCancel: () => `Vous n'avez aucun rendez-vous à annuler.`,

    full: (s, { department } = {}) =>
      `Le planning${department ? ` du service « ${department} »` : ''} est complet pour le moment. 📋\n` +
      `Nous avons noté votre demande, la clinique vous contactera dès qu'un créneau se libère.\n\n` +
      `${s.clinic}`,

    unsupported: () =>
      `Je comprends seulement les messages texte. 🙂\n` +
      `Envoyez votre nom complet pour réserver, ou écrivez AIDE.`,

    error: () =>
      `Désolé, une erreur est survenue. Merci de réessayer dans quelques instants.`,

    reminder: (s, { name, day, queue, department }) =>
      `🔔 Rappel de votre rendez-vous\n\n` +
      `Bonjour ${name}, nous vous attendons le ${formatLong(day, 'fr')}.\n` +
      (department ? `Service : ${department}\n` : '') +
      `Numéro de passage : ${queue}\n\n` +
      `${s.clinic}` +
      (s.address ? `\n📍 ${s.address}` : '') +
      (s.phone ? `\nTél : ${s.phone}` : '') +
      `\n\nPour annuler, envoyez : ANNULER`,

    turnNow: (s, { name, queue, department, room }) =>
      `🔔 C'est votre tour !\n\n` +
      `Bonjour ${name}, le patient précédent a terminé sa consultation.\n` +
      `C'est maintenant votre tour (numéro ${queue})` +
      (department ? ` — ${department}` : '') +
      (room ? ` (${room})` : '') +
      ` — merci de vous présenter au cabinet.\n\n` +
      `${s.clinic}` +
      (s.phone ? `\nTél : ${s.phone}` : ''),

    queueAhead: (s, { name, queue, ahead, etaMinutes, department }) =>
      `⏳ Mise à jour de votre passage\n\n` +
      `Bonjour ${name} (numéro ${queue}${department ? ` · ${department}` : ''}),\n` +
      `• Personnes restantes avant vous : ${formatPatientsAhead(ahead, 'fr')}\n` +
      `• Temps d'attente estimé : environ ${formatDuration(etaMinutes, 'fr')}\n\n` +
      `${s.clinic}\n` +
      `En cas d'empêchement, envoyez : ANNULER`,

    tooFast: () =>
      `Vous avez envoyé plusieurs messages. Merci de patienter quelques minutes. 🙏`,

    price: (s, { treatment, price }) =>
      `Le tarif de « ${treatment} » est de ${money(price, s.currency)}. ` +
      `Envoyez votre nom complet pour réserver.`,

    intakeInvite: (s) =>
      `📋 Fiche pré-consultation — ${s.clinic}\n` +
      `🔒 Conformément à la Loi 18-07, vos réponses sont conservées uniquement au cabinet pour préparer votre consultation médicale.\n` +
      `Acceptez-vous de répondre à quelques questions rapides (vous pouvez envoyer 0 pour passer une question) ?\n` +
      `Répondez OUI ou NON.`,

    intakeDeclined: () =>
      `C'est noté, votre rendez-vous reste bien confirmé. À bientôt au cabinet ! 🙏`,

    intakeAskWeight: (_s, { isChild } = {}) =>
      isChild
        ? `1️⃣ Quel est le poids de l'enfant en kg ? (ex : 14,5 kg — indispensable pour le dosage pédiatrique, ou 0 pour passer)`
        : `1️⃣ Quel est votre poids approximatif en kg ? (ex : 72 ou 72,5 — envoyez 0 pour passer)`,

    intakeRetryWeight: () =>
      `Poids non reconnu. Merci d'envoyer un nombre entre 0,3 et 400 kg (ex : 72 ou 14,5), ou envoyez 0 pour passer.`,

    intakeAskChildAge: () =>
      `👶 Quel est l'âge de l'enfant ? (ex : 4 ans ou 18 mois — envoyez 0 pour passer)`,

    intakeAskHeight: (_s, { isChild } = {}) =>
      isChild
        ? `2️⃣ Quelle est la taille de l'enfant en cm ? (ex : 98 cm — ou 0 pour passer)`
        : `2️⃣ Quelle est votre taille en cm ? (ex : 170 — ou 0 pour passer)`,

    intakeRetryHeight: () =>
      `Taille non reconnue. Merci d'indiquer une taille entre 30 et 250 cm (ex : 170), ou envoyez 0 pour passer.`,

    intakeAskComplaint: (_s, { isChild } = {}) =>
      isChild
        ? `3️⃣ Quel est le motif principal de consultation pour l'enfant (symptômes) ? (ou 0 pour passer)`
        : `3️⃣ Quel est le motif principal de votre consultation / vos symptômes ? (ou 0 pour passer)`,

    intakeAskDuration: () =>
      `4️⃣ Depuis combien de temps ces symptômes durent-ils ? (ex : 3 jours, 2 semaines — ou 0 pour passer)`,

    intakeAskMedications: (_s, { isChild } = {}) =>
      isChild
        ? `5️⃣ L'enfant prend-il actuellement des médicaments ? (indiquez lesquels, ou écrivez AUCUN / 0)`
        : `5️⃣ Prenez-vous actuellement des médicaments ? (indiquez lesquels, ou écrivez AUCUN / 0)`,

    intakeAskAllergies: (_s, { isChild } = {}) =>
      isChild
        ? `6️⃣ L'enfant a-t-il des allergies connues (médicaments, aliments) ? (ou écrivez AUCUNE / 0)`
        : `6️⃣ Avez-vous des allergies connues (ex : pénicilline, aspirine) ? (ou écrivez AUCUNE / 0)`,

    intakeAskChronic: (_s, { isChild } = {}) =>
      isChild
        ? `7️⃣ L'enfant a-t-il une maladie chronique connue (asthme, diabète…) ? (ou AUCUNE / 0)`
        : `7️⃣ Avez-vous des maladies chroniques (tension, diabète, asthme, reins…) ? (ou AUCUNE / 0)`,

    intakeAskPregnant: () =>
      `8️⃣ Êtes-vous actuellement enceinte ? (Répondez OUI, NON, ou 0 pour passer)`,

    intakeAskBreastfeeding: () =>
      `9️⃣ Allaitez-vous actuellement ? (Répondez OUI, NON, ou 0 pour passer)`,

    intakeSummary: (_s, { draft }) => {
      const lines = [
        `📋 Récapitulatif pré-consultation :`,
        `• Poids : ${draft.weight_kg ? `${draft.weight_kg} kg` : '—'}`,
        `• Taille : ${draft.height_cm ? `${draft.height_cm} cm` : '—'}`,
        `• Motif : ${draft.chief_complaint || '—'}${draft.symptom_duration ? ` (${draft.symptom_duration})` : ''}`,
        `• Traitements en cours : ${draft.current_medications || 'Aucun'}`,
        `• Allergies déclarées : ${draft.known_allergies || 'Aucune'}`,
        `• Maladies chroniques : ${draft.chronic_conditions || 'Aucune'}`,
      ];
      if (draft.is_pregnant !== null && draft.is_pregnant !== undefined) {
        lines.push(`• Grossesse : ${draft.is_pregnant ? 'Oui' : 'Non'}`);
      }
      if (draft.is_breastfeeding !== null && draft.is_breastfeeding !== undefined) {
        lines.push(`• Allaitement : ${draft.is_breastfeeding ? 'Oui' : 'Non'}`);
      }
      lines.push(`\nRépondez OUI pour transmettre au médecin, ou CORRIGER pour recommencer.`);
      return lines.join('\n');
    },

    intakeCompleted: () =>
      `✅ Merci ! Votre fiche pré-consultation a été enregistrée pour le médecin (elle sera vérifiée lors de votre passage).`,
  },

  ar: {
    help: (s, { departments } = {}) =>
      `مرحبا بكم في ${s.clinic}. 👋\n` +
      (s.doctor ? `${s.doctor}${s.specialty ? ` — ${s.specialty}` : ''}\n` : '') +
      (s.address ? `📍 ${s.address}\n` : '') +
      `\n` +
      (Array.isArray(departments) && departments.length >= 2
        ? `المصالح الطبية المتوفرة:\n${formatDepartmentList(departments, 'ar', s.currency)}\n\n` +
          `لحجز موعد، أرسلوا اسمكم الكامل (أو رقم المصلحة المطلوبة).\n\n`
        : `لحجز موعد، أرسلوا اسمكم الكامل (الاسم واللقب).\n\n`) +
      `الأوامر:\n` +
      `• إلغاء — لإلغاء الموعد\n` +
      `• موعدي — لمعرفة موعدكم\n\n` +
      `شكرا.`,

    askName: (s) =>
      `مرحبا بكم في ${s.clinic}. 🙏\nأرسلوا اسمكم الكامل (الاسم واللقب) ` +
      `لحجز أول موعد متاح.`,

    chooseDepartment: (s, { name, departments }) =>
      `🏥 مرحبا ${name}، يرجى اختيار المصلحة الطبية المطلوبة بإرسال رقمها:\n\n` +
      `${formatDepartmentList(departments, 'ar', s.currency)}\n\n` +
      `أرسلوا رقم المصلحة فقط (مثلا: 1).`,

    askNameForDepartment: (s, { department }) =>
      `🏥 تم اختيار المصلحة: ${department}.\n` +
      `أرسلوا الآن اسمكم الكامل (الاسم واللقب) لتأكيد حجز الموعد.`,

    invalidDepartmentChoice: (s, { departments }) =>
      `رقم المصلحة غير صحيح. يرجى إرسال رقم بين 1 و ${departments.length}:\n\n` +
      `${formatDepartmentList(departments, 'ar', s.currency)}`,

    booked: (s, { name, day, queue, department, doctor, room, instructions }) =>
      `✅ تم تأكيد الموعد\n\n` +
      `المريض: ${name}\n` +
      (department ? `المصلحة: ${department}\n` : '') +
      (doctor ? `الطبيب: ${doctor}\n` : '') +
      (room ? `القاعة / الطابق: ${room}\n` : '') +
      `التاريخ: ${formatLong(day, 'ar')}\n` +
      `رقم الدور: ${queue}\n` +
      (instructions ? `\n📌 ملاحظة: ${instructions}\n` : '') +
      `\n${s.clinic}` +
      (s.address ? `\n📍 ${s.address}` : '') +
      `\nللإلغاء أرسلوا: إلغاء\n\n` +
      `📋 هل ترغبون في ملء بطاقة ما قبل الفحص (الوزن، الأعراض، الحساسية) لمساعدة الطبيب؟\n` +
      `🔒 معلوماتكم تبقى سرية داخل العيادة طبقا للقانون 18-07.\n` +
      `أرسلوا نعم للبدء أو لا للتجاوز.`,

    alreadyBooked: (s, { day, queue, department }) =>
      `لديكم موعد مسبق` +
      (department ? ` (${department})` : '') +
      ` يوم ${formatLong(day, 'ar')} (رقم ${queue}).\n\n` +
      `للإلغاء أرسلوا: إلغاء`,

    myAppointment: (s, { day, queue, department, room, treatment, ahead, etaMinutes }) =>
      `📅 موعدكم\n\n` +
      (department ? `المصلحة: ${department}\n` : '') +
      (room ? `القاعة: ${room}\n` : '') +
      `التاريخ: ${formatLong(day, 'ar')}\n` +
      `رقم الدور: ${queue}\n` +
      (treatment ? `الخدمة الطبية: ${treatment}\n` : '') +
      (ahead === 0
        ? `الحالة: حان دوركم الآن للدخول.\n`
        : ahead > 0
          ? `بقي قبلكم: ${formatPatientsAhead(ahead, 'ar')} (حوالي ${formatDuration(etaMinutes, 'ar')})\n`
          : '') +
      `\nللإلغاء أرسلوا: إلغاء`,

    noAppointment: () =>
      `ليس لديكم أي موعد حاليا.\nأرسلوا اسمكم الكامل للحجز.`,

    cancelled: (s, { day }) =>
      `✅ تم إلغاء موعدكم يوم ${formatLong(day, 'ar')}.\n` +
      `أرسلوا اسمكم الكامل إذا أردتم حجز موعد جديد.`,

    nothingToCancel: () => `ليس لديكم أي موعد لإلغائه.`,

    full: (s, { department } = {}) =>
      `المواعيد ممتلئة حاليا${department ? ` في «${department}»` : ''}. 📋\n` +
      `سجلنا طلبكم، وستتصل بكم العيادة عند توفر موعد.\n\n${s.clinic}`,

    unsupported: () =>
      `أفهم الرسائل النصية فقط. 🙂\nأرسلوا اسمكم الكامل للحجز أو اكتبوا مساعدة.`,

    error: () => `عذرا، حدث خطأ. يرجى المحاولة بعد لحظات.`,

    reminder: (s, { name, day, queue, department }) =>
      `🔔 تذكير بموعدكم\n\n` +
      `مرحبا ${name}، موعدكم يوم ${formatLong(day, 'ar')}.\n` +
      (department ? `المصلحة: ${department}\n` : '') +
      `رقم الدور: ${queue}\n\n` +
      `${s.clinic}` +
      (s.address ? `\n📍 ${s.address}` : '') +
      (s.phone ? `\nالهاتف: ${s.phone}` : '') +
      `\n\nللإلغاء أرسلوا: إلغاء`,

    turnNow: (s, { name, queue, department, room }) =>
      `🔔 حان دوركم الآن!\n\n` +
      `مرحبا ${name}، أنهى المريض السابق فحصه الطبي وحان دوركم للدخول (رقم الدور: ${queue})` +
      (department ? ` — ${department}` : '') +
      (room ? ` (${room})` : '') +
      `.\nيرجى التفضل بالدخول إلى العيادة الآن.\n\n` +
      `${s.clinic}` +
      (s.phone ? `\nالهاتف: ${s.phone}` : ''),

    queueAhead: (s, { name, queue, ahead, etaMinutes, department }) =>
      `⏳ تنبيه بخصوص دوركم\n\n` +
      `مرحبا ${name} (رقم الدور: ${queue}${department ? ` · ${department}` : ''})،\n` +
      `• عدد المرضى المتبقين قبلكم: ${formatPatientsAhead(ahead, 'ar')}\n` +
      `• الوقت التقديري لانتظاركم: حوالي ${formatDuration(etaMinutes, 'ar')}\n\n` +
      `${s.clinic}\n` +
      `في حال تعذر الحضور أرسلوا: إلغاء`,

    tooFast: () => `أرسلتم عدة رسائل. يرجى الانتظار بضع دقائق. 🙏`,

    price: (s, { treatment, price }) =>
      `سعر «${treatment}» هو ${money(price, s.currency)}. ` +
      `أرسلوا اسمكم الكامل للحجز.`,

    intakeInvite: (s) =>
      `📋 بطاقة ما قبل الفحص — ${s.clinic}\n` +
      `🔒 طبقا للقانون 18-07، تُحفظ إجاباتكم محليا وبسرية داخل العيادة فقط لتحضير فحصكم الطبي.\n` +
      `هل توافقون على الإجابة عن بعض الأسئلة السريعة (يمكنكم إرسال 0 لتخطي أي سؤال)؟\n` +
      `أرسلوا نعم أو لا.`,

    intakeDeclined: () =>
      `تم تسجيل ذلك، موعدكم يبقى مؤكدا. مرحبا بكم في العيادة! 🙏`,

    intakeAskWeight: (_s, { isChild } = {}) =>
      isChild
        ? `1️⃣ ما هو وزن الطفل بالكيلوغرام؟ (مثال: 14.5 كغ — ضروري لحساب جرعة الدواء، أو أرسلوا 0 للتخطي)`
        : `1️⃣ ما هو وزنكم التقريبي بالكيلوغرام؟ (مثال: 72 أو 72.5 — أو أرسلوا 0 للتخطي)`,

    intakeRetryWeight: () =>
      `لم نتعرف على الوزن. يرجى إرسال رقم بين 0.3 و 400 كغ (مثال: 72 أو 14.5)، أو أرسلوا 0 للتخطي.`,

    intakeAskChildAge: () =>
      `👶 كم عمر الطفل؟ (مثال: 4 سنوات أو 18 شهر — أو أرسلوا 0 للتخطي)`,

    intakeAskHeight: (_s, { isChild } = {}) =>
      isChild
        ? `2️⃣ ما هو طول الطفل بالسنتيمتر؟ (مثال: 98 سم — أو أرسلوا 0 للتخطي)`
        : `2️⃣ ما هو طولكم بالسنتيمتر؟ (مثال: 170 — أو أرسلوا 0 للتخطي)`,

    intakeRetryHeight: () =>
      `لم نتعرف على الطول. يرجى إرسال رقم بين 30 و 250 سم (مثال: 170)، أو أرسلوا 0 للتخطي.`,

    intakeAskComplaint: (_s, { isChild } = {}) =>
      isChild
        ? `3️⃣ ما هو سبب الفحص أو الأعراض التي يعاني منها الطفل؟ (أو أرسلوا 0 للتخطي)`
        : `3️⃣ ما هو سبب الفحص الرئيسي أو الأعراض الحالية؟ (أو أرسلوا 0 للتخطي)`,

    intakeAskDuration: () =>
      `4️⃣ منذ متى بدأت هذه الأعراض؟ (مثال: 3 أيام، أسبوعان — أو أرسلوا 0 للتخطي)`,

    intakeAskMedications: (_s, { isChild } = {}) =>
      isChild
        ? `5️⃣ هل يتناول الطفل أدوية حاليا؟ (اذكروها أو أرسلوا لا يوجد / 0)`
        : `5️⃣ هل تتناولون أدوية حاليا؟ (اذكروها أو أرسلوا لا يوجد / 0)`,

    intakeAskAllergies: (_s, { isChild } = {}) =>
      isChild
        ? `6️⃣ هل لدى الطفل حساسية معروفة (أدوية أو أغذية)؟ (أو أرسلوا لا يوجد / 0)`
        : `6️⃣ هل لديكم حساسية معروفة للأدوية (مثل البنسلين)؟ (أو أرسلوا لا يوجد / 0)`,

    intakeAskChronic: (_s, { isChild } = {}) =>
      isChild
        ? `7️⃣ هل يعاني الطفل من مرض مزمن (ربو، سكري...)؟ (أو أرسلوا لا يوجد / 0)`
        : `7️⃣ هل تعانون من أمراض مزمنة (ضغط، سكري، ربو، كلى...)؟ (أو أرسلوا لا يوجد / 0)`,

    intakeAskPregnant: () =>
      `8️⃣ هل يوجد حمل حاليا؟ (أرسلوا نعم أو لا أو 0 للتخطي)`,

    intakeAskBreastfeeding: () =>
      `9️⃣ هل توجد رضاعة طبيعية حاليا؟ (أرسلوا نعم أو لا أو 0 للتخطي)`,

    intakeSummary: (_s, { draft }) => {
      const lines = [
        `📋 ملخص بطاقة ما قبل الفحص:`,
        `• الوزن: ${draft.weight_kg ? `${draft.weight_kg} كغ` : '—'}`,
        `• الطول: ${draft.height_cm ? `${draft.height_cm} سم` : '—'}`,
        `• سبب الفحص: ${draft.chief_complaint || '—'}${draft.symptom_duration ? ` (${draft.symptom_duration})` : ''}`,
        `• الأدوية الحالية: ${draft.current_medications || 'لا يوجد'}`,
        `• الحساسية المصرّح بها: ${draft.known_allergies || 'لا يوجد'}`,
        `• الأمراض المزمنة: ${draft.chronic_conditions || 'لا يوجد'}`,
      ];
      if (draft.is_pregnant !== null && draft.is_pregnant !== undefined) {
        lines.push(`• الحمل: ${draft.is_pregnant ? 'نعم' : 'لا'}`);
      }
      if (draft.is_breastfeeding !== null && draft.is_breastfeeding !== undefined) {
        lines.push(`• الرضاعة: ${draft.is_breastfeeding ? 'نعم' : 'لا'}`);
      }
      lines.push(`\nأرسلوا نعم لإرسال البطاقة للطبيب، أو تصحيح للإعادة.`);
      return lines.join('\n');
    },

    intakeCompleted: () =>
      `✅ شكرا لكم! تم حفظ بطاقة ما قبل الفحص ليطلع عليها الطبيب ويتحقق منها أثناء الموعد.`,
  },
};

const DARIJA_TEMPLATES = {
  ar: {
    help: (s, { departments } = {}) =>
      `سلام ومرحبا بيكم في ${s.clinic} 👋\n` +
      (s.doctor ? `${s.doctor}${s.specialty ? ` — ${s.specialty}` : ''}\n` : '') +
      (s.address ? `📍 ${s.address}\n` : '') +
      `\n` +
      (Array.isArray(departments) && departments.length >= 2
        ? `المصالح الطبية المتوفرة:\n${formatDepartmentList(departments, 'ar', s.currency)}\n\n` +
          `باش تحجز موعد، ابعث الاسم واللقب تاعك (ولا رقم المصلحة).\n\n`
        : `باش تحجز موعد، ابعث برك الاسم واللقب تاعك كاملين.\n\n`) +
      `الأوامر:\n• إلغاء — لإلغاء الموعد\n• موعدي — لمعرفة نهار ونيميرو الدور تاعك\n• تأكيد — لتأكيد الحضور`,
    booked: (_s, { name, day, queue, department, room, instructions }) =>
      `✅ تم تسجيل الموعد تاعك بالصحة والعافية\n\n` +
      `المريض(ة): ${name}\n` +
      (department ? `المصلحة: ${department}${room ? ` (${room})` : ''}\n` : '') +
      `النهار: ${formatLong(day, 'ar')}\n` +
      `نيميرو الدور: ${queue}\n` +
      (instructions ? `📌 ملاحظة: ${instructions}\n` : '') +
      `\nتقدر ترد بـ نعم إيلا حبيت تعمّر بطاقة المعلومات قبل ما تجي للعيادة.`,
    turnNow: (s, { name, queue, department, room }) =>
      `🔔 خويا/ختي ${name}، لحق الدور تاعك درك (النيميرو ${queue})${department ? ` في ${department}` : ''}${room ? ` — ${room}` : ''} في ${s.clinic}. تفضل(ي) للداخل.`,
  },
  fr: {
    help: (s, { departments } = {}) =>
      `Salam et marhba bikoum au ${s.clinic} 👋\n` +
      (Array.isArray(departments) && departments.length >= 2
        ? `Services disponibles :\n${formatDepartmentList(departments, 'fr', s.currency)}\n\n`
        : '') +
      `Envoyez votre nom complet bash tahجزou RDV. Commandes : MON RDV · CONFIRMER · ANNULER.`,
    booked: (_s, { name, day, queue, department, room }) =>
      `✅ RDV mriguel inchallah !\nPatient : ${name}\n` +
      (department ? `Service : ${department}${room ? ` (${room})` : ''}\n` : '') +
      `Jour : ${formatLong(day, 'fr')} — Tour N° ${queue}.\nRépondez OUI pour préparer votre fiche médicale.`,
    turnNow: (s, { name, queue }) =>
      `🔔 Salam ${name}, c'est votre tour maintenant (N° ${queue}) au ${s.clinic}, tfadhel(i) !`,
  },
};

/** @returns {string} localized template output */
function message(lang, key, settings, vars = {}) {
  if (settings && settings.darija) {
    const djDict = DARIJA_TEMPLATES[lang] || DARIJA_TEMPLATES.fr;
    if (djDict && djDict[key]) return djDict[key](settings, vars);
  }
  const dict = t[lang] || t.fr;
  const builder = dict[key] || t.fr[key];
  return builder(settings, vars);
}

module.exports = { message, templates: t, formatDuration, formatPatientsAhead, formatDepartmentList };
