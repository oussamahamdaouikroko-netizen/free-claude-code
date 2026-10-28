'use strict';
/**
 * French / Arabic / Darija reply templates for the DentaRDV WhatsApp bot.
 */

const { formatLong, formatFR } = require('../utils/dates');

const money = (value, currency = 'DZD') =>
  `${Number(value).toLocaleString('fr-DZ', { maximumFractionDigits: 2 })} ${currency}`;

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

function formatPlacesLeft(left, lang = 'fr') {
  const n = Math.max(0, Math.round(Number(left) || 0));
  if (lang === 'ar') {
    if (n === 1) return 'مكان واحد متاح (1)';
    if (n === 2) return 'مكانان متاحان (2)';
    if (n >= 3 && n <= 10) return `${n} أماكن متاحة`;
    return `${n} مكاناً متاحاً`;
  }
  return n === 1 ? '1 place disponible' : `${n} places disponibles`;
}

function formatAvailableDaysList(days = [], lang = 'fr') {
  return days
    .map(
      (d, idx) =>
        `${idx + 1}. 📅 ${formatLong(d.day, lang)} (${formatFR(d.day)}) — ${formatPlacesLeft(d.left, lang)}`,
    )
    .join('\n');
}

function formatHoursLine(s, lang = 'fr') {
  if (!s) return '';
  if (s.is24h) {
    return lang === 'ar'
      ? '🕒 أوقات العمل: مفتوحة 24/24 ساعة بدون توقف\n'
      : '🕒 Horaires : Ouvert 24h/24 sans interruption\n';
  }
  if (s.openHour && s.closeHour) {
    const endFmt = (hhmm) =>
      hhmm === '00:00' ? (lang === 'ar' ? '00:00 (12 ليلاً)' : '00:00 (minuit)') : hhmm;
    const shift1 = `${s.openHour} – ${endFmt(s.closeHour)}`;
    const shift2 =
      s.twoShifts && s.shift2OpenHour && s.shift2CloseHour
        ? lang === 'ar'
          ? ` | الفترة 2: ${s.shift2OpenHour} – ${endFmt(s.shift2CloseHour)}`
          : ` | 2e période : ${s.shift2OpenHour} – ${endFmt(s.shift2CloseHour)}`
        : '';
    const breakLine =
      s.breakEnabled && s.breakStart && s.breakEnd
        ? lang === 'ar'
          ? `\n☕ راحة الطبيب: ${s.breakStart} – ${s.breakEnd}`
          : `\n☕ Pause praticien : ${s.breakStart} – ${s.breakEnd}`
        : '';
    return lang === 'ar'
      ? `🕒 أوقات العمل: ${shift1}${shift2}${breakLine}\n`
      : `🕒 Horaires : ${shift1}${shift2}${breakLine}\n`;
  }
  return '';
}

function formatHolidayBanner(s, lang = 'fr') {
  const h = s?.holidayCtx?.holiday;
  if (!h) return '';
  if (lang === 'ar') {
    if (h.start_day === h.end_day) {
      return `🏖️ تنبيه: نعلمكم أن الطبيب في عطلة يوم ${formatLong(h.start_day, 'ar')} (${formatFR(h.start_day)}) — الحجز مغلق في هذا اليوم ومتاح في الأيام الموالية.\n\n`;
    }
    return `🏖️ تنبيه: نعلمكم أن الطبيب في عطلة من ${formatLong(h.start_day, 'ar')} إلى ${formatLong(h.end_day, 'ar')} — الحجز متاح بعد انتهاء العطلة.\n\n`;
  }
  if (h.start_day === h.end_day) {
    return `🏖️ Info : Nous vous informons que le praticien est en congé le ${formatLong(h.start_day, 'fr')} (${formatFR(h.start_day)}) — réservation fermée ce jour et ouverte sur les autres dates.\n\n`;
  }
  return `🏖️ Info : Nous vous informons que le praticien est en congé du ${formatLong(h.start_day, 'fr')} au ${formatLong(h.end_day, 'fr')} — réservation ouverte après cette période.\n\n`;
}

