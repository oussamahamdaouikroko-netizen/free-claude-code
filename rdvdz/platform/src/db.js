/**
 * Couche base de données.
 *
 * Deux pilotes, un seul SQL :
 *  - `pg`      : PostgreSQL en production (pool de connexions) ;
 *  - `pglite`  : PostgreSQL compilé en WASM, utilisé en développement et dans
 *                les tests — même dialecte, aucun serveur à installer.
 *
 * Le code métier n'écrit que du SQL paramétré (`$1`, `$2`, …). Aucune
 * concaténation de valeur dans une requête : c'est la seule protection
 * réellement efficace contre l'injection SQL, et elle est vérifiée par un test.
 */

import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'packages', 'db', 'migrations');

/** Contexte d'exécution courant (undefined = pool principal). */
let driver = null;
/** File d'attente des transactions quand le pilote n'a qu'une connexion. */
let txQueue = Promise.resolve();

class PgDriver {
  constructor(pool) {
    this.pool = pool;
    this.kind = 'pg';
    this.serial = false;
  }

  async query(text, params = []) {
    const result = await this.pool.query(text, params);
    return { rows: result.rows, rowCount: result.rowCount ?? result.rows.length };
  }

  /** Exécute un script SQL multi-instructions (migrations uniquement). */
  async exec(sql) {
    await this.pool.query(sql);
  }

  async tx(fn) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const executor = {
        query: async (text, params = []) => {
          const r = await client.query(text, params);
          return { rows: r.rows, rowCount: r.rowCount ?? r.rows.length };
        },
        exec: async (sql) => {
          await client.query(sql);
        },
      };
      const result = await fn(executor);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async close() {
    await this.pool.end();
  }
}

class PgliteDriver {
  constructor(db) {
    this.db = db;
    this.kind = 'pglite';
    // PGlite n'a qu'une connexion : deux transactions concurrentes
    // s'entrelaceraient. Elles sont donc sérialisées.
    this.serial = true;
  }

  async query(text, params = []) {
    const result = await this.db.query(text, params);
    return { rows: result.rows, rowCount: result.rows.length, affected: result.affectedRows };
  }

  /**
   * Script multi-instructions : PGlite prépare les requêtes de `query()`, qui
   * n'accepte donc qu'une seule instruction. `exec()` exécute un script.
   */
  async exec(sql) {
    await this.db.exec(sql);
  }

  async tx(fn) {
    const run = async () => {
      await this.db.exec('BEGIN');
      try {
        const executor = {
          query: async (text, params = []) => {
            const r = await this.db.query(text, params);
            return { rows: r.rows, rowCount: r.rows.length };
          },
          exec: async (sql) => {
            await this.db.exec(sql);
          },
        };
        const result = await fn(executor);
        await this.db.exec('COMMIT');
        return result;
      } catch (error) {
        try {
          await this.db.exec('ROLLBACK');
        } catch {
          /* ignore */
        }
        throw error;
      }
    };
    const chained = txQueue.then(run, run);
    // La file ne doit jamais rester dans un état rejeté.
    txQueue = chained.then(
      () => undefined,
      () => undefined,
    );
    return chained;
  }

  async close() {
    await this.db.close();
  }
}

/**
 * Ouvre la base. `options.driver` force un pilote (utile aux tests) ;
 * `options.pgliteDir` accepte `:memory:`.
 */
export async function openDatabase(options = {}) {
  if (driver) return driver;
  const chosen = options.driver || config.db.driver;

  if (chosen === 'pg') {
    const { default: pg } = await import('pg');
    const url = options.url || config.db.url;
    if (!url) throw new Error('DATABASE_URL est requis avec DB_DRIVER=pg');
    const pool = new pg.Pool({ connectionString: url, max: 10 });
    await pool.query('SELECT 1');
    driver = new PgDriver(pool);
    return driver;
  }

  const { PGlite } = await import('@electric-sql/pglite');
  const dir = options.pgliteDir || config.db.pgliteDir;
  const db = dir === ':memory:' ? new PGlite() : new PGlite(dir);
  await db.waitReady;
  driver = new PgliteDriver(db);
  return driver;
}

