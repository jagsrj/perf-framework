import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, test } from 'node:test';
import { assertSafeExposure, extractApiKey, keysMatch } from '../web/auth.js';
import { loadConfig } from '../web/config.js';
import { createApp } from '../web/create-app.js';

const API_KEY = 'test-key-0123456789abcdef0123456789';

test('refuses to expose the API on the network without a key', () => {
  assert.throws(() => assertSafeExposure({ host: '0.0.0.0', apiKey: null }), /PERF_API_KEY/);
  assert.throws(() => assertSafeExposure({ host: '127.0.0.1', apiKey: 'short' }), /at least 24/);
  assert.doesNotThrow(() => assertSafeExposure({ host: '127.0.0.1', apiKey: null }));
  assert.doesNotThrow(() => assertSafeExposure({ host: 'localhost', apiKey: null }));
  assert.doesNotThrow(() => assertSafeExposure({ host: '0.0.0.0', apiKey: API_KEY }));
});

test('reads the key from a bearer token or X-API-Key and compares it safely', () => {
  assert.equal(extractApiKey({ headers: { authorization: 'Bearer abc' } }), 'abc');
  assert.equal(extractApiKey({ headers: { 'x-api-key': ' abc ' } }), 'abc');
  assert.equal(extractApiKey({ headers: { authorization: 'Basic abc' } }), null);
  assert.equal(keysMatch('abc', 'abc'), true);
  assert.equal(keysMatch('abd', 'abc'), false);
  assert.equal(keysMatch('', 'abc'), false);
  assert.equal(keysMatch(null, 'abc'), false);
});

test('config reads WEB_HOST, PERF_API_KEY and PERF_ALLOWED_HOSTS', () => {
  const config = loadConfig({
    WEB_HOST: '0.0.0.0',
    PERF_API_KEY: API_KEY,
    PERF_ALLOWED_HOSTS: 'perf.local, 10.0.0.5:4000'
  });
  assert.equal(config.host, '0.0.0.0');
  assert.equal(config.apiKey, API_KEY);
  assert.deepEqual(config.allowedHosts, ['perf.local', '10.0.0.5:4000']);
  assert.equal(loadConfig({}).host, '127.0.0.1');
  assert.equal(loadConfig({}).apiKey, null);
});

describe('API key enforcement', () => {
  let server;
  let port;

  // A pool stub is enough: these requests never reach real queries beyond SELECT 1 / list.
  const pool = { query: async () => ({ rows: [], rowCount: 0 }) };
  const runs = {};

  function request(pathname, { method = 'GET', headers = {} } = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
      });
      req.on('error', reject);
      req.end();
    });
  }

  before(async () => {
    server = http.createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
    const config = { ...loadConfig({}), port, apiKey: API_KEY, allowedHosts: ['perf.example.com'] };
    server.on('request', createApp({ pool, runs, config }));
  });

  after(() => new Promise((resolve) => server.close(resolve)));

  test('health stays open so load balancers can probe it', async () => {
    assert.equal((await request('/api/health')).status, 200);
  });

  test('other API calls need the key', async () => {
    const missing = await request('/api/scenarios');
    assert.equal(missing.status, 401);
    assert.equal(missing.headers['www-authenticate'], 'Bearer');
    assert.equal((await request('/api/scenarios', { headers: { authorization: 'Bearer wrong' } })).status, 401);
    assert.equal((await request('/api/runs/x/abort', { method: 'POST' })).status, 401);
    assert.equal((await request('/api/scenarios', { headers: { authorization: `Bearer ${API_KEY}` } })).status, 200);
    assert.equal((await request('/api/scenarios', { headers: { 'x-api-key': API_KEY } })).status, 200);
  });

  test('the UI itself loads without a key (it prompts for one on the first API call)', async () => {
    const page = await request('/');
    assert.equal(page.status, 200);
    assert.match(page.body, /<html/i);
  });

  test('accepts configured host names and rejects others and cross-origin calls', async () => {
    const auth = { authorization: `Bearer ${API_KEY}` };
    assert.equal((await request('/api/scenarios', { headers: { ...auth, host: 'perf.example.com' } })).status, 200);
    assert.equal((await request('/api/scenarios', { headers: { ...auth, host: 'evil.example' } })).status, 403);
    const crossOrigin = await request('/api/scenarios', {
      headers: { ...auth, host: 'perf.example.com', origin: 'https://evil.example' }
    });
    assert.equal(crossOrigin.status, 403);
    const sameOrigin = await request('/api/scenarios', {
      headers: { ...auth, host: 'perf.example.com', origin: 'https://perf.example.com' }
    });
    assert.equal(sameOrigin.status, 200);
  });
});

test('the CI and MCP API client sends the key as a bearer token', async () => {
  const { PerfApiClient } = await import('../mcp/clients.js');
  const seen = [];
  const fetchImpl = async (url, options) => {
    seen.push(new Headers(options.headers));
    return new Response('[]', { status: 200 });
  };
  await new PerfApiClient({ baseUrl: 'http://x', apiKey: API_KEY, fetchImpl }).request('GET', '/api/scenarios');
  await new PerfApiClient({ baseUrl: 'http://x', fetchImpl }).request('GET', '/api/scenarios');
  assert.equal(seen[0].get('authorization'), `Bearer ${API_KEY}`);
  assert.equal(seen[1].get('authorization'), null);
});
