// Entry point for the web app: `npm run web`.

import { mkdir } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { assertSafeExposure } from './auth.js';
import { loadConfig } from './config.js';
import { createApp } from './create-app.js';
import { createAgentHub } from './agent-hub.js';
import { createPool, migrate } from './db.js';
import { createRunService } from './run-service.js';

const config = loadConfig();
try {
  assertSafeExposure(config);
} catch (error) {
  console.error(`Refusing to start: ${error.message}`);
  process.exit(1);
}
await mkdir(config.uploadRoot, { recursive: true });
await mkdir(config.resultsRoot, { recursive: true });
await mkdir(path.join(config.sharedDir, 'scripts'), { recursive: true });
await mkdir(path.join(config.sharedDir, 'plugins'), { recursive: true });

const pool = createPool(config.databaseUrl);
await migrate(pool, { log: console.log });

const agents = createAgentHub({ pool, config });
agents.startSweeper();
const runs = createRunService({ pool, config, agents });
const app = createApp({ pool, runs, config, agents });

const server = http.createServer(app);
server.listen(config.port, config.host, () => {
  console.log(`Performance test UI listening at http://${config.host}:${config.port}`);
  if (config.apiKey) console.log('API key authentication is on.');
  console.log(`Shared drive: ${config.sharedDir}`);
  if (config.agentToken) console.log('Remote load generators are enabled.');
  runs.recoverActiveRuns().catch((error) => console.error(`Could not recover active runs: ${error.message}`));
});

async function shutdown() {
  agents.stopSweeper();
  server.close();
  await pool.end();
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
