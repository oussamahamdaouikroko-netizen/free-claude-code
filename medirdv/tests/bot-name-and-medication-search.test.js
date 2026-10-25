'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { useTempDb } = require('./helpers');

const dbMod = require('../src/main/db');
const intents = require('../src/main/whatsapp/intents');
const bot = require('../src/main/whatsapp/bot');
const { WhatsAppService } = require('../src/main/whatsapp/service');
const patients = require('../src/main/services/patients');
const appointments = require('../src/main/services/appointments');
const settings = require('../src/main/services/settings');
const prescriptions = require('../src/main/services/prescriptions');
const { normalizeSearch } = require('../src/main/utils/common');
const { runMigration } = require('../scripts/migrate-invalid-names');

test('Issue 1 — Greetings (AR/FR/EN/start) are rejected as names and prompt with example', () => {
  const ctx = useTempDb();
  try {
    const greetings = [
      { phone: '213550000001', text: 'مرحبا', expectAr: true },
      { phone: '213550000002', text: 'السلام عليكم', expectAr: true },
      { phone: '213550000003', text: 'السلام عليكم ورحمة الله وبركاته', expectAr: true },
      { phone: '213550000004', text: 'أهلا', expectAr: true },
      { phone: '213550000005', text: 'سلام', expectAr: true },
      { phone: '213550000006', text: 'صباح الخير', expectAr: true },
      { phone: '213550000007', text: 'مساء الخير', expectAr: true },
      { phone: '213550000008', text: 'hello', expectAr: false },
      { phone: '213550000009', text: 'Salut', expectAr: false },
      { phone: '213550000010', text: '/start', expectAr: false },
      { phone: '213550000011', text: 'Bonjour !', expectAr: false },
      { phone: '213550000012', text: 'hi', expectAr: false },
    ];

    for (const g of greetings) {
      assert.equal(intents.isGreeting(g.text), true, `Expected "${g.text}" to be detected as greeting`);
      const res = bot.handle({ phone: g.phone, text: g.text, delivery: 'local' });
      assert.equal(res.action, 'help', `Expected action=help for "${g.text}"`);
      if (g.expectAr) {
        assert.match(res.reply, /أهلاً بك/);
        assert.match(res.reply, /أسامة حمداوي/);
      } else {
        assert.match(res.reply, /Bienvenue/i);
        assert.match(res.reply, /Oussama Hamdaoui/);
      }
      // Must NOT save any patient row
      assert.equal(patients.findByPhone(g.phone), null, `"${g.text}" must never be saved as patient`);
      // Must record persistent awaiting-name session
      const pending = bot.getPending(g.phone);
      assert.equal(pending?.step, 'await_full_name');
    }
  } finally {
    ctx.cleanup();
  }
});

test('Issue 1 — Real names containing greeting substrings & compound/Latin/spaced names are accepted and cleaned', () => {
  const ctx = useTempDb();
  try {
    const validCases = [
      {
        phone: '213551000001',
        input: 'سلامة محمد',
        expectedSaved: 'سلامة محمد',
      },
      {
        phone: '213551000002',
        input: 'هلال بن أحمد',
        expectedSaved: 'هلال بن أحمد',
      },
      {
        phone: '213551000003',
        input: 'أسامة حمداوي',
        expectedSaved: 'أسامة حمداوي',
      },
      {
        phone: '213551000004',
        input: 'Oussama Hamdaoui',
        expectedSaved: 'Oussama Hamdaoui',
      },
      {
        phone: '213551000005',
        input: 'jean-pierre dupont',
        expectedSaved: 'Jean-Pierre Dupont',
      },
      {
        phone: '213551000006',
        input: '  أحمد    بن   علي  ',
        expectedSaved: 'أحمد بن علي',
      },
      {
        phone: '213551000007',
        input: 'أُسَامَةُ حَمْدَاوِيّـ',
        expectedSaved: 'أسامة حمداوي',
      },
    ];

    for (const c of validCases) {
      assert.equal(intents.isGreeting(c.input), false, `"${c.input}" must NOT be treated as greeting`);
      const v = intents.validatePersonName(c.input);
      assert.equal(v.valid, true, `"${c.input}" should be valid (got reason=${v.reason})`);
      assert.equal(v.name, c.expectedSaved);

      const res = bot.handle({ phone: c.phone, text: c.input, delivery: 'local' });
      assert.equal(res.action, 'booked', `"${c.input}" should book cleanly`);
      const saved = patients.findByPhone(c.phone);
      assert.ok(saved, `Patient should be created for "${c.input}"`);
      assert.equal(saved.full_name, c.expectedSaved);
    }
  } finally {
    ctx.cleanup();
  }
});

