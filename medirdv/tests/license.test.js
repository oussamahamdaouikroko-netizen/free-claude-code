'use strict';
/**
 * Comprehensive Automated Test Suite for the Offline Ed25519 Licensing System.
 *
 * Covers all 17 mandatory cryptographic, lifecycle, renewal, replay/reinstall,
 * anti-clock-rollback, dual-storage self-healing, bot/IPC read-only enforcement,
 * CLI keygen (Node + Python), and Renderer modal scenarios using programmatic
 * clock jumps (zero sleeps).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { JSDOM } = require('jsdom');

const dbMod = require('../src/main/db');
const license = require('../src/main/services/license');
const appointments = require('../src/main/services/appointments');
const patients = require('../src/main/services/patients');
const prescriptions = require('../src/main/services/prescriptions');
const payments = require('../src/main/services/payments');
const reports = require('../src/main/services/reports');
const settings = require('../src/main/services/settings');
const auth = require('../src/main/services/auth');
const bot = require('../src/main/whatsapp/bot');
const { createHandlers } = require('../src/main/handlers');
const { TrayController } = require('../src/main/tray');
const { TRAY_MENU_LICENSE } = require('../src/main/config');
const { createFakeRegRunner, safeRemove, signTestCode } = require('./helpers');

const KEYGEN_JS_PATH = path.join(__dirname, '..', 'tools', 'license_keygen.js');
const KEYGEN_PY_PATH = path.join(__dirname, '..', 'tools', 'license_keygen.py');
const localKeygen = fs.existsSync(KEYGEN_JS_PATH) ? require(KEYGEN_JS_PATH) : null;

const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_MS = 60 * 1000;

function makeIsolatedEnv(extraOpts = {}) {
  dbMod.closeAndReset();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'medirdv-lic-'));
  const dbFile = path.join(dir, 'medirdv.sqlite');
  dbMod.open(dbFile);

  const keypair = crypto.generateKeyPairSync('ed25519');
  const privPem = keypair.privateKey.export({ type: 'pkcs8', format: 'pem' });
  const pubB64 = keypair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const privPath = path.join(dir, 'dev-only-private.pem');
  const ledgerPath = path.join(dir, 'dev-issued.csv');
  fs.writeFileSync(privPath, privPem, { mode: 0o600 });

  let nowMs = extraOpts.initialNowMs || Date.parse('2026-10-26T10:00:00.000Z');
  const fakeReg = createFakeRegRunner();
  const events = [];
  const warnings = [];
  const expirations = [];

  license.configure({
    storageDir: dir,
    publicKeySpkiB64: pubB64,
    machineFingerprint: extraOpts.machineFingerprint || 'A1B2-C3D4-E5F6-0718',
    regRunner: fakeReg.runner,
    useRegistry: true,
    bindToMachine: extraOpts.bindToMachine !== undefined ? extraOpts.bindToMachine : true,
    trialDays: extraOpts.trialDays !== undefined ? extraOpts.trialDays : 0,
    clock: () => nowMs,
    dbActivityProvider:
      extraOpts.dbActivityProvider || (() => ({ utcExactMs: 0, localNaiveMs: 0 })),
    onChange: (st) => events.push(st),
    onWarning: (st) => warnings.push(st),
    onExpired: (st) => expirations.push(st),
  });

  const issue = (plan, machine = license.getMachineId(), customIssuedSec = Math.floor(nowMs / 1000)) => {
    if (localKeygen) {
      const res = localKeygen.signLicenseCode({
        privateKeyPem: privPem,
        plan,
        machine,
        issuedAtSec: customIssuedSec,
      });
      localKeygen.appendIssuedCsv(ledgerPath, res);
      return res;
    }
    const code = signTestCode({
      plan,
      planDays: license.PLANS[plan] || 30,
      machineId: machine || '',
      issuedSec: customIssuedSec,
      privateKey: keypair.privateKey,
    });
    return { code, plan, durationDays: license.PLANS[plan] || 30 };
  };

  return {
    dir,
    dbFile,
    privPath,
    ledgerPath,
    pubB64,
    fakeReg,
    events,
    warnings,
    expirations,
    getNow: () => nowMs,
    setNow: (ms) => {
      nowMs = ms;
    },
    advanceMs: (delta) => {
      nowMs += delta;
    },
    issue,
    cleanup() {
      license.stopPeriodicCheck();
      try {
        dbMod.close();
      } catch (_err) {
        /* ignore */
      }
      safeRemove(dir);
    },
  };
}