function formatUnavailableReason({ day, reason }, lang = 'fr') {
  const dateText = day ? `${formatLong(day, lang)} (${formatFR(day)})` : '';
  if (lang === 'ar') {
    switch (reason) {
      case 'holiday':
        return `🏖️ عذراً، نعلمكم أن الطبيب في عطلة يوم ${dateText}، لذلك لا يمكن الحجز في هذا التاريخ.`;
      case 'full':
        return `⚠️ عذراً، يوم ${dateText} ممتلئ بالكامل حسب الحجوزات الحالية.`;
      case 'closed':
        return `⚠️ عذراً، العيادة مغلقة يوم ${dateText} (خارج أيام العمل).`;
      case 'today_disabled':
        return `⚠️ عذراً، الحجز لنفس اليوم مغلق حالياً. يرجى اختيار أحد الأيام القادمة المتاحة.`;
      case 'past':
        return `⚠️ عذراً، التاريخ المدخل (${dateText || day}) قد مضى.`;
      case 'beyond_horizon':
        return `⚠️ عذراً، التاريخ ${dateText} يقع خارج فترة الحجز المتاحة حالياً.`;
      default:
        return `⚠️ التاريخ المدخل غير صالح. يرجى اختيار رقم من القائمة أو كتابة التاريخ بصيغة يوم/شهر (مثلاً: 05/11).`;
    }
  }
  switch (reason) {
    case 'holiday':
      return `🏖️ Désolé, nous vous informons que le praticien est en congé le ${dateText} (réservation indisponible à cette date).`;
    case 'full':
      return `⚠️ Désolé, la journée du ${dateText} est complète selon les réservations actuelles.`;
    case 'closed':
      return `⚠️ Désolé, le cabinet est fermé le ${dateText} (hors jours ouvrables).`;
    case 'today_disabled':
      return `⚠️ Désolé, la réservation pour le jour même est fermée. Veuillez choisir l'une des prochaines dates disponibles.`;
    case 'past':
      return `⚠️ Désolé, la date saisie (${dateText || day}) est déjà passée.`;
    case 'beyond_horizon':
      return `⚠️ Désolé, la date du ${dateText} dépasse la période d'ouverture de l'agenda.`;
    default:
      return `⚠️ Date non valide. Veuillez envoyer un numéro de la liste ou saisir une date au format JJ/MM (ex : 05/11).`;
  }
}

