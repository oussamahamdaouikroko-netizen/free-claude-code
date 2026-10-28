'use strict';
/**
 * French / Arabic reply templates for the MediRDV WhatsApp bot.
 *
 * Supports both solo specialist cabinets and multi-department polyclinics
 * (numbered department menu + department-specific doctor, room & instructions).
 */

const { formatLong, formatFR } = require('../utils/dates');

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
    .map((d, idx) => {
      const slotPart = d.nextSlotTime ? ` · ⏰ ${d.nextSlotTime}` : '';
      return (
        `${idx + 1}. 📅 ${formatLong(d.day, lang)} (${formatFR(d.day)}) — ` +
        `${formatPlacesLeft(d.left, lang)}${slotPart}`
      );
    })
    .join('\n');
}

function formatHoursBlock(s, lang = 'fr') {
  if (!s) return '';
  if (s.is24h) {
    return lang === 'ar'
      ? `🕒 أوقات العمل: 24/24 ساعة بدون توقف\n`
      : `🕒 Horaires : Ouvert 24h/24 sans interruption\n`;
  }
  const schedText = lang === 'ar' ? s.scheduleTextAr : s.scheduleTextFr;
  const breakText = lang === 'ar' ? s.breakTextAr : s.breakTextFr;
  if (!schedText) return '';
  return lang === 'ar'
    ? `🕒 أوقات العمل: ${schedText}${breakText ? ` (☕ ${breakText})` : ''}\n`
    : `🕒 Horaires : ${schedText}${breakText ? ` (☕ ${breakText})` : ''}\n`;
}

function formatHolidayBanner(s, lang = 'fr') {
  const h = s?.holidayCtx?.holiday;
  if (!h) return '';
  const single = h.start_day === h.end_day;
  const resume = s?.holidayCtx?.resumeDay;
  if (lang === 'ar') {
    const period = single
      ? `يوم ${formatLong(h.start_day, 'ar')} (${formatFR(h.start_day)})`
      : `من ${formatLong(h.start_day, 'ar')} إلى ${formatLong(h.end_day, 'ar')}`;
    const resumeText = resume ? ` — يستأنف العمل يوم ${formatLong(resume, 'ar')}` : '';
    return `🏖️ تنبيه: الطبيب في عطلة ${period}${resumeText}.\n\n`;
  }
  const period = single
    ? `le ${formatLong(h.start_day, 'fr')} (${formatFR(h.start_day)})`
    : `du ${formatLong(h.start_day, 'fr')} au ${formatLong(h.end_day, 'fr')}`;
  const resumeText = resume ? ` — reprise le ${formatLong(resume, 'fr')}` : '';
  return `🏖️ Info : Le médecin est en congé ${period}${resumeText}.\n\n`;
}