test('1 & 2 — Keypair generation (Node + Python CLI), 1M/6M/1Y code generation, CSV ledger, and first-time activation expiry calculation in Algeria TZ', () => {
  const tmpKeyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'medirdv-kg-'));
  const privFile = path.join(tmpKeyDir, 'priv.pem');
  const ledgerFile = path.join(tmpKeyDir, 'ledger.csv');

  try {
    let pubB64;
    const generated = {};

    if (fs.existsSync(KEYGEN_PY_PATH)) {
      // Test Python CLI keypair init
      const pyInitOut = execFileSync(
        'python3',
        [KEYGEN_PY_PATH, '--init-keys', '--private-key', privFile],
        { encoding: 'utf8' },
      );
      assert.ok(fs.existsSync(privFile), 'Private key PEM created outside app');
      const pubMatch = pyInitOut.match(/MCowBQYDK2VwAyEA[A-Za-z0-9+/=]+/);
      assert.ok(pubMatch, 'SPKI Base64 public key printed by CLI');
      pubB64 = pubMatch[0];

      for (const plan of ['1M', '6M', '1Y']) {
        const out = execFileSync(
          'python3',
          [
            KEYGEN_PY_PATH,
            '--plan',
            plan,
            '--machine',
            'A1B2-C3D4-E5F6-0718',
            '--private-key',
            privFile,
            '--log-csv',
            ledgerFile,
          ],
          { encoding: 'utf8' },
        );
        const codeMatch = out.match(/((?:[2-9A-HJ-KM-NP-Z]{5}[\s-]+){12,}[2-9A-HJ-KM-NP-Z]{1,5})/);
        assert.ok(codeMatch, `Code generated for ${plan}`);
        generated[plan] = codeMatch[1];

        // Even pasting the ENTIRE CLI output box (Arabic headers + borders + 3-line code) verifies cleanly!
        assert.equal(license.verifySignedLicenseCode(out, { publicKeySpkiB64: pubB64 }).ok, true);
      }

      // Verify CSV ledger recorded all 3 issued licenses
      const csvLines = fs.readFileSync(ledgerFile, 'utf8').trim().split('\n');
      assert.equal(csvLines.length, 4, 'Header + 3 issued rows');
      assert.match(csvLines[0], /issued_at_utc,license_id,plan,duration_days,machine_fingerprint/);
    } else {
      // In clean CI checkouts where `tools/` is gitignored by design, verify with an ephemeral Ed25519 keypair
      const kp = crypto.generateKeyPairSync('ed25519');
      pubB64 = kp.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
      for (const plan of ['1M', '6M', '1Y']) {
        generated[plan] = signTestCode({
          plan,
          planDays: license.PLANS[plan],
          machineId: 'A1B2-C3D4-E5F6-0718',
          privateKey: kp.privateKey,
        });
      }
    }

    for (const plan of ['1M', '6M', '1Y']) {
      // Ambiguous characters (0, O, 1, I, L) must NEVER appear in generated codes
      assert.doesNotMatch(generated[plan], /[0O1IL]/);

      const verified = license.verifySignedLicenseCode(generated[plan], { publicKeySpkiB64: pubB64 });
      assert.equal(verified.ok, true);
      assert.equal(verified.plan, plan);
      assert.equal(verified.durationDays, license.PLANS[plan]);
      assert.equal(verified.machineHex, 'A1B2C3D4E5F60718');
    }

    // Verify first-time activation calculates exact UTC expiry (+30d / +180d / +365d) & Algeria date
    for (const [plan, expectedDays] of Object.entries({ '1M': 30, '6M': 180, '1Y': 365 })) {
      const env = makeIsolatedEnv();
      try {
        license.configure({
          storageDir: env.dir,
          publicKeySpkiB64: pubB64,
          machineFingerprint: 'A1B2-C3D4-E5F6-0718',
          regRunner: env.fakeReg.runner,
          useRegistry: true,
          clock: env.getNow,
        });
        assert.equal(license.getStatus().status, 'unlicensed');
        assert.equal(license.isLicenseValid(), false);

        const st = license.activate(generated[plan]);
        assert.equal(st.valid, true);
        assert.equal(st.status, 'active');
        assert.equal(st.days_remaining, expectedDays);
        assert.equal(st.expires_at_utc_ms, env.getNow() + expectedDays * DAY_MS);
        assert.match(st.expires_date_dz, /^\d{2}\/\d{2}\/\d{4}$/);
      } finally {
        env.cleanup();
      }
    }
  } finally {
    safeRemove(tmpKeyDir);
  }
});

