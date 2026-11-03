// Builds the Express app. Kept separate from server.js so tests can create an app
// against a test database and a fake Docker runtime.

import path from 'node:path';
import express from 'express';
import { asyncHandler, respondError } from './http.js';
import { runsRouter } from './routes/runs.js';
import { scenariosRouter } from './routes/scenarios.js';

function localhostOnly(port) {
  const allowedHosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`]);
  return (request, response, next) => {
    if (!allowedHosts.has(request.headers.host)) {
      return response.status(403).json({ error: 'This local service only accepts localhost requests.' });
    }
    const origin = request.headers.origin;
    if (origin) {
      try {
        const originUrl = new URL(origin);
        if (
          originUrl.protocol !== 'http:' ||
          !['localhost', '127.0.0.1'].includes(originUrl.hostname) ||
          Number(originUrl.port || 80) !== port
        ) {
          return response.status(403).json({ error: 'Cross-origin requests are not allowed.' });
        }
      } catch {
        return response.status(403).json({ error: 'Invalid request origin.' });
      }
    }
    next();
  };
}

export function createApp({ pool, runs, config, analyze }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(localhostOnly(config.port));
  app.use(express.json({ limit: '1mb' }));
  app.use(express.static(config.publicDir));

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
