'use strict';
/**
 * French / Arabic reply templates for the WhatsApp bot.
 *
 * Rules of thumb:
 *  - short, no emoji spam, no links (better deliverability);
 *  - always tell the patient what to type next;
 *  - Arabic templates are written in simple, clinic-friendly Arabic.
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

const t = {
  fr: {
    help: (s) =>
      `Bonjour et bienvenue au ${s.clinic}. 👋\n\n` +
      `Pour prendre un rendez-vous, envoyez simplement votre nom complet ` +
      `(prénom et nom).\n\n` +
      `Commandes :\n` +
      `• ANNULER — annuler votre rendez-vous\n` +
      `• MON RDV — consulter votre rendez-vous\n\n` +
      `Merci.`,
    askName: (s) =>
      `Bienvenue au ${s.clinic}. 🙏\nEnvoyez votre nom complet (prénom + nom) ` +
      `pour réserver le premier créneau disponible.`,
    booked: (s, { name, day, queue }) =>
      `✅ Rendez-vous confirmé\n\n` +
      `Patient : ${name}\n` +
      `Date : ${formatLong(day, 'fr')}\n` +
      `Numéro de passage : ${queue}\n\n` +
      `${s.clinic}\n` +
      `Pour annuler, envoyez : ANNULER`,
    alreadyBooked: (s, { day, queue }) =>
      `Vous avez déjà un rendez-vous le ${formatLong(day, 'fr')} ` +
      `(numéro ${queue}).\n\nPour l'annuler, envoyez : ANNULER`,
    myAppointment: (s, { day, queue, treatment, ahead, etaMinutes }) =>
      `📅 Votre rendez-vous\n\n` +
      `Date : ${formatLong(day, 'fr')}\n` +
      `Numéro de passage : ${queue}\n` +
      (treatment ? `Soin : ${treatment}\n` : '') +
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
    full: (s) =>
      `Le planning est complet pour le moment. 📋\n` +
      `Nous avons noté votre demande, le cabinet vous contactera dès qu'un créneau se libère.\n\n` +
      `${s.clinic}`,
    unsupported: () =>
      `Je comprends seulement les messages texte. 🙂\n` +
      `Envoyez votre nom complet pour réserver, ou écrivez AIDE.`,
    error: () =>
      `Désolé, une erreur est survenue. Merci de réessayer dans quelques instants.`,
    reminder: (s, { name, day, queue }) =>
      `🔔 Rappel de votre rendez-vous\n\n` +
      `Bonjour ${name}, nous vous attendons le ${formatLong(day, 'fr')}.\n` +
      `Numéro de passage : ${queue}\n\n` +
      `${s.clinic}` +
      (s.phone ? `\nTél : ${s.phone}` : '') +
      `\n\nPour annuler, envoyez : ANNULER`,
    turnNow: (s, { name, queue }) =>
      `🔔 C'est votre tour !\n\n` +
      `Bonjour ${name}, le patient précédent a terminé son soin.\n` +
      `C'est maintenant votre tour (numéro ${queue}) — merci de vous présenter au cabinet.\n\n` +
      `${s.clinic}` +
      (s.phone ? `\nTél : ${s.phone}` : ''),
    queueAhead: (s, { name, queue, ahead, etaMinutes }) =>
      `⏳ Mise à jour de votre passage\n\n` +
      `Bonjour ${name} (numéro ${queue}),\n` +
      `• Personnes restantes avant vous : ${formatPatientsAhead(ahead, 'fr')}\n` +
      `• Temps d'attente estimé : environ ${formatDuration(etaMinutes, 'fr')}\n\n` +
      `${s.clinic}\n` +
      `En cas d'empêchement, envoyez : ANNULER`,
    tooFast: () =>
      `Vous avez envoyé plusieurs messages. Merci de patienter quelques minutes. 🙏`,
    price: (s, { treatment, price }) =>
      `Le tarif de « ${treatment} » est de ${money(price, s.currency)}. ` +
      `Envoyez votre nom complet pour réserver.`,
  },

  ar: {
    help: (s) =>
      `مرحبا بكم في ${s.clinic}. 👋\n\n` +
      `لحجز موعد، أرسلوا اسمكم الكامل (الاسم واللقب).\n\n` +
      `الأوامر:\n` +
      `• إلغاء — لإلغاء الموعد\n` +
      `• موعدي — لمعرفة موعدكم\n\n` +
      `شكرا.`,
    askName: (s) =>
      `مرحبا بكم في ${s.clinic}. 🙏\nأرسلوا اسمكم الكامل (الاسم واللقب) ` +
      `لحجز أول موعد متاح.`,
    booked: (s, { name, day, queue }) =>
      `✅ تم تأكيد الموعد\n\n` +
      `المريض: ${name}\n` +
      `التاريخ: ${formatLong(day, 'ar')}\n` +
      `رقم الدور: ${queue}\n\n` +
      `${s.clinic}\n` +
      `للإلغاء أرسلوا: إلغاء`,
    alreadyBooked: (s, { day, queue }) =>
      `لديكم موعد مسبق يوم ${formatLong(day, 'ar')} (رقم ${queue}).\n\n` +
      `للإلغاء أرسلوا: إلغاء`,
    myAppointment: (s, { day, queue, treatment, ahead, etaMinutes }) =>
      `📅 موعدكم\n\n` +
      `التاريخ: ${formatLong(day, 'ar')}\n` +
      `رقم الدور: ${queue}\n` +
      (treatment ? `العلاج: ${treatment}\n` : '') +
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
    full: (s) =>
      `المواعيد ممتلئة حاليا. 📋\n` +
      `سجلنا طلبكم، وسيتصل بكم العيادة عند توفر موعد.\n\n${s.clinic}`,
    unsupported: () =>
      `أفهم الرسائل النصية فقط. 🙂\nأرسلوا اسمكم الكامل للحجز أو اكتبوا مساعدة.`,
    error: () => `عذرا، حدث خطأ. يرجى المحاولة بعد لحظات.`,
    reminder: (s, { name, day, queue }) =>
      `🔔 تذكير بموعدكم\n\n` +
      `مرحبا ${name}، موعدكم يوم ${formatLong(day, 'ar')}.\n` +
      `رقم الدور: ${queue}\n\n` +
      `${s.clinic}` +
      (s.phone ? `\nالهاتف: ${s.phone}` : '') +
      `\n\nللإلغاء أرسلوا: إلغاء`,
    turnNow: (s, { name, queue }) =>
      `🔔 حان دوركم الآن!\n\n` +
      `مرحبا ${name}، أنهى المريض السابق علاجه وحان دوركم للدخول (رقم الدور: ${queue}).\n` +
      `يرجى التفضل بالدخول إلى العيادة الآن.\n\n` +
      `${s.clinic}` +
      (s.phone ? `\nالهاتف: ${s.phone}` : ''),
    queueAhead: (s, { name, queue, ahead, etaMinutes }) =>
      `⏳ تنبيه بخصوص دوركم\n\n` +
      `مرحبا ${name} (رقم الدور: ${queue})،\n` +
      `• عدد المرضى المتبقين قبلكم: ${formatPatientsAhead(ahead, 'ar')}\n` +
      `• الوقت التقديري لانتظاركم: حوالي ${formatDuration(etaMinutes, 'ar')}\n\n` +
      `${s.clinic}\n` +
      `في حال تعذر الحضور أرسلوا: إلغاء`,
    tooFast: () => `أرسلتم عدة رسائل. يرجى الانتظار بضع دقائق. 🙏`,
    price: (s, { treatment, price }) =>
      `سعر «${treatment}» هو ${money(price, s.currency)}. ` +
      `أرسلوا اسمكم الكامل للحجز.`,
  },
};

/** @returns {string} localized template output */
function message(lang, key, settings, vars = {}) {
  const dict = t[lang] || t.fr;
  const builder = dict[key] || t.fr[key];
  return builder(settings, vars);
}

module.exports = { message, templates: t, formatDuration, formatPatientsAhead };