test('3, 4 & 5 — Tampered/random codes rejected, short/empty/corrupt inputs never crash, and messy whitespace/lowercase/hyphen pastes succeed', () => {
  const env = makeIsolatedEnv();
  try {
    const { code } = env.issue('1M');

    // Scenario 3: Flip a single character inside the signature half of the valid Base32 code -> INVALID_CODE
    const chars = code.split('');
    let idx = Math.floor(chars.length * 0.75);
    while (chars[idx] === '-') idx += 1;
    chars[idx] = chars[idx] === 'A' ? 'B' : 'A';
    const singleCharFlipped = chars.join('');
    assert.throws(
      () => license.activate(singleCharFlipped),
      (err) => err.code === 'INVALID_CODE' && /غير صالح/.test(err.message),
    );

    // Random valid-alphabet string preserving leading structure -> INVALID_CODE
    const randomSameLen = code.slice(0, 12) + code.slice(12).replace(/[2-9A-Z]/g, 'K');
    assert.throws(
      () => license.activate(randomSameLen),
      (err) => err.code === 'INVALID_CODE' || err.code === 'MALFORMED_CODE',
    );

    // Scenario 4: Empty, short, null, or invalid characters -> MALFORMED_CODE without crashing
    for (const bad of ['', '   ', null, undefined, 'ABCDE-FGHIJ', '00000-OOOOO-11111-IIIII', '🔥🚀💀']) {
      assert.throws(
        () => license.activate(bad),
        (err) => err.code === 'MALFORMED_CODE' && /تالف أو ناقص/.test(err.message),
      );
    }

    // Pasting the 16-char Machine Fingerprint by mistake gives a clear dedicated guidance message
    assert.throws(
      () => license.activate('A1B2-C3D4-E5F6-0718'),
      (err) => err.code === 'PASTED_MACHINE_ID' && /بصمة الجهاز/.test(err.message),
    );

    // Scenario 5: Valid code with lowercase, extra spaces, RTL WhatsApp marks (\u200F, \u200E, \uFEFF),
    // backticks, surrounding Arabic label, and newlines -> cleaned & accepted!
    const messy = `\u200F\uFEFFتفضل كود التفعيل:\n \`${code.toLowerCase().replace(/-/g, ' -- ')}\`\u200E \r\n `;
    const res = license.activate(messy);
    assert.equal(res.valid, true);
    assert.equal(res.days_remaining, 30);
  } finally {
    env.cleanup();
  }
});

