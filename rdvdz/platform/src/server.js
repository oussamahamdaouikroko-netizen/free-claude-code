/**
 * Point d'entrée du serveur.
 *
 * Démarrage : configuration validée → base ouverte → migrations → modèles de
 * notification → worker → écoute HTTP. Toute incohérence de configuration
 * arrête le processus AVANT d'accepter la moindre requête.
 */

import { buildApp } from './app.js';
import { config, validateConfig } from './config.js';
import { closeDatabase, migrate, openDatabase } from './db.js';
import { releaseExpiredHolds } from './modules/booking/service.js';
import { seedTemplates, sendDueReminders } from './modules/notifications/service.js';

/** Worker minimal : verrous expirés + rappels. Aucune dépendance externe. */
function startWorker(logger) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const released = await releaseExpiredHolds();
      if (released.released > 0) logger.info(`[worker] ${released.released} verrou(s) libéré(s)`);
      const reminders = await sendDueReminders();
      if (reminders.sent > 0) logger.info(`[worker] ${reminders.sent} rappel(s) programmé(s)`);
    } catch (error) {
      logger.error(`[worker] ${error.message}`);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, 60_000);
  if (timer.unref) timer.unref();
  setTimeout(tick, 5_000).unref?.();
  return () => clearInterval(timer);
}

async function main() {
  validateConfig();
  await openDatabase();
  const applied = await migrate();
  await seedTemplates();

  const app = await buildApp();
  if (applied.length) app.log.info(`[db] migrations appliquées: ${applied.join(', ')}`);

  const stopWorker = startWorker({
    info: (message) => app.log.info(message),
    error: (message) => app.log.error(message),
  });

  await app.listen({ port: config.port, host: config.host });
  app.log.info(
    `[rdvdz] API prête — paiements: ${config.payments.provider} · OTP debug: ${config.notifications.otpDebug} · ` +
      `télémédecine payante: ${config.compliance.telemedicinePaidEnabled}`,
  );

  const shutdown = async (signal) => {
    app.log.info(`[rdvdz] arrêt (${signal})`);
    stopWorker();
    await app.close();
    await closeDatabase();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error) => {
  console.error('[rdvdz] démarrage impossible:', error.message);
  process.exit(1);
});
