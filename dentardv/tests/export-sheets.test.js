'use strict';
/**
 * Google Sheets / Excel export.
 *
 * The app ships no spreadsheet library, so the .xlsx writer is verified here
 * the hard way: the produced file is un-zipped byte by byte and the sheet XML
 * is inspected. This is exactly what Excel/Google Sheets do when they open it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { useTempDb, safeRemove } = require('./helpers');
const settings = require('../src/main/services/settings');
const patients = require('../src/main/services/patients');
const appointments = require('../src/main/services/appointments');
const payments = require('../src/main/services/payments');
const expenses = require('../src/main/services/expenses');
const dates = require('../src/main/utils/dates');
const { createZip } = require('../src/main/export/zip');
const { buildWorkbook, colName, dateSerial } = require('../src/main/export/xlsx');
const sheets = require('../src/main/export/sheets');
const { createHandlers } = require('../src/main/handlers');

/** Minimal ZIP reader: enough to prove the archive is valid. */
function unzip(buffer) {
  // End of central directory record is the last 22 bytes (no archive comment).
  const eocd = buffer.length - 22;
  assert.equal(buffer.readUInt32LE(eocd), 0x06054b50, 'end of central directory signature');
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const files = {};

  for (let index = 0; index < count; index += 1) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014b50, 'central directory entry');
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);

    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(start, start + compressedSize);
    const data = method === 8 ? zlib.inflateRawSync(raw) : raw;
    assert.equal(data.length, uncompressedSize, `size of ${name}`);
    files[name] = data.toString('utf8');

    offset += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

function freshClinic() {
  const ctx = useTempDb();
  settings.setMany({
    clinic_name: 'Cabinet Test',
    working_days: '0,1,2,3,4,5,6',
    daily_capacity: '10',
  });
  const patient = patients.create({ full_name: 'Amina Test', phone: '0555111222' });
  const day = dates.toISODate();
  const appointment = appointments.create({
    patient_id: patient.id,
    day,
    price: 6000,
    treatment_name: 'Couronne',
  });
  payments.add({ patient_id: patient.id, appointment_id: appointment.id, amount: 2500, method: 'cash' });
  expenses.create({ amount: 1200, category_id: expenses.categories()[0].id, label: 'Gants', day });
  return { ctx, patient, appointment, day };
}

test('the ZIP writer produces an archive every unzipper accepts', () => {
  const buffer = createZip([
    { name: 'a.txt', data: 'hello' },
    { name: 'nested/b.xml', data: '<x>مرحبا</x>' },
  ]);
  const files = unzip(buffer);
  assert.equal(files['a.txt'], 'hello');
  assert.equal(files['nested/b.xml'], '<x>مرحبا</x>', 'UTF-8 names and content survive');
});

test('column names and Excel dates follow the spec', () => {
  assert.equal(colName(0), 'A');
  assert.equal(colName(25), 'Z');
  assert.equal(colName(26), 'AA');
  assert.equal(colName(27), 'AB');
  assert.equal(colName(701), 'ZZ');
  // 2026-10-23 is the serial Excel and Google Sheets both display as 23/10/2026.
  assert.equal(dateSerial('2026-10-23'), 46318);
  assert.equal(dateSerial('not-a-date'), null);
});

