import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, test } from 'node:test';
import { createServiceVirtualizerHooks, serviceVirtualizerSettings } from '../web/service-virtualizer.js';

// --- A stand-in service-virtualizer -------------------------------------------------------------

const calls = [];
let server;
let url;
let behaviour = 'ok';

before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      calls.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null });
      res.setHeader('content-type', 'application/json');
      if (behaviour === 'error') {
        res.statusCode = 500;
        return res.end(JSON.stringify({ error: 'WireMock unreachable' }));
      }
      if (behaviour === 'hang') return; // never answers
      if (req.method === 'POST') {
        const { runId, scenario } = JSON.parse(body);
        return res.end(
          JSON.stringify({ runId, scenario, timeline: scenario === 'Checkout Load' ? 'checkout-load' : null })
        );
      }
      res.end(JSON.stringify({ ended: decodeURIComponent(req.url.split('/').pop()), timeline: null }));
    });
  });
  await new Promise((resolve) => server.listen(0, resolve));
  url = `http://localhost:${server.address().port}/`;
});

after(() => server.closeAllConnections?.() ?? server.close());

const quietLog = () => {
  const lines = [];
  return { lines, log: (m) => lines.push(m), error: (m) => lines.push(m) };
};

test('settings are off unless SERVICE_VIRTUALIZER_URL is set', () => {
  assert.equal(serviceVirtualizerSettings({}).enabled, false);
  const s = serviceVirtualizerSettings({
    SERVICE_VIRTUALIZER_URL: 'http://sv:4100/',
    SERVICE_VIRTUALIZER_TIMEOUT_SECONDS: '3'
  });
  assert.deepEqual(s, { url: 'http://sv:4100', enabled: true, timeoutMs: 3000 });
});

test('disabled hooks make no calls', async () => {
  const hooks = createServiceVirtualizerHooks({
    settings: serviceVirtualizerSettings({}),
    fetchImpl: () => assert.fail('no call expected')
  });
  assert.equal(await hooks.runStarted('r1', 'x'), null);
  assert.equal(await hooks.runEnded('r1'), null);
});

test('starts and ends the run with its id and scenario', async () => {
  behaviour = 'ok';
  calls.length = 0;
  const log = quietLog();
  const hooks = createServiceVirtualizerHooks({
    settings: serviceVirtualizerSettings({ SERVICE_VIRTUALIZER_URL: url }),
    log
  });
  const started = await hooks.runStarted('1793311043290-37306672', 'Checkout Load');
  assert.equal(started.timeline, 'checkout-load');
  const ended = await hooks.runEnded('1793311043290-37306672');
  assert.equal(ended.ended, '1793311043290-37306672');
  assert.deepEqual(calls, [
    { method: 'POST', url: '/api/runs', body: { runId: '1793311043290-37306672', scenario: 'Checkout Load' } },
    { method: 'DELETE', url: '/api/runs/1793311043290-37306672', body: null }
  ]);
  assert.match(log.lines.join('\n'), /playing timeline "checkout-load"/);
});

test('a failing virtualizer never throws', async () => {
  behaviour = 'error';
  const log = quietLog();
  const hooks = createServiceVirtualizerHooks({
    settings: serviceVirtualizerSettings({ SERVICE_VIRTUALIZER_URL: url }),
    log
  });
  assert.deepEqual(await hooks.runStarted('r2', 'x'), { status: 'error', error: 'WireMock unreachable' });
  assert.deepEqual(await hooks.runEnded('r2'), { status: 'error', error: 'WireMock unreachable' });
  assert.equal(log.lines.length, 2);
});

test('an unreachable or hanging virtualizer times out instead of blocking the run', async () => {
  const down = createServiceVirtualizerHooks({
    settings: serviceVirtualizerSettings({ SERVICE_VIRTUALIZER_URL: 'http://localhost:1' }),
    log: quietLog()
  });
  assert.equal((await down.runStarted('r3', 'x')).status, 'error');

  behaviour = 'hang';
  const hanging = createServiceVirtualizerHooks({
    settings: { ...serviceVirtualizerSettings({ SERVICE_VIRTUALIZER_URL: url }), timeoutMs: 200 },
    log: quietLog()
  });
  const start = Date.now();
  assert.equal((await hanging.runStarted('r4', 'x')).status, 'error');
  assert.ok(Date.now() - start < 2000);
});