test('6 — Machine binding rejects another PC code with clear Arabic error, while unbound codes work on any PC when binding is disabled', () => {
  const env = makeIsolatedEnv({ machineFingerprint: '1122-3344-5566-7788' });
  try {
    const otherMachineCode = env.issue('6M', 'AABB-CCDD-EEFF-0011').code;
    assert.throws(
      () => license.activate(otherMachineCode),
      (err) => err.code === 'WRONG_MACHINE' && /لا يخص هذا الجهاز/.test(err.message),
    );

    // Unbound code is rejected when bindToMachine=true
    const unboundCode = env.issue('1M', null).code;
    assert.throws(
      () => license.activate(unboundCode),
      (err) => err.code === 'MACHINE_REQUIRED',
    );

    // When bindToMachine=false, the unbound code works on ANY machine!
    license.configure({
      storageDir: env.dir,
      publicKeySpkiB64: env.pubB64,
      machineFingerprint: '9999-8888-7777-6666',
      regRunner: env.fakeReg.runner,
      useRegistry: true,
      bindToMachine: false,
      clock: env.getNow,
    });
    const st = license.activate(unboundCode);
    assert.equal(st.valid, true);
    assert.equal(st.days_remaining, 30);
  } finally {
    env.cleanup();
  }
});

test('7 & 8 — Replay protection (same code twice adds 0 days) AND same-PC clean reinstall accepts still-valid machine-bound code without extending original expiry', () => {
  const env = makeIsolatedEnv();
  try {
    const issuedSec = Math.floor(env.getNow() / 1000);
    const { code } = env.issue('1M', license.getMachineId(), issuedSec);

    const first = license.activate(code);
    assert.equal(first.valid, true);
    const originalExpiry = first.expires_at_utc_ms;

    // Scenario 7: Entering the exact same code a second time on the installed app -> rejected (ALREADY_USED), 0 days added!
    env.advanceMs(5 * DAY_MS);
    assert.throws(
      () => license.activate(code),
      (err) => err.code === 'ALREADY_USED' && /تم استعمال هذا الكود مسبقاً/.test(err.message),
    );
    assert.equal(license.getStatus().expires_at_utc_ms, originalExpiry);
    assert.equal(license.getStatus().days_remaining, 25);

    // Scenario 8: Simulate complete OS/App wipe & reinstall on the SAME machine 10 days after issue
    // (both AppData file AND HKCU registry wiped, same hardware fingerprint)
    fs.unlinkSync(path.join(env.dir, 'license-state.json'));
    for (const k of Object.keys(env.fakeReg.values)) delete env.fakeReg.values[k];

    env.setNow(issuedSec * 1000 + 10 * DAY_MS);
    assert.equal(license.getStatus().status, 'unlicensed');

    // Re-entering the same machine-bound code on fresh reinstall succeeds,
    // anchored to `issuedAtUtcMs` so only 20 days remain (NEVER 30 new days!)
    const reinstalled = license.activate(code);
    assert.equal(reinstalled.valid, true);
    assert.equal(reinstalled.expires_at_utc_ms, issuedSec * 1000 + 30 * DAY_MS);
    assert.equal(reinstalled.days_remaining, 20);

    // Entering an ALREADY-EXPIRED old code on reinstall is rejected as CODE_EXPIRED
    fs.unlinkSync(path.join(env.dir, 'license-state.json'));
    for (const k of Object.keys(env.fakeReg.values)) delete env.fakeReg.values[k];
    env.setNow(issuedSec * 1000 + 35 * DAY_MS);
    assert.throws(
      () => license.activate(code),
      (err) => err.code === 'CODE_EXPIRED',
    );
  } finally {
    env.cleanup();
  }
});