function formatUnavailableReason({ day, reason, closureLabel }, lang = 'fr') {
  const dateText = day ? `${formatLong(day, lang)} (${formatFR(day)})` : '';
  if (lang === 'ar') {
    switch (reason) {
      case 'holiday':
        return `🏖️ عذراً، الطبيب في عطلة يوم ${dateText}، لذلك لا يمكن الحجز في هذا التاريخ.`;
      case 'full':
        return `⚠️ عذراً، يوم ${dateText} ممتلئ بالكامل حسب الحجوزات الحالية.`;
      case 'closed':
        return (
          `⚠️ عذراً، العيادة مغلقة يوم ${dateText}` +
          (closureLabel ? ` (${closureLabel})` : ' (خارج أيام العمل)') +
          `.`
        );
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
      return `🏖️ Désolé, le médecin est en congé le ${dateText}. Aucune réservation n'est possible à cette date.`;
    case 'full':
      return `⚠️ Désolé, la journée du ${dateText} est complète selon les réservations actuelles.`;
    case 'closed':
      return (
        `⚠️ Désolé, le cabinet est fermé le ${dateText}` +
        (closureLabel ? ` (${closureLabel})` : ' (hors jours ouvrables)') +
        `.`
      );
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
    help: (s, { departments } = {}) =>
      formatHolidayBanner(s, 'fr') +
      `Bonjour et bienvenue au ${s.clinic}. 👋\n` +
      (s.doctor ? `${s.doctor}${s.specialty ? ` — ${s.specialty}` : ''}\n` : '') +
      (s.address ? `📍 ${s.address}\n` : '') +
      formatHoursBlock(s, 'fr') +
      `\n` +
      (Array.isArray(departments) && departments.length >= 2
        ? `Services disponibles :\n${formatDepartmentList(departments, 'fr', s.currency)}\n\n` +
          `Pour prendre un rendez-vous, envoyez votre nom complet (ou le numéro du service).\n\n`
        : `Pour prendre un rendez-vous, envoyez simplement votre nom complet (prénom et nom).\n\n`) +
      `Commandes :\n` +
      `• JOURS DISPONIBLES — consulter les dates libres\n` +
      `• MON RDV — consulter votre rendez-vous\n` +
      `• ANNULER — annuler votre rendez-vous\n\n` +
      `Merci.`,

    doctorOnLeave: (s, { holiday, resumeDay, department } = {}) =>
      `🏖️ Information — ${s.clinic}${department ? ` (${department})` : ''}\n\n` +
      (holiday && holiday.start_day !== holiday.end_day
        ? `Nous vous informons que le médecin est actuellement en congé du ${formatLong(holiday.start_day, 'fr')} au ${formatLong(holiday.end_day, 'fr')}.\n`
        : holiday
          ? `Nous vous informons que le médecin est en congé le ${formatLong(holiday.start_day, 'fr')} (${formatFR(holiday.start_day)}).\n`
          : `Nous vous informons que le médecin est actuellement en congé.\n`) +
      (resumeDay
        ? `📅 Les consultations et réservations reprendront à partir du ${formatLong(resumeDay, 'fr')} (${formatFR(resumeDay)}).\n\n`
        : `\n`) +
      `Merci de votre compréhension 🙏`,

    askName: (s) =>
      formatHolidayBanner(s, 'fr') +
      `Bienvenue au ${s.clinic}. 🙏\nEnvoyez votre nom complet (prénom + nom, ex : Oussama Hamdaoui) ` +
      `pour réserver le premier créneau disponible.`,

    welcomeAskName: (s) =>
      formatHolidayBanner(s, 'fr') +
      `Bienvenue au ${s.clinic} 👋\n` +
      formatHoursBlock(s, 'fr') +
      `Veuillez entrer votre nom complet (exemple : Oussama Hamdaoui).`,

    invalidName: () =>
      `Le nom saisi n'est pas valide 🙏\n` +
      `Veuillez entrer votre nom complet en lettres uniquement, sans chiffres ni symboles (exemple : Oussama Hamdaoui).`,

    nonTextAskName: () =>
      `Je comprends uniquement les messages texte 🙂\n` +
      `Veuillez envoyer votre nom complet par écrit (exemple : Oussama Hamdaoui).`,

    chooseDepartment: (s, { name, departments }) =>
      `🏥 Bonjour ${name}, veuillez choisir le service médical souhaité en envoyant son numéro :\n\n` +
      `${formatDepartmentList(departments, 'fr', s.currency)}\n\n` +
      `Répondez uniquement par le numéro du service (ex : 1).`,

    askNameForDepartment: (s, { department }) =>
      `🏥 Service sélectionné : ${department}.\n` +
      `Envoyez maintenant votre nom complet (exemple : Oussama Hamdaoui) pour confirmer le rendez-vous.`,

    invalidDepartmentChoice: (s, { departments }) =>
      `Numéro de service invalide. Merci d'envoyer un numéro entre 1 et ${departments.length} :\n\n` +
      `${formatDepartmentList(departments, 'fr', s.currency)}`,

    chooseDay: (s, { name, department, days = [], hasMore = false }) =>
      formatHolidayBanner(s, 'fr') +
      `📅 Bonjour${name ? ` ${name}` : ''}` +
      (department ? ` (${department})` : '') +
      `, veuillez choisir le jour et la date de votre rendez-vous parmi les disponibilités :\n\n` +
      `${formatAvailableDaysList(days, 'fr')}\n\n` +
      `👉 Répondez par le numéro du jour souhaité (1 à ${days.length}) ou écrivez une date (ex : ${days[0] ? formatFR(days[0].day).slice(0, 5) : '05/11'}).` +
      (hasMore ? `\n🔄 Envoyez 0 ou PLUS pour afficher d'autres dates disponibles.` : ''),

    dayUnavailable: (_s, { day, reason, closureLabel, department, days = [], hasMore = false }) =>
      `${formatUnavailableReason({ day, reason, closureLabel }, 'fr')}\n\n` +
      `📅 Dates disponibles${department ? ` (${department})` : ''} :\n` +
      `${formatAvailableDaysList(days, 'fr')}\n\n` +
      `👉 Répondez par un numéro entre 1 et ${days.length}` +
      (hasMore ? ` (ou 0 pour plus de dates).` : `.`),

    invalidDayChoice: (_s, { department, days = [], hasMore = false }) =>
      `Choix non reconnu 🙏\n` +
      `Merci d'envoyer un numéro entre 1 et ${days.length} (ou une date au format JJ/MM) pour choisir votre rendez-vous` +
      (department ? ` (${department})` : '') +
      ` :\n\n` +
      `${formatAvailableDaysList(days, 'fr')}` +
      (hasMore ? `\n\n🔄 Envoyez 0 ou PLUS pour voir les dates suivantes.` : ''),

    availableDaysPreview: (s, { department, days = [], hasMore = false }) =>
      formatHolidayBanner(s, 'fr') +
      `📅 Prochaines dates disponibles au ${s.clinic}` +
      (department ? ` (${department})` : '') +
      ` :\n` +
      formatHoursBlock(s, 'fr') +
      `\n${formatAvailableDaysList(days, 'fr')}` +
      (hasMore ? `\n(et d'autres dates suivantes…)` : '') +
      `\n\n✍️ Pour réserver l'une de ces dates, envoyez d'abord votre nom complet (exemple : Oussama Hamdaoui).`,

    booked: (s, { name, day, queue, slotTime, department, doctor, room, instructions }) =>
      `✅ Rendez-vous confirmé\n\n` +
      `Patient : ${name}\n` +
      (department ? `Service : ${department}\n` : '') +
      (doctor ? `Médecin : ${doctor}\n` : '') +
      (room ? `Salle : ${room}\n` : '') +
      `Date : ${formatLong(day, 'fr')}\n` +
      (slotTime ? `Horaire : ${slotTime}\n` : '') +
      `Numéro de passage : ${queue}\n` +
      formatHoursBlock(s, 'fr') +
      (instructions ? `\n📌 Consignes : ${instructions}\n` : '') +
      `\n${s.clinic}` +
      (s.address ? `\n📍 ${s.address}` : '') +
      `\nPour annuler, envoyez : ANNULER\n\n` +
      `📋 Pour faciliter l'examen du médecin (âge, poids et symptômes éventuels) :\n` +
      `🔒 Données locales strictement confidentielles au cabinet (Loi 18-07).\n` +
      `Répondez OUI (ou envoyez directement votre âge, ex : 32 ans) — ou NON pour ignorer.`,

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

    cancelConfirm: (_s, { day, slotTime, queue, department, cooldownMinutes = 30 }) =>
      `⚠️ Êtes-vous sûr de vouloir annuler votre rendez-vous du ${formatLong(day, 'fr')}` +
      (slotTime ? ` à ${slotTime}` : queue ? ` (tour n° ${queue})` : '') +
      (department ? ` — ${department}` : '') +
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

    cancelled: (s, { day, rebookTime, cooldownMinutes }) =>
      `✅ Votre rendez-vous du ${formatLong(day, 'fr')} a bien été annulé.\n` +
      (rebookTime
        ? `⏳ Vous pourrez réserver un nouveau rendez-vous dans ${cooldownMinutes || 30} minutes (à partir de ${rebookTime}).`
        : `Envoyez votre nom complet si vous souhaitez reprendre un rendez-vous.`),

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
      (Number(ahead) <= 2
        ? `⏳ Votre tour approche au cabinet !\n\n` +
          `Bonjour ${name} (numéro ${queue}${department ? ` · ${department}` : ''}),\n` +
          `• Votre passage est proche — il reste avant vous : ${formatPatientsAhead(ahead, 'fr')}\n` +
          `• Temps d'attente estimé : environ ${formatDuration(etaMinutes, 'fr')}\n\n` +
          `Merci de vous préparer à vous présenter au ${s.clinic}.\n` +
          `En cas d'empêchement, envoyez : ANNULER`
        : `⏳ Mise à jour de votre passage\n\n` +
          `Bonjour ${name} (numéro ${queue}${department ? ` · ${department}` : ''}),\n` +
          `• Patients restants avant vous : ${formatPatientsAhead(ahead, 'fr')}\n` +
          `• Temps d'attente estimé : environ ${formatDuration(etaMinutes, 'fr')}\n\n` +
          `${s.clinic}\n` +
          `En cas d'empêchement, envoyez : ANNULER`),

    tooFast: () =>
      `Vous avez envoyé plusieurs messages. Merci de patienter quelques minutes. 🙏`,

    price: (s, { treatment, price }) =>
      `Le tarif de « ${treatment} » est de ${money(price, s.currency)}. ` +
      `Envoyez votre nom complet pour réserver.`,

    intakeInvite: (s) =>
      `📋 Informations rapides pour le médecin — ${s.clinic}\n` +
      `🔒 Conformément à la Loi 18-07, vos réponses (âge, poids et symptômes éventuels) restent uniquement au cabinet.\n` +
      `Répondez OUI (ou envoyez directement votre âge, ex : 32 ans) — ou NON pour ignorer.`,

    intakeDeclined: () =>
      `C'est noté, votre rendez-vous reste bien confirmé. À bientôt au cabinet ! 🙏`,

    intakeAskAge: (_s, { isChild } = {}) =>
      isChild
        ? `1️⃣ Quel est l'âge de l'enfant ? (ex : 4 ans ou 18 mois — envoyez 0 pour passer)`
        : `1️⃣ Quel est l'âge du patient ? (ex : 32 ans ou 18 mois — envoyez 0 pour passer)`,

    intakeRetryAge: () =>
      `Âge non reconnu. Merci d'indiquer l'âge en années ou en mois (ex : 32 ou 18 mois), ou envoyez 0 pour passer.`,

    intakeAskWeight: (_s, { isChild } = {}) =>
      isChild
        ? `2️⃣ Quel est le poids de l'enfant en kg ? (ex : 14,5 kg — envoyez 0 pour passer)`
        : `2️⃣ Quel est votre poids approximatif en kg ? (ex : 72 ou 72,5 — envoyez 0 pour passer)`,

    intakeRetryWeight: () =>
      `Poids non reconnu. Merci d'envoyer un nombre entre 0,3 et 400 kg (ex : 72 ou 14,5), ou envoyez 0 pour passer.`,

    intakeAskComplaint: (_s, { isChild } = {}) =>
      isChild
        ? `3️⃣ Si vous souhaitez signaler quelques symptômes de l'enfant au médecin, écrivez-les brièvement (optionnel — envoyez 0 ou NON pour terminer) :`
        : `3️⃣ Si vous souhaitez signaler quelques symptômes au médecin, écrivez-les brièvement (optionnel — envoyez 0 ou NON pour terminer) :`,

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
      if (draft?.chief_complaint) details.push(`Symptômes : ${draft.chief_complaint}`);
      return (
        `✅ Merci ! Vos informations ont été enregistrées pour faciliter la consultation du médecin` +
        (details.length ? ` (${details.join(' · ')})` : '') +
        `.`
      );
    },
  },

  ar: {
    help: (s, { departments } = {}) =>
      formatHolidayBanner(s, 'ar') +
      `مرحبا بكم في ${s.clinic}. 👋\n` +
      (s.doctor ? `${s.doctor}${s.specialty ? ` — ${s.specialty}` : ''}\n` : '') +
      (s.address ? `📍 ${s.address}\n` : '') +
      formatHoursBlock(s, 'ar') +
      `\n` +
      (Array.isArray(departments) && departments.length >= 2
        ? `المصالح الطبية المتوفرة:\n${formatDepartmentList(departments, 'ar', s.currency)}\n\n` +
          `لحجز موعد، أرسلوا اسمكم الكامل (أو رقم المصلحة المطلوبة).\n\n`
        : `لحجز موعد، أرسلوا اسمكم الكامل (الاسم واللقب).\n\n`) +
      `الأوامر:\n` +
      `• الأيام المتاحة — لعرض الأيام والتواريخ الشاغرة\n` +
      `• موعدي — لمعرفة موعدكم\n` +
      `• إلغاء — لإلغاء الموعد\n\n` +
      `شكرا.`,

    doctorOnLeave: (s, { holiday, resumeDay, department } = {}) =>
      `🏖️ إعلام — ${s.clinic}${department ? ` (${department})` : ''}\n\n` +
      (holiday && holiday.start_day !== holiday.end_day
        ? `نُعلمكم أن الطبيب في عطلة حالياً من ${formatLong(holiday.start_day, 'ar')} إلى ${formatLong(holiday.end_day, 'ar')}.\n`
        : holiday
          ? `نُعلمكم أن الطبيب في عطلة يوم ${formatLong(holiday.start_day, 'ar')} (${formatFR(holiday.start_day)}).\n`
          : `نُعلمكم أن الطبيب في عطلة حالياً.\n`) +
      (resumeDay
        ? `📅 يُستأنف استقبال المرضى والحجز ابتداءً من يوم ${formatLong(resumeDay, 'ar')} (${formatFR(resumeDay)}).\n\n`
        : `\n`) +
      `نشكركم على تفهمكم ونتمنى لكم دوام الصحة والعافية 🙏`,

    askName: (s) =>
      formatHolidayBanner(s, 'ar') +
      `مرحبا بكم في ${s.clinic}. 🙏\nأرسلوا اسمكم الكامل (الاسم واللقب، مثال: أسامة حمداوي) ` +
      `لحجز أول موعد متاح.`,

    welcomeAskName: (s) =>
      formatHolidayBanner(s, 'ar') +
      `أهلاً بك في ${s.clinic} 👋\n` +
      formatHoursBlock(s, 'ar') +
      `من فضلك أدخل اسمك الكامل (مثال: أسامة حمداوي).`,

    invalidName: () =>
      `عذراً، الاسم المدخل غير صالح 🙏\n` +
      `من فضلك أدخل اسمك الكامل بالحروف فقط دون أرقام أو رموز (مثال: أسامة حمداوي).`,

    nonTextAskName: () =>
      `عذراً، أستقبل الرسائل النصية فقط 🙂\n` +
      `من فضلك أرسل اسمك الكامل نصاً (مثال: أسامة حمداوي).`,

    chooseDepartment: (s, { name, departments }) =>
      `🏥 مرحبا ${name}، يرجى اختيار المصلحة الطبية المطلوبة بإرسال رقمها:\n\n` +
      `${formatDepartmentList(departments, 'ar', s.currency)}\n\n` +
      `أرسلوا رقم المصلحة فقط (مثلا: 1).`,

    askNameForDepartment: (s, { department }) =>
      `🏥 تم اختيار المصلحة: ${department}.\n` +
      `أرسلوا الآن اسمكم الكامل (مثال: أسامة حمداوي) لتأكيد حجز الموعد.`,

    invalidDepartmentChoice: (s, { departments }) =>
      `رقم المصلحة غير صحيح. يرجى إرسال رقم بين 1 و ${departments.length}:\n\n` +
      `${formatDepartmentList(departments, 'ar', s.currency)}`,

    chooseDay: (s, { name, department, days = [], hasMore = false }) =>
      formatHolidayBanner(s, 'ar') +
      `📅 مرحبا${name ? ` ${name}` : ''}` +
      (department ? ` (${department})` : '') +
      `، يرجى اختيار اليوم والتاريخ المناسب لحجز موعدكم من بين الأيام المتاحة:\n\n` +
      `${formatAvailableDaysList(days, 'ar')}\n\n` +
      `👉 أرسلوا رقم اليوم المطلوب (من 1 إلى ${days.length}) أو اكتبوا التاريخ (مثلاً: ${days[0] ? formatFR(days[0].day).slice(0, 5) : '05/11'}).` +
      (hasMore ? `\n🔄 أرسلوا 0 أو المزيد لعرض أيام وتواريخ أخرى متاحة.` : ''),

    dayUnavailable: (_s, { day, reason, closureLabel, department, days = [], hasMore = false }) =>
      `${formatUnavailableReason({ day, reason, closureLabel }, 'ar')}\n\n` +
      `📅 الأيام المتاحة حالياً${department ? ` (${department})` : ''}:\n` +
      `${formatAvailableDaysList(days, 'ar')}\n\n` +
      `👉 يرجى إرسال رقم بين 1 و ${days.length}` +
      (hasMore ? ` (أو 0 لعرض المزيد من التواريخ).` : `.`),

    invalidDayChoice: (_s, { department, days = [], hasMore = false }) =>
      `عذراً، الاختيار غير معروف 🙏\n` +
      `يرجى إرسال رقم بين 1 و ${days.length} (أو كتابة التاريخ بصيغة يوم/شهر) لاختيار موعدكم` +
      (department ? ` (${department})` : '') +
      `:\n\n` +
      `${formatAvailableDaysList(days, 'ar')}` +
      (hasMore ? `\n\n🔄 أرسلوا 0 أو المزيد لعرض التواريخ التالية.` : ''),

    availableDaysPreview: (s, { department, days = [], hasMore = false }) =>
      formatHolidayBanner(s, 'ar') +
      `📅 الأيام والتواريخ المتاحة حالياً في ${s.clinic}` +
      (department ? ` (${department})` : '') +
      `:\n` +
      formatHoursBlock(s, 'ar') +
      `\n${formatAvailableDaysList(days, 'ar')}` +
      (hasMore ? `\n(وتوجد تواريخ أخرى تالية…)` : '') +
      `\n\n✍️ لحجز أحد هذه الأيام، أرسلوا أولاً اسمكم الكامل (مثال: أسامة حمداوي).`,

    booked: (s, { name, day, queue, slotTime, department, doctor, room, instructions }) =>
      `✅ تم تأكيد الموعد\n\n` +
      `المريض: ${name}\n` +
      (department ? `المصلحة: ${department}\n` : '') +
      (doctor ? `الطبيب: ${doctor}\n` : '') +
      (room ? `القاعة / الطابق: ${room}\n` : '') +
      `التاريخ: ${formatLong(day, 'ar')}\n` +
      (slotTime ? `التوقيت: ${slotTime}\n` : '') +
      `رقم الدور: ${queue}\n` +
      formatHoursBlock(s, 'ar') +
      (instructions ? `\n📌 ملاحظة: ${instructions}\n` : '') +
      `\n${s.clinic}` +
      (s.address ? `\n📍 ${s.address}` : '') +
      `\nللإلغاء أرسلوا: إلغاء\n\n` +
      `📋 لتسهيل الفحص على الطبيب (العمر، الوزن، وبعض الأعراض إن أردتم):\n` +
      `🔒 معلوماتكم تبقى سرية داخل العيادة طبقا للقانون 18-07.\n` +
      `أرسلوا نعم (أو أرسلوا عمركم مباشرة، مثلا: 32 سنة) — أو لا للتجاوز.`,

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

    cancelConfirm: (_s, { day, slotTime, queue, department, cooldownMinutes = 30 }) =>
      `⚠️ هل أنت متأكد من إلغاء موعدك يوم ${formatLong(day, 'ar')}` +
      (slotTime ? ` على الساعة ${slotTime}` : queue ? ` (رقم الدور ${queue})` : '') +
      (department ? ` — ${department}` : '') +
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

    cancelled: (s, { day, rebookTime, cooldownMinutes }) =>
      `✅ تم إلغاء موعدكم يوم ${formatLong(day, 'ar')}.\n` +
      (rebookTime
        ? `⏳ يمكنكم حجز موعد جديد بعد ${cooldownMinutes || 30} دقيقة (ابتداءً من الساعة ${rebookTime}).`
        : `أرسلوا اسمكم الكامل إذا أردتم حجز موعد جديد.`),

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
      (Number(ahead) <= 2
        ? `⏳ اقترب دوركم في العيادة!\n\n` +
          `مرحبا ${name} (رقم الدور: ${queue}${department ? ` · ${department}` : ''})،\n` +
          `• اقترب موعد دخولكم — بقي أمامكم: ${formatPatientsAhead(ahead, 'ar')}\n` +
          `• الوقت التقديري المتبقي: حوالي ${formatDuration(etaMinutes, 'ar')}\n\n` +
          `يرجى الاستعداد والتوجه إلى ${s.clinic}.\n` +
          `في حال تعذر الحضور أرسلوا: إلغاء`
        : `⏳ تنبيه بخصوص دوركم\n\n` +
          `مرحبا ${name} (رقم الدور: ${queue}${department ? ` · ${department}` : ''})،\n` +
          `• عدد المرضى المتبقين أمامكم: ${formatPatientsAhead(ahead, 'ar')}\n` +
          `• الوقت التقديري لانتظاركم: حوالي ${formatDuration(etaMinutes, 'ar')}\n\n` +
          `${s.clinic}\n` +
          `في حال تعذر الحضور أرسلوا: إلغاء`),

    tooFast: () => `أرسلتم عدة رسائل. يرجى الانتظار بضع دقائق. 🙏`,

    price: (s, { treatment, price }) =>
      `سعر «${treatment}» هو ${money(price, s.currency)}. ` +
      `أرسلوا اسمكم الكامل للحجز.`,

    intakeInvite: (s) =>
      `📋 معلومات سريعة للطبيب — ${s.clinic}\n` +
      `🔒 طبقا للقانون 18-07، تُحفظ إجاباتكم (العمر، الوزن، وبعض الأعراض إن وجدت) محليا وبسرية داخل العيادة فقط.\n` +
      `أرسلوا نعم (أو أرسلوا عمركم مباشرة، مثلا: 32 سنة) — أو لا للتجاوز.`,

    intakeDeclined: () =>
      `تم تسجيل ذلك، موعدكم يبقى مؤكدا. مرحبا بكم في العيادة! 🙏`,

    intakeAskAge: (_s, { isChild } = {}) =>
      isChild
        ? `1️⃣ كم عمر الطفل؟ (مثال: 4 سنوات أو 18 شهر — أو أرسلوا 0 للتخطي)`
        : `1️⃣ ما هو عمر المريض؟ (مثال: 32 سنة أو 18 شهر — أو أرسلوا 0 للتخطي)`,

    intakeRetryAge: () =>
      `لم نتعرف على العمر. يرجى إرسال العمر بالسنوات أو الأشهر (مثال: 32 أو 18 شهر)، أو أرسلوا 0 للتخطي.`,

    intakeAskWeight: (_s, { isChild } = {}) =>
      isChild
        ? `2️⃣ ما هو وزن الطفل بالكيلوغرام؟ (مثال: 14.5 كغ — أو أرسلوا 0 للتخطي)`
        : `2️⃣ ما هو وزنكم التقريبي بالكيلوغرام؟ (مثال: 72 أو 72.5 — أو أرسلوا 0 للتخطي)`,

    intakeRetryWeight: () =>
      `لم نتعرف على الوزن. يرجى إرسال رقم بين 0.3 و 400 كغ (مثال: 72 أو 14.5)، أو أرسلوا 0 للتخطي.`,

    intakeAskComplaint: (_s, { isChild } = {}) =>
      isChild
        ? `3️⃣ إذا أردتم إخبار الطبيب ببعض الأعراض التي يعاني منها الطفل اكتبوها باختصار (اختياري — أرسلوا 0 أو لا للإنهاء):`
        : `3️⃣ إذا أردتم إخبار الطبيب ببعض الأعراض باختصار اكتبوها الآن (اختياري — أرسلوا 0 أو لا للإنهاء):`,

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
        `✅ شكرا لكم! تم تسجيل المعلومات لتسهيل الفحص على الطبيب` +
        (details.length ? ` (${details.join(' · ')})` : '') +
        `.`
      );
    },
  },
};

