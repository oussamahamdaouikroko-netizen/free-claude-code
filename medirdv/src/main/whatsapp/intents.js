'use strict';
/**
 * Intent detection for incoming WhatsApp messages.
 *
 * Kept 100% pure (no DB, no network) so it can be unit-tested. Arabic is
 * normalized first: diacritics removed, letter variants unified, so "إلغاء",
 * "الغاء" and "لغاء" all match the same keyword list.
 */

/** Arabic diacritics + tatweel. */
const AR_DIACRITICS = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g;

function normalize(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .replace(AR_DIACRITICS, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/[ؤئ]/g, 'ء')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}@._'\-\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const CANCEL_WORDS = [
  'annuler', 'annule', 'annulation', 'annulez', 'cancel', 'supprimer', 'effacer',
  'الغاء', 'الغي', 'الغاء الموعد', 'الغاء الحجز', 'نلغي', 'لغي', 'لالغاء', 'الغي الموعد',
];

const CONFIRM_WORDS = [
  'confirmer', 'confirme', 'confirmation', 'confirm',
  'تاكيد', 'اكد', 'ماكد', 'مءكد', 'تاكيد الموعد',
];

const MY_APPOINTMENT_WORDS = [
  'mon rdv', 'mon rendez', 'mon rendez vous', 'rdv', 'rendez vous', 'rendez',
  'mes rdv', 'ma reservation', 'reservation', 'consulter', 'quand est mon rdv',
  'موعدي', 'الموعد', 'موعد', 'حجزي', 'الحجز', 'متي موعدي', 'وقتاش موعدي', 'وقتاش موعد',
  'وين موعدي', 'اشوف موعدي', 'موعدي وين',
];

const HELP_WORDS = [
  'aide', 'help', 'menu', 'info', 'information', 'bonjour', 'salut', 'bjr', 'bj',
  'bonsoir', 'cc', 'salam', 'salam alikoum', 'salam aleykoum', 'as salam alikoum',
  'saha', 'marhba', 'مرحبا', 'اهلا', 'سلام', 'السلام عليكم', 'صباح الخير', 'مساء الخير',
  'مساعدة', 'مساعده', 'كيفاش', 'كيف',
];

const INTAKE_WORDS = [
  'fiche', 'ma fiche', 'fiche medicale', 'pre consultation', 'preconsultation', 'poids',
  'معلومات', 'معلوماتي', 'وزن', 'الوزن', 'استماره', 'ملفي', 'ملف طبي',
];

/** Short acknowledgements must never be mistaken for a patient name. */
const STOP_WORDS = new Set([
  'ok', 'oui', 'non', 'si', 'merci', 'daccord', 'd accord', 'bon', 'bien', 'yes', 'no',
  'شكرا', 'نعم', 'لا', 'اوكي', 'اوك', 'حسنا', 'تمام', 'بارك الله فيك', 'صافي',
]);

/**
 * @param {string} rawText
 * @param {{currentLanguage?: 'fr'|'ar'}} [options]
 * @returns {{intent:'cancel'|'my_appointment'|'help'|'name'|'unsupported',
 *            text:string, isArabic:boolean, language:'fr'|'ar', name?:string}}
 */
function detect(rawText, options = {}) {
  const original = String(rawText ?? '').trim();
  const normalized = normalize(original);
  const arabicChars = (original.match(/[\u0600-\u06FF]/g) || []).length;
  const latinChars = (original.match(/[A-Za-zÀ-ÿ]/g) || []).length;
  const isArabic = arabicChars > latinChars;
  const language = isArabic ? 'ar' : 'fr';

  if (!normalized) return { intent: 'unsupported', text: original, isArabic, language };

  if (CANCEL_WORDS.some((word) => normalized === word || normalized.startsWith(`${word} `))) {
    return { intent: 'cancel', text: original, isArabic, language };
  }
  if (CONFIRM_WORDS.some((word) => normalized === word || normalized.startsWith(`${word} `))) {
    return { intent: 'confirm', text: original, isArabic, language };
  }
  if (MY_APPOINTMENT_WORDS.some((word) => normalized === word || normalized.startsWith(`${word} `))) {
    return { intent: 'my_appointment', text: original, isArabic, language };
  }
  if (INTAKE_WORDS.some((word) => normalized === word || normalized.startsWith(`${word} `))) {
    return { intent: 'intake', text: original, isArabic, language };
  }
  if (HELP_WORDS.some((word) => normalized === word)) {
    return { intent: 'help', text: original, isArabic, language };
  }
  if (STOP_WORDS.has(normalized)) {
    return { intent: 'help', text: original, isArabic, language };
  }

  // Anything else that looks like a human name becomes a booking request.
  const letters = (original.match(/\p{L}/gu) || []).length;
  const hasDigits = /\d{4,}/.test(original);
  if (letters >= 2 && letters <= 80 && !hasDigits) {
    return {
      intent: 'name',
      text: original,
      isArabic,
      language,
      name: original.replace(/\s+/g, ' ').trim().slice(0, 80),
    };
  }
  return { intent: 'unsupported', text: original, isArabic, language };
}

module.exports = {
  normalize,
  detect,
  CANCEL_WORDS,
  MY_APPOINTMENT_WORDS,
  INTAKE_WORDS,
  HELP_WORDS,
  STOP_WORDS,
};