test('Issue 1 — Invalid names (1 word, digits, URLs, emoji, empty, >60 chars, stop-words) are rejected politely and keep awaiting state', () => {
  const ctx = useTempDb();
  try {
    settings.set('bot_language', 'ar');
    const phone = '213552000001';

    // First send a greeting -> puts user in await_full_name
    const greetRes = bot.handle({ phone, text: 'السلام عليكم', delivery: 'local' });
    assert.equal(greetRes.action, 'help');
    assert.equal(bot.getPending(phone)?.step, 'await_full_name');

    const invalidInputs = [
      'أحمد', // single word (default MIN_WORDS = 2)
      '12345', // digits only
      'اسامة123', // letters + digits
      'أسامة ١٢٣', // Arabic-Indic digits
      'https://example.com', // URL
      'www.google.com test', // URL
      '😀😀', // emoji
      'أسامة 😀 حمداوي', // name + emoji
      '', // empty
      '     ', // spaces only
      'نعم محمد', // stop-word token? Wait: let's also test standalone stop-words & long string
      'نعم', // single stop-word
      'ok', // stop-word
      'أحمد بن محمد\nعلي', // multiline
      `${'أبجد '.repeat(15)}هوز`, // > 60 chars (78 chars)
    ];

    // Check explicit required invalid inputs from specification
    for (const bad of [
      'أحمد',
      '12345',
      'اسامة123',
      'https://example.com',
      '😀😀',
      '',
      '   ',
      'أ'.repeat(50) + ' ' + 'ب'.repeat(50), // 101 chars (> 60)
      'نعم',
      'شكراً',
      'أحمد\nمحمد',
    ]) {
      const check = intents.validatePersonName(bad);
      assert.equal(check.valid, false, `Expected "${bad}" to fail validatePersonName`);

      const r = bot.handle({ phone, text: bad, delivery: 'local' });
      assert.equal(r.action, 'unsupported', `Expected unsupported action for "${bad}"`);
      assert.match(r.reply, /أسامة حمداوي/, `Expected polite error with example for "${bad}"`);
      assert.equal(patients.findByPhone(phone), null, `"${bad}" must NOT be saved as patient`);
      assert.equal(
        bot.getPending(phone)?.step,
        'await_full_name',
        `User must stay in await_full_name after "${bad}"`,
      );
    }

    // Verify configurable rule override (e.g. MIN_WORDS: 1 allows single-word name when configured)
    assert.equal(intents.validatePersonName('أحمد').valid, false);
    assert.equal(intents.validatePersonName('أحمد', { MIN_WORDS: 1 }).valid, true);

    // Finally user enters valid full name -> booked immediately!
    const okRes = bot.handle({ phone, text: 'أسامة حمداوي', delivery: 'local' });
    assert.equal(okRes.action, 'booked');
    assert.equal(patients.findByPhone(phone)?.full_name, 'أسامة حمداوي');
    assert.notEqual(bot.getPending(phone)?.step, 'await_full_name');
  } finally {
    ctx.cleanup();
  }
});

