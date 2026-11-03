// Network access control for the web app.
//
// Local mode (default): listens on 127.0.0.1 and only accepts localhost Host headers. No key needed.
// Remote mode: set PERF_API_KEY (and usually WEB_HOST=0.0.0.0 and PERF_ALLOWED_HOSTS). Every /api
// request except GET /api/health must then send the key as "Authorization: Bearer <key>" or
// "X-API-Key: <key>". The server refuses to listen on a non-loopback address without a key.

import { createHash, timingSafeEqual } from 'node:crypto';

export const MIN_API_KEY_LENGTH = 24;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

export function isLoopbackHost(host) {
  return LOOPBACK_HOSTS.has(String(host).toLowerCase());
}

// Throws if the configuration would expose an unauthenticated API to the network.
export function assertSafeExposure({ host, apiKey }) {
  if (apiKey && apiKey.length < MIN_API_KEY_LENGTH) {
    throw new Error(`PERF_API_KEY must be at least ${MIN_API_KEY_LENGTH} characters long.`);
  }
  if (!isLoopbackHost(host) && !apiKey) {
    throw new Error(
      `WEB_HOST=${host} would expose the API to the network without authentication. ` +
        'Set PERF_API_KEY (for example: openssl rand -hex 32) or keep WEB_HOST=127.0.0.1.'
    );
  }
}

const digest = (value) => createHash('sha256').update(String(value)).digest();

export function keysMatch(provided, expected) {
  // Hash both sides so the comparison is constant-time regardless of length.
  return Boolean(provided) && timingSafeEqual(digest(provided), digest(expected));
}

export function extractApiKey(request) {
  const authorization = request.headers.authorization || '';
  const bearer = /^Bearer\s+(.+)$/i.exec(authorization);
  if (bearer) return bearer[1].trim();
  const header = request.headers['x-api-key'];
  return typeof header === 'string' ? header.trim() : null;
}

// Rejects requests whose Host is not this server, and cross-origin browser requests.
// Guards against DNS-rebinding and drive-by requests from other websites.
export function hostGuard({ port, allowedHosts = [] }) {
  const allowed = new Set([`localhost:${port}`, `127.0.0.1:${port}`, ...allowedHosts.map((h) => h.toLowerCase())]);
  return (request, response, next) => {
    const host = String(request.headers.host || '').toLowerCase();
    if (!allowed.has(host)) {
      return response.status(403).json({ error: 'Requests for this host name are not accepted.' });
    }
    const origin = request.headers.origin;
    if (origin) {
      let originHost;
      try {
        originHost = new URL(origin).host.toLowerCase();
      } catch {
        return response.status(403).json({ error: 'Invalid request origin.' });
      }
      if (originHost !== host) {
        return response.status(403).json({ error: 'Cross-origin requests are not allowed.' });
      }
    }
    next();
  };
}

export function requireApiKey(apiKey) {
  return (request, response, next) => {
    if (!apiKey) return next();
    if (request.method === 'GET' && request.path === '/health') return next();
    if (keysMatch(extractApiKey(request), apiKey)) return next();
    response.set('WWW-Authenticate', 'Bearer');
    return response.status(401).json({ error: 'A valid API key is required.' });
  };
}