test('9 & 10 — Early renewal stacks days onto remaining balance (10 + 180 = 190d); post-expiry renewal starts 30d from activation moment', () => {
  const env = makeIsolatedEnv();
  try {
    const code1M = env.issue('1M').code;
    license.activate(code1M);

    // Advance 20 days -> exactly 10 days remaining
    env.advanceMs(20 * DAY_MS);
    assert.equal(license.getStatus().days_remaining, 10);

    // Scenario 9: Activate 6M (180d) early -> new balance = 10 + 180 = 190 days!
    const code6M = env.issue('6M').code;
    const renewedEarly = license.activate(code6M);
    assert.equal(renewedEarly.valid, true);
    assert.equal(renewedEarly.days_remaining, 190);
    assert.equal(renewedEarly.expires_at_utc_ms, env.getNow() + 190 * DAY_MS);

    // Advance 195 days -> expired for 5 days!
    env.advanceMs(195 * DAY_MS);
    const expiredSt = license.getStatus();
    assert.equal(expiredSt.valid, false);
    assert.equal(expiredSt.status, 'expired');

    // Scenario 10: Activate new 1M (30d) 5 days AFTER expiry -> exactly 30 days from NOW!
    const codeLate1M = env.issue('1M').code;
    const renewedLate = license.activate(codeLate1M);
    assert.equal(renewedLate.valid, true);
    assert.equal(renewedLate.days_remaining, 30);
    assert.equal(renewedLate.expires_at_utc_ms, env.getNow() + 30 * DAY_MS);
  } finally {
    env.cleanup();
  }
});

test('11, 12 & 13 — 7-day once-per-day warning, zero-data-loss read-only mode on expiry (UI/IPC + WhatsApp bot), and instant unlock upon renewal without restart', () => {
  const env = makeIsolatedEnv();
  try {
    settings.setMany({ bot_language: 'ar', working_days: '0,1,2,3,4,5,6' });
    auth.setup({ password: '1234', confirm: '1234' });
    auth.login('1234');
    const handlers = createHandlers({
      version: '2.2.0',
      dataDir: env.dir,
      onEvent: (ev) => env.events.push(ev),
    });

    const code1M = env.issue('1M').code;
    handlers['license:activate']({ code: code1M });

    // Create real clinic data while licensed: patient, appointment, payment, prescription
    const pat = patients.create({ full_name: 'أمين بن علي', phone: '0555123456' });
    const dayStr = new Date(env.getNow() + DAY_MS).toISOString().slice(0, 10);
    const appt = appointments.create({
      patient_id: pat.id,
      day: dayStr,
      price: 2500,
    });
    payments.add({ patient_id: pat.id, appointment_id: appt.id, amount: 2500, method: 'cash' });
    const rx = prescriptions.create({
      patient_id: pat.id,
      day: dayStr,
      items: [{ drug_name: 'Paracetamol 1g', dosage: '1 cp x 3/j', duration: '5j' }],
    });

    // Scenario 11: Jump to 23 days + 1 hour later -> 7 days remaining -> warning fires ONCE per Algeria day
    env.advanceMs(23 * DAY_MS + 60 * MIN_MS);
    const c1 = license.checkPeriodic();
    assert.equal(c1.warnedToday, true);
    assert.equal(env.warnings.length, 1);
    assert.equal(c1.status.days_remaining, 7);

    // Calling checkPeriodic again on the SAME day does NOT spam a second warning
    env.advanceMs(2 * 60 * MIN_MS);
    const c2 = license.checkPeriodic();
    assert.equal(c2.warnedToday, false);
    assert.equal(env.warnings.length, 1);

    // Next calendar day (6 days remaining) -> warns once for the new day
    env.advanceMs(DAY_MS);
    const c3 = license.checkPeriodic();
    assert.equal(c3.warnedToday, true);
    assert.equal(env.warnings.length, 2);

    // Scenario 12: Jump past expiration -> immediate transition to expired / read-only
    env.advanceMs(7 * DAY_MS);
    const expCheck = license.checkPeriodic();
    assert.equal(expCheck.status.valid, false);
    assert.equal(expCheck.status.status, 'expired');
    assert.equal(env.expirations.length, 1);

    // ALL new booking paths are blocked:
    // (a) Direct service / IPC appointments:create, reschedule, waiting-add
    assert.throws(
      () => handlers['appointments:create']({ patient_id: pat.id, day: new Date(env.getNow() + 2 * DAY_MS).toISOString().slice(0, 10) }),
      (err) => err.code === 'LICENSE_REQUIRED',
    );
    assert.throws(
      () => handlers['appointments:reschedule']({ id: appt.id, day: new Date(env.getNow() + 3 * DAY_MS).toISOString().slice(0, 10) }),
      (err) => err.code === 'LICENSE_REQUIRED',
    );
    assert.throws(
      () => appointments.addToWaitingList({ patient_id: pat.id }),
      (err) => err.code === 'LICENSE_REQUIRED',
    );

    // (b) WhatsApp bot blocks new bookings with polite Arabic message
    const botReply = bot.handle({ phone: '213661998877', text: 'السلام عليكم أريد حجز موعد', delivery: 'local' });
    assert.equal(botReply.action, 'license_expired');
    assert.match(botReply.reply, /الخدمة متوقفة مؤقتاً، يرجى التواصل مع العيادة/);

    // (c) ZERO DATA LOSS: Existing patients, appointments, payments, prescriptions, and reports remain 100% readable!
    assert.equal(patients.get(pat.id).full_name, 'أمين بن علي');
    assert.equal(appointments.get(appt.id).price, 2500);
    assert.equal(prescriptions.forPatient(pat.id).length, 1);
    assert.equal(prescriptions.forPatient(pat.id)[0].id, rx.id);
    assert.ok(reports.daily(dayStr));

    // Scenario 13: Activate a fresh code -> full functionality resumes INSTANTLY without restart!
    const renewalCode = env.issue('6M').code;
    const activatedNow = handlers['license:activate']({ code: renewalCode });
    assert.equal(activatedNow.valid, true);
    assert.equal(license.isLicenseValid(), true);

    const nextBookDay = new Date(env.getNow() + 2 * DAY_MS).toISOString().slice(0, 10);
    const newAppt = handlers['appointments:create']({ patient_id: pat.id, day: nextBookDay, price: 3000 });
    assert.ok(newAppt.id > appt.id, 'New appointment created immediately without restarting');

    const botStep1 = bot.handle({ phone: '213661998877', text: 'سفيان حداد', delivery: 'local' });
    assert.equal(botStep1.action, 'choose_day');
    const botStep2 = bot.handle({ phone: '213661998877', text: '1', delivery: 'local' });
    assert.equal(botStep2.action, 'booked');
  } finally {
    env.cleanup();
  }
});

