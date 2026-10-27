'use strict';
/**
 * Intent detection, greeting detection, and person-name validation for
 * incoming WhatsApp messages (DentaRDV v2.0.0).
 *
 * Kept 100% pure (no DB, no network) so it can be unit-tested independently.
 */

const { isValidISODate, addDays, toISODate, diffDays, weekday } = require('../utils/dates');

const NAME_RULES = {
  MIN_WORDS: 2,
  MAX_WORDS: 5,
  MIN_WORD_LENGTH: 2,
  MAX_WORD_LENGTH: 20,
  MAX_TOTAL_LENGTH: 60,
  EXAMPLE_AR: 'أسامة حمداوي',
  EXAMPLE_FR: 'Oussama Hamdaoui',
};

const GREETING_START_WORDS = new Set([
  'السلام',
  'سلام',
  'مرحبا',
  'اهلا',
  'هلا',
  'صباح',
  'مساء',
  'hello',
  'hi',
  'hey',
  'salut',
  'bonjour',
  'bonsoir',
  '/start',
]);

const GREETING_PHRASE_PREFIXES = [
  'وعليكم السلام',
  'عسلامه',
  'يا مرحبا',
  'يا هلا',
  'يا اهلا',
  'as salam',
  'assalam alikoum',
  'salam alikoum',
  'salam aleykoum',
];

const GREETING_EXACT_SET = new Set([
  ...GREETING_START_WORDS,
  'اهلين',
  'سهلا',
  'اهلا وسهلا',
  'مرحبا بك',
  'مرحبا بكم',
  'السلام عليكم',
  'سلام عليكم',
  'صباح الخير',
  'صباح النور',
  'مساء الخير',
  'مساء النور',
  'عسلامه',
  'صحا',
  'صحيت',
  'ابدا',
  'start',
  'bjr',
  'bj',
  'bsr',
  'slt',
  'cc',
  'coucou',
  'salam',
  'slm',
  'saha',
  'marhba',
  'marhaba',
  'ahlan',
]);

const NON_NAME_WORDS = new Set([
  'نعم', 'لا', 'اوكي', 'اوك', 'شكرا', 'ابدا', 'تمام', 'حسنا', 'صافي',
  'موعد', 'موعدي', 'مواعيد', 'حجز', 'احجز', 'نحجز', 'الغاء', 'الغي', 'تاكيد',
  'عياده', 'طبيب', 'دكتور', 'ضرس', 'اسنان', 'خلع', 'استماره', 'معلومات', 'ملفي',
  'اريد', 'بغيت', 'نحب', 'ممكن', 'هل', 'كيف', 'كيفاش', 'متي', 'وقتاش', 'وين', 'اين',
  'بكم', 'شحال', 'سعر', 'اسمي', 'مساعده',
  'ok', 'oui', 'non', 'si', 'yes', 'no', 'merci', 'thanks', 'daccord',
  'start', 'help', 'aide', 'menu', 'info', 'information',
  'rdv', 'rendez', 'reserver', 'reservation', 'annuler', 'annule', 'cancel', 'confirmer', 'confirm',
  'svp', 'stp', 'docteur', 'dentiste', 'cabinet', 'clinique', 'combien', 'prix', 'tarif', 'quand', 'comment',
]);

const AR_DIACRITICS = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g;

const ALLOWED_LETTERS = 'A-Za-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u024F\\u0621-\\u063A\\u0641-\\u064A\\u0671-\\u06D3\\u06D5';
const VALID_NAME_WORD_RE = new RegExp(`^[${ALLOWED_LETTERS}]+(?:[-'][${ALLOWED_LETTERS}]+)*$`);
const URL_LIKE_RE = /(?:https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|net|org|dz|fr|io|me|co|ly|info|app)\b)/i;

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

