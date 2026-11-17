'use strict';
/**
 * Emergency administrator reset (desktop standalone data folder).
 *
 * Use this only if you still have the 1.1.0 build installed, which generated a
 * random administrator password that was never shown. It sets the credentials
 * you choose for the existing account list — no data is deleted.
 *
 * Usage (Windows, with the app closed):
 *   "%LOCALAPPDATA%\Programs\Medirdv Central\resources\server\..."  (not needed)
 *   Simpler: run this with the repository, pointing at the data folder:
 *
 *   node scripts/reset-admin.js --data "C:\Users\<you>\AppData\Roaming\Medirdv Central\data" \
 *        --email you@example.dz --password "your-new-password"
 *
 * If you are on 1.2.0 or later you do not need this: the app asks you to
 * create the first account on launch.
 */
const fs = require('node:fs');
const path = require('node:path');

function arg(flag, fallback = '') {
  const i = process.argv.indexOf(flag);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const dataDir = arg('--data', process.env.MEDIRDV_DATA_DIR || '');
const fileName = arg('--database', 'medirdv-central.sqlite');
const email = arg('--email', '').trim();
const password = arg('--password', '');

if (!dataDir || !email || !password) {
  console.error('Usage: node scripts/reset-admin.js --data <data folder> --email <email> --password <new password>');
  process.exit(2);
}
if (password.length < 8) {
  console.error('Password must be at least 8 characters.');
  process.exit(2);
}

const dbFile = path.isAbsolute(fileName) ? fileName : path.join(dataDir, fileName);
if (!fs.existsSync(dbFile)) {
  console.error(`No database found at ${dbFile}`);
  console.error('Check the path: in the app, Help → Data folder… shows it.');
  process.exit(1);
}

process.env.MEDIRDV_DB_PATH = dbFile;
const db = require('../src/db');
const auth = require('../src/auth');

db.open();
const users = db.getDb().prepare('SELECT id, email, role FROM users ORDER BY id').all();
if (users.length === 0) {
  console.log('This database has no accounts yet. Just start the app and create one.');
  db.close();
  process.exit(0);
}

const existing = auth.getUserByEmail(email);
if (existing) {
  auth.changePassword(existing.id, { newPassword: password, requireCurrent: false });
  console.log(`Password reset for ${existing.email} (${existing.role}).`);
} else {
  // Keep exactly one super administrator: promote the first account.
  const target = users.find((user) => user.role === 'super_admin') || users[0];
  db.getDb().prepare('UPDATE users SET email = ? WHERE id = ?').run(email, target.id);
  auth.changePassword(target.id, { newPassword: password, requireCurrent: false });
  console.log(`Updated the administrator account to ${email}.`);
}

console.log('You can now sign in with the email and password you just set.');
console.log('All existing data was preserved; no records were deleted.');
db.close();