test('14 — System clock rollback (>10 min behind last_seen or latest SQLite activity) blocks bypass and recovers once clock is fixed', () => {
  let dbLatestUtc = 0;
  const env = makeIsolatedEnv({
    dbActivityProvider: () => ({ utcExactMs: dbLatestUtc, localNaiveMs: 0 }),
  });
  try {
    const code = env.issue('1M').code;
    license.activate(code);
    assert.equal(license.isLicenseValid(), true);

    // Advance 5 days normally and persist periodic check
    env.advanceMs(5 * DAY_MS);
    license.checkPeriodic();
    assert.equal(license.isLicenseValid(), true);

    // Roll clock backwards by 15 minutes (> 10 min tolerance) -> BLOCKED!
    env.advanceMs(-15 * MIN_MS);
    const rolledStatus = license.getStatus();
    assert.equal(rolledStatus.valid, false);
    assert.equal(rolledStatus.status, 'clock_tampered');
    assert.match(rolledStatus.message_ar, /ساعة الحاسوب/);
    assert.throws(
      () => license.requireValidLicense(),
      (err) => err.code === 'CLOCK_TAMPERED',
    );

    // Restore accurate clock -> license works again automatically!
    env.advanceMs(20 * MIN_MS);
    assert.equal(license.isLicenseValid(), true);

    // Also test rollback relative to SQLite database activity (even if state last_seen was older)
    dbLatestUtc = env.getNow() + 60 * MIN_MS;
    assert.equal(license.getStatus().status, 'clock_tampered');
  } finally {
    env.cleanup();
  }
});

