/**
 * Configuration de l'application.
 *
 * Toutes les valeurs viennent de l'environnement, avec des valeurs par défaut
 * SÛRES (pas de secret en dur, fonctionnalités sensibles désactivées).
 * La configuration est validée au démarrage : une valeur incohérente arrête le
 * processus au lieu de produire un comportement silencieusement faux.
 */

// Doit rester le PREMIER import : il remplit `process.env` depuis `.env` avant
// que la configuration ne soit lue.
import './env.js';
import { randomBytes } from 'node:crypto';

const env = process.env;

function bool(name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw === '1' || raw.toLowerCase() === 'true' || raw.toLowerCase() === 'yes';
}

function int(name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) throw new Error(`CONFIG_INVALID: ${name} doit être un entier`);
  return value;
}

function str(name, fallback = '') {
  const raw = env[name];
  return raw === undefined || raw === '' ? fallback : raw;
}

export const isTest = env.NODE_ENV === 'test';

/** Secret de développement déterministe : jamais utilisé hors test. */
const devSecret = 'dev-only-insecure-secret-do-not-use-in-production-0123456789';

function resolveSecret() {
  const raw = str('APP_SECRET');
  if (raw && raw.length >= 32) return raw;
  if (isTest) return devSecret;
  throw new Error(
    'CONFIG_INVALID: APP_SECRET est obligatoire (≥ 32 caractères). ' +
      'Générer avec: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64url\'))"',
  );
}

export const config = {
  nodeEnv: str('NODE_ENV', 'development'),
  isTest,
  isProduction: env.NODE_ENV === 'production',
  port: int('PORT', 8080),
  host: str('HOST', '0.0.0.0'),
  appUrl: str('PUBLIC_WEB_URL', 'http://localhost:8080'),
  logLevel: str('LOG_LEVEL', isTest ? 'silent' : 'info'),

  db: {
    driver: str('DB_DRIVER', env.DATABASE_URL ? 'pg' : 'pglite'),
    url: str('DATABASE_URL'),
    pgliteDir: str('PGLITE_DIR', './.data/pglite'),
  },

  security: {
    appSecret: resolveSecret(),
    cookieSecure: bool('COOKIE_SECURE', false),
    sessionTtlHours: int('SESSION_TTL_HOURS', 168),
    documentLinkTtlSeconds: int('DOCUMENT_LINK_TTL_SECONDS', 300),
    sessionCookieName: 'rdv_session',
    csrfHeader: 'x-csrf-token',
    maxFailedLogins: 5,
    lockoutMinutes: 15,
    otpTtlMinutes: 5,
    maxOtpAttempts: 5,
  },

  compliance: {
    allowCrossBorder: bool('ALLOW_CROSS_BORDER', false),
    telemedicineEnabled: bool('TELEMEDICINE_ENABLED', true),
    telemedicinePaidEnabled: bool('TELEMEDICINE_PAID_ENABLED', false),
    walletEnabled: bool('WALLET_ENABLED', false),
  },

  payments: {
    provider: str('PAYMENTS_PROVIDER', 'sandbox'),
    sandboxAllowed: bool('PAYMENTS_SANDBOX_ALLOWED', !env.NODE_ENV || env.NODE_ENV !== 'production'),
    chargily: {
      secretKey: str('CHARGILY_SECRET_KEY'),
      baseUrl: str('CHARGILY_BASE_URL', 'https://pay.chargily.net/test/api/v2'),
      webhookUrl: str('CHARGILY_WEBHOOK_URL'),
    },
  },

  notifications: {
    whatsapp: {
      provider: str('WHATSAPP_PROVIDER', 'click_to_chat'),
      phoneNumberId: str('WHATSAPP_PHONE_NUMBER_ID'),
      token: str('WHATSAPP_TOKEN'),
      verifyToken: str('WHATSAPP_VERIFY_TOKEN'),
      businessNumber: str('WHATSAPP_BUSINESS_NUMBER', ''),
    },
    smtpUrl: str('SMTP_URL'),
    smsProvider: str('SMS_PROVIDER', 'dev'),
    otpDebug: bool('OTP_DEBUG', isTest),
  },

  storage: {
    driver: str('STORAGE_DRIVER', 'local'),
    dir: str('STORAGE_DIR', './.data/documents'),
    encryptionKey: str('STORAGE_ENCRYPTION_KEY') || (isTest ? randomBytes(32).toString('hex') : ''),
  },

  booking: {
    holdTtlMinutes: 10,
    maxSlotsPerRequest: 200,
  },
};

/** Vérifications de cohérence — exécutées une fois au démarrage. */
export function validateConfig() {
  const problems = [];

  if (config.isProduction) {
    if (!config.security.cookieSecure) problems.push('COOKIE_SECURE doit être true en production');
    if (config.compliance.allowCrossBorder) {
      problems.push(
        'ALLOW_CROSS_BORDER=true exige une autorisation ANPDP (loi 18-07 mod. 25-11) : à documenter avant activation',
      );
    }
    if (config.payments.provider === 'sandbox') {
      problems.push('PAYMENTS_PROVIDER=sandbox est interdit en production (paiements simulés)');
    }
    if (config.notifications.otpDebug) problems.push('OTP_DEBUG doit être false en production');
    if (!config.storage.encryptionKey) problems.push('STORAGE_ENCRYPTION_KEY est obligatoire en production');
  }

  if (config.payments.provider === 'chargily' && !config.payments.chargily.secretKey) {
    problems.push('PAYMENTS_PROVIDER=chargily exige CHARGILY_SECRET_KEY');
  }

  if (config.compliance.telemedicinePaidEnabled && !config.compliance.telemedicineEnabled) {
    problems.push('TELEMEDICINE_PAID_ENABLED=true est incohérent avec TELEMEDICINE_ENABLED=false');
  }

  if (problems.length) throw new Error(`CONFIG_INVALID:\n - ${problems.join('\n - ')}`);
  return true;
}