/** Pilote courant (ouvert au démarrage du serveur ou par les tests). */
export function db() {
  if (!driver) throw new Error('La base de données n\'est pas ouverte');
  return driver;
}

/** Ferme la connexion (tests, arrêt du serveur). */
export async function closeDatabase() {
  if (!driver) return;
  const current = driver;
  driver = null;
  await current.close();
}

/** Raccourcis d'exécution. */
export const query = (text, params) => db().query(text, params);
export const tx = (fn) => db().tx(fn);

export async function one(text, params) {
  const { rows } = await query(text, params);
  return rows[0] ?? null;
}

export async function many(text, params) {
  const { rows } = await query(text, params);
  return rows;
}

/**
 * Applique les migrations manquantes, dans l'ordre numérique.
 * Chaque fichier est exécuté dans une transaction : une migration qui échoue
 * ne laisse aucun état partiel.
 */
export async function migrate() {
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  const connection = db();

  // La table de suivi peut ne pas exister : la première migration la crée.
  await connection.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version integer PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`,
  );
  const { rows } = await connection.query('SELECT version FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.version));

  const executed = [];
  for (const file of files) {
    const version = Number.parseInt(file.slice(0, 3), 10);
    if (!Number.isFinite(version)) throw new Error(`MIGRATION_INVALID: ${file}`);
    if (applied.has(version)) continue;
    const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
    await connection.tx(async (client) => {
      await client.exec(sql);
      await client.query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [version, file]);
    });
    executed.push(file);
  }
  return executed;
}

/** Numéro de la dernière migration appliquée (diagnostic `/ready`). */
export async function schemaVersion() {
  const row = await one('SELECT coalesce(max(version), 0)::int AS version FROM schema_migrations');
  return row?.version ?? 0;
}

/* ------------------------------- utilitaires ------------------------------ */

/** Construit un `IN ($1, $2, …)` à partir d'un tableau (jamais de valeur inline). */
export function placeholders(values, startIndex = 1) {
  return values.map((_, i) => `$${startIndex + i}`).join(', ');
}

/**
 * Insère une ligne et renvoie l'enregistrement créé.
 * @param {string} table
 * @param {Record<string, unknown>} data
 * @param {{ returning?: string, conflict?: string, client?: { query: Function } }} [options]
 */
export async function insert(table, data, options = {}) {
  const keys = Object.keys(data);
  if (keys.length === 0) throw new Error('INSERT_EMPTY');
  const columns = keys.map((k) => `"${k}"`).join(', ');
  const values = keys.map((_, i) => `$${i + 1}`).join(', ');
  const returning = options.returning || '*';
  const conflict = options.conflict ? ` ${options.conflict}` : '';
  const sql = `INSERT INTO ${table} (${columns}) VALUES (${values})${conflict} RETURNING ${returning}`;
  const executor = options.client || db();
  const result = await executor.query(
    sql,
    keys.map((k) => data[k]),
  );
  return options.returning === 'id' ? result.rows[0]?.id : result.rows[0] ?? null;
}

/** Met à jour une ligne par identifiant (colonnes en liste blanche). */
export async function update(table, id, data, options = {}) {
  const keys = Object.keys(data);
  if (keys.length === 0) return null;
  const sets = keys.map((k, i) => `"${k}" = $${i + 1}`).join(', ');
  const executor = options.client || db();
  const result = await executor.query(
    `UPDATE ${table} SET ${sets} WHERE id = $${keys.length + 1} RETURNING *`,
    [...keys.map((k) => data[k]), id],
  );
  return result.rows[0] ?? null;
}

/** Nouvel identifiant UUID généré côté application (utile avant insertion). */
export const newId = () => randomUUID();

/** Numérotation lisible des références (`RDV-2026-000123`). */
export async function nextReference(prefix, table = 'appointments') {
  const year = new Date().getUTCFullYear();
  const row = await one(`SELECT count(*)::int AS n FROM ${table}`);
  const seq = String((row?.n ?? 0) + 1).padStart(6, '0');
  return `${prefix}-${year}-${seq}`;
}
