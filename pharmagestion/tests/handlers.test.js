'use strict';
/**
 * The IPC action list — the only surface the window can reach.
 * Each handler is called directly here (no Electron needed) with the same
 * context the main process builds at boot.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../src/main/db');
const backup = require('../src/main/services/backup');
const settings = require('../src/main/services/settings');
const { createHandlers, allowedMethods, SECTIONS } = require('../src/main/handlers');
const { useTempDataDir } = require('./helpers');

async function withHandlers(run, overrides = {}) {
  const folder = useTempDataDir();
  db.closeAndReset();
  const databaseFile = path.join(folder.dir, 'pharmagestion.sqlite');
  db.open(databaseFile, { backupDir: folder.backupsDir });
  backup.init(folder.dir);

  const copied = [];
  const opened = [];
  const extraDialogs =
    typeof overrides.dialogs === 'function' ? overrides.dialogs(folder) : overrides.dialogs || {};
  const dialogs = {
    openPath: async (target) => {
      opened.push(target);
      return '';
    },
    copyText: (text) => copied.push(text),
    chooseBackup: async () => ({ canceled: true }),
    saveBackup: async () => ({ canceled: true }),
    ...extraDialogs,
  };

  const handlers = createHandlers({
    version: '0.1.0-test',
    dataDir: folder.dir,
    logFile: path.join(folder.dir, 'pharmagestion.log'),
    isPackaged: false,
    dialogs,
  });

  try {
    return await run({ handlers, folder, copied, opened, dialogs, databaseFile });
  } finally {
    backup.stopScheduler();
    try {
      db.close();
    } catch (error) {
      /* closed */
    }
    folder.cleanup();
  }
}

test('the allowlist contains only declared actions', () =>
  withHandlers(({ handlers }) => {
    const allowed = allowedMethods(handlers);
    assert.ok(allowed.size >= 12);
    for (const method of allowed) {
      assert.match(method, /^[a-z][a-z0-9]*:[a-zA-Z0-9]+$/);
      assert.equal(typeof handlers[method], 'function');
    }
    assert.equal(allowed.has('backup:restore'), true);
    assert.equal(allowed.has('eval'), false);
    assert.equal(allowed.has('fs:readFile'), false);
    assert.deepEqual(SECTIONS.length, 10);
  }));

