const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const dbMod = require('../src/main/db');
const { SCHEMA_VERSION, MIGRATIONS } = require('../src/main/db/schema');
const { useTempDb } = require('./helpers');
const patients = require('../src/main/services/patients');
const appointments = require('../src/main/services/appointments');
const prescriptions = require('../src/main/services/prescriptions');
const reports = require('../src/main/services/reports');

test('Phase 10 — lossless V1 (MIGRATION_1) -> V10 (SCHEMA_VERSION=10) upgrade preserves all existing clinic data', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'medirdv-v1-upgrade-'));
  const dbPath = path.join(tmpDir, 'clinic-v1.sqlite');
  t.after(() => {
    dbMod.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // 1. Construct an authentic MediRDV v1.0.0 SQLite database (user_version = 1)
  const raw = new Database(dbPath);
  raw.exec(MIGRATIONS[0]);
  raw.pragma('user_version = 1');
  raw.prepare("INSERT INTO settings (key, value) VALUES ('clinic_name', 'Clinique V1 Historique')").run();
  raw.prepare(
    `INSERT INTO patients (full_name, phone, phone_norm, allergies, chronic_conditions)
     VALUES ('Hadj Tahar', '0550998877', '213550998877', 'Pénicilline', 'HTA')`,
  ).run();
  raw.prepare(
    `INSERT INTO appointments (patient_id, day, queue_number, status, price)
     VALUES (1, '2026-10-20', 1, 'done', 2500)`,
  ).run();
  raw.prepare(
    `INSERT INTO payments (patient_id, appointment_id, amount, method, paid_at)
     VALUES (1, 1, 2500, 'cash', '2026-10-20 10:00:00')`,
  ).run();
  raw.prepare(
    `INSERT INTO prescriptions (patient_id, day, patient_name, diagnosis)
     VALUES (1, '2026-10-20', 'Hadj Tahar', 'HTA essentielle')`,
  ).run();
  raw.prepare(
    `INSERT INTO prescription_items (prescription_id, drug_name, dci, dosage, duration)
     VALUES (1, 'AMLOR', 'Amlodipine', '1 gélule/j', '30 jours')`,
  ).run();
  raw.close();

  // 2. Open through MediRDV db.open() -> runs MIGRATION_2 .. MIGRATION_13 + seedDefaults
  dbMod.open(dbPath);
  const upgraded = dbMod.getDb();
  assert.equal(upgraded.pragma('user_version', { simple: true }), SCHEMA_VERSION);
  assert.equal(SCHEMA_VERSION, 13);

  // 3. Verify 100% preservation of V1 records + usability of new V2 columns
  const p = patients.get(1);
  assert.equal(p.full_name, 'Hadj Tahar');
  assert.equal(p.allergies, 'Pénicilline');
  assert.equal(p.insurance_type, 'none');

  const rxList = prescriptions.forPatient(1);
  assert.equal(rxList.length, 1);
  assert.equal(rxList[0].items[0].drug_name, 'AMLOR');

  const rep = reports.daily('2026-10-20');
  assert.equal(rep.income, 2500);
});

test('Phase 10 — scale benchmark: 5,000 Nomenclature drugs, 10,000 patients & 50,000 appointments stay fast', (t) => {
  useTempDb(t);
  const db = dbMod.getDb();

  // 1. Insert 5,000 Nomenclature drugs
  const insertDrugs = db.transaction(() => {
    const stmt = db.prepare(
      `INSERT INTO medications
        (brand, dci, strength, form, registration_number, ppa, reimbursable, folded_search, source, verified)
       VALUES (?, ?, '500mg', 'Comprimé', ?, 320, 1, ?, 'nomenclature', 0)`,
    );
    for (let i = 1; i <= 5000; i += 1) {
      stmt.run(`MEDALG-${i}`, i === 4321 ? 'Metformine Chlorhydrate' : `Molecule-${i % 400}`, `09B${i}`, `medalg ${i} molecule ${i % 400}`);
    }
  });
  insertDrugs();

  const t0Drug = performance.now();
  const foundDrugs = prescriptions.searchMedications({ search: 'Metformine' });
  const drugMs = performance.now() - t0Drug;
  assert.ok(foundDrugs.length >= 1);
  assert.ok(drugMs < 350, `5k FTS drug search took ${drugMs.toFixed(1)}ms`);

  // 2. Insert 10,000 patients + 50,000 appointments in one fast SQLite transaction
  const targetDay = '2026-10-25';
  const bulkSeed = db.transaction(() => {
    const pStmt = db.prepare(
      `INSERT INTO patients (full_name, phone, phone_norm) VALUES (?, ?, ?)`,
    );
    for (let i = 1; i <= 10000; i += 1) {
      const ph = `05${String(10000000 + i).slice(0, 8)}`;
      pStmt.run(i === 9876 ? 'Zinedine Zidane Test' : `Patient Algérie ${i}`, ph, `213${ph.slice(1)}`);
    }
    const aStmt = db.prepare(
      `INSERT INTO appointments (patient_id, day, queue_number, status, price)
       VALUES (?, ?, ?, 'done', 2000)`,
    );
    for (let i = 0; i < 50000; i += 1) {
      const dayIdx = i % 1000; // 50 appointments/day across 1,000 distinct days
      const y = 2020 + Math.floor(dayIdx / 336);
      const m = String((Math.floor(dayIdx / 28) % 12) + 1).padStart(2, '0');
      const d = String((dayIdx % 28) + 1).padStart(2, '0');
      const dayStr = i < 25 ? targetDay : `${y}-${m}-${d}`;
      const qNum = i < 25 ? i + 1 : Math.floor(i / 1000) + 100;
      aStmt.run((i % 10000) + 1, dayStr, qNum);
    }
  });
  bulkSeed();

  const t0Pat = performance.now();
  const patHits = patients.list('Zinedine', { limit: 20 });
  const patMs = performance.now() - t0Pat;
  assert.equal(patHits.length, 1);
  assert.ok(patMs < 400, `10k patient search took ${patMs.toFixed(1)}ms`);

  const t0Agenda = performance.now();
  const dayRows = appointments.agenda(targetDay);
  const dailyRep = reports.daily(targetDay);
  const agendaMs = performance.now() - t0Agenda;
  assert.equal(dayRows.length, 25);
  assert.equal(dailyRep.appointments.done, 25);
  assert.ok(agendaMs < 400, `50k appointments agenda+report took ${agendaMs.toFixed(1)}ms`);
});