function normalizeGreeting(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(AR_DIACRITICS, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[^\p{L}\p{N}\s/]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isGreeting(rawText) {
  const trimmed = String(rawText ?? '').trim();
  if (!trimmed) return false;
  if (/^\/start(?:\s|$|@)/i.test(trimmed)) return true;

  const norm = normalizeGreeting(trimmed);
  if (!norm) return false;
  const collapsed = norm.replace(/(.)\1{2,}/gu, '$1');

  if (GREETING_EXACT_SET.has(norm) || GREETING_EXACT_SET.has(collapsed)) return true;
  if (GREETING_PHRASE_PREFIXES.some((p) => norm === p || norm.startsWith(`${p} `))) return true;

  const firstWord = norm.split(' ')[0];
  const firstCollapsed = collapsed.split(' ')[0];
  if (GREETING_START_WORDS.has(firstWord) || GREETING_START_WORDS.has(firstCollapsed)) return true;

  return false;
}

function cleanPersonName(rawText) {
  return String(rawText ?? '')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(AR_DIACRITICS, '')
    .replace(/[ \t\u00A0]+/g, ' ')
    .trim();
}

function formatPersonName(cleanedName) {
  return cleanedName
    .split(' ')
    .map((word) => {
      if (!/[A-Za-z\u00C0-\u024F]/.test(word)) return word;
      return word
        .split(/([-'])/)
        .map((seg) => {
          if (seg === '-' || seg === "'") return seg;
          if (!seg) return seg;
          return seg.charAt(0).toUpperCase() + seg.slice(1).toLowerCase();
        })
        .join('');
    })
    .join(' ');
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
  'aide', 'help', 'menu', 'info', 'information', '/help', '/menu',
  'مساعدة', 'مساعده', 'كيفاش', 'كيف',
];

const INTAKE_WORDS = [
  'fiche', 'ma fiche', 'fiche dentaire', 'pre consultation', 'preconsultation', 'poids',
  'معلومات', 'معلوماتي', 'وزن', 'الوزن', 'استماره', 'ملفي', 'ملف طبي',
];

const BOOK_WORDS = [
  '/book', 'book', 'reserver', 'prendre rdv', 'prendre rendez vous', 'nouveau rdv',
  'حجز', 'حجز موعد', 'حجز جديد', 'اريد حجز', 'اريد موعد', 'نحجز',
];

const DATES_WORDS = [
  'jours disponibles', 'dates disponibles', 'disponibilites', 'disponibilite',
  'creneaux disponibles', 'creneaux', 'prochains jours', 'quelles dates', 'quels jours',
  'الايام المتاحه', 'المواعيد المتاحه', 'التواريخ المتاحه',
  'الايام المتوفره', 'المواعيد المتوفره', 'التواريخ المتوفره',
  'الايام الشاغره', 'المواعيد الشاغره', 'الايام الفارغه',
  'ايام الحجز', 'تواريخ الحجز', 'وشمن نهار', 'واش من نهار', 'وقتاش كاين موعد',
];

const MORE_DAYS_WORDS = new Set([
  '0', 'المزيد', 'مزيد', 'ايام اخري', 'ايام اخرى', 'تواريخ اخري', 'تواريخ اخرى',
  'مواعيد اخري', 'مواعيد اخرى', 'التالي', 'plus', 'autres', 'autres jours',
  'autres dates', 'suivant', 'more',
]);

const WEEKDAY_SYNONYMS = [
  { wd: 0, words: ['الاحد', 'احد', 'لحد', 'يوم الاحد', 'نهار الاحد', 'نهار لحد', 'dimanche'] },
  { wd: 1, words: ['الاثنين', 'اثنين', 'الاتنين', 'لتنين', 'يوم الاثنين', 'نهار الاثنين', 'نهار لتنين', 'lundi'] },
  { wd: 2, words: ['الثلاثاء', 'ثلاثاء', 'التلاتاء', 'لتلات', 'الثلاثا', 'يوم الثلاثاء', 'نهار الثلاثاء', 'نهار لتلات', 'mardi'] },
  { wd: 3, words: ['الاربعاء', 'اربعاء', 'الاربعا', 'لاربع', 'لاربعا', 'يوم الاربعاء', 'نهار الاربعاء', 'نهار لاربع', 'mercredi'] },
  { wd: 4, words: ['الخميس', 'خميس', 'لخميس', 'يوم الخميس', 'نهار الخميس', 'نهار لخميس', 'jeudi'] },
  { wd: 5, words: ['الجمعه', 'جمعه', 'لجمعه', 'يوم الجمعه', 'نهار الجمعه', 'vendredi'] },
  { wd: 6, words: ['السبت', 'سبت', 'لسبت', 'يوم السبت', 'نهار السبت', 'samedi'] },
];

/** Convert Eastern Arabic / Persian digits to ASCII 0-9. */
function normalizeDigits(text) {
  return String(text ?? '')
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)));
}

/**
 * Parse a patient's reply while choosing an available booking day.
 */
function parseDaySelection(rawText, choicesLength = 0, options = {}) {
  const today = options.fromDate || toISODate();
  const allowSameDay = options.allowSameDay !== false;
  const ascii = normalizeDigits(rawText).trim();
  if (!ascii) return { type: 'unknown' };

  const norm = normalize(ascii);
  if (MORE_DAYS_WORDS.has(norm)) {
    return { type: 'more' };
  }

  // 1. Explicit ISO date: YYYY-MM-DD or YYYY/MM/DD
  const isoMatch = ascii.match(/^(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})$/);
  if (isoMatch) {
    const day = `${isoMatch[1]}-${isoMatch[2].padStart(2, '0')}-${isoMatch[3].padStart(2, '0')}`;
    return isValidISODate(day) ? { type: 'date', day } : { type: 'invalid_date' };
  }

  // 2. Explicit DD/MM/YYYY or DD-MM-YYYY (4-digit or 2-digit year)
  const dmyMatch = ascii.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/);
  if (dmyMatch) {
    const yearStr = dmyMatch[3].length === 2 ? `20${dmyMatch[3]}` : dmyMatch[3];
    const day = `${yearStr}-${dmyMatch[2].padStart(2, '0')}-${dmyMatch[1].padStart(2, '0')}`;
    return isValidISODate(day) ? { type: 'date', day } : { type: 'invalid_date' };
  }

  // 3. Short DD/MM or DD-MM
  const dmMatch = ascii.match(/^(\d{1,2})[/-](\d{1,2})$/);
  if (dmMatch) {
    const todayYear = Number.parseInt(today.slice(0, 4), 10);
    const mm = dmMatch[2].padStart(2, '0');
    const dd = dmMatch[1].padStart(2, '0');
    let candidate = `${todayYear}-${mm}-${dd}`;
    if (!isValidISODate(candidate)) {
      candidate = `${todayYear + 1}-${mm}-${dd}`;
      if (!isValidISODate(candidate)) return { type: 'invalid_date' };
    } else if (diffDays(today, candidate) < -30) {
      const nextYearCandidate = `${todayYear + 1}-${mm}-${dd}`;
      if (isValidISODate(nextYearCandidate)) candidate = nextYearCandidate;
    }
    return { type: 'date', day: candidate };
  }

  // 4. Numbered menu choice (1..N, including "2.", "1️⃣", "رقم 2", "choix 2")
  const cleanedChoice = ascii
    .replace(/[\uFE0F\u20E3]/g, '')
    .replace(/^[#•*-\s]+|[.):\s]+$/g, '')
    .trim();
  const numMatch =
    cleanedChoice.match(/^(\d{1,2})$/) ||
    norm.match(/^(?:رقم|الرقم|خيار|اختيار|يوم رقم|choix|option|numero|n)\s*(\d{1,2})$/);
  if (numMatch) {
    const n = Number.parseInt(numMatch[1], 10);
    if (n === 0) return { type: 'more' };
    if (choicesLength > 0 && n >= 1 && n <= choicesLength) {
      return { type: 'index', index: n - 1 };
    }
    if (choicesLength > 0 && n > choicesLength) {
      return { type: 'out_of_range', number: n };
    }
  }

  // 5. Relative day expressions (Arabic / Darija / French)
  if (
    norm === 'بعد غد' ||
    norm === 'بعد غدا' ||
    norm === 'غير غدوه' ||
    norm === 'بعدد غدوه' ||
    norm === 'apres demain' ||
    norm === 'apres-demain'
  ) {
    return { type: 'date', day: addDays(today, 2) };
  }
  if (
    norm === 'غدا' ||
    norm === 'غد' ||
    norm === 'غدوه' ||
    norm === 'بكره' ||
    norm === 'اليوم الموالي' ||
    norm === 'demain' ||
    norm === 'ghodwa' ||
    norm === 'ghedwa'
  ) {
    return { type: 'date', day: addDays(today, 1) };
  }
  if (
    norm === 'اليوم' ||
    norm === 'نهار اليوم' ||
    norm === 'هاد النهار' ||
    norm === 'هذا اليوم' ||
    norm === 'aujourd hui' ||
    norm === "aujourd'hui" ||
    norm === 'aujourdhui' ||
    norm === 'ce jour'
  ) {
    return { type: 'date', day: today };
  }

  // 6. Weekday name -> nearest upcoming date matching that weekday
  for (const entry of WEEKDAY_SYNONYMS) {
    if (entry.words.includes(norm)) {
      let delta = (entry.wd - weekday(today) + 7) % 7;
      if (delta === 0 && !allowSameDay) delta = 7;
      return { type: 'date', day: addDays(today, delta) };
    }
  }

  return { type: 'unknown' };
}

const STOP_WORDS = new Set([
  'ok', 'oui', 'non', 'si', 'merci', 'daccord', 'd accord', 'bon', 'bien', 'yes', 'no',
  'شكرا', 'نعم', 'لا', 'اوكي', 'اوك', 'حسنا', 'تمام', 'بارك الله فيك', 'صافي',
]);

function validatePersonName(rawText, ruleOverrides = {}) {
  const rules = { ...NAME_RULES, ...ruleOverrides };
  if (typeof rawText !== 'string') return { valid: false, reason: 'empty' };
  if (/[\r\n\u2028\u2029]/.test(rawText)) return { valid: false, reason: 'multiline' };

  const cleaned = cleanPersonName(rawText);
  if (!cleaned) return { valid: false, reason: 'empty' };
  if (cleaned.length > rules.MAX_TOTAL_LENGTH) return { valid: false, reason: 'too_long' };
  if (URL_LIKE_RE.test(rawText) || URL_LIKE_RE.test(cleaned)) return { valid: false, reason: 'url' };
  if (/\p{N}/u.test(cleaned)) return { valid: false, reason: 'digits' };
  if (isGreeting(rawText)) return { valid: false, reason: 'greeting' };

  const normPhrase = normalize(rawText);
  if (
    STOP_WORDS.has(normPhrase) ||
    HELP_WORDS.includes(normPhrase) ||
    CANCEL_WORDS.some((w) => normPhrase === w || normPhrase.startsWith(`${w} `)) ||
    CONFIRM_WORDS.some((w) => normPhrase === w || normPhrase.startsWith(`${w} `)) ||
    MY_APPOINTMENT_WORDS.some((w) => normPhrase === w || normPhrase.startsWith(`${w} `)) ||
    INTAKE_WORDS.some((w) => normPhrase === w || normPhrase.startsWith(`${w} `)) ||
    DATES_WORDS.some((w) => normPhrase === w || normPhrase.startsWith(`${w} `))
  ) {
    return { valid: false, reason: 'common_word' };
  }

  const words = cleaned.split(' ');
  if (words.length < rules.MIN_WORDS || words.length > rules.MAX_WORDS) {
    return { valid: false, reason: 'word_count' };
  }

  for (const word of words) {
    if (word.length < rules.MIN_WORD_LENGTH || word.length > rules.MAX_WORD_LENGTH) {
      return { valid: false, reason: 'word_length' };
    }
    if (!VALID_NAME_WORD_RE.test(word)) {
      return { valid: false, reason: 'invalid_chars' };
    }
    const wordNorm = normalizeGreeting(word);
    if (NON_NAME_WORDS.has(wordNorm)) {
      return { valid: false, reason: 'common_word' };
    }
  }

  return { valid: true, name: formatPersonName(cleaned) };
}

function detect(rawText) {
  const original = String(rawText ?? '').trim();
  const normalized = normalize(original);
  const arabicChars = (original.match(/[\u0600-\u06FF]/g) || []).length;
  const latinChars = (original.match(/[A-Za-zÀ-ÿ]/g) || []).length;
  const isArabic = arabicChars > latinChars;
  const language = isArabic ? 'ar' : 'fr';

  if (isGreeting(original)) {
    return { intent: 'help', isGreeting: true, text: original, isArabic, language };
  }
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
  if (DATES_WORDS.some((word) => normalized === word || normalized.startsWith(`${word} `))) {
    return { intent: 'dates', text: original, isArabic, language };
  }
  if (BOOK_WORDS.some((word) => normalized === word || normalized.startsWith(`${word} `))) {
    return { intent: 'book', text: original, isArabic, language };
  }
  if (HELP_WORDS.some((word) => normalized === word)) {
    return { intent: 'help', text: original, isArabic, language };
  }
  if (STOP_WORDS.has(normalized)) {
    return { intent: 'help', isStopWord: true, text: original, isArabic, language };
  }

  const nameCheck = validatePersonName(rawText);
  if (nameCheck.valid) {
    return {
      intent: 'name',
      text: original,
      isArabic,
      language,
      name: nameCheck.name,
    };
  }
  return { intent: 'unsupported', text: original, isArabic, language };
}

module.exports = {
  NAME_RULES,
  GREETING_START_WORDS,
  GREETING_EXACT_SET,
  NON_NAME_WORDS,
  normalize,
  normalizeDigits,
  normalizeGreeting,
  isGreeting,
  cleanPersonName,
  formatPersonName,
  validatePersonName,
  parseDaySelection,
  detect,
  CANCEL_WORDS,
  CONFIRM_WORDS,
  MY_APPOINTMENT_WORDS,
  INTAKE_WORDS,
  BOOK_WORDS,
  DATES_WORDS,
  HELP_WORDS,
  STOP_WORDS,
};
