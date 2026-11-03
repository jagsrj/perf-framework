// Apply pending database migrations and exit. The web app also does this on start-up,
// so running it by hand is only needed before deploying or to check the schema.
//   npm run migrate

import { loadConfig } from '../web/config.js';
import { createPool, migrate } from '../web/db.js';

const config = loadConfig();
const pool = createPool(config.databaseUrl);
try {
  const applied = await migrate(pool, { log: console.log });
  console.log(applied.length ? `Applied ${applied.length} migration(s).` : 'Database schema is up to date.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
