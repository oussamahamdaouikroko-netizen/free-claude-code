'use strict';
/**
 * Offline Asymmetric (Ed25519) Activation License Service for MediRDV.
 *
 * Security architecture:
 *  - Asymmetric Ed25519 signature verification ONLY (`node:crypto`).
 *    The private key NEVER exists in this codebase, repository, or `.exe`.
 *  - Compact binary token (`version | flags | license_id | plan | days | issued_at | [machine_id] | sig64`)
 *    encoded in unambiguous uppercase Base32-style alphabet (strictly no 0/O/1/I/L)
 *    grouped as `XXXXX-XXXXX-...`.
 *  - Dual tamper-evident persistence:
 *      1) Atomic file (`<dataDir>/license-state.json` via temp + fsync + rename)
 *      2) Windows Registry (`HKCU\Software\MediRDV\License` -> `StateBlob`)
 *    Both authenticated with `HMAC-SHA256` derived from machine fingerprint + public key.
 *  - Never trusts a stored plaintext `expires_at`: expiration is ALWAYS re-derived
 *    from the Ed25519-verified signed code(s) + HMAC-protected activation chain.
 *  - Anti-clock-rollback: compares UTC clock against monotonic `last_seen_utc_ms`
 *    AND latest SQLite database activity timestamp (`LICENSE_CLOCK_SKEW_MINUTES` tolerance).
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const dbMod = require('../db');
const {
  APP_NAME,
  PLANS,
  LICENSE_BIND_TO_MACHINE,
  TRIAL_DAYS,
  LICENSE_WARN_DAYS,
  LICENSE_CHECK_INTERVAL_MINUTES,
  LICENSE_CLOCK_SKEW_MINUTES,
  algeriaISODate,
  formatAlgeriaDate,
} = require('../config');
const { AppError } = require('../utils/common');

/**
 * Embedded Ed25519 Public Key (SPKI DER Base64).
 * Generated once by `tools/license_keygen` (`--init-keys --embed-public`).
 * Private key stays exclusively on the developer's machine outside the repo.
 */
const EMBEDDED_PUBLIC_KEY_SPKI_B64 = 'MCowBQYDK2VwAyEAXCQmahdSZyRS7OAf8Q2HMMjvZon+827uq0YMXqgJsH8=';

const DOMAIN_PREFIX = Buffer.from('MRDV-LIC-V1:', 'utf8');
const TOKEN_VERSION = 1;
const FLAG_MACHINE_BOUND = 0x01;

// Unambiguous 31-character alphabet: digits 2-9 + uppercase A-Z WITHOUT 0, O, 1, I, L.
const SAFE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const BASE_N = BigInt(SAFE_ALPHABET.length);
const CHAR_MAP = new Map([...SAFE_ALPHABET].map((ch, idx) => [ch, BigInt(idx)]));

const PLAN_TO_TAG = Object.freeze({ CUSTOM: 0, '1M': 1, '6M': 2, '1Y': 3 });
const TAG_TO_PLAN = Object.freeze({ 0: 'CUSTOM', 1: '1M', 2: '6M', 3: '1Y' });

const REG_LICENSE_KEY = 'HKCU\\Software\\MediRDV\\License';
const REG_LICENSE_VALUE = 'StateBlob';
const REG_CRYPTOGRAPHY_KEY = 'HKLM\\SOFTWARE\\Microsoft\\Cryptography';

const DAY_MS = 24 * 60 * 60 * 1000;
const REINSTALL_FRESH_GRACE_MS = 24 * 60 * 60 * 1000; // 24h window for newly generated code

// User-facing messages in clear Arabic & French (no crypto internals exposed)
const MESSAGES = {
  ar: {
    INVALID_CODE: 'كود التفعيل غير صالح. يرجى التأكد من صحة الكود.',
    MALFORMED_CODE: 'الكود المدخل تالف أو ناقص. يرجى نسخ الكود كاملاً وإعادة المحاولة.',
    PASTED_MACHINE_ID:
      'ما قمت بلصقه هو «بصمة الجهاز» وليس كود التفعيل! أرسل بصمة جهازك إلى أداة التوليد للحصول على كود التفعيل.',
    ALREADY_USED: 'تم استعمال هذا الكود مسبقاً.',
    WRONG_MACHINE: 'هذا الكود لا يخص هذا الجهاز. يرجى إصدار كود مطابق لبصمة هذا الجهاز الظاهرة أعلاه.',
    MACHINE_REQUIRED: 'هذا الكود غير مربوط ببصمة هذا الجهاز.',
    CODE_EXPIRED: 'انتهت صلاحية هذا الكود.',
    CLOCK_TAMPERED:
      'تم اكتشاف تأخير غير طبيعي في ساعة الحاسوب. يرجى ضبط تاريخ ووقت النظام الصحيحين لاستئناف العمل.',
    LICENSE_REQUIRED: 'الخدمة متوقفة مؤقتاً، يرجى التواصل مع العيادة.',
    BOT_SUSPENDED: 'الخدمة متوقفة مؤقتاً، يرجى التواصل مع العيادة.',
  },
  fr: {
    INVALID_CODE: "Code d'activation invalide. Veuillez vérifier le code saisi.",
    MALFORMED_CODE: 'Le code saisi est incomplet ou endommagé. Veuillez coller le code complet.',
    PASTED_MACHINE_ID:
      "Vous avez collé l'empreinte de l'ordinateur au lieu du code d'activation.",
    ALREADY_USED: 'Ce code a déjà été utilisé.',
    WRONG_MACHINE: "Ce code n'appartient pas à cet ordinateur.",
    MACHINE_REQUIRED: "Ce code n'est pas lié à l'empreinte de cet ordinateur.",
    CODE_EXPIRED: 'Ce code a expiré.',
    CLOCK_TAMPERED:
      "Un recul anormal de l'horloge système a été détecté. Veuillez corriger la date et l'heure de l'ordinateur.",
    LICENSE_REQUIRED: 'Le service de réservation est temporairement suspendu, veuillez contacter le cabinet.',
    BOT_SUSPENDED: 'Le service de réservation est temporairement suspendu, veuillez contacter le cabinet.',
  },
};