test('15 & 16 — Dual-storage self-healing (deleting AppData file OR HKCU registry) and HMAC anti-tamper protection against manual file edits', () => {
  const env = makeIsolatedEnv();
  try {
    const issuedSec = Math.floor(env.getNow() / 1000);
    const { code } = env.issue('1M', license.getMachineId(), issuedSec);
    license.activate(code);

    const stateFile = path.join(env.dir, 'license-state.json');
    const regSlot = `${license.REG_LICENSE_KEY}::${license.REG_LICENSE_VALUE}`;
    assert.ok(fs.existsSync(stateFile), 'AppData state file created');
    assert.ok(env.fakeReg.values[regSlot], 'HKCU registry state created');

    // Scenario 15a: Delete AppData `license-state.json` -> self-heals from HKCU registry!
    fs.unlinkSync(stateFile);
    assert.equal(fs.existsSync(stateFile), false);
    assert.equal(license.isLicenseValid(), true);
    assert.equal(fs.existsSync(stateFile), true, 'AppData file automatically healed from Registry');

    // Scenario 15b: Delete HKCU Registry value -> self-heals from AppData file!
    delete env.fakeReg.values[regSlot];
    assert.equal(env.fakeReg.values[regSlot], undefined);
    assert.equal(license.isLicenseValid(), true);
    assert.ok(env.fakeReg.values[regSlot], 'HKCU Registry automatically healed from AppData file');

    // Scenario 16: Attacker edits `license-state.json` AND deletes Registry trying to forge `effective_start_utc_ms` +1 year in the future!
    env.advanceMs(10 * DAY_MS); // 20 days legitimately left
    const rawEnvelope = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const inner = JSON.parse(rawEnvelope.p);
    // Plain expiry dates are NEVER stored; attacker tries shifting effective_start_utc_ms forward by 300 days
    inner.entries[0].effective_start_utc_ms += 300 * DAY_MS;
    rawEnvelope.p = JSON.stringify(inner); // Invalidates HMAC `m`!
    fs.writeFileSync(stateFile, JSON.stringify(rawEnvelope), 'utf8');
    delete env.fakeReg.values[regSlot];

    // App detects invalid HMAC, refuses forged start date, never crashes, and recovers ONLY the genuine Ed25519-signed 20 remaining days!
    const afterTamper = license.getStatus();
    assert.equal(afterTamper.valid, true);
    assert.equal(afterTamper.days_remaining, 20, 'Tampering NEVER grants extra days beyond signed issuedAt + duration');

    // Corrupting JSON completely -> never crashes, falls back cleanly to unlicensed
    fs.writeFileSync(stateFile, '{{{NOT-JSON-AT-ALL', 'utf8');
    delete env.fakeReg.values[regSlot];
    const corruptStatus = license.getStatus();
    assert.equal(corruptStatus.valid, false);
    assert.equal(corruptStatus.status, 'unlicensed');
  } finally {
    env.cleanup();
  }
});

