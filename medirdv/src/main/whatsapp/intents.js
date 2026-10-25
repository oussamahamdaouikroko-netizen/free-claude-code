'use strict';
/**
 * Intent detection, greeting detection, and person-name validation for
 * incoming WhatsApp messages.
 *
 * Kept 100% pure (no DB, no network) so it can be unit-tested independently.
 */

/* -------------------------------------------------------------------------- */
/*  Configurable Person-Name & Greeting Constants (edit here as needed)       */
/* -------------------------------------------------------------------------- */

const NAME_RULES = {
  MIN_WORDS: 2,
  MAX_WORDS: 5,
  MIN_WORD_LENGTH: 2,
  MAX_WORD_LENGTH: 20,
  MAX_TOTAL_LENGTH: 60,
  EXAMPLE_AR: 'أسامة حمداوي',
  EXAMPLE_FR: 'Oussama Hamdaoui',
};

/** Whole-word starters that classify any message starting with them as a greeting. */
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

/** Multi-word greeting prefixes matched on full word boundaries. */
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

/** Exact single/short greeting expressions. */
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

/** Common words / commands that must never be accepted inside a person's name. */
const NON_NAME_WORDS = new Set([
  'نعم', 'لا', 'اوكي', 'اوك', 'شكرا', 'ابدا', 'تمام', 'حسنا', 'صافي',
  'موعد', 'موعدي', 'مواعيد', 'حجز', 'احجز', 'نحجز', 'الغاء', 'الغي', 'تاكيد',
  'عياده', 'طبيب', 'دكتور', 'فحص', 'استماره', 'معلومات', 'ملفي',
  'اريد', 'بغيت', 'نحب', 'ممكن', 'هل', 'كيف', 'كيفاش', 'متي', 'وقتاش', 'وين', 'اين',
  'بكم', 'شحال', 'سعر', 'اسمي', 'مساعده',
  'ok', 'oui', 'non', 'si', 'yes', 'no', 'merci', 'thanks', 'daccord',
  'start', 'help', 'aide', 'menu', 'info', 'information',
  'rdv', 'rendez', 'reserver', 'reservation', 'annuler', 'annule', 'cancel', 'confirmer', 'confirm',
  'svp', 'stp', 'docteur', 'cabinet', 'clinique', 'combien', 'prix', 'tarif', 'quand', 'comment',
]);

/** Arabic diacritics (tashkeel) + tatweel ("ـ"). */
const AR_DIACRITICS = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g;

/**
 * Allowed letters in person names:
 *  - Arabic letters (\u0621-\u063A, \u0641-\u064A, \u0671-\u06D3, \u06D5) — excludes Arabic digits & punctuation
 *  - Latin ASCII + accented Latin letters (\u00C0-\u024F minus × \u00D7 and ÷ \u00F7)
 *  - Single internal '-' or "'" between letter groups (e.g. Ait-Ahmed, O'Brien)
 */
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

/**
 * Normalize text specifically for greeting comparison:
 * lowercase, strip tashkeel & tatweel, unify (إأآٱ -> ا), (ى -> ي), (ة -> ه), collapse spaces.
 */
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

/**
 * Detect whether rawText is a greeting (exact match or whole-word greeting starter,
 * including /start), without falsely matching lookalike names such as "سلامة" or "هلال".
 */
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

/** Clean a candidate name: strip tashkeel & tatweel, normalize apostrophes, collapse spaces. */
function cleanPersonName(rawText) {
  return String(rawText ?? '')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(AR_DIACRITICS, '')
    .replace(/[ \t\u00A0]+/g, ' ')
    .trim();
}

/** Format a validated cleaned name: preserve Arabic, title-case Latin segments (e.g. Ait-Ahmed). */
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
  'fiche', 'ma fiche', 'fiche medicale', 'pre consultation', 'preconsultation', 'poids',
  'معلومات', 'معلوماتي', 'وزن', 'الوزن', 'استماره', 'ملفي', 'ملف طبي',
];

const BOOK_WORDS = [
  '/book', 'book', 'reserver', 'prendre rdv', 'prendre rendez vous', 'nouveau rdv',
  'حجز', 'حجز موعد', 'حجز جديد', 'اريد حجز', 'اريد موعد', 'نحجز',
];

/** Short acknowledgements must never be mistaken for a patient name. */
const STOP_WORDS = new Set([
  'ok', 'oui', 'non', 'si', 'merci', 'daccord', 'd accord', 'bon', 'bien', 'yes', 'no',
  'شكرا', 'نعم', 'لا', 'اوكي', 'اوك', 'حسنا', 'تمام', 'بارك الله فيك', 'صافي',
]);

/**
 * Validate whether rawText is a real full person name according to NAME_RULES.
 * @param {string} rawText
 * @param {Partial<typeof NAME_RULES>} [ruleOverrides]
 * @returns {{ valid: boolean, reason?: string, name?: string }}
 */
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
    INTAKE_WORDS.some((w) => normPhrase === w || normPhrase.startsWith(`${w} `))
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

/**
 * @param {string} rawText
 * @param {{currentLanguage?: 'fr'|'ar'}} [options]
 * @returns {{intent:'cancel'|'confirm'|'my_appointment'|'intake'|'help'|'name'|'unsupported',
 *            isGreeting?: boolean, isStopWord?: boolean,
 *            text:string, isArabic:boolean, language:'fr'|'ar', name?:string}}
 */
function detect(rawText, options = {}) {
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
  normalizeGreeting,
  isGreeting,
  cleanPersonName,
  formatPersonName,
  validatePersonName,
  detect,
  CANCEL_WORDS,
  MY_APPOINTMENT_WORDS,
  INTAKE_WORDS,
  BOOK_WORDS,
  HELP_WORDS,
  STOP_WORDS,
};