const t = {
  fr: {
    help: (s) =>
      formatHolidayBanner(s, 'fr') +
      `Bonjour et bienvenue au ${s.clinic}. 🦷👋\n` +
      (s.doctor ? `${s.doctor}${s.specialty ? ` — ${s.specialty}` : ''}\n` : '') +
      (s.address ? `📍 ${s.address}\n` : '') +
      formatHoursLine(s, 'fr') +
      `\nPour prendre un rendez-vous dentaire, envoyez simplement votre nom complet (prénom et nom).\n\n` +
      `Commandes :\n` +
      `• JOURS DISPONIBLES — consulter les dates libres\n` +
      `• MON RDV — consulter votre rendez-vous\n` +
      `• CONFIRMER — confirmer votre présence\n` +
      `• ANNULER — annuler votre rendez-vous\n\n` +
      `Merci.`,

    doctorOnLeave: (s, { holiday, resumeDay } = {}) =>
      `🏖️ Information — ${s.clinic}\n\n` +
      (holiday && holiday.start_day !== holiday.end_day
        ? `Nous vous informons que le praticien est actuellement en congé du ${formatLong(holiday.start_day, 'fr')} au ${formatLong(holiday.end_day, 'fr')}.\n`
        : holiday
          ? `Nous vous informons que le praticien est en congé le ${formatLong(holiday.start_day, 'fr')} (${formatFR(holiday.start_day)}).\n`
          : `Nous vous informons que le praticien est actuellement en congé.\n`) +
      (resumeDay
        ? `📅 Les consultations et réservations reprendront à partir du ${formatLong(resumeDay, 'fr')} (${formatFR(resumeDay)}).\n\n`
        : `\n`) +
      `Merci de votre compréhension 🙏`,

    chooseDay: (s, { name, days = [], hasMore = false }) =>
      formatHolidayBanner(s, 'fr') +
      `📅 Bonjour${name ? ` ${name}` : ''}, veuillez choisir le jour et la date de votre rendez-vous dentaire parmi les disponibilités :\n\n` +
      `${formatAvailableDaysList(days, 'fr')}\n\n` +
      `👉 Répondez par le numéro du jour souhaité (1 à ${days.length}) ou écrivez une date (ex : ${days[0] ? formatFR(days[0].day).slice(0, 5) : '05/11'}).` +
      (hasMore ? `\n🔄 Envoyez 0 ou PLUS pour afficher d'autres dates disponibles.` : ''),

    dayUnavailable: (_s, { day, reason, days = [], hasMore = false }) =>
      `${formatUnavailableReason({ day, reason }, 'fr')}\n\n` +
      `📅 Dates disponibles :\n` +
      `${formatAvailableDaysList(days, 'fr')}\n\n` +
      `👉 Répondez par un numéro entre 1 et ${days.length}` +
      (hasMore ? ` (ou 0 pour plus de dates).` : `.`),

    invalidDayChoice: (_s, { days = [], hasMore = false }) =>
      `Choix non reconnu 🙏\n` +
      `Merci d'envoyer un numéro entre 1 et ${days.length} (ou une date au format JJ/MM) pour choisir votre rendez-vous :\n\n` +
      `${formatAvailableDaysList(days, 'fr')}` +
      (hasMore ? `\n\n🔄 Envoyez 0 ou PLUS pour voir les dates suivantes.` : ''),

    availableDaysPreview: (s, { days = [] }) =>
      formatHolidayBanner(s, 'fr') +
      `📅 Prochaines dates disponibles au ${s.clinic} :\n` +
      (s?.is24h || s?.twoShifts || s?.breakEnabled ? formatHoursLine(s, 'fr') : '') +
      `\n${formatAvailableDaysList(days, 'fr')}\n\n` +
      `✍️ Pour réserver, envoyez d'abord votre nom complet (exemple : Oussama Hamdaoui).`,

    askName: (s) =>
      formatHolidayBanner(s, 'fr') +
      `Bienvenue au ${s.clinic}. 🙏\nEnvoyez votre nom complet (prénom + nom, ex : Oussama Hamdaoui) ` +
      `pour réserver le premier créneau disponible.`,

    welcomeAskName: (s) =>
      formatHolidayBanner(s, 'fr') +
      `Bienvenue au ${s.clinic} 🦷👋\n` +
      (s?.is24h || s?.twoShifts || s?.breakEnabled ? formatHoursLine(s, 'fr') : '') +
      `Veuillez entrer votre nom complet (exemple : Oussama Hamdaoui).`,

    invalidName: () =>
      `Le nom saisi n'est pas valide 🙏\n` +
      `Veuillez entrer votre nom complet en lettres uniquement, sans chiffres ni symboles (exemple : Oussama Hamdaoui).`,

    nonTextAskName: () =>
      `Je comprends uniquement les messages texte 🙂\n` +
      `Veuillez envoyer votre nom complet par écrit (exemple : Oussama Hamdaoui).`,

    booked: (s, { name, day, queue, doctor }) =>
      `✅ Rendez-vous confirmé\n\n` +
      `Patient : ${name}\n` +
      (doctor ? `Chirurgien-Dentiste : ${doctor}\n` : '') +
      `Date : ${formatLong(day, 'fr')}\n` +
      `Numéro de passage : ${queue}\n` +
      `\n${s.clinic}` +
      (s.address ? `\n📍 ${s.address}` : '') +
      (s?.is24h || s?.twoShifts || s?.breakEnabled ? `\n${formatHoursLine(s, 'fr').trim()}` : '') +
      `\nPour annuler, envoyez : ANNULER\n\n` +
      `📋 Pour préparer votre soin dentaire (âge, poids et symptômes éventuels) :\n` +
      `🔒 Données locales strictement confidentielles au cabinet (Loi 18-07).\n` +
      `Répondez OUI (ou envoyez directement votre âge, ex : 32 ans) — ou NON pour ignorer.`,

    alreadyBooked: (_s, { day, queue }) =>
      `Vous avez déjà un rendez-vous le ${formatLong(day, 'fr')} (numéro ${queue}).\n\nPour l'annuler, envoyez : ANNULER`,

    myAppointment: (_s, { day, queue, treatment, ahead, etaMinutes }) =>
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

    cancelConfirm: (_s, { day, slotTime, queue, cooldownMinutes = 30 }) =>
      `⚠️ Êtes-vous sûr de vouloir annuler votre rendez-vous dentaire du ${formatLong(day, 'fr')}` +
      (slotTime ? ` à ${slotTime}` : queue ? ` (tour n° ${queue})` : '') +
      ` ?\n` +
      `Attention : après annulation, vous ne pourrez réserver un nouveau rendez-vous qu'après ${cooldownMinutes} minutes.\n\n` +
      `• ✅ Oui, annuler le rendez-vous (répondez OUI)\n` +
      `• ❌ Non, garder le rendez-vous (répondez NON)`,

    cancelAborted: () => `Votre rendez-vous est maintenu.`,
    cancelStale: () => `Ce rendez-vous n'existe plus ou a déjà été annulé.`,
    cancelForbidden: () => `Action refusée : ce rendez-vous ne vous appartient pas.`,

    bookingCooldown: (_s, { minutes, time }) =>
      `⏳ Vous ne pouvez pas réserver un nouveau rendez-vous maintenant. Vous pourrez réessayer dans ${minutes} minute${minutes > 1 ? 's' : ''} (à ${time}).`,

    serviceSuspended: () =>
      `Le service de réservation est temporairement suspendu, veuillez contacter le cabinet.`,

    cancelled: (_s, { day, rebookTime, cooldownMinutes }) =>
      `✅ Votre rendez-vous du ${formatLong(day, 'fr')} a bien été annulé.\n` +
      (rebookTime
        ? `⏳ Vous pourrez réserver un nouveau rendez-vous dans ${cooldownMinutes || 30} minutes (à partir de ${rebookTime}).`
        : `Envoyez votre nom complet si vous souhaitez reprendre un rendez-vous.`),

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
      (s.address ? `\n📍 ${s.address}` : '') +
      (s.phone ? `\nTél : ${s.phone}` : '') +
      `\n\nPour confirmer : CONFIRMER · Pour annuler : ANNULER`,

    turnNow: (s, { name, queue }) =>
      `🔔 C'est votre tour !\n\n` +
      `Bonjour ${name}, le patient précédent a terminé son soin.\n` +
      `C'est maintenant votre tour (numéro ${queue}) — merci de vous présenter au cabinet.\n\n` +
      `${s.clinic}` +
      (s.phone ? `\nTél : ${s.phone}` : ''),

    queueAhead: (s, { name, queue, ahead, etaMinutes }) =>
      (Number(ahead) <= 2
        ? `⏳ Votre tour approche au cabinet dentaire !\n\n` +
          `Bonjour ${name} (numéro ${queue}),\n` +
          `• Votre passage est proche — il reste avant vous : ${formatPatientsAhead(ahead, 'fr')}\n` +
          `• Temps d'attente estimé : environ ${formatDuration(etaMinutes, 'fr')}\n\n` +
          `Merci de vous préparer à vous présenter au ${s.clinic}.\n` +
          `En cas d'empêchement, envoyez : ANNULER`
        : `⏳ Mise à jour de votre passage\n\n` +
          `Bonjour ${name} (numéro ${queue}),\n` +
          `• Personnes restantes avant vous : ${formatPatientsAhead(ahead, 'fr')}\n` +
          `• Temps d'attente estimé : environ ${formatDuration(etaMinutes, 'fr')}\n\n` +
          `${s.clinic}\n` +
          `En cas d'empêchement, envoyez : ANNULER`),

    tooFast: () =>
      `Vous avez envoyé plusieurs messages. Merci de patienter quelques minutes. 🙏`,

    price: (s, { treatment, price }) =>
      `Le tarif de « ${treatment} » est de ${money(price, s.currency)}. ` +
      `Envoyez votre nom complet pour réserver.`,

    intakeInvite: (s) =>
      `📋 Informations rapides pour le chirurgien-dentiste — ${s.clinic}\n` +
      `🔒 Conformément à la Loi 18-07, vos réponses (âge, poids et motif dentaire éventuel) restent uniquement au cabinet.\n` +
      `Répondez OUI (ou envoyez directement votre âge, ex : 32 ans) — ou NON pour ignorer.`,

    intakeDeclined: () =>
      `C'est noté, votre rendez-vous reste bien confirmé. À bientôt au cabinet ! 🙏`,

    intakeAskAge: (_s, { isChild } = {}) =>
      isChild
        ? `1️⃣ Quel est l'âge de l'enfant ? (ex : 6 ans ou 24 mois — envoyez 0 pour passer)`
        : `1️⃣ Quel est l'âge du patient ? (ex : 32 ans — envoyez 0 pour passer)`,

    intakeRetryAge: () =>
      `Âge non reconnu. Merci d'indiquer l'âge en années ou en mois (ex : 32 ou 24 mois), ou envoyez 0 pour passer.`,

    intakeAskWeight: (_s, { isChild } = {}) =>
      isChild
        ? `2️⃣ Quel est le poids de l'enfant en kg ? (ex : 18 kg — envoyez 0 pour passer)`
        : `2️⃣ Quel est votre poids approximatif en kg ? (ex : 72 ou 72,5 — envoyez 0 pour passer)`,

    intakeRetryWeight: () =>
      `Poids non reconnu. Merci d'envoyer un nombre entre 0,3 et 400 kg (ex : 72 ou 18,5), ou envoyez 0 pour passer.`,

    intakeAskComplaint: (_s, { isChild } = {}) =>
      isChild
        ? `3️⃣ Souhaitez-vous préciser brièvement le motif dentaire de l'enfant (douleur, abcès, carie...) ? (optionnel — envoyez 0 ou NON pour terminer) :`
        : `3️⃣ Souhaitez-vous préciser brièvement vos symptômes dentaires (douleur, gonflement, dent de sagesse...) ? (optionnel — envoyez 0 ou NON pour terminer) :`,

    intakeCompleted: (_s, { draft } = {}) => {
      const details = [];
      if (draft?.age_years !== null && draft?.age_years !== undefined) {
        details.push(
          draft.age_years < 2
            ? `Âge : ${Math.round(draft.age_years * 12)} mois`
            : `Âge : ${Math.round(draft.age_years * 10) / 10} ans`,
        );
      }
      if (draft?.weight_kg) details.push(`Poids : ${draft.weight_kg} kg`);
      if (draft?.chief_complaint) details.push(`Motif : ${draft.chief_complaint}`);
      return (
        `✅ Merci ! Vos informations ont été enregistrées pour faciliter l'examen du chirurgien-dentiste` +
        (details.length ? ` (${details.join(' · ')})` : '') +
        `.`
      );
    },
  },

  ar: {
    help: (s) =>
      formatHolidayBanner(s, 'ar') +
      `مرحبا بكم في ${s.clinic}. 🦷👋\n` +
      (s.doctor ? `${s.doctor}${s.specialty ? ` — ${s.specialty}` : ''}\n` : '') +
      (s.address ? `📍 ${s.address}\n` : '') +
      formatHoursLine(s, 'ar') +
      `\nلحجز موعد لطب الأسنان، أرسلوا اسمكم الكامل (الاسم واللقب).\n\n` +
      `الأوامر:\n` +
      `• الأيام المتاحة — لعرض التواريخ المتوفرة للحجز\n` +
      `• موعدي — لمعرفة موعدكم\n` +
      `• تأكيد — لتأكيد الحضور\n` +
      `• إلغاء — لإلغاء الموعد\n\n` +
      `شكرا.`,

    doctorOnLeave: (s, { holiday, resumeDay } = {}) =>
      `🏖️ إشعار من ${s.clinic}\n\n` +
      (holiday && holiday.start_day !== holiday.end_day
        ? `نعلمكم أن الطبيب في عطلة حالياً من ${formatLong(holiday.start_day, 'ar')} إلى غاية ${formatLong(holiday.end_day, 'ar')}.\n`
        : holiday
          ? `نعلمكم أن الطبيب في عطلة يوم ${formatLong(holiday.start_day, 'ar')} (${formatFR(holiday.start_day)}).\n`
          : `نعلمكم أن الطبيب في عطلة حالياً.\n`) +
      (resumeDay
        ? `📅 سيُستأنف العمل واستقبال الحجوزات ابتداءً من يوم ${formatLong(resumeDay, 'ar')} (${formatFR(resumeDay)}) إن شاء الله.\n\n`
        : `\n`) +
      `شكراً لتفهمكم ونتمنى لكم دوام الصحة والعافية 🙏`,

    chooseDay: (s, { name, days = [], hasMore = false }) =>
      formatHolidayBanner(s, 'ar') +
      `📅 مرحبا${name ? ` ${name}` : ''}، يرجى اختيار اليوم والتاريخ المناسب لحجز موعدكم من بين الأيام المتاحة:\n\n` +
      `${formatAvailableDaysList(days, 'ar')}\n\n` +
      `👉 أرسلوا رقم اليوم المطلوب (من 1 إلى ${days.length}) أو اكتبوا التاريخ (مثلاً: ${days[0] ? formatFR(days[0].day).slice(0, 5) : '05/11'}).` +
      (hasMore ? `\n🔄 أرسلوا 0 أو المزيد لعرض أيام وتواريخ أخرى متاحة.` : ''),

    dayUnavailable: (_s, { day, reason, days = [], hasMore = false }) =>
      `${formatUnavailableReason({ day, reason }, 'ar')}\n\n` +
      `📅 الأيام المتاحة حالياً:\n` +
      `${formatAvailableDaysList(days, 'ar')}\n\n` +
      `👉 يرجى إرسال رقم بين 1 و ${days.length}` +
      (hasMore ? ` (أو 0 لعرض المزيد من التواريخ).` : `.`),

    invalidDayChoice: (_s, { days = [], hasMore = false }) =>
      `عذراً، الاختيار غير معروف 🙏\n` +
      `يرجى إرسال رقم بين 1 و ${days.length} (أو كتابة التاريخ بصيغة يوم/شهر) لاختيار موعدكم:\n\n` +
      `${formatAvailableDaysList(days, 'ar')}` +
      (hasMore ? `\n\n🔄 أرسلوا 0 أو المزيد لعرض التواريخ التالية.` : ''),

    availableDaysPreview: (s, { days = [] }) =>
      formatHolidayBanner(s, 'ar') +
      `📅 الأيام والتواريخ المتاحة حالياً في ${s.clinic}:\n` +
      (s?.is24h || s?.twoShifts || s?.breakEnabled ? formatHoursLine(s, 'ar') : '') +
      `\n${formatAvailableDaysList(days, 'ar')}\n\n` +
      `✍️ للحجز، أرسلوا أولاً اسمكم الكامل (مثال: أسامة حمداوي).`,

    askName: (s) =>
      formatHolidayBanner(s, 'ar') +
      `مرحبا بكم في ${s.clinic}. 🙏\nأرسلوا اسمكم الكامل (الاسم واللقب، مثال: أسامة حمداوي) ` +
      `لحجز أول موعد متاح.`,

    welcomeAskName: (s) =>
      formatHolidayBanner(s, 'ar') +
      `أهلاً بك في ${s.clinic} 🦷👋\n` +
      (s?.is24h || s?.twoShifts || s?.breakEnabled ? formatHoursLine(s, 'ar') : '') +
      `من فضلك أدخل اسمك الكامل (مثال: أسامة حمداوي).`,

    invalidName: () =>
      `عذراً، الاسم المدخل غير صالح 🙏\n` +
      `من فضلك أدخل اسمك الكامل بالحروف فقط دون أرقام أو رموز (مثال: أسامة حمداوي).`,

    nonTextAskName: () =>
      `عذراً، أستقبل الرسائل النصية فقط 🙂\n` +
      `من فضلك أرسل اسمك الكامل نصاً (مثال: أسامة حمداوي).`,

    booked: (s, { name, day, queue, doctor }) =>
      `✅ تم تأكيد الموعد\n\n` +
      `المريض: ${name}\n` +
      (doctor ? `جراح الأسنان: ${doctor}\n` : '') +
      `التاريخ: ${formatLong(day, 'ar')}\n` +
      `رقم الدور: ${queue}\n` +
      `\n${s.clinic}` +
      (s.address ? `\n📍 ${s.address}` : '') +
      (s?.is24h || s?.twoShifts || s?.breakEnabled ? `\n${formatHoursLine(s, 'ar').trim()}` : '') +
      `\nللإلغاء أرسلوا: إلغاء\n\n` +
      `📋 لتسهيل الفحص على طبيب الأسنان (العمر، الوزن، وبعض الأعراض إن أردتم):\n` +
      `🔒 معلوماتكم تبقى سرية داخل العيادة طبقا للقانون 18-07.\n` +
      `أرسلوا نعم (أو أرسلوا عمركم مباشرة، مثلا: 32 سنة) — أو لا للتجاوز.`,

    alreadyBooked: (_s, { day, queue }) =>
      `لديكم موعد مسبق يوم ${formatLong(day, 'ar')} (رقم ${queue}).\n\n` +
      `للإلغاء أرسلوا: إلغاء`,

    myAppointment: (_s, { day, queue, treatment, ahead, etaMinutes }) =>
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

    cancelConfirm: (_s, { day, slotTime, queue, cooldownMinutes = 30 }) =>
      `⚠️ هل أنت متأكد من إلغاء موعدك يوم ${formatLong(day, 'ar')}` +
      (slotTime ? ` على الساعة ${slotTime}` : queue ? ` (رقم الدور ${queue})` : '') +
      `؟\n` +
      `تنبيه: بعد الإلغاء لن تتمكن من حجز موعد جديد إلا بعد ${cooldownMinutes} دقيقة.\n\n` +
      `• ✅ نعم، ألغِ الموعد (أرسل: نعم)\n` +
      `• ❌ لا، احتفظ بالموعد (أرسل: لا)`,

    cancelAborted: () => `تم الاحتفاظ بموعدك.`,
    cancelStale: () => `هذا الموعد لم يعد قائماً.`,
    cancelForbidden: () => `عذراً، لا تملكون صلاحية إلغاء هذا الموعد.`,

    bookingCooldown: (_s, { minutes, time }) =>
      `⏳ لا يمكنك حجز موعد جديد الآن. يمكنك المحاولة بعد ${minutes} دقيقة (الساعة ${time}).`,

    serviceSuspended: () =>
      `الخدمة متوقفة مؤقتاً، يرجى التواصل مع العيادة.`,

    cancelled: (_s, { day, rebookTime, cooldownMinutes }) =>
      `✅ تم إلغاء موعدكم يوم ${formatLong(day, 'ar')}.\n` +
      (rebookTime
        ? `⏳ يمكنكم حجز موعد جديد بعد ${cooldownMinutes || 30} دقيقة (ابتداءً من الساعة ${rebookTime}).`
        : `أرسلوا اسمكم الكامل إذا أردتم حجز موعد جديد.`),

    nothingToCancel: () => `ليس لديكم أي موعد لإلغائه.`,

    full: (s) =>
      `المواعيد ممتلئة حاليا. 📋\n` +
      `سجلنا طلبكم، وستتصل بكم العيادة عند توفر موعد.\n\n${s.clinic}`,

    unsupported: () =>
      `أفهم الرسائل النصية فقط. 🙂\nأرسلوا اسمكم الكامل للحجز أو اكتبوا مساعدة.`,

    error: () => `عذرا، حدث خطأ. يرجى المحاولة بعد لحظات.`,

    reminder: (s, { name, day, queue }) =>
      `🔔 تذكير بموعدكم\n\n` +
      `مرحبا ${name}، موعدكم يوم ${formatLong(day, 'ar')}.\n` +
      `رقم الدور: ${queue}\n\n` +
      `${s.clinic}` +
      (s.address ? `\n📍 ${s.address}` : '') +
      (s.phone ? `\nالهاتف: ${s.phone}` : '') +
      `\n\nللتأكيد أرسلوا: تأكيد · للإلغاء أرسلوا: إلغاء`,

    turnNow: (s, { name, queue }) =>
      `🔔 حان دوركم الآن!\n\n` +
      `مرحبا ${name}، أنهى المريض السابق علاجه وحان دوركم للدخول (رقم الدور: ${queue}).\n` +
      `يرجى التفضل بالدخول إلى عيادة الأسنان الآن.\n\n` +
      `${s.clinic}` +
      (s.phone ? `\nالهاتف: ${s.phone}` : ''),

    queueAhead: (s, { name, queue, ahead, etaMinutes }) =>
      (Number(ahead) <= 2
        ? `⏳ اقترب دوركم في عيادة الأسنان!\n\n` +
          `مرحبا ${name} (رقم الدور: ${queue})،\n` +
          `• اقترب موعد دخولكم — بقي أمامكم: ${formatPatientsAhead(ahead, 'ar')}\n` +
          `• الوقت التقديري المتبقي: حوالي ${formatDuration(etaMinutes, 'ar')}\n\n` +
          `يرجى الاستعداد والتوجه إلى ${s.clinic}.\n` +
          `في حال تعذر الحضور أرسلوا: إلغاء`
        : `⏳ تنبيه بخصوص دوركم\n\n` +
          `مرحبا ${name} (رقم الدور: ${queue})،\n` +
          `• عدد المرضى المتبقين أمامكم: ${formatPatientsAhead(ahead, 'ar')}\n` +
          `• الوقت التقديري لانتظاركم: حوالي ${formatDuration(etaMinutes, 'ar')}\n\n` +
          `${s.clinic}\n` +
          `في حال تعذر الحضور أرسلوا: إلغاء`),

    tooFast: () => `أرسلتم عدة رسائل. يرجى الانتظار بضع دقائق. 🙏`,

    price: (s, { treatment, price }) =>
      `سعر «${treatment}» هو ${money(price, s.currency)}. ` +
      `أرسلوا اسمكم الكامل للحجز.`,

    intakeInvite: (s) =>
      `📋 معلومات سريعة لطبيب الأسنان — ${s.clinic}\n` +
      `🔒 طبقا للقانون 18-07، تُحفظ إجاباتكم (العمر، الوزن، وبعض الأعراض إن وجدت) محليا وبسرية داخل العيادة فقط.\n` +
      `أرسلوا نعم (أو أرسلوا عمركم مباشرة، مثلا: 32 سنة) — أو لا للتجاوز.`,

    intakeDeclined: () =>
      `تم تسجيل ذلك، موعدكم يبقى مؤكدا. مرحبا بكم في العيادة! 🙏`,

    intakeAskAge: (_s, { isChild } = {}) =>
      isChild
        ? `1️⃣ كم عمر الطفل؟ (مثال: 6 سنوات أو 24 شهر — أو أرسلوا 0 للتخطي)`
        : `1️⃣ ما هو عمر المريض؟ (مثال: 32 سنة — أو أرسلوا 0 للتخطي)`,

    intakeRetryAge: () =>
      `لم نتعرف على العمر. يرجى إرسال العمر بالسنوات أو الأشهر (مثال: 32 أو 24 شهر)، أو أرسلوا 0 للتخطي.`,

    intakeAskWeight: (_s, { isChild } = {}) =>
      isChild
        ? `2️⃣ ما هو وزن الطفل بالكيلوغرام؟ (مثال: 18 كغ — أو أرسلوا 0 للتخطي)`
        : `2️⃣ ما هو وزنكم التقريبي بالكيلوغرام؟ (مثال: 72 أو 72.5 — أو أرسلوا 0 للتخطي)`,

    intakeRetryWeight: () =>
      `لم نتعرف على الوزن. يرجى إرسال رقم بين 0.3 و 400 كغ (مثال: 72 أو 18.5)، أو أرسلوا 0 للتخطي.`,

    intakeAskComplaint: (_s, { isChild } = {}) =>
      isChild
        ? `3️⃣ إذا أردتم إخبار طبيب الأسنان ببعض الأعراض (ألم سن، انتفاخ، تسوس...) اكتبوها باختصار (اختياري — أرسلوا 0 أو لا للإنهاء):`
        : `3️⃣ إذا أردتم إخبار طبيب الأسنان ببعض الأعراض باختصار (ألم ضرس، انتفاخ اللثة، ضرس العقل...) اكتبوها الآن (اختياري — أرسلوا 0 أو لا للإنهاء):`,

    intakeCompleted: (_s, { draft } = {}) => {
      const details = [];
      if (draft?.age_years !== null && draft?.age_years !== undefined) {
        details.push(
          draft.age_years < 2
            ? `العمر: ${Math.round(draft.age_years * 12)} شهر`
            : `العمر: ${Math.round(draft.age_years * 10) / 10} سنة`,
        );
      }
      if (draft?.weight_kg) details.push(`الوزن: ${draft.weight_kg} كغ`);
      if (draft?.chief_complaint) details.push(`الأعراض: ${draft.chief_complaint}`);
      return (
        `✅ شكرا لكم! تم تسجيل المعلومات لتسهيل الفحص على طبيب الأسنان` +
        (details.length ? ` (${details.join(' · ')})` : '') +
        `.`
      );
    },
  },
};