test('a workbook contains the parts Excel and Google Sheets require', () => {
  const buffer = buildWorkbook([
    {
      name: 'Résumé',
      widths: [30, 20],
      freezeRow: 1,
      filter: { row: 1 },
      rows: [
        [{ text: 'Indicateur', style: 'header' }, { text: 'Valeur', style: 'header' }],
        ['Recettes', { money: 1250.5 }],
        ['Jour', { date: '2026-10-23' }],
        [{ text: 'TOTAL', style: 'total' }, { money: 1250.5, style: 'total' }],
      ],
    },
  ]);
  const files = unzip(buffer);

  for (const part of [
    '[Content_Types].xml',
    '_rels/.rels',
    'xl/workbook.xml',
    'xl/_rels/workbook.xml.rels',
    'xl/styles.xml',
    'xl/worksheets/sheet1.xml',
    'docProps/core.xml',
  ]) {
    assert.ok(files[part], `missing part ${part}`);
  }

  assert.match(files['[Content_Types].xml'], /spreadsheetml\.sheet\.main\+xml/);
  assert.match(files['xl/worksheets/sheet1.xml'], /<sheetData>/);
  assert.match(files['xl/workbook.xml'], /name="Résumé"/, 'sheet names keep their accents');
  // strings are inline, money and dates are real typed cells
  assert.match(files['xl/worksheets/sheet1.xml'], /t="inlineStr"/);
  assert.match(files['xl/worksheets/sheet1.xml'], /<v>1250\.5<\/v>/);
  assert.match(files['xl/worksheets/sheet1.xml'], /<v>46318<\/v>/);
  assert.match(files['xl/worksheets/sheet1.xml'], /state="frozen"/);
  assert.match(files['xl/worksheets/sheet1.xml'], /<autoFilter/);
  assert.match(files['xl/styles.xml'], /formatCode="dd\/mm\/yyyy"/);
});

test('sheet names are cleaned up the way Excel demands', () => {
  const buffer = buildWorkbook([
    { name: 'Dépenses/Mars:2026 [labo]', rows: [['x']] },
    { name: 'Résumé', rows: [['x']] },
    { name: 'RÉSUMÉ', rows: [['x']] },
    { name: '   ', rows: [['x']] },
  ]);
  const files = unzip(buffer);
  const names = [...files['xl/workbook.xml'].matchAll(/<sheet name="([^"]+)"/g)].map((match) => match[1]);

  assert.deepEqual(names, ['Dépenses Mars 2026 labo', 'Résumé', 'RÉSUMÉ (2)', 'Feuille 4']);
  for (const name of names) {
    assert.doesNotMatch(name, /[:\\/?*[\]]/, 'no forbidden character');
    assert.ok(name.length <= 31, 'at most 31 characters');
  }
});

test('the daily export carries the real figures of the day', (t) => {
  const { ctx, day } = freshClinic();
  t.after(() => ctx.cleanup());

  const workbook = sheets.build('daily', day);
  assert.match(workbook.filename, /^DentaRDV-\d{4}-\d{2}-\d{2}\.xlsx$/);
  assert.deepEqual(workbook.sheets, ['Résumé', 'Paiements', 'Dépenses', 'Soins']);

  const files = unzip(workbook.buffer);
  const summary = files['xl/worksheets/sheet1.xml'];
  assert.match(summary, /Cabinet Test/, 'clinic name');
  assert.match(summary, /<v>2500<\/v>/, 'income of the day (2500 paid)');
  assert.match(summary, /<v>1200<\/v>/, 'expenses of the day');
  assert.match(summary, /<v>1300<\/v>/, 'net profit');
  assert.match(files['xl/worksheets/sheet2.xml'], /Amina Test/, 'the payment row');
});

test('the monthly export has one sheet per analysis axis', (t) => {
  const { ctx, day } = freshClinic();
  t.after(() => ctx.cleanup());

  const workbook = sheets.build('monthly', day.slice(0, 7));
  assert.deepEqual(workbook.sheets, [
    'Résumé',
    'Par jour',
    'Dépenses par catégorie',
    'Paiements',
    'Dépenses',
    'Soins',
  ]);
  const files = unzip(workbook.buffer);
  assert.equal(Object.keys(files).filter((name) => name.startsWith('xl/worksheets/')).length, 6);
});

test('the full export contains every table the accountant needs', (t) => {
  const { ctx } = freshClinic();
  t.after(() => ctx.cleanup());

  const workbook = sheets.build('full');
  assert.deepEqual(workbook.sheets, [
    'Résumé',
    'Patients',
    'Dettes',
    'Rendez-vous',
    'Paiements',
    'Dépenses',
    'Soins',
  ]);
  const files = unzip(workbook.buffer);
  const patientsSheet = Object.entries(files).find(([, xml]) => xml.includes('Nom complet'));
  assert.ok(patientsSheet, 'the patients sheet is there');
  assert.match(workbook.filename, /^DentaRDV-complet-\d{4}-\d{2}-\d{2}\.xlsx$/);
});

