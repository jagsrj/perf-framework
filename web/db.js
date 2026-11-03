// PostgreSQL connection and versioned schema migrations.
//
// Migrations are plain SQL files in web/migrations named NNN_description.sql. Each one runs once,
// inside its own transaction, and is recorded in the schema_migrations table. A Postgres advisory
// lock stops two processes (for example the web app and `npm run migrate`) from migrating at once.

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');
const MIGRATION_FILE = /^\d{3,}_[a-z0-9_-]+\.sql$/i;
// Arbitrary but fixed key for pg_advisory_lock, so only one migrator runs at a time.
const MIGRATION_LOCK_KEY = 7_340_211;

export function createPool(databaseUrl) {
  return new pg.Pool({ connectionString: databaseUrl });
}

export async function listMigrations(dir = MIGRATIONS_DIR) {
  const files = (await readdir(dir)).filter((file) => MIGRATION_FILE.test(file)).sort();
  const seen = new Set();
  for (const file of files) {
    const number = file.split('_')[0];
    if (seen.has(number)) throw new Error(`Two migrations share the number ${number}.`);
    seen.add(number);
  }
  return files;
}

export async function migrate(pool, { dir = MIGRATIONS_DIR, log = () => {} } = {}) {
  const files = await listMigrations(dir);
  const client = await pool.connect();
  const applied = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((row) => row.name));

    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(path.join(dir, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw new Error(`Migration ${file} failed: ${error.message}`, { cause: error });
      }
      applied.push(file);
      log(`Applied migration ${file}`);
    }
    return applied;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => {});
    client.release();
  }
}