const DARIJA_TEMPLATES = {
  ar: {
    help: (s, { departments } = {}) =>
      formatHolidayBanner(s, 'ar') +
      `سلام ومرحبا بيكم في ${s.clinic} 👋\n` +
      (s.doctor ? `${s.doctor}${s.specialty ? ` — ${s.specialty}` : ''}\n` : '') +
      (s.address ? `📍 ${s.address}\n` : '') +
      formatHoursBlock(s, 'ar') +
      `\n` +
      (Array.isArray(departments) && departments.length >= 2
        ? `المصالح الطبية المتوفرة:\n${formatDepartmentList(departments, 'ar', s.currency)}\n\n` +
          `باش تحجز موعد، ابعث الاسم واللقب تاعك (ولا رقم المصلحة).\n\n`
        : `باش تحجز موعد، ابعث برك الاسم واللقب تاعك كاملين.\n\n`) +
      `الأوامر:\n• الأيام المتاحة — باش تشوف النهارات الفارغة\n• إلغاء — لإلغاء الموعد\n• موعدي — لمعرفة نهار ونيميرو الدور تاعك\n• تأكيد — لتأكيد الحضور`,
    doctorOnLeave: (s, { holiday, resumeDay, department } = {}) =>
      `🏖️ سلام خويا/ختي — ${s.clinic}${department ? ` (${department})` : ''}\n\n` +
      (holiday && holiday.start_day !== holiday.end_day
        ? `الطبيب راه في عطلة من ${formatLong(holiday.start_day, 'ar')} حتى ${formatLong(holiday.end_day, 'ar')}.\n`
        : holiday
          ? `الطبيب راه في عطلة نهار ${formatLong(holiday.start_day, 'ar')} (${formatFR(holiday.start_day)}).\n`
          : `الطبيب راه في عطلة حالياً.\n`) +
      (resumeDay ? `📅 الخدمة والحجز يرجعو نهار ${formatLong(resumeDay, 'ar')} إن شاء الله.\n` : '') +
      `ربي يجيب الشفاء 🙏`,
    chooseDay: (s, { name, department, days = [], hasMore = false }) =>
      formatHolidayBanner(s, 'ar') +
      `📅 مرحبا${name ? ` ${name}` : ''}` +
      (department ? ` (${department})` : '') +
      `، خيّر النهار والتاريخ اللي يساعدك من القائمة:\n\n` +
      `${formatAvailableDaysList(days, 'ar')}\n\n` +
      `👉 ابعث نيميرو النهار (من 1 إلى ${days.length}) ولا اكتب التاريخ (مثلا: ${days[0] ? formatFR(days[0].day).slice(0, 5) : '05/11'}).` +
      (hasMore ? `\n🔄 ابعث 0 ولا المزيد باش تشوف نهارات خرين.` : ''),
    booked: (_s, { name, day, queue, slotTime, department, room, instructions }) =>
      `✅ تم تسجيل الموعد تاعك بالصحة والعافية\n\n` +
      `المريض(ة): ${name}\n` +
      (department ? `المصلحة: ${department}${room ? ` (${room})` : ''}\n` : '') +
      `النهار: ${formatLong(day, 'ar')}\n` +
      (slotTime ? `الوقت: ${slotTime}\n` : '') +
      `نيميرو الدور: ${queue}\n` +
      (instructions ? `📌 ملاحظة: ${instructions}\n` : '') +
      `\nلتسهيل الفحص على الطبيب (القانون 18-07): ابعث نعم ولا ابعث العمر تاعك مباشرة (مثلا: 32) باش تسجل العمر والوزن.`,
    turnNow: (s, { name, queue, department, room }) =>
      `🔔 خويا/ختي ${name}، لحق الدور تاعك درك (النيميرو ${queue})${department ? ` في ${department}` : ''}${room ? ` — ${room}` : ''} في ${s.clinic}. تفضل(ي) للداخل.`,
    queueAhead: (s, { name, queue, ahead, etaMinutes, department }) =>
      `⏳ سلام ${name} (النيميرو ${queue}${department ? ` · ${department}` : ''})، قرب الدور تاعك! بقي أمامك ${formatPatientsAhead(ahead, 'ar')} (حوالي ${formatDuration(etaMinutes, 'ar')}) في ${s.clinic}.\nإيلا ما تقدرش تجي ابعث: إلغاء`,
  },
  fr: {
    help: (s, { departments } = {}) =>
      formatHolidayBanner(s, 'fr') +
      `Salam et marhba bikoum au ${s.clinic} 👋\n` +
      formatHoursBlock(s, 'fr') +
      (Array.isArray(departments) && departments.length >= 2
        ? `Services disponibles :\n${formatDepartmentList(departments, 'fr', s.currency)}\n\n`
        : '') +
      `Envoyez votre nom complet bash tahجزou RDV. Commandes : MON RDV · CONFIRMER · ANNULER.`,
    doctorOnLeave: (s, { holiday, resumeDay, department } = {}) =>
      `🏖️ Salam — ${s.clinic}${department ? ` (${department})` : ''} : le médecin est actuellement en congé` +
      (holiday && holiday.start_day !== holiday.end_day
        ? ` du ${formatLong(holiday.start_day, 'fr')} au ${formatLong(holiday.end_day, 'fr')}`
        : holiday
          ? ` le ${formatLong(holiday.start_day, 'fr')}`
          : '') +
      `.\n` +
      (resumeDay ? `📅 Reprise des RDV le ${formatLong(resumeDay, 'fr')} inchallah. 🙏` : `Merci de votre compréhension 🙏`),
    booked: (_s, { name, day, queue, department, room }) =>
      `✅ RDV mriguel inchallah !\nPatient : ${name}\n` +
      (department ? `Service : ${department}${room ? ` (${room})` : ''}\n` : '') +
      `Jour : ${formatLong(day, 'fr')} — Tour N° ${queue}.\nRépondez OUI (ou votre âge) pour indiquer âge et poids au médecin (Loi 18-07).`,
    turnNow: (s, { name, queue }) =>
      `🔔 Salam ${name}, c'est votre tour maintenant (N° ${queue}) au ${s.clinic}, tfadhel(i) !`,
    queueAhead: (s, { name, queue, ahead, etaMinutes, department }) =>
      `⏳ Salam ${name} (N° ${queue}${department ? ` · ${department}` : ''}), votre tour approche ! Il reste ${formatPatientsAhead(ahead, 'fr')} avant vous (~${formatDuration(etaMinutes, 'fr')}) au ${s.clinic}.\nEn cas d'empêchement, envoyez : ANNULER`,
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

module.exports = {
  message,
  templates: t,
  formatDuration,
  formatPatientsAhead,
  formatDepartmentList,
  formatAvailableDaysList,
  formatPlacesLeft,
};
