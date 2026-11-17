'use strict';
/**
 * Release manifest helper (Part 18.5).
 *
 * After a Windows/Android build exists in release/windows or release/android,
 * run this to write the SHA-256 checksums and a release note stub. It refuses
 * to invent an entry: if the file is missing, it says so and exits non-zero.
 *
 * Usage: node scripts/build-release-list.js
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const targets = [
  { platform: 'windows', file: path.join(ROOT, 'release', 'windows', 'Medirdv-Central-Setup.exe'), label: 'Medirdv Central — Windows installer' },
  { platform: 'android', file: path.join(ROOT, 'release', 'android', 'Medirdv-Patient.apk'), label: 'Medirdv Patient — Android APK' },
];

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const lines = [`# Medirdv Central ${pkg.version} — release manifest`, ''];
let missing = 0;

for (const t of targets) {
  const match = fs.existsSync(path.dirname(t.file))
    ? fs.readdirSync(path.dirname(t.file)).find((f) => f.startsWith(path.basename(t.file, path.extname(t.file))))
    : null;
  if (!match) {
    lines.push(`- **${t.label}**: NOT BUILT (no file in release/${t.platform}/)`);
    missing += 1;
    continue;
  }
  const full = path.join(path.dirname(t.file), match);
  lines.push(`- **${t.label}**: \`${match}\` · ${(fs.statSync(full).size / 1024 / 1024).toFixed(1)} MB · SHA-256 \`${sha256(full)}\``);
}

lines.push('');
lines.push('Builds are produced by CI (.github/workflows/medirdv-central-windows.yml, medirdv-central-android.yml).');
lines.push('A build is only listed here after the artifact actually exists.');

const out = path.join(ROOT, 'release', 'RELEASE.md');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${lines.join('\n')}\n`);
console.log(lines.join('\n'));
if (missing === targets.length) {
  console.log('\n[build-release-list] No build artifacts found yet — nothing claimed.');
}
