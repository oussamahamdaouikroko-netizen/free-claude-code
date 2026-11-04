#!/usr/bin/env node
/**
 * Applique les migrations puis affiche la version du schéma.
 * Usage : npm run migrate
 */

import { closeDatabase, migrate, openDatabase, schemaVersion } from '../src/db.js';
import { validateConfig } from '../src/config.js';
import { seedTemplates } from '../src/modules/notifications/service.js';

async function main() {
  validateConfig();
  await openDatabase();
  const applied = await migrate();
  await seedTemplates();
  console.log(applied.length ? `[migrate] appliquées: ${applied.join(', ')}` : '[migrate] déjà à jour');
  console.log(`[migrate] version du schéma: ${await schemaVersion()}`);
  await closeDatabase();
}

main().catch((error) => {
  console.error('[migrate] échec:', error.message);
  process.exit(1);
});
