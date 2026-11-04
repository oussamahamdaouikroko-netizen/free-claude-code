/**
 * Environnement de test — DOIT être importé en premier dans chaque fichier de
 * test : les modules ES sont évalués dans l'ordre des imports, et la
 * configuration lit `process.env` à son chargement.
 */

process.env.NODE_ENV = 'test';
process.env.DB_DRIVER = 'pglite';
process.env.PGLITE_DIR = ':memory:';
process.env.PAYMENTS_PROVIDER = 'sandbox';
process.env.PAYMENTS_SANDBOX_ALLOWED = 'true';
// Clé de test Chargily : permet de vérifier la vraie logique HMAC du webhook
// sans jamais appeler le réseau (le fetch est remplacé dans les tests).
process.env.CHARGILY_SECRET_KEY = 'test_secret_webhook_key';
process.env.CHARGILY_BASE_URL = 'https://pay.chargily.net/test/api/v2';
process.env.OTP_DEBUG = 'true';
process.env.STORAGE_DIR = './.data/test-documents';
process.env.LOG_LEVEL = 'silent';
process.env.TELEMEDICINE_ENABLED = 'true';
process.env.TELEMEDICINE_PAID_ENABLED = 'false';
process.env.WHATSAPP_PROVIDER = 'click_to_chat';

export const TEST_ENV_READY = true;