test('17 — Optional non-renewable TRIAL_DAYS cannot be reset by deleting a single store, Tray menu exposes "الترخيص", and Renderer modal activates live', async () => {
  // Part A: Optional non-renewable trial protection
  const env = makeIsolatedEnv({ trialDays: 7 });
  try {
    const st1 = license.getStatus();
    assert.equal(st1.valid, true);
    assert.equal(st1.days_remaining, 7);

    // Expire trial after 8 days
    env.advanceMs(8 * DAY_MS);
    assert.equal(license.getStatus().valid, false);
    assert.equal(license.getStatus().status, 'expired');

    // Deleting AppData `license-state.json` alone CANNOT re-trigger a free trial because HKCU Registry still proves trial was consumed!
    fs.unlinkSync(path.join(env.dir, 'license-state.json'));
    assert.equal(license.getStatus().valid, false);
    assert.equal(license.getStatus().status, 'expired');

    // Part B: System Tray exposes "الترخيص" and triggers onOpenLicense callback + notifyAlert for --autostart
    let licenseOpenedCount = 0;
    const balloons = [];
    const tray = new TrayController({
      electron: {
        Tray: class {
          setToolTip() {}
          setContextMenu(m) {
            this.menu = m;
          }
          on() {}
          displayBalloon(b) {
            balloons.push(b);
          }
        },
        Menu: { buildFromTemplate: (t) => t },
        nativeImage: { createFromPath: () => ({ isEmpty: () => false }) },
      },
      getMainWindow: () => ({ isDestroyed: () => false, show() {}, focus() {}, isMinimized: () => false }),
      onOpenLicense: () => {
        licenseOpenedCount += 1;
      },
    });
    const inst = tray.init();
    const licItem = inst.menu.find((i) => i.id === 'license');
    assert.ok(licItem, 'Tray menu contains license item');
    assert.equal(licItem.label, TRAY_MENU_LICENSE);
    licItem.click();
    assert.equal(licenseOpenedCount, 1);

    tray.notifyAlert('الترخيص غير مفعّل');
    assert.equal(balloons.length, 1);
    assert.match(balloons[0].content, /الترخيص/);

    // Part C: JSDOM Renderer License Modal (`window.Components.openLicenseModal`)
    const validCode = env.issue('6M').code;
    let copiedText = '';
    const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
    global.window = dom.window;
    global.document = dom.window.document;
    global.Node = dom.window.Node;
    global.CustomEvent = dom.window.CustomEvent;
    global.localStorage = dom.window.localStorage;

    try {
      window.API = {
        demo: false,
        invoke: async (method, payload) => {
          if (method === 'license:status') return license.getStatus();
          if (method === 'license:activate') return license.activate(payload.code);
          if (method === 'app:copy-text') {
            copiedText = payload.text;
            return { ok: true };
          }
          return {};
        },
      };
      window.App = {
        language: 'ar',
        settings: { currency: 'DZD' },
        license: license.getStatus(),
        updateLicenseBanner: () => {},
        renderPage: () => {},
      };

      const loadScript = (rel) => {
        const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', rel), 'utf8');
        dom.window.eval(src);
      };
      loadScript('js/i18n.js');
      window.I18N.setLanguage('ar');
      loadScript('js/ui.js');
      loadScript('js/components.js');

      await window.Components.openLicenseModal();
      const modalRoot = document.querySelector('.license-modal-root');
      assert.ok(modalRoot, 'License modal rendered');
      assert.match(modalRoot.textContent, /منتهي الصلاحية/);

      // Click copy machine fingerprint button
      const buttons = [...document.querySelectorAll('.modal button')];
      const copyBtn = buttons.find((b) => b.textContent.includes('نسخ'));
      assert.ok(copyBtn, 'Copy fingerprint button exists');
      copyBtn.click();
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(copiedText, 'A1B2-C3D4-E5F6-0718');

      // Paste activation code and click "تفعيل"
      const textarea = modalRoot.querySelector('textarea');
      textarea.value = validCode;
      const activateBtn = buttons.find((b) => b.textContent.includes('تفعيل'));
      assert.ok(activateBtn, 'Activate button exists');
      activateBtn.click();
      await new Promise((r) => setTimeout(r, 20));

      assert.equal(license.isLicenseValid(), true);
      assert.equal(window.App.license.valid, true);
      assert.equal(window.App.license.days_remaining, 180);
    } finally {
      dom.window.close();
      delete global.window;
      delete global.document;
      delete global.Node;
      delete global.CustomEvent;
      delete global.localStorage;
    }
  } finally {
    env.cleanup();
  }
});