const DARIJA_TEMPLATES = {
  ar: {
    help: (s) =>
      formatHolidayBanner(s, 'ar') +
      `سلام ومرحبا بيكم في ${s.clinic} 🦷👋\n` +
      (s.doctor ? `${s.doctor}${s.specialty ? ` — ${s.specialty}` : ''}\n` : '') +
      (s.address ? `📍 ${s.address}\n` : '') +
      formatHoursLine(s, 'ar') +
      `\nباش تحجز موعد عند طبيب الأسنان، ابعث برك الاسم واللقب تاعك كاملين.\n\n` +
      `الأوامر:\n• الأيام المتاحة — باش تشوف النهارات الفارغة\n• موعدي — لمعرفة نهار ونيميرو الدور تاعك\n• تأكيد — لتأكيد الحضور\n• إلغاء — لإلغاء الموعد`,
    doctorOnLeave: (s, { holiday, resumeDay } = {}) =>
      `🏖️ إعلام من ${s.clinic}\n\n` +
      (holiday && holiday.start_day !== holiday.end_day
        ? `نعلموكم بلي الطبيب راهو في عطلة من ${formatLong(holiday.start_day, 'ar')} حتى لـ ${formatLong(holiday.end_day, 'ar')}.\n`
        : holiday
          ? `نعلموكم بلي الطبيب راهو في عطلة نهار ${formatLong(holiday.start_day, 'ar')} (${formatFR(holiday.start_day)}).\n`
          : `نعلموكم بلي الطبيب راهو في عطلة حالياً.\n`) +
      (resumeDay
        ? `📅 الخدمة والحجز يرجعو ابتداءً من نهار ${formatLong(resumeDay, 'ar')} (${formatFR(resumeDay)}) إن شاء الله.\n`
        : '') +
      `بارك الله فيكم على التفهم 🙏`,
    chooseDay: (s, { name, days = [], hasMore = false }) =>
      formatHolidayBanner(s, 'ar') +
      `📅 مرحبا${name ? ` ${name}` : ''}، خيّر النهار والتاريخ اللي يساعدك من القائمة:\n\n` +
      `${formatAvailableDaysList(days, 'ar')}\n\n` +
      `👉 ابعث نيميرو النهار (من 1 إلى ${days.length}) ولا اكتب التاريخ (مثلا: ${days[0] ? formatFR(days[0].day).slice(0, 5) : '05/11'}).` +
      (hasMore ? `\n🔄 ابعث 0 ولا المزيد باش تشوف نهارات خرين.` : ''),
    booked: (_s, { name, day, queue }) =>
      `✅ تم تأكيد الموعد تاعك بالصحة والعافية\n\n` +
      `المريض(ة): ${name}\n` +
      `النهار: ${formatLong(day, 'ar')}\n` +
      `نيميرو الدور: ${queue}\n` +
      `\nلتسهيل الفحص على طبيب الأسنان (القانون 18-07): ابعث نعم ولا ابعث العمر تاعك مباشرة (مثلا: 32) باش تسجل العمر والوزن.`,
    turnNow: (s, { name, queue }) =>
      `🔔 خويا/ختي ${name}، لحق الدور تاعك درك (النيميرو ${queue}) في ${s.clinic}. تفضل(ي) للداخل.`,
    queueAhead: (s, { name, queue, ahead, etaMinutes }) =>
      `⏳ سلام ${name} (النيميرو ${queue})، قرب الدور تاعك! بقي أمامك ${formatPatientsAhead(ahead, 'ar')} (حوالي ${formatDuration(etaMinutes, 'ar')}) في ${s.clinic}.\nإيلا ما تقدرش تجي ابعث: إلغاء`,
  },
  fr: {
    help: (s) =>
      formatHolidayBanner(s, 'fr') +
      `Salam et marhba bikoum au ${s.clinic} 🦷👋\n` +
      formatHoursLine(s, 'fr') +
      `Envoyez votre nom complet (prénom + nom) pour réserver votre RDV dentaire.\n` +
      `Commandes : JOURS DISPONIBLES · MON RDV · CONFIRMER · ANNULER.`,
    doctorOnLeave: (s, { holiday, resumeDay } = {}) =>
      `🏖️ Info ${s.clinic} : Le docteur est en congé` +
      (holiday && holiday.start_day !== holiday.end_day
        ? ` du ${formatLong(holiday.start_day, 'fr')} au ${formatLong(holiday.end_day, 'fr')}.`
        : holiday
          ? ` le ${formatLong(holiday.start_day, 'fr')}.`
          : `.`) +
      (resumeDay
        ? `\n📅 Reprise des RDV à partir du ${formatLong(resumeDay, 'fr')} (${formatFR(resumeDay)}) inchallah. Baraka Allahou fikoum 🙏`
        : `\nBaraka Allahou fikoum 🙏`),
    booked: (_s, { name, day, queue }) =>
      `✅ Rendez-vous confirmé (RDV mriguel inchallah) !\nPatient : ${name}\n` +
      `Jour : ${formatLong(day, 'fr')} — Numéro de passage : ${queue}.\n` +
      `Répondez OUI (ou votre âge) pour indiquer âge et poids au chirurgien-dentiste (Loi 18-07).`,
    turnNow: (s, { name, queue }) =>
      `🔔 Salam ${name}, c'est votre tour maintenant (N° ${queue}) au ${s.clinic}, tfadhel(i) !`,
    queueAhead: (s, { name, queue, ahead, etaMinutes }) =>
      `⏳ Salam ${name} (N° ${queue}), votre tour approche ! Il reste ${formatPatientsAhead(ahead, 'fr')} avant vous (~${formatDuration(etaMinutes, 'fr')}) au ${s.clinic}.\nEn cas d'empêchement, envoyez : ANNULER`,
  },
};

function message(lang, key, settings, vars = {}) {
  if (settings && settings.darija) {
    const djDict = DARIJA_TEMPLATES[lang] || DARIJA_TEMPLATES.fr;
    if (djDict && djDict[key]) return djDict[key](settings, vars);
  }
  const dict = t[lang] || t.fr;
  const builder = dict[key] || t.fr[key];
  return builder(settings, vars);
}

module.exports = { message, templates: t, formatDuration, formatPatientsAhead };
