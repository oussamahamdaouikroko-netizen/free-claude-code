'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  LicenseManager,
  DOMAIN_PREFIX,
  TOKEN_VERSION,
  FLAG_MACHINE_BOUND,
  PLAN_TO_TAG,
  encodeSafeBase32,
  normalizeMachineFingerprint,
} = require('../src/main/services/license');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dentardv-lic-test-'));
}

function issueKey(privateKey, { machineId, plan = '1Y', issuedAtSec, durationDays = 365 }) {
  const mf = normalizeMachineFingerprint(machineId);
  const payload = Buffer.alloc(25);
  payload.writeUInt8(TOKEN_VERSION, 0);
  payload.writeUInt8(FLAG_MACHINE_BOUND, 1);
  crypto.randomBytes(8).copy(payload, 2);
  payload.writeUInt8(PLAN_TO_TAG[plan] ?? 0, 10);
  payload.writeUInt16BE(durationDays, 11);
  payload.writeUInt32BE(issuedAtSec >>> 0, 13);
  mf.bytes.copy(payload, 17);

  const msg = Buffer.concat([DOMAIN_PREFIX, payload]);
  const sig = crypto.sign(null, msg, privateKey);
  return encodeSafeBase32(Buffer.concat([payload, sig]));
}

test('DentaRDV LicenseManager enforces 7-day trial, Read-Only expiry, Ed25519 verification, anti-replay & bidi paste cleaning', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pubSpkiB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

  // Second independent keypair (simulating MediRDV keypair) to prove strict cross-app isolation
  const otherPair = crypto.generateKeyPairSync('ed25519');

  const dir = makeTempDir();
  let fakeNow = Date.UTC(2026, 9, 26, 10, 0, 0);

  try {
    const mgr = new LicenseManager({
      publicKeySpkiB64: pubSpkiB64,
      clock: () => fakeNow,
      useRegistry: false,
      dbActivityProvider: () => ({ utcExactMs: 0, localNaiveMs: 0 }),
    });
    mgr.init({ dataDir: dir, demo: false, nowFn: () => fakeNow, publicKeySpkiB64: pubSpkiB64, useRegistry: false, dbActivityProvider: () => ({ utcExactMs: 0, localNaiveMs: 0 }) });

    // 1. Fresh install starts in 7-day trial
    const initial = mgr.getStatus();
    assert.equal(initial.state, 'trial');
    assert.equal(initial.readOnly, false);
    assert.equal(initial.daysRemaining, 7);
    assert.doesNotThrow(() => mgr.requireValidLicense());

    // 2. Advance clock 8 days -> trial expires -> Read-Only mode
    fakeNow += 8 * 86_400_000;
    const expired = mgr.getStatus();
    assert.equal(expired.state, 'expired');
    assert.equal(expired.readOnly, true);
    assert.throws(() => mgr.requireValidLicense(), (err) => err.code === 'LICENSE_REQUIRED');

    const issuedAtSec = Math.floor(fakeNow / 1000);

    // 3. Rejects key signed by another keypair (e.g. MediRDV keypair)
    const wrongAppKey = issueKey(otherPair.privateKey, {
      machineId: initial.machineCode,
      plan: '1Y',
      issuedAtSec,
      durationDays: 365,
    });
    assert.throws(() => mgr.activate(wrongAppKey), (err) => err.code === 'INVALID_CODE');

    // 4. Rejects key bound to a different machine code
    const wrongMachineKey = issueKey(privateKey, {
      machineId: 'AAAA-BBBB-CCCC-DDDD',
      plan: '1Y',
      issuedAtSec,
      durationDays: 365,
    });
    assert.throws(() => mgr.activate(wrongMachineKey), (err) => err.code === 'WRONG_MACHINE');

    // 5. Rejects pasting the Machine ID itself
    assert.throws(() => mgr.activate(initial.machineCode), (err) => err.code === 'PASTED_MACHINE_ID');

    // 6. Accepts valid DentaRDV 1Y key even when wrapped in WhatsApp RTL bidi marks & extra text
    const validKey = issueKey(privateKey, {
      machineId: initial.machineCode,
      plan: '1Y',
      issuedAtSec,
      durationDays: 365,
    });

    const messyPaste = `\u200Fكود التفعيل الخاص بك:\n\u202A${validKey}\u202C\nشكرا`;
    const activated = mgr.activate(messyPaste);
    assert.equal(activated.state, 'activated');
    assert.equal(activated.plan, '1Y');
    assert.equal(activated.readOnly, false);
    assert.ok(activated.daysRemaining >= 365);
    assert.doesNotThrow(() => mgr.requireValidLicense());

    // 7. Anti-replay: using the exact same key a second time throws ALREADY_USED
    assert.throws(() => mgr.activate(validKey), (err) => err.code === 'ALREADY_USED');

    // 8. Clock-rollback protection (> tolerance backward enters Read-Only until clock restored)
    fakeNow -= 4 * 86_400_000;
    const rolledBack = mgr.getStatus();
    assert.equal(rolledBack.state, 'expired');
    assert.equal(rolledBack.status, 'clock_tampered');
    assert.equal(rolledBack.readOnly, true);

    fakeNow += 4 * 86_400_000;
    assert.equal(mgr.getStatus().state, 'activated');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