function userMessage(code, lang = 'ar') {
  const table = lang === 'fr' ? MESSAGES.fr : MESSAGES.ar;
  return table[code] || MESSAGES.ar[code] || MESSAGES.ar.INVALID_CODE;
}

/* -------------------------------------------------------------------------- */
/*  Unambiguous Base Encoding (no 0/O/1/I/L) & Input Sanitization             */
/* -------------------------------------------------------------------------- */

const INVISIBLE_AND_WRAP_RE =
  /[\u0000-\u001F\u007F-\u009F\u00AD\u061C\u200B-\u200F\u2028-\u202F\u205F-\u206F\uFEFF"'`*<>[\](){}]+/g;

function cleanLicenseInput(raw) {
  const stripped = String(raw ?? '')
    .replace(INVISIBLE_AND_WRAP_RE, ' ')
    .toUpperCase();

  // If the user pasted surrounding WhatsApp/chat/CLI text along with a grouped code
  // (e.g. "كود التفعيل: DSHJV-227MJ-..."), extract the grouped Base32 token automatically.
  const embeddedMatch = stripped.match(
    /(?:[2-9A-HJ-KM-NP-Z]{5}[\s\-–—_]+){12,}[2-9A-HJ-KM-NP-Z]{1,5}/,
  );
  const target = embeddedMatch ? embeddedMatch[0] : stripped;

  return target.replace(/[\s\-–—_]+/g, '');
}

function formatLicenseGroups(cleaned, groupSize = 5) {
  const parts = [];
  for (let i = 0; i < cleaned.length; i += groupSize) {
    parts.push(cleaned.slice(i, i + groupSize));
  }
  return parts.join('-');
}

function encodeSafeBase32(buffer) {
  const withSentinel = Buffer.concat([Buffer.from([0x01]), Buffer.from(buffer)]);
  let num = 0n;
  for (const byte of withSentinel) {
    num = (num << 8n) | BigInt(byte);
  }
  const chars = [];
  while (num > 0n) {
    const rem = num % BASE_N;
    num = num / BASE_N;
    chars.push(SAFE_ALPHABET[Number(rem)]);
  }
  return formatLicenseGroups(chars.reverse().join(''));
}

function decodeSafeBase32(input) {
  const cleaned = cleanLicenseInput(input);
  if (!cleaned || cleaned.length < 40 || cleaned.length > 300) {
    return null;
  }
  let num = 0n;
  for (const ch of cleaned) {
    const val = CHAR_MAP.get(ch);
    if (val === undefined) return null;
    num = num * BASE_N + val;
  }
  const bytes = [];
  while (num > 0n) {
    bytes.push(Number(num & 0xffn));
    num >>= 8n;
  }
  bytes.reverse();
  if (bytes.length < 2 || bytes[0] !== 0x01) return null;
  return Buffer.from(bytes.slice(1));
}

/* -------------------------------------------------------------------------- */
/*  Machine Fingerprint (`HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid`)  */
/* -------------------------------------------------------------------------- */

function defaultRegRunner(args) {
  return execFileSync('reg.exe', args, {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function parseRegValue(output, valueName) {
  if (!output) return null;
  const escaped = String(valueName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^\\s*${escaped}\\s+REG_[A-Z0-9_]+\\s+(.+?)\\s*$`, 'im');
  const match = String(output).match(re);
  return match ? match[1].trim() : null;
}

function readWindowsMachineGuid(regRunner = defaultRegRunner) {
  const attempts = [
    ['query', REG_CRYPTOGRAPHY_KEY, '/v', 'MachineGuid', '/reg:64'],
    ['query', REG_CRYPTOGRAPHY_KEY, '/v', 'MachineGuid'],
  ];
  for (const args of attempts) {
    try {
      const out = regRunner(args);
      const val = parseRegValue(out, 'MachineGuid');
      if (val && val.length >= 8) return val.toLowerCase();
    } catch (_err) {
      /* try next */
    }
  }
  return null;
}

function readFallbackHardwareSeed() {
  const parts = [os.platform(), os.arch(), os.hostname()];
  try {
    const cpus = os.cpus();
    if (cpus && cpus[0] && cpus[0].model) parts.push(cpus[0].model.trim());
  } catch (_err) {
    /* ignore */
  }
  for (const idFile of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
    try {
      if (fs.existsSync(idFile)) {
        const content = fs.readFileSync(idFile, 'utf8').trim();
        if (content) {
          parts.push(content);
          break;
        }
      }
    } catch (_err) {
      /* ignore */
    }
  }
  return parts.join('|');
}

function formatMachineHex(hex16) {
  const up = String(hex16).toUpperCase();
  return `${up.slice(0, 4)}-${up.slice(4, 8)}-${up.slice(8, 12)}-${up.slice(12, 16)}`;
}

function normalizeMachineFingerprint(input) {
  const cleaned = String(input ?? '')
    .toUpperCase()
    .replace(/[\s\-–—_:]+/g, '');
  if (!/^[0-9A-F]{16}$/.test(cleaned)) return null;
  return {
    hex: cleaned,
    formatted: formatMachineHex(cleaned),
    bytes: Buffer.from(cleaned, 'hex'),
  };
}

function computeMachineFingerprint({ platform = process.platform, regRunner = defaultRegRunner, rawOverride = null } = {}) {
  let seed = rawOverride;
  if (!seed && platform === 'win32') {
    seed = readWindowsMachineGuid(regRunner);
  }
  if (!seed) {
    seed = readFallbackHardwareSeed();
  }
  const digest = crypto
    .createHash('sha256')
    .update(`MediRDV-HWID-v1:${seed}`, 'utf8')
    .digest();
  const bytes = digest.subarray(0, 8);
  const hex = bytes.toString('hex').toUpperCase();
  return {
    hex,
    formatted: formatMachineHex(hex),
    bytes,
  };
}

/* -------------------------------------------------------------------------- */
/*  Binary Payload Parsing & Ed25519 Signature Verification ONLY              */
/* -------------------------------------------------------------------------- */

function buildPublicKeyObject(spkiB64) {
  const der = Buffer.from(String(spkiB64 || '').trim(), 'base64');
  return crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
}

function verifySignedLicenseCode(rawCode, { publicKeySpkiB64 = EMBEDDED_PUBLIC_KEY_SPKI_B64 } = {}) {
  const cleaned = cleanLicenseInput(rawCode);
  if (!cleaned) {
    return { ok: false, errorCode: 'MALFORMED_CODE' };
  }

  // Helpful UX guard: if someone accidentally pasted their 16-hex-char Machine Fingerprint
  // (`XXXX-XXXX-XXXX-XXXX`) into the Activation Code field, tell them explicitly!
  if (/^[0-9A-F]{16}$/.test(cleaned)) {
    return { ok: false, errorCode: 'PASTED_MACHINE_ID' };
  }

  const decoded = decodeSafeBase32(cleaned);
  if (!decoded || decoded.length < 17 + 64) {
    return { ok: false, errorCode: 'MALFORMED_CODE' };
  }

  const version = decoded.readUInt8(0);
  if (version !== TOKEN_VERSION) {
    return { ok: false, errorCode: 'INVALID_CODE' };
  }

  const flags = decoded.readUInt8(1);
  const hasMachine = (flags & FLAG_MACHINE_BOUND) === FLAG_MACHINE_BOUND;
  const payloadLen = hasMachine ? 25 : 17;

  if (decoded.length !== payloadLen + 64) {
    return { ok: false, errorCode: 'MALFORMED_CODE' };
  }

  const payloadBuf = decoded.subarray(0, payloadLen);
  const signatureBuf = decoded.subarray(payloadLen);

  let pubKey;
  try {
    pubKey = buildPublicKeyObject(publicKeySpkiB64);
  } catch (_err) {
    return { ok: false, errorCode: 'INVALID_CODE' };
  }

  const signedMessage = Buffer.concat([DOMAIN_PREFIX, payloadBuf]);
  let validSig = false;
  try {
    validSig = crypto.verify(null, signedMessage, pubKey, signatureBuf);
  } catch (_err) {
    validSig = false;
  }

  if (!validSig) {
    return { ok: false, errorCode: 'INVALID_CODE' };
  }

  const licenseId = payloadBuf.subarray(2, 10).toString('hex');
  const planTag = payloadBuf.readUInt8(10);
  const durationDays = payloadBuf.readUInt16BE(11);
  const issuedAtSec = payloadBuf.readUInt32BE(13);
  const machineHex = hasMachine ? payloadBuf.subarray(17, 25).toString('hex').toUpperCase() : null;

  if (!durationDays || durationDays < 1) {
    return { ok: false, errorCode: 'INVALID_CODE' };
  }

  return {
    ok: true,
    version,
    licenseId,
    plan: TAG_TO_PLAN[planTag] || 'CUSTOM',
    durationDays,
    issuedAtSec,
    issuedAtUtcMs: issuedAtSec * 1000,
    hasMachine,
    machineHex,
    normalizedCode: formatLicenseGroups(cleaned),
  };
}

/* -------------------------------------------------------------------------- */
/*  Database Activity Timestamp Cross-Check (Anti-Clock-Rollback)             */
/* -------------------------------------------------------------------------- */

function parseLocalTimestampMs(ts) {
  if (!ts) return 0;
  const s = String(ts).trim();
  if (!s) return 0;
  const isoCandidate = s.includes('T') ? s : s.replace(' ', 'T');
  const ms = new Date(isoCandidate).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function defaultDbLatestActivityProvider() {
  if (!dbMod.isOpen()) return { utcExactMs: 0, localNaiveMs: 0 };
  const db = dbMod.getDb();
  let utcExactMs = 0;
  let localNaiveMs = 0;

  try {
    const sess = db.prepare('SELECT MAX(updated_at) AS m FROM bot_sessions').get();
    if (sess && Number(sess.m) > utcExactMs) utcExactMs = Number(sess.m);
  } catch (_err) {
    /* ignore */
  }

  for (const sql of [
    'SELECT MAX(created_at) AS c, MAX(updated_at) AS u FROM appointments',
    'SELECT MAX(paid_at) AS c FROM payments',
    'SELECT MAX(created_at) AS c FROM audit_log',
  ]) {
    try {
      const row = db.prepare(sql).get();
      if (row) {
        const cMs = parseLocalTimestampMs(row.c);
        const uMs = parseLocalTimestampMs(row.u);
        if (cMs > localNaiveMs) localNaiveMs = cMs;
        if (uMs > localNaiveMs) localNaiveMs = uMs;
      }
    } catch (_err) {
      /* ignore */
    }
  }

  return { utcExactMs, localNaiveMs };
}

/* -------------------------------------------------------------------------- */
/*  Atomic File + Windows HKCU Dual HMAC-Authenticated Storage                */
/* -------------------------------------------------------------------------- */

let tmpCounter = 0;

function writeFileAtomically(filePath, content) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  tmpCounter += 1;
  const tmpFile = `${filePath}.tmp.${process.pid}.${tmpCounter}`;
  let fd = null;
  try {
    fd = fs.openSync(tmpFile, 'w', 0o600);
    fs.writeFileSync(fd, content, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmpFile, filePath);
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch (_err) {
        /* ignore */
      }
    }
    try {
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    } catch (_err) {
      /* ignore */
    }
  }
}

function emptyState() {
  return {
    v: 1,
    entries: [],
    used_license_ids: [],
    last_seen_utc_ms: 0,
    trial: { granted: false, started_at_utc_ms: null },
    last_warn_day_dz: '',
  };
}

function normalizeStateShape(raw) {
  const base = emptyState();
  if (!raw || typeof raw !== 'object') return base;
  if (Array.isArray(raw.entries)) {
    base.entries = raw.entries
      .filter((e) => e && typeof e.raw_code === 'string')
      .map((e) => ({
        raw_code: String(e.raw_code),
        activated_at_utc_ms: Number(e.activated_at_utc_ms) || 0,
        effective_start_utc_ms: Number(e.effective_start_utc_ms) || 0,
      }));
  }
  if (Array.isArray(raw.used_license_ids)) {
    base.used_license_ids = [...new Set(raw.used_license_ids.map((id) => String(id)))];
  }
  base.last_seen_utc_ms = Math.max(0, Number(raw.last_seen_utc_ms) || 0);
  if (raw.trial && typeof raw.trial === 'object') {
    base.trial = {
      granted: Boolean(raw.trial.granted),
      started_at_utc_ms: raw.trial.started_at_utc_ms ? Number(raw.trial.started_at_utc_ms) : null,
    };
  }
  base.last_warn_day_dz = typeof raw.last_warn_day_dz === 'string' ? raw.last_warn_day_dz : '';
  return base;
}

/* -------------------------------------------------------------------------- */
/*  LicenseManager                                                            */
/* -------------------------------------------------------------------------- */

class LicenseManager {
  constructor(options = {}) {
    this.configure(options);
  }

  configure(options = {}) {
    this.publicKeySpkiB64 = options.publicKeySpkiB64 || EMBEDDED_PUBLIC_KEY_SPKI_B64;
    this.storageDir =
      options.storageDir ||
      path.join(os.homedir(), '.medirdv-data');
    this.platform = options.platform || process.platform;
    this.regRunner = options.regRunner || defaultRegRunner;
    this.useRegistry =
      options.useRegistry !== undefined
        ? Boolean(options.useRegistry)
        : this.platform === 'win32' || Boolean(options.regRunner);
    this.bindToMachine =
      options.bindToMachine !== undefined ? Boolean(options.bindToMachine) : LICENSE_BIND_TO_MACHINE;
    this.trialDays = options.trialDays !== undefined ? Number(options.trialDays) : TRIAL_DAYS;
    this.warnDays = options.warnDays !== undefined ? Number(options.warnDays) : LICENSE_WARN_DAYS;
    this.clockSkewMinutes =
      options.clockSkewMinutes !== undefined
        ? Number(options.clockSkewMinutes)
        : LICENSE_CLOCK_SKEW_MINUTES;
    this.checkIntervalMinutes =
      options.checkIntervalMinutes !== undefined
        ? Number(options.checkIntervalMinutes)
        : LICENSE_CHECK_INTERVAL_MINUTES;
    this.clock = options.clock || (() => Date.now());
    this.dbActivityProvider = options.dbActivityProvider || defaultDbLatestActivityProvider;
    this.demoMode = Boolean(options.demoMode);
    this.onChange = options.onChange || null;
    this.onWarning = options.onWarning || null;
    this.onExpired = options.onExpired || null;

    this.machine = options.machineFingerprint
      ? normalizeMachineFingerprint(options.machineFingerprint)
      : computeMachineFingerprint({
          platform: this.platform,
          regRunner: this.regRunner,
        });

    if (!this.machine) {
      this.machine = computeMachineFingerprint({ rawOverride: 'fallback-default-machine' });
    }

    this.hmacKey = crypto
      .createHash('sha256')
      .update(`MediRDV-State-MAC-v1:${this.machine.hex}:${this.publicKeySpkiB64}`, 'utf8')
      .digest();

    this.activating = false;
    this.lastPersistMs = 0;
    this.lastKnownValid = null;
    this.stopPeriodicCheck();
  }

  stateFilePath() {
    return path.join(this.storageDir, 'license-state.json');
  }

  getMachineId() {
    return this.machine.formatted;
  }

  getMachineHex() {
    return this.machine.hex;
  }

  signEnvelope(stateObj) {
    const normalized = normalizeStateShape(stateObj);
    const payload = JSON.stringify(normalized);
    const mac = crypto.createHmac('sha256', this.hmacKey).update(payload, 'utf8').digest('hex');
    return JSON.stringify({ p: payload, m: mac });
  }

  verifyEnvelope(rawEnvelopeText) {
    if (!rawEnvelopeText || typeof rawEnvelopeText !== 'string') {
      return { valid: false, state: null, candidateCodes: [] };
    }
    let parsedEnv;
    try {
      parsedEnv = JSON.parse(rawEnvelopeText);
    } catch (_err) {
      return { valid: false, state: null, candidateCodes: [] };
    }

    const extractCandidates = (text) => {
      try {
        const inner = typeof text === 'string' ? JSON.parse(text) : text;
        if (inner && Array.isArray(inner.entries)) {
          return inner.entries
            .map((e) => (e && typeof e.raw_code === 'string' ? e.raw_code : null))
            .filter(Boolean);
        }
      } catch (_err) {
        /* ignore */
      }
      return [];
    };

    if (!parsedEnv || typeof parsedEnv.p !== 'string' || typeof parsedEnv.m !== 'string') {
      return { valid: false, state: null, candidateCodes: extractCandidates(parsedEnv) };
    }

    const expectedMac = crypto
      .createHmac('sha256', this.hmacKey)
      .update(parsedEnv.p, 'utf8')
      .digest('hex');

    const macBufA = Buffer.from(parsedEnv.m, 'utf8');
    const macBufB = Buffer.from(expectedMac, 'utf8');
    const match = macBufA.length === macBufB.length && crypto.timingSafeEqual(macBufA, macBufB);
    if (!match) {
      return {
        valid: false,
        tampered: true,
        state: null,
        candidateCodes: extractCandidates(parsedEnv.p),
      };
    }

    try {
      return {
        valid: true,
        tampered: false,
        state: normalizeStateShape(JSON.parse(parsedEnv.p)),
        candidateCodes: [],
      };
    } catch (_err) {
      return { valid: false, tampered: true, state: null, candidateCodes: [] };
    }
  }

  readFileEnvelope() {
    const file = this.stateFilePath();
    try {
      if (!fs.existsSync(file)) return { exists: false, valid: false, state: null, candidateCodes: [] };
      const text = fs.readFileSync(file, 'utf8');
      return { exists: true, ...this.verifyEnvelope(text) };
    } catch (_err) {
      return { exists: false, valid: false, state: null, candidateCodes: [] };
    }
  }

  readRegistryEnvelope() {
    if (!this.useRegistry) {
      return { exists: false, valid: false, state: null, candidateCodes: [] };
    }
    try {
      const out = this.regRunner(['query', REG_LICENSE_KEY, '/v', REG_LICENSE_VALUE]);
      const b64 = parseRegValue(out, REG_LICENSE_VALUE);
      if (!b64) return { exists: false, valid: false, state: null, candidateCodes: [] };
      const jsonText = Buffer.from(b64, 'base64url').toString('utf8');
      return { exists: true, ...this.verifyEnvelope(jsonText) };
    } catch (_err) {
      return { exists: false, valid: false, state: null, candidateCodes: [] };
    }
  }

  saveState(stateObj) {
    const normalized = normalizeStateShape(stateObj);
    const envelope = this.signEnvelope(normalized);

    try {
      writeFileAtomically(this.stateFilePath(), envelope);
    } catch (err) {
      console.warn('[license] file write warning:', err.message);
    }

    if (this.useRegistry) {
      try {
        const b64 = Buffer.from(envelope, 'utf8').toString('base64url');
        this.regRunner([
          'add',
          REG_LICENSE_KEY,
          '/v',
          REG_LICENSE_VALUE,
          '/t',
          'REG_SZ',
          '/d',
          b64,
          '/f',
        ]);
      } catch (err) {
        console.warn('[license] registry write warning:', err.message);
      }
    }

    this.lastPersistMs = this.clock();
    return normalized;
  }

  mergeStates(a, b) {
    const primary =
      (b.entries.length > a.entries.length || b.last_seen_utc_ms > a.last_seen_utc_ms) ? b : a;
    const secondary = primary === a ? b : a;

    const byCode = new Map();
    for (const item of [...secondary.entries, ...primary.entries]) {
      const cleaned = cleanLicenseInput(item.raw_code);
      if (!byCode.has(cleaned)) byCode.set(cleaned, item);
    }

    const used = [...new Set([...a.used_license_ids, ...b.used_license_ids])];
    const trialGranted = Boolean(a.trial.granted || b.trial.granted);
    const trialStarts = [a.trial.started_at_utc_ms, b.trial.started_at_utc_ms].filter(
      (n) => Number.isFinite(n) && n > 0,
    );

    return normalizeStateShape({
      v: 1,
      entries: [...byCode.values()],
      used_license_ids: used,
      last_seen_utc_ms: Math.max(a.last_seen_utc_ms, b.last_seen_utc_ms),
      trial: {
        granted: trialGranted,
        started_at_utc_ms: trialStarts.length > 0 ? Math.min(...trialStarts) : null,
      },
      last_warn_day_dz:
        a.last_warn_day_dz >= b.last_warn_day_dz ? a.last_warn_day_dz : b.last_warn_day_dz,
    });
  }

  /**
   * Load state from dual storage with automatic self-healing & tamper recovery.
   * Never throws on corrupted or manually edited files.
   */
  loadState() {
    const f = this.readFileEnvelope();
    const r = this.readRegistryEnvelope();

    if (f.valid && r.valid) {
      const merged = this.mergeStates(f.state, r.state);
      if (
        JSON.stringify(merged) !== JSON.stringify(f.state) ||
        JSON.stringify(merged) !== JSON.stringify(r.state)
      ) {
        this.saveState(merged);
      }
      return { state: merged, recoveredFromTamper: false, freshEmpty: false };
    }

    if (f.valid && !r.valid) {
      this.saveState(f.state);
      return { state: f.state, recoveredFromTamper: Boolean(r.tampered), freshEmpty: false };
    }

    if (!f.valid && r.valid) {
      this.saveState(r.state);
      return { state: r.state, recoveredFromTamper: Boolean(f.tampered), freshEmpty: false };
    }

    // Neither store has a valid HMAC: either genuinely first run, or BOTH stores were manually edited.
    const candidates = [...new Set([...(f.candidateCodes || []), ...(r.candidateCodes || [])])];
    if (candidates.length > 0) {
      const recoveredEntries = [];
      const usedIds = [];
      let cursorEnd = 0;

      for (const code of candidates) {
        const verified = this.verifyCodeForThisMachine(code);
        if (verified.ok && !usedIds.includes(verified.licenseId)) {
          // Anchor conservatively to signed issuedAtUtcMs so tampering can NEVER grant extra days!
          const startMs = cursorEnd > verified.issuedAtUtcMs ? cursorEnd : verified.issuedAtUtcMs;
          recoveredEntries.push({
            raw_code: verified.normalizedCode,
            activated_at_utc_ms: verified.issuedAtUtcMs,
            effective_start_utc_ms: startMs,
          });
          usedIds.push(verified.licenseId);
          cursorEnd = startMs + verified.durationDays * DAY_MS;
        }
      }

      const healed = normalizeStateShape({
        v: 1,
        entries: recoveredEntries,
        used_license_ids: usedIds,
        last_seen_utc_ms: this.clock(),
        trial: { granted: this.trialDays > 0, started_at_utc_ms: null },
        last_warn_day_dz: '',
      });
      this.saveState(healed);
      return { state: healed, recoveredFromTamper: true, freshEmpty: false };
    }

    const hadCorruptFiles = Boolean(f.exists || r.exists);
    const fresh = emptyState();
    if (hadCorruptFiles) {
      // Wipe corrupt/tampered garbage cleanly without crashing
      this.saveState(fresh);
    }
    return { state: fresh, recoveredFromTamper: hadCorruptFiles, freshEmpty: !hadCorruptFiles };
  }

  verifyCodeForThisMachine(rawCode) {
    const verified = verifySignedLicenseCode(rawCode, {
      publicKeySpkiB64: this.publicKeySpkiB64,
    });
    if (!verified.ok) return verified;

    if (this.bindToMachine) {
      if (!verified.hasMachine) {
        return { ok: false, errorCode: 'MACHINE_REQUIRED' };
      }
      if (verified.machineHex !== this.machine.hex) {
        return { ok: false, errorCode: 'WRONG_MACHINE' };
      }
    } else if (verified.hasMachine && verified.machineHex !== this.machine.hex) {
      // When LICENSE_BIND_TO_MACHINE is explicitly disabled, unbound codes work anywhere;
      // if a code WAS explicitly bound to another machine, still respect its embedded machine tag
      // ONLY when bindToMachine is true (per spec: "إذا كان الخيار معطلاً يعمل الكود على أي جهاز").
    }

    return verified;
  }

  detectClockTamper(nowMs, state) {
    const skewMs = Math.max(1, this.clockSkewMinutes) * 60 * 1000;

    if (state.last_seen_utc_ms > 0 && nowMs < state.last_seen_utc_ms - skewMs) {
      return true;
    }

    const dbAct = this.dbActivityProvider();
    if (dbAct.utcExactMs > 0 && nowMs < dbAct.utcExactMs - skewMs) {
      return true;
    }

    if (dbAct.localNaiveMs > 0) {
      // When state.last_seen_utc_ms > 0, exact UTC checks already guard 10-min rollbacks, so allow
      // up to 14h on timezone-naive SQLite strings so legitimate OS timezone changes never false-trigger.
      // When state.last_seen_utc_ms === 0 (e.g. attacker wiped license stores AND rolled back clock),
      // enforce strict skewMs!
      const localMargin = state.last_seen_utc_ms > 0 ? Math.max(skewMs, 14 * 3600 * 1000) : skewMs;
      if (nowMs < dbAct.localNaiveMs - localMargin) {
        return true;
      }
    }

    return false;
  }

  /**
   * Re-verify EVERY stored signed code from scratch and compute exact expiration in UTC.
   * Never trusts a stored expiration date string.
   */
  computeChainExpiration(state) {
    let latestExpiryMs = 0;
    let activePlan = null;
    let validCount = 0;

    for (const entry of state.entries) {
      const verified = this.verifyCodeForThisMachine(entry.raw_code);
      if (!verified.ok) continue;

      const startMs =
        Number.isFinite(entry.effective_start_utc_ms) && entry.effective_start_utc_ms > 0
          ? entry.effective_start_utc_ms
          : verified.issuedAtUtcMs;
      const entryEndMs = startMs + verified.durationDays * DAY_MS;
      if (entryEndMs > latestExpiryMs) {
        latestExpiryMs = entryEndMs;
        activePlan = verified.plan;
      }
      validCount += 1;
    }

    if (validCount === 0 && state.trial.granted && state.trial.started_at_utc_ms && this.trialDays > 0) {
      const trialEnd = state.trial.started_at_utc_ms + this.trialDays * DAY_MS;
      if (trialEnd > latestExpiryMs) {
        latestExpiryMs = trialEnd;
        activePlan = 'TRIAL';
      }
    }

    return { expiresAtUtcMs: latestExpiryMs, plan: activePlan, validCount };
  }

  ensureTrialIfConfigured(state, nowMs, freshEmpty) {
    if (this.trialDays > 0 && !state.trial.granted && state.entries.length === 0 && freshEmpty) {
      state.trial = {
        granted: true,
        started_at_utc_ms: nowMs,
      };
      state.last_seen_utc_ms = Math.max(state.last_seen_utc_ms, nowMs);
      this.saveState(state);
    }
  }

  getStatus(options = {}) {
    if (this.demoMode) {
      return {
        valid: true,
        status: 'demo',
        demo: true,
        read_only: false,
        machine_id: this.getMachineId(),
        expires_at_utc_ms: null,
        expires_date_dz: null,
        days_remaining: null,
        warning_soon: false,
        plan: 'DEMO',
        plans: { ...PLANS },
        bind_to_machine: this.bindToMachine,
        message_ar: 'نسخة تجريبية للعرض فقط',
      };
    }

    const nowMs = options.nowMs !== undefined ? Number(options.nowMs) : this.clock();
    const loaded = this.loadState();
    const { state } = loaded;

    // 1. Check clock rollback BEFORE updating last_seen_utc_ms
    if (this.detectClockTamper(nowMs, state)) {
      return {
        valid: false,
        status: 'clock_tampered',
        read_only: true,
        machine_id: this.getMachineId(),
        expires_at_utc_ms: null,
        expires_date_dz: null,
        days_remaining: 0,
        warning_soon: false,
        plan: null,
        plans: { ...PLANS },
        bind_to_machine: this.bindToMachine,
        message_ar: userMessage('CLOCK_TAMPERED', 'ar'),
        message_fr: userMessage('CLOCK_TAMPERED', 'fr'),
      };
    }

    // 2. Grant optional one-time trial if TRIAL_DAYS > 0 on genuinely fresh install
    this.ensureTrialIfConfigured(state, nowMs, loaded.freshEmpty);

    // 3. Monotonically advance last_seen_utc_ms (persist periodically or when forced)
    if ((options.nowMs === undefined || options.persistClock) && nowMs > state.last_seen_utc_ms) {
      state.last_seen_utc_ms = nowMs;
      if (options.persistClock || nowMs - this.lastPersistMs >= 5 * 60 * 1000) {
        this.saveState(state);
      }
    }

    // 4. Re-verify cryptographic signatures on all stored codes
    const chain = this.computeChainExpiration(state);

    if (chain.expiresAtUtcMs <= 0) {
      return {
        valid: false,
        status: 'unlicensed',
        read_only: true,
        machine_id: this.getMachineId(),
        expires_at_utc_ms: null,
        expires_date_dz: null,
        days_remaining: 0,
        warning_soon: false,
        plan: null,
        plans: { ...PLANS },
        bind_to_machine: this.bindToMachine,
        message_ar: 'غير مفعّل — يرجى إدخال كود التفعيل لتشغيل الحجوزات.',
        message_fr: "Non activé — veuillez saisir un code d'activation.",
      };
    }

    if (nowMs >= chain.expiresAtUtcMs) {
      const expDateDz = formatAlgeriaDate(chain.expiresAtUtcMs);
      return {
        valid: false,
        status: 'expired',
        read_only: true,
        machine_id: this.getMachineId(),
        expires_at_utc_ms: chain.expiresAtUtcMs,
        expires_date_dz: expDateDz,
        days_remaining: 0,
        warning_soon: false,
        plan: chain.plan,
        plans: { ...PLANS },
        bind_to_machine: this.bindToMachine,
        message_ar: `منتهي الصلاحية منذ ${expDateDz} — وضع القراءة فقط.`,
        message_fr: `Licence expirée le ${expDateDz} — mode lecture seule.`,
      };
    }

    const msLeft = chain.expiresAtUtcMs - nowMs;
    const daysRemaining = Math.max(1, Math.ceil(msLeft / DAY_MS));
    const expDateDz = formatAlgeriaDate(chain.expiresAtUtcMs);
    const warningSoon = daysRemaining <= this.warnDays;

    return {
      valid: true,
      status: 'active',
      read_only: false,
      machine_id: this.getMachineId(),
      expires_at_utc_ms: chain.expiresAtUtcMs,
      expires_date_dz: expDateDz,
      days_remaining: daysRemaining,
      warning_soon: warningSoon,
      plan: chain.plan,
      plans: { ...PLANS },
      bind_to_machine: this.bindToMachine,
      message_ar: `مفعّل حتى ${expDateDz} (متبقي ${daysRemaining} يوم)`,
      message_fr: `Activé jusqu'au ${expDateDz} (${daysRemaining} jour(s) restant(s))`,
    };
  }

  /**
   * Central boolean guard invoked across ALL booking/appointment creation paths.
   */
  isLicenseValid(options = {}) {
    return this.getStatus(options).valid === true;
  }

  /**
   * Central throwing guard for backend services & IPC handlers.
   */
  requireValidLicense(options = {}) {
    const status = this.getStatus(options);
    if (!status.valid) {
      const errCode = status.status === 'clock_tampered' ? 'CLOCK_TAMPERED' : 'LICENSE_REQUIRED';
      throw new AppError(errCode, status.message_ar, {
        license_status: status.status,
      });
    }
    return status;
  }

  /**
   * Activate or renew a license code.
   * Handles:
   *  - Double-click / concurrent activation lock
   *  - Whitespace / hyphen / newline / case normalization
   *  - Ed25519 signature & machine-fingerprint validation
   *  - Clock-rollback check
   *  - Replay rejection (`ALREADY_USED`)
   *  - Reinstall on same machine with same valid machine-bound code (anchored to `issuedAtUtcMs` -> zero extra days!)
   *  - Early renewal (`effective_start = current_expires_at` so zero days are lost!)
   *  - Post-expiry renewal (`effective_start = now`)
   */
  activate(rawCode, options = {}) {
    if (this.activating) {
      throw new AppError('ALREADY_USED', userMessage('ALREADY_USED', 'ar'));
    }
    this.activating = true;
    try {
      const nowMs = options.nowMs !== undefined ? Number(options.nowMs) : this.clock();
      const loaded = this.loadState();
      const { state } = loaded;

      // 1. Verify clock integrity first
      if (this.detectClockTamper(nowMs, state)) {
        throw new AppError('CLOCK_TAMPERED', userMessage('CLOCK_TAMPERED', 'ar'));
      }

      // 2. Verify Ed25519 signature & machine binding
      const verified = this.verifyCodeForThisMachine(rawCode);
      if (!verified.ok) {
        throw new AppError(verified.errorCode, userMessage(verified.errorCode, 'ar'));
      }

      // 3. Reject replay if license_id was already recorded locally
      const priorIds = new Set(state.used_license_ids);
      for (const e of state.entries) {
        const v = verifySignedLicenseCode(e.raw_code, { publicKeySpkiB64: this.publicKeySpkiB64 });
        if (v.ok) priorIds.add(v.licenseId);
      }
      if (priorIds.has(verified.licenseId)) {
        throw new AppError('ALREADY_USED', userMessage('ALREADY_USED', 'ar'));
      }

      // 4. Determine effective start timestamp:
      //    - Active license exists (`currentExpiry > nowMs`): extend from `currentExpiry` (early renewal!)
      //    - Previous history exists on this installation (expired renewal): start from `nowMs`
      //    - Fresh / wiped local storage (`entries.length === 0`) AND code was issued >24h ago:
      //      reinstall on same machine -> anchor to `verified.issuedAtUtcMs` so NO extra days are granted!
      const currentChain = this.computeChainExpiration(state);
      const hasPriorInstallHistory = state.entries.length > 0 || state.used_license_ids.length > 0;

      let effectiveStartMs;
      if (currentChain.expiresAtUtcMs > nowMs) {
        effectiveStartMs = currentChain.expiresAtUtcMs;
      } else if (!hasPriorInstallHistory && nowMs > verified.issuedAtUtcMs + REINSTALL_FRESH_GRACE_MS) {
        effectiveStartMs = verified.issuedAtUtcMs;
      } else {
        effectiveStartMs = nowMs;
      }

      const newExpiryMs = effectiveStartMs + verified.durationDays * DAY_MS;
      if (newExpiryMs <= nowMs) {
        throw new AppError('CODE_EXPIRED', userMessage('CODE_EXPIRED', 'ar'));
      }

      state.entries.push({
        raw_code: verified.normalizedCode,
        activated_at_utc_ms: nowMs,
        effective_start_utc_ms: effectiveStartMs,
      });
      state.used_license_ids = [...new Set([...state.used_license_ids, verified.licenseId])];
      state.last_seen_utc_ms = Math.max(state.last_seen_utc_ms, nowMs);
      // Reset warning marker so future 7-day window can warn properly
      state.last_warn_day_dz = '';

      this.saveState(state);

      // Record tamper-evident audit entry if SQLite is open
      if (options.audit !== false && dbMod.isOpen()) {
        try {
          const security = require('./security');
          security.appendAudit({
            username: 'admin',
            role: 'admin',
            action: 'license.activate',
            entity_type: 'license',
            entity_id: verified.licenseId,
            summary: `Activated plan ${verified.plan} (${verified.durationDays}d)`,
          });
        } catch (_err) {
          /* ignore if audit table unavailable */
        }
      }

      const nextStatus = this.getStatus({ nowMs, persistClock: false });
      this.lastKnownValid = nextStatus.valid;
      if (typeof this.onChange === 'function') {
        this.onChange(nextStatus);
      }
      return nextStatus;
    } finally {
      this.activating = false;
    }
  }

  /**
   * Non-blocking periodic background check (runs on startup + every hour).
   * Fires `onWarning` at most once per Algeria calendar day when <= 7 days remain,
   * and fires `onExpired` / `onChange` immediately upon crossing expiration.
   */
  checkPeriodic(options = {}) {
    const nowMs = options.nowMs !== undefined ? Number(options.nowMs) : this.clock();
    const status = this.getStatus({ nowMs, persistClock: true });

    const transitionedToInvalid = this.lastKnownValid === true && !status.valid;
    const transitionedState = this.lastKnownValid !== null && this.lastKnownValid !== status.valid;
    this.lastKnownValid = status.valid;

    if (transitionedToInvalid && typeof this.onExpired === 'function') {
      this.onExpired(status);
    }
    if (transitionedState && typeof this.onChange === 'function') {
      this.onChange(status);
    }

    let warnedToday = false;
    if (status.valid && status.warning_soon) {
      const todayDz = algeriaISODate(nowMs);
      const { state } = this.loadState();
      if (todayDz && state.last_warn_day_dz !== todayDz) {
        state.last_warn_day_dz = todayDz;
        this.saveState(state);
        warnedToday = true;
        if (typeof this.onWarning === 'function') {
          this.onWarning(status);
        }
      }
    }

    return { status, warnedToday, transitionedToInvalid };
  }

  startPeriodicCheck() {
    this.stopPeriodicCheck();
    const intervalMs = Math.max(1, this.checkIntervalMinutes) * 60 * 1000;
    this.periodicTimer = setInterval(() => {
      setImmediate(() => {
        try {
          this.checkPeriodic();
        } catch (err) {
          console.error('[license] periodic check error:', err.message);
        }
      });
    }, intervalMs);
    if (this.periodicTimer && typeof this.periodicTimer.unref === 'function') {
      this.periodicTimer.unref();
    }
    return this.periodicTimer;
  }

  stopPeriodicCheck() {
    if (this.periodicTimer) {
      clearInterval(this.periodicTimer);
      this.periodicTimer = null;
    }
  }
}

const defaultManager = new LicenseManager();

module.exports = {
  EMBEDDED_PUBLIC_KEY_SPKI_B64,
  DOMAIN_PREFIX,
  TOKEN_VERSION,
  FLAG_MACHINE_BOUND,
  SAFE_ALPHABET,
  PLAN_TO_TAG,
  TAG_TO_PLAN,
  REG_LICENSE_KEY,
  REG_LICENSE_VALUE,
  PLANS,
  LICENSE_BIND_TO_MACHINE,
  TRIAL_DAYS,
  LICENSE_WARN_DAYS,
  LICENSE_CHECK_INTERVAL_MINUTES,
  LICENSE_CLOCK_SKEW_MINUTES,
  LicenseManager,
  createLicenseManager: (opts) => new LicenseManager(opts),
  cleanLicenseInput,
  formatLicenseGroups,
  encodeSafeBase32,
  decodeSafeBase32,
  normalizeMachineFingerprint,
  computeMachineFingerprint,
  verifySignedLicenseCode,
  userMessage,
  configure: (opts) => defaultManager.configure(opts),
  getStatus: (opts) => defaultManager.getStatus(opts),
  isLicenseValid: (opts) => defaultManager.isLicenseValid(opts),
  is_license_valid: (opts) => defaultManager.isLicenseValid(opts),
  requireValidLicense: (opts) => defaultManager.requireValidLicense(opts),
  activate: (code, opts) => defaultManager.activate(code, opts),
  checkPeriodic: (opts) => defaultManager.checkPeriodic(opts),
  startPeriodicCheck: () => defaultManager.startPeriodicCheck(),
  stopPeriodicCheck: () => defaultManager.stopPeriodicCheck(),
  getMachineId: () => defaultManager.getMachineId(),
};
