// Builds the Express app. Kept separate from server.js so tests can create an app
// against a test database and a fake Docker runtime.

import path from 'node:path';
import express from 'express';
import { hostGuard, requireApiKey } from './auth.js';
import { asyncHandler, respondError } from './http.js';
import { runsRouter } from './routes/runs.js';
import { scenariosRouter } from './routes/scenarios.js';

export function createApp({ pool, runs, config, analyze }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(hostGuard({ port: config.port, allowedHosts: config.allowedHosts }));
  app.use(express.json({ limit: '1mb' }));
  app.use(express.static(config.publicDir));
  app.use('/api', requireApiKey(config.apiKey));

  app.get(
    '/api/health',
    asyncHandler(async (request, response) => {
      await pool.query('SELECT 1');
      response.json({ status: 'ok' });
    })
  );
  app.use('/api/scenarios', scenariosRouter({ pool, runs, config }));
  app.use('/api/runs', runsRouter({ pool, runs, config, analyze }));
  app.use('/api', (request, response) => response.status(404).json({ error: 'Not found.' }));

  app.get('*', (request, response) => {
    response.sendFile(path.join(config.publicDir, 'index.html'));
  });

  app.use((error, request, response, next) => {
    if (response.headersSent) return next(error);
    const status = error.statusCode || (error.type === 'entity.parse.failed' ? 400 : 500);
    if (status >= 500) console.error(error);
    respondError(response, error, status);
  });

  return app;
}