test('a date with Arabic or accented text does not corrupt the file', (t) => {
  const { ctx } = freshClinic();
  t.after(() => ctx.cleanup());

  patients.create({ full_name: 'سمية بن عمر « éprouvé » & <test>', phone: '0555999888' });
  const workbook = sheets.build('full');
  const files = unzip(workbook.buffer);
  const patientsSheet = Object.values(files).find((xml) => xml.includes('سمية'));
  assert.ok(patientsSheet, 'Arabic name written');
  assert.match(patientsSheet, /&amp;/, 'ampersand escaped');
  assert.match(patientsSheet, /&lt;test&gt;/, 'angle brackets escaped');
});

test('the clipboard table is tab separated and Google Sheets ready', (t) => {
  const { ctx, day } = freshClinic();
  t.after(() => ctx.cleanup());

  const daily = sheets.clipboardTable('daily', day);
  const lines = daily.split('\n');
  assert.equal(lines[0], 'Indicateur\tValeur');
  assert.ok(lines.some((line) => line.startsWith('Recettes encaissées\t2500')));

  const monthly = sheets.clipboardTable('monthly', day.slice(0, 7));
  assert.equal(monthly.split('\n')[0], 'Date\tRecettes\tDépenses\tNet');
  assert.match(monthly, /\nTOTAL\t/);
});

test('the export writes a file when the dialog provides a path', async (t) => {
  const { ctx } = freshClinic();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dentardv-export-'));
  t.after(() => {
    ctx.cleanup();
    safeRemove(dir);
  });

  const handlers = createHandlers({
    version: 'test',
    dataDir: dir,
    dialogs: { saveExport: async (filename) => ({ canceled: false, file: path.join(dir, filename) }) },
  });

  const result = await handlers['export:sheet']({ kind: 'daily', day: dates.toISODate() });
  assert.equal(result.ok, true);
  assert.ok(fs.existsSync(result.file), 'the .xlsx landed on disk');
  assert.match(fs.readFileSync(result.file).subarray(0, 2).toString(), /PK/, 'real ZIP container');

  // Cancelling the dialog writes nothing and reports it.
  const cancelled = createHandlers({ version: 'test', dataDir: dir, dialogs: { saveExport: async () => ({ canceled: true }) } });
  assert.deepEqual(await cancelled['export:sheet']({ kind: 'daily' }), { canceled: true });
});

test('the clipboard and reveal actions go through the OS bridge', async (t) => {
  const { ctx, day } = freshClinic();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dentardv-clip-'));
  t.after(() => {
    ctx.cleanup();
    safeRemove(dir);
  });

  const copied = [];
  const opened = [];
  const file = path.join(dir, 'exports', 'rapport.xlsx');
  const handlers = createHandlers({
    version: 'test',
    dataDir: dir,
    dialogs: { copyText: (text) => copied.push(text), openPath: (target) => opened.push(target) },
  });

  assert.deepEqual(await handlers['app:copy-text']({ text: 'a\tb' }), { ok: true });
  assert.deepEqual(copied, ['a\tb']);

  const clipboard = await handlers['export:clipboard']({ kind: 'daily', day });
  assert.match(clipboard.tsv, /^Indicateur\tValeur/);
  const monthly = handlers['export:clipboard']({ kind: 'monthly', month: day.slice(0, 7) });
  assert.match(monthly.tsv, /^Date\tRecettes\tDépenses\tNet/);

  assert.deepEqual(await handlers['export:reveal']({ file }), { ok: true });
  assert.deepEqual(opened, [path.join(dir, 'exports')], 'the folder opens, not the file');

  // Without a bridge (tests, headless) the app reports a clean error code.
  const bare = createHandlers({ version: 'test', dataDir: dir });
  await assert.rejects(
    async () => bare['app:copy-text']({ text: 'x' }),
    (error) => error.code === 'CLIPBOARD_UNAVAILABLE',
  );
});
