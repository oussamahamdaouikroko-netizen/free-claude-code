'use strict';
/**
 * Shared test helpers: throwaway databases and Windows-safe cleanup.
 *
 * On Windows, SQLite keeps the .sqlite/-wal/-shm files locked until the
 * connection is closed, so deleting a data folder needs retries.
 */

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const db = require('../src/main/db');
const license = require('../src/main/services/license');

const TEST_KEYPAIR = crypto.generateKeyPairSync('ed25519');
const TEST_PRIVATE_PEM = TEST_KEYPAIR.privateKey.export({ type: 'pkcs8', format: 'pem' });
const TEST_PUBLIC_B64 = TEST_KEYPAIR.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

function signTestCode({
  plan = '1Y',
  planDays = license.PLANS[plan] || 365,
  machineId = '',
  issuedSec = Math.floor(Date.now() / 1000),
  licenseId = crypto.randomBytes(8),
  privateKey = TEST_KEYPAIR.privateKey,
} = {}) {
  const norm = machineId ? license.normalizeMachineFingerprint(machineId) : null;
  const hasMachine = Boolean(norm);
  const payload = Buffer.alloc(hasMachine ? 25 : 17);
  payload.writeUInt8(license.TOKEN_VERSION, 0);
  payload.writeUInt8(hasMachine ? license.FLAG_MACHINE_BOUND : 0, 1);
  licenseId.copy(payload, 2, 0, 8);
  payload.writeUInt8(license.PLAN_TO_TAG[plan] || 0, 10);
  payload.writeUInt16BE(planDays, 11);
  payload.writeUInt32BE(issuedSec >>> 0, 13);
  if (hasMachine) {
    norm.bytes.copy(payload, 17, 0, 8);
  }
  const signedMessage = Buffer.concat([license.DOMAIN_PREFIX, payload]);
  const sig = crypto.sign(null, signedMessage, privateKey);
  return license.formatLicenseGroups(license.encodeSafeBase32(Buffer.concat([payload, sig])));
}

function createFakeRegRunner(initialRegValue = null) {
  const values = {};
  if (initialRegValue !== null) {
    values[`${license.REG_LICENSE_KEY}::${license.REG_LICENSE_VALUE}`] = String(initialRegValue);
  }
  return {
    values,
    runner(args) {
      const action = String(args[0] || '').toLowerCase();
      const key = args[1];
      const vIdx = args.indexOf('/v');
      const valName = vIdx >= 0 ? args[vIdx + 1] : '';
      const slot = `${key}::${valName}`;
      if (action === 'query') {
        if (key && key.includes('Cryptography') && valName === 'MachineGuid') {
          return `    MachineGuid    REG_SZ    {8899AABB-CCDD-EEFF-0011-223344556677}\r\n`;
        }
        if (Object.prototype.hasOwnProperty.call(values, slot)) {
          return `    ${valName}    REG_SZ    ${values[slot]}\r\n`;
        }
        throw new Error('Registry value not found');
      }
      if (action === 'add') {
        const dIdx = args.indexOf('/d');
        const data = dIdx >= 0 ? args[dIdx + 1] : '';
        values[slot] = String(data);
        return 'The operation completed successfully.\r\n';
      }
      if (action === 'delete') {
        delete values[slot];
        return 'The operation completed successfully.\r\n';
      }
      throw new Error('Unsupported reg command');
    },
  };
}

function safeRemove(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch (error) {
    // A leftover temp folder must never turn a green run red.
    console.warn(`[test] could not remove ${target}: ${error.code || error.message}`);
  }
}

function activateTestLicense(storageDir, options = {}) {
  const fakeReg = createFakeRegRunner();
  license.configure({
    storageDir,
    publicKeySpkiB64: TEST_PUBLIC_B64,
    machineFingerprint: 'A1B2-C3D4-E5F6-0718',
    regRunner: fakeReg.runner,
    useRegistry: true,
    ...options,
  });
  if (!options.unlicensed) {
    const fp = license.getMachineId();
    const nowMs = options.clock ? options.clock() : Date.now();
    const code = signTestCode({
      plan: '1Y',
      machineId: fp,
      issuedSec: Math.floor(nowMs / 1000),
    });
    license.activate(code, { nowMs, audit: false });
  }
  return fakeReg;
}

function useTempDb(options = {}) {
  db.closeAndReset();
  const base = path.join(
    os.tmpdir(),
    `dentardv-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  fs.mkdirSync(base, { recursive: true });
  const file = path.join(base, 'medirdv.sqlite');
  db.open(file);

  const fakeReg = activateTestLicense(base, options);

  return {
    file,
    dir: base,
    fakeReg,
    cleanup() {
      license.stopPeriodicCheck();
      try {
        db.close();
      } catch (error) {
        /* already closed */
      }
      safeRemove(base);
    },
  };
}

/** Today's local date, the same way the services see it. */
function today() {
  return require('../src/main/utils/dates').toISODate();
}

module.exports = {
  useTempDb,
  today,
  safeRemove,
  TEST_KEYPAIR,
  TEST_PRIVATE_PEM,
  TEST_PUBLIC_B64,
  signTestCode,
  createFakeRegRunner,
  activateTestLicense,
};
