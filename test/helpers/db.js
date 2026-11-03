// Gives each database test file its own PostgreSQL schema, so files that run in parallel
// (node --test runs files concurrently) never reset each other's tables.
import { createPool } from '../../web/db.js';

export async function createTestPool(databaseUrl, schema) {
  const url = new URL(databaseUrl);
  url.searchParams.set('options', `-c search_path=${schema}`);
  const pool = createPool(url.toString());
  await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await pool.query(`CREATE SCHEMA ${schema}`);
  return pool;
}
