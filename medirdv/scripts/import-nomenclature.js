#!/usr/bin/env node
'use strict';
/**
 * CLI importer for the Algerian National Drug Nomenclature (CSV / JSON / XLSX).
 *
 * Usage:
 *   node scripts/import-nomenclature.js <path-to-file.csv|xlsx|json> [--db <path.sqlite>] [--verified]
 */

const path = require('node:path');
const os = require('node:os');
const db = require('../src/main/db');
const nomenclature = require('../src/main/services/nomenclature');

function parseArgs(argv) {
  const args = argv.slice(2);
  let filePath = '';
  let dbPath = '';
  let verified = false;

  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--db' && args[i + 1]) {
      dbPath = args[i + 1];
      i += 1;
    } else if (a === '--verified') {
      verified = true;
    } else if (!a.startsWith('-')) {
      filePath = a;
    }
  }
  return { filePath, dbPath, verified };
}

function main() {
  const { filePath, dbPath, verified } = parseArgs(process.argv);
  if (!filePath) {
    console.error('Usage: node scripts/import-nomenclature.js <file.csv|xlsx|json> [--db <path.sqlite>] [--verified]');
    process.exit(1);
  }

  const targetDb =
    dbPath ||
    path.join(
      process.env.APPDATA || path.join(os.homedir(), '.config'),
      'MediRDV',
      'data',
      'medirdv.sqlite',
    );

  db.open(path.resolve(targetDb));
  try {
    const res = nomenclature.importNomenclature({
      filePath: path.resolve(filePath),
      mark_verified: verified,
      source: 'nomenclature_cli',
    });
    console.log(
      `[nomenclature] Done — imported: ${res.imported}, updated: ${res.updated}, skipped: ${res.skipped} (${targetDb})`,
    );
  } finally {
    db.close();
  }
}

if (require.main === module) {
  main();
}

module.exports = { parseArgs };