test('app:info reports the real application facts', () =>
  withHandlers(async ({ handlers, folder }) => {
    const info = await handlers['app:info']({});
    assert.equal(info.name, 'PharmaGestion DZ');
    assert.equal(info.version, '0.1.0-test');
    assert.equal(info.dataDir, folder.dir);
    assert.ok(info.databaseFile.startsWith(folder.dir));
    assert.equal(info.schemaVersion, db.SCHEMA_VERSION);
    assert.equal(info.isPackaged, false);
    assert.match(info.today, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(!('password' in info));
  }));

test('settings:set accepts one key or a whole form', () =>
  withHandlers(async ({ handlers }) => {
    const single = await handlers['settings:set']({ key: 'pharmacy_name', value: 'Pharmacie El Amel' });
    assert.equal(single.pharmacy_name, 'Pharmacie El Amel');
    const many = await handlers['settings:set']({
      values: { pharmacy_phone: '0555 12 34 56', backup_keep: 15 },
    });
    assert.equal(many.pharmacy_phone, '0555 12 34 56');
    assert.equal(many.backup_keep, 15);
    await assert.rejects(
      () => handlers['settings:set']({ values: { expiry_threshold_1: 10, expiry_threshold_2: 60 } }),
      { code: 'INVALID_THRESHOLDS' },
    );
  }));

test('settings:set rejects a missing key and unknown keys', () =>
  withHandlers(async ({ handlers }) => {
    await assert.rejects(() => handlers['settings:set']({}), { code: 'INVALID_SETTING_KEY' });
    await assert.rejects(
      () => handlers['settings:set']({ key: 'sql_injection', value: "1; DROP TABLE settings" }),
      { code: 'INVALID_SETTING_KEY' },
    );
  }));

test('settings:language switches and audits the change', () =>
  withHandlers(async ({ handlers }) => {
    const result = await handlers['settings:language']({ language: 'ar' });
    assert.deepEqual(result, { language: 'ar' });
    assert.equal(settings.getLanguage(), 'ar');
    const entries = await handlers['audit:list']({ limit: 5 });
    assert.equal(entries[0].action, 'settings.language');
    await assert.rejects(() => handlers['settings:language']({ language: 'xx' }), { code: 'INVALID_SETTING_VALUE' });
  }));

test('dashboard:summary is honest about phase 1 counters', () =>
  withHandlers(async ({ handlers }) => {
    const summary = await handlers['dashboard:summary']({});
    assert.equal(summary.counters.medicines, 0);
    assert.equal(summary.counters.customerDebtCents, 0);
    assert.equal(summary.counters.supplierDebtCents, 0);
    assert.equal(summary.database.integrityOk, true);
    assert.equal(summary.modules.length, 10);
    assert.equal(summary.backups.count, 0);
    assert.equal(summary.backups.last, null);
    assert.ok(summary.today);
    assert.deepEqual(summary.recentActivity, []);
  }));

test('backup:create + backup:list are consistent', () =>
  withHandlers(async ({ handlers }) => {
    const created = await handlers['backup:create']({});
    assert.equal(created.kind, 'manual');
    assert.ok(fs.existsSync(created.file));
    const list = await handlers['backup:list']({});
    assert.equal(list.length, 1);
    assert.equal(list[0].name, created.name);
    assert.equal(list[0].kind, 'manual');
    const summary = await handlers['dashboard:summary']({});
    assert.equal(summary.backups.count, 1);
    assert.equal(summary.backups.last.name, created.name);
  }));

test('backup:export writes to the file chosen in the dialog', () => {
  let chosen = null;
  return withHandlers(
    async ({ handlers, folder }) => {
      const result = await handlers['backup:export']({});
      assert.equal(result.canceled, false);
      assert.ok(chosen, 'the dialog was called');
      assert.equal(result.file, chosen);
      assert.ok(fs.existsSync(chosen));
      assert.ok(chosen.startsWith(folder.dir), 'written where the pharmacist chose');
      assert.equal(db.checkIntegrity(chosen).ok, true);
    },
    {
      dialogs: (folder) => ({
        saveBackup: async (name) => {
          chosen = path.join(folder.dir, 'exports', name);
          return { canceled: false, file: chosen };
        },
      }),
    },
  );
});

test('backup:export reports cancellation without writing anything', () =>
  withHandlers(async ({ handlers }) => {
    const result = await handlers['backup:export']({});
    assert.equal(result.canceled, true);
  }));

test('restore only accepts a file inside the backups folder or one the user picked', () =>
  withHandlers(async ({ handlers, folder }) => {
    const snapshot = await handlers['backup:create']({});

    // A path outside the backups folder that the pharmacist never approved.
    await assert.rejects(
      () => handlers['backup:restore']({ file: path.join(folder.dir, 'secret.sqlite') }),
      { code: 'RESTORE_NOT_APPROVED' },
    );

    // A file inside the backups folder is allowed.
    const restored = await handlers['backup:restore']({ file: snapshot.file });
    assert.equal(restored.ok, true);

    // A non-sqlite extension is refused outright.
    await assert.rejects(
      () => handlers['backup:restore']({ file: path.join(folder.dir, 'backups', 'evil.exe') }),
      { code: 'INVALID_FILE' },
    );
  }));

test('a backup chosen through the native dialog can be restored', () =>
  withHandlers(
    async ({ handlers }) => {
      const chosen = await handlers['backup:choose']({});
      assert.equal(chosen.canceled, false);
      assert.equal(chosen.integrityOk, true);
      assert.equal(chosen.tooNew, false);
      assert.match(chosen.name, /\.sqlite$/);

      const restored = await handlers['backup:restore']({ file: chosen.file });
      assert.equal(restored.ok, true);
    },
    {
      dialogs: (folder) => ({
        chooseBackup: async () => {
          // A database the pharmacist picked outside the backups folder.
          const source = path.join(folder.dir, 'picked-by-user.sqlite');
          db.backupTo(source);
          return { canceled: false, file: source };
        },
      }),
    },
  ));

test('db:integrity reports a healthy database', () =>
  withHandlers(async ({ handlers, databaseFile }) => {
    const result = await handlers['db:integrity']({});
    assert.equal(result.ok, true);
    assert.equal(result.file, databaseFile);
    assert.equal(result.foreignKeys, true);
    assert.equal(result.journalMode.toLowerCase(), 'wal');
    assert.equal(result.schemaVersion, db.SCHEMA_VERSION);
    assert.ok(Array.isArray(result.tables));
  }));

test('app:openFolder only opens known folders', () =>
  withHandlers(async ({ handlers, opened, folder }) => {
    await handlers['app:openFolder']({ kind: 'backups' });
    assert.equal(opened[0], path.join(folder.dir, 'backups'));
    await assert.rejects(() => handlers['app:openFolder']({ kind: '../../windows' }), { code: 'INVALID_TARGET' });
  }));

test('app:copyText refuses huge payloads and copies normal ones', () =>
  withHandlers(async ({ handlers, copied }) => {
    await handlers['app:copyText']({ text: 'Pharmacie El Nour' });
    assert.deepEqual(copied, ['Pharmacie El Nour']);
    await assert.rejects(() => handlers['app:copyText']({ text: 'x'.repeat(50000) }), { code: 'TEXT_TOO_LONG' });
  }));
