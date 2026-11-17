'use strict';
/**
 * Minimal .env loader (no dependencies).
 *
 * Loads KEY=VALUE lines from `./.env` into process.env without overwriting
 * variables that are already set. Supports `#` comments, blank lines, and
 * optional single/double quotes around values. Never logs values.
 */
const fs = require('node:fs');
const path = require('node:path');

function loadEnv(filePath = path.resolve(process.cwd(), '.env')) {
  if (!fs.existsSync(filePath)) return { loaded: false, path: filePath };
  const text = fs.readFileSync(filePath, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return { loaded: true, path: filePath };
}

module.exports = { loadEnv };