test('Issue 1 — Non-text media messages during awaiting-name ask for text without saving anything, and awaiting state survives DB/bot restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'medirdv-persist-'));
  const dbPath = path.join(dir, 'persist.sqlite');
  try {
    dbMod.open(dbPath);
    settings.set('bot_language', 'ar');
    settings.set('send_min_delay_ms', 0);
    settings.set('send_max_delay_ms', 1);

    const phone = '213553000001';
    const r1 = bot.handle({ phone, text: 'مرحبا', delivery: 'local' });
    assert.equal(r1.action, 'help');
    assert.equal(bot.getPending(phone)?.step, 'await_full_name');

    // Simulate full bot + DB restart by closing SQLite, clearing in-memory cache, and reopening DB
    const rawSessionBeforeClose = dbMod
      .getDb()
      .prepare('SELECT state_json FROM bot_sessions WHERE phone_key = ?')
      .get(phone.slice(-9));
    assert.ok(rawSessionBeforeClose, 'Session must be persisted in SQLite bot_sessions');

    dbMod.close();
    dbMod.open(dbPath);

    // After restart, awaiting state is still present in SQLite!
    assert.equal(bot.getPending(phone)?.step, 'await_full_name');

    // Send non-text media (image, sticker, voice, location, document) through WhatsAppService
    const sentPayloads = [];
    const svc = new WhatsAppService({
      authDir: path.join(dir, 'wa-auth'),
      onStatus: () => {},
      onEvent: () => {},
    });
    svc.state = 'connected';
    svc.typingDelay = () => 0;
    svc.sock = {
      user: { id: '213500000000:1@s.whatsapp.net' },
      sendPresenceUpdate: async () => {},
      sendMessage: async (_jid, content) => {
        sentPayloads.push(content);
      },
    };

    const mediaPayloads = [
      { id: 'M-IMG', message: { imageMessage: { mimetype: 'image/jpeg' } } },
      { id: 'M-STK', message: { stickerMessage: { mimetype: 'image/webp' } } },
      { id: 'M-AUD', message: { audioMessage: { mimetype: 'audio/ogg; codecs=opus', ptt: true } } },
      { id: 'M-LOC', message: { locationMessage: { degreesLatitude: 36.75, degreesLongitude: 3.05 } } },
      { id: 'M-DOC', message: { documentMessage: { fileName: 'analyse.pdf' } } },
    ];

    const nowSec = Math.floor(Date.now() / 1000);
    for (const m of mediaPayloads) {
      await svc.handleIncoming({
        key: { remoteJid: `${phone}@s.whatsapp.net`, fromMe: false, id: m.id },
        messageTimestamp: nowSec,
        message: m.message,
      });
    }
    await svc.sendChain;

    assert.equal(sentPayloads.length, 5, 'All 5 media messages should receive polite text-only prompt');
    for (const p of sentPayloads) {
      assert.match(p.text, /الرسائل النصية فقط/);
      assert.match(p.text, /أسامة حمداوي/);
    }
    assert.equal(patients.findByPhone(phone), null, 'Media messages must never create a patient');
    assert.equal(bot.getPending(phone)?.step, 'await_full_name');

    // Registered users are completely unaffected when sending greetings or media
    const existingPatient = patients.create({ full_name: 'Karim Benali', phone: '213553999888' });
    const regGreet = bot.handle({ phone: '213553999888', text: 'Bonjour', delivery: 'local' });
    assert.equal(regGreet.action, 'help');
    assert.equal(patients.get(existingPatient.id).full_name, 'Karim Benali');
  } finally {
    dbMod.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Issue 1 — Legacy invalid-name migration script supports dry-run first, then apply without losing appointments', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'medirdv-mig-'));
  const dbPath = path.join(dir, 'legacy.sqlite');
  try {
    dbMod.open(dbPath);
    const pGreetingAr = patients.create({ full_name: 'السلام عليكم', phone: '213554000001' });
    const pGreetingFr = patients.create({ full_name: 'Bonjour', phone: '213554000002' });
    const pDigits = patients.create({ full_name: 'اسامة123', phone: '213554000003' });
    const pValid = patients.create({ full_name: 'أسامة حمداوي', phone: '213554000004' });

    // Create an appointment for pGreetingAr to prove appointments stay intact across migration
    const appt = appointments.create({ patient_id: pGreetingAr.id, source: 'whatsapp' });
    dbMod.close();

    // 1. Dry-run MUST NOT mutate database
    const dry = runMigration({ dbPath, apply: false });
    assert.equal(dry.ok, true);
    assert.equal(dry.mode, 'dry-run');
    assert.equal(dry.total_patients, 4);
    assert.equal(dry.valid_count, 1);
    assert.equal(dry.affected_count, 3);
    assert.equal(dry.greeting_count, 2);
    assert.equal(dry.invalid_format_count, 1);
    assert.equal(dry.migrated_count, 0);

    dbMod.open(dbPath);
    assert.equal(patients.get(pGreetingAr.id).full_name, 'السلام عليكم');
    dbMod.close();

    // 2. Apply mode backs up DB, resets affected names to '', and flags bot_sessions
    const applied = runMigration({ dbPath, apply: true });
    assert.equal(applied.ok, true);
    assert.equal(applied.mode, 'apply');
    assert.equal(applied.migrated_count, 3);
    assert.equal(applied.sessions_flagged, 3);
    assert.ok(applied.backupPath && fs.existsSync(applied.backupPath), 'Backup sqlite file created');

    // 3. Re-running dry-run after apply reports 0 affected & 3 already awaiting name (idempotent)
    const dryAfter = runMigration({ dbPath, apply: false });
    assert.equal(dryAfter.affected_count, 0);
    assert.equal(dryAfter.already_awaiting_count, 3);
    assert.equal(dryAfter.valid_count, 1);

    // 4. Reopen app DB: valid patient untouched; migrated patient prompted on greeting, then updated in-place on real name!
    dbMod.open(dbPath);
    assert.equal(patients.get(pValid.id).full_name, 'أسامة حمداوي');
    assert.equal(patients.get(pGreetingAr.id).full_name, '');

    // Patient can still check their existing appointment before updating name
    const checkAppt = bot.handle({ phone: '213554000001', text: 'موعدي', delivery: 'local' });
    assert.equal(checkAppt.action, 'appointment_info');

    // Sending greeting still asks for real name
    const askAgain = bot.handle({ phone: '213554000001', text: 'مرحبا', delivery: 'local' });
    assert.equal(askAgain.action, 'help');
    assert.match(askAgain.reply, /أسامة حمداوي/);

    // Cancel old appointment so we can book or test name update on next booking
    appointments.cancel(appt.id);
    const updateAndBook = bot.handle({
      phone: '213554000001',
      text: 'محمد أمين بوزيد',
      delivery: 'local',
    });
    assert.equal(updateAndBook.action, 'booked');
    // Same patient.id was updated in place!
    const refreshed = patients.get(pGreetingAr.id);
    assert.equal(refreshed.full_name, 'محمد أمين بوزيد');
    assert.match(refreshed.notes, /Migration nom invalide/);
  } finally {
    dbMod.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Issue 2 — Case-insensitive, Arabic-normalized, hyphen-flexible, SQL-safe medication search with prefix ranking', () => {
  const ctx = useTempDb();
  try {
    // Seed specific test medications covering every required case
    prescriptions.createMedication({
      brand: 'Doliprane',
      dci: 'Paracétamol',
      strength: '1000 mg',
      form: 'Comprimé',
      specialty: 'general',
    });
    prescriptions.createMedication({
      brand: 'Endoliprane Plus', // infix match for "doliprane" / "doli" — must rank AFTER prefix "Doliprane"
      dci: 'Paracétamol',
      strength: '500 mg',
      form: 'Comprimé',
      specialty: 'general',
    });
    prescriptions.createMedication({
      brand: 'Augmentin 1g',
      dci: 'Amoxicilline + Acide clavulanique',
      strength: '1 g',
      form: 'Comprimé',
      specialty: 'general',
    });
    prescriptions.createMedication({
      brand: 'أموكلان',
      dci: 'Amoxicilline + Acide clavulanique',
      strength: '1 g',
      form: 'معلق',
      specialty: 'general',
    });
    prescriptions.createMedication({
      brand: 'Doli-Prane Flash',
      dci: 'Paracétamol',
      strength: '500 mg',
      form: 'Comprimé',
      specialty: 'general',
    });
    prescriptions.createMedication({
      brand: 'Éconazole Crème',
      dci: 'Éconazole nitrate',
      strength: '1%',
      form: 'Crème',
      specialty: 'dermatologie',
    });
    prescriptions.createMedication({
      brand: 'شراب كحة للأطفال',
      dci: 'Carbocistéine',
      strength: '2%',
      form: 'شراب',
      specialty: 'pediatrie',
    });

    // 1. "Doliprane" found via all casing & whitespace variations
    for (const q of ['doliprane', 'DOLIPRANE', 'DoLiPrAnE', 'doli', '  doliPrane  ']) {
      const results = prescriptions.searchMedications({ query: q, limit: 25 });
      assert.ok(
        results.some((r) => r.brand === 'Doliprane'),
        `Expected "Doliprane" to be found when searching "${q}"`,
      );
      // Ranking: prefix match ("Doliprane" / "DOLIPRANE...") MUST appear before infix match ("Endoliprane Plus")
      const idxPrefix = results.findIndex((r) => normalizeSearch(r.brand).startsWith('doli'));
      const idxInfix = results.findIndex((r) => r.brand === 'Endoliprane Plus');
      if (idxInfix !== -1) {
        assert.ok(
          idxPrefix !== -1 && idxPrefix < idxInfix,
          `Prefix match must rank before infix match for "${q}" (prefix=${idxPrefix}, infix=${idxInfix})`,
        );
      }
    }

    // 2. "Augmentin 1g" found via "augmentin" and "AUGMENTIN 1G"
    for (const q of ['augmentin', 'AUGMENTIN 1G', '  AuGmEnTiN   1g ']) {
      const results = prescriptions.searchMedications({ query: q, limit: 25 });
      assert.ok(
        results.some((r) => r.brand === 'Augmentin 1g'),
        `Expected "Augmentin 1g" for query "${q}"`,
      );
    }

    // 3. Arabic "أموكلان" found via "اموكلان", "أموكلان", "إموكلان", "آموكلان", tashkeel & tatweel
    for (const q of ['اموكلان', 'أموكلان', 'إموكلان', 'آموكلان', 'أَمُوكلـان']) {
      const results = prescriptions.searchMedications({ query: q, limit: 20 });
      assert.ok(
        results.some((r) => r.brand === 'أموكلان'),
        `Expected "أموكلان" for Arabic query "${q}"`,
      );
    }

    // Arabic ة <-> ه and ى <-> ي normalization ("شراب كحه للاطفال" matches "شراب كحة للأطفال")
    const arTa = prescriptions.searchMedications({ query: 'شراب كحه للاطفال', limit: 10 });
    assert.ok(arTa.some((r) => r.brand === 'شراب كحة للأطفال'));

    // 4. Hyphen <-> space equivalence ("doli-prane" == "doli prane")
    const bySpace = prescriptions.searchMedications({ query: 'doli prane flash', limit: 10 });
    assert.ok(bySpace.some((r) => r.brand === 'Doli-Prane Flash'));
    const byHyphen = prescriptions.searchMedications({ query: 'doli-prane', limit: 25 });
    assert.ok(byHyphen.some((r) => r.brand === 'Doli-Prane Flash'));

    // 5. Accented uppercase/lowercase ("Éconazole Crème" found via "econazole", "ÉCONAZOLE", "éconazole")
    for (const q of ['econazole', 'ÉCONAZOLE', 'éconazole', 'ECONAZOLE CREME']) {
      const results = prescriptions.searchMedications({ query: q, limit: 10 });
      assert.ok(
        results.some((r) => r.brand === 'Éconazole Crème'),
        `Expected "Éconazole Crème" for query "${q}"`,
      );
    }

    // 6. Non-matching search returns empty array cleanly without throwing
    const none = prescriptions.searchMedications({ query: 'zzzxxyyynonexistentdrug999', limit: 10 });
    assert.deepEqual(none, []);

    // 7. SQL wildcard (% and _) and quote/injection inputs are escaped and safe
    // Searching "%" must ONLY match drugs with a literal "%" (e.g. "1%" cream), NEVER "Doliprane" (1000 mg)!
    const percentRes = prescriptions.searchMedications({ query: '%', limit: 25 });
    assert.equal(
      percentRes.some((r) => r.brand === 'Doliprane'),
      false,
      '"%" must be escaped as literal percent, not match all rows like "Doliprane"',
    );
    for (const r of percentRes) {
      const combined = `${r.brand} ${r.strength} ${r.form} ${r.dci} ${r.folded_search}`;
      assert.ok(combined.includes('%'), `Row "${r.brand}" matched "%" without containing literal "%"`);
    }

    for (const wildcardQuery of [
      '%%%',
      '_',
      '___',
      'd_liprane', // "_" must NOT act as single-char wildcard for "o" in "doliprane"!
      '%_\\',
      "doliprane' OR 1=1 --",
      '"; DROP TABLE medications; --',
    ]) {
      const res = prescriptions.searchMedications({ query: wildcardQuery, limit: 20 });
      assert.ok(Array.isArray(res));
      assert.equal(
        res.length,
        0,
        `Wildcard/injection query "${wildcardQuery}" must NOT match arbitrary rows (got ${res.length})`,
      );
    }

    // Verify medications table is completely intact after injection attempts
    const countRow = dbMod.getDb().prepare('SELECT COUNT(*) AS n FROM medications').get();
    assert.ok(countRow.n >= 5381);
  } finally {
    ctx.cleanup();
  }
});
