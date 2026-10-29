// End-to-end test: starts the real MCP server over stdio against a fake web app and fake InfluxDB.

import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCENARIO_ID = '11111111-2222-4333-8444-555555555555';
const summary = {
  samples: 100, failures: 1, errorRatePercent: 1, averageResponseMs: 120, p95ResponseMs: 250,
  p99ResponseMs: 400, maxResponseMs: 800, successful: 99,
  transactions: { login: { samples: 100, failures: 1, errorRatePercent: 1, averageResponseMs: 120, p95ResponseMs: 250, p99ResponseMs: 400, maxResponseMs: 800 } }
};
const scenario = {
  id: SCENARIO_ID, name: 'login-smoke', script_name: 'login.jmx', original_filename: 'login.jmx', script_version: 1,
  users: 50, duration_seconds: 300, rampup_seconds: 30, has_script: true
};
const run = (id, overrides = {}) => ({
  run_id: id, scenario_id: SCENARIO_ID, scenario_name: 'login-smoke', script_sha256: 'abc', status: 'completed',
  users: 50, duration_seconds: 300, rampup_seconds: 30, started_at: '2026-01-01T00:00:00Z',
  ended_at: '2026-01-01T00:05:00Z', summary, grafanaUrl: 'http://localhost:3000/d/x', ...overrides
});

const calls = [];
let webServer;
let influxServer;
let client;

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

before(async () => {
  webServer = await listen(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    calls.push({ method: request.method, url: request.url, body });
    const send = (status, data) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(data));
    };
    if (request.url === '/api/health') return send(200, { status: 'ok' });
    if (request.url === '/api/scenarios' && request.method === 'GET') return send(200, [scenario]);
    if (request.url === `/api/scenarios/${SCENARIO_ID}` && request.method === 'PUT') return send(200, { ...scenario, ...JSON.parse(body) });
    if (request.url === `/api/scenarios/${SCENARIO_ID}/script` && request.method === 'POST') return send(200, { ...scenario, script_version: 2 });
    if (request.url === `/api/scenarios/${SCENARIO_ID}/runs`) return send(202, run('run-new', { status: 'starting', summary: null, ended_at: null }));
    if (request.url === '/api/runs') return send(200, [run('run-2'), run('run-1')]);
    if (request.url === '/api/runs/run-new') return send(200, run('run-new', { status: 'running', summary: null, ended_at: null }));
    if (request.url === '/api/runs/run-2') return send(200, run('run-2'));
    if (request.url === '/api/runs/run-1') return send(200, run('run-1', { summary: { ...summary, p95ResponseMs: 150 } }));
    if (request.url === '/api/runs/run-2/results') {
      return send(200, { run: run('run-2'), baseline: { run_id: 'run-1', started_at: '2025-12-31T00:00:00Z', summary: { ...summary, p95ResponseMs: 150 } } });
    }
    send(404, { error: 'Not found' });
  });

  influxServer = await listen((request, response) => {
    const q = new URL(request.url, 'http://x').searchParams.get('q');
    const series = q.includes('meanAT')
      ? [{ columns: ['time', 'active_threads'], values: [[0, 25]] }]
      : [{ tags: { transaction: 'all' }, columns: ['time', 'samples', 'errors', 'avg_ms', 'p95_ms', 'p99_ms'], values: [[0, 300, 3, 110, 240, 390]] }];
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ results: [{ statement_id: 0, series }] }));
  });

  client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [path.join(projectRoot, 'mcp', 'server.js')],
    cwd: projectRoot,
    stderr: 'ignore',
    env: {
      ...process.env,
      PERF_WEB_URL: `http://127.0.0.1:${webServer.address().port}`,
      INFLUXDB_QUERY_URL: `http://127.0.0.1:${influxServer.address().port}/query`,
      MCP_MAX_USERS: '100',
      MCP_MAX_DURATION_SECONDS: '600'
    }
  }));
});

after(async () => {
  await client?.close();
  webServer?.close();
  influxServer?.close();
});

const call = async (name, args = {}) => {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content[0].text;
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { isError: Boolean(result.isError), data };
};

test('exposes the expected tools', async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [
    'abort_run', 'check_health', 'check_slo', 'compare_runs', 'create_scenario', 'get_live_metrics',
    'get_report_url', 'get_run', 'get_run_results', 'get_script', 'get_trends', 'list_runs', 'list_scenarios', 'run_scenario',
    'update_scenario', 'upload_script'
  ]);
});

test('check_health reports guardrails', async () => {
  const { data } = await call('check_health');
  assert.equal(data.status, 'ok');
  assert.equal(data.guardrails.maxUsers, 100);
});

test('run_scenario starts a run through the web app', async () => {
  const { isError, data } = await call('run_scenario', { scenarioId: SCENARIO_ID });
  assert.equal(isError, false);
  assert.equal(data.run.run_id, 'run-new');
  assert.equal(data.run.active, true);
  assert.ok(calls.some((c) => c.method === 'POST' && c.url === `/api/scenarios/${SCENARIO_ID}/runs`));
});

test('update_scenario is blocked above the guardrail and passes through otherwise', async () => {
  const blocked = await call('update_scenario', { scenarioId: SCENARIO_ID, users: 500 });
  assert.equal(blocked.isError, true);
  assert.match(blocked.data, /MCP_MAX_USERS=100/);

  const allowed = await call('update_scenario', { scenarioId: SCENARIO_ID, users: 80 });
  assert.equal(allowed.isError, false);
  const put = calls.findLast((c) => c.method === 'PUT');
  assert.deepEqual(JSON.parse(put.body), { name: 'login-smoke', scriptName: 'login.jmx', users: 80, duration: 300, rampup: 30 });
});

test('upload_script sends multipart JMX content', async () => {
  const { isError, data } = await call('upload_script', { scenarioId: SCENARIO_ID, jmxContent: '<jmeterTestPlan/>', filename: 'new' });
  assert.equal(isError, false);
  assert.equal(data.script_version, 2);
  const upload = calls.findLast((c) => c.url.endsWith('/script'));
  assert.match(upload.body, /filename="new\.jmx"/);
  assert.match(upload.body, /<jmeterTestPlan\/>/);
});

test('get_live_metrics reads InfluxDB', async () => {
  const { data } = await call('get_live_metrics', { runId: 'run-new', windowSeconds: 60 });
  assert.equal(data.overall.throughputPerSecond, 5);
  assert.equal(data.activeThreads, 25);
});

test('get_run_results compares with the baseline', async () => {
  const { data } = await call('get_run_results', { runId: 'run-2' });
  assert.equal(data.baseline.runId, 'run-1');
  assert.ok(data.comparison.regressions.some((r) => r.startsWith('overall p95ResponseMs')));
});

test('compare_runs and check_slo work on completed runs', async () => {
  const compared = await call('compare_runs', { runId: 'run-2', baselineRunId: 'run-1' });
  assert.equal(compared.data.sameScriptAndLoad, true);

  const slo = await call('check_slo', { runId: 'run-2', p95Ms: 200, errorRatePercent: 5 });
  assert.equal(slo.data.passed, false);
  assert.equal(slo.data.failed, 1);
});

test('reports web app errors as tool errors', async () => {
  const { isError, data } = await call('get_run', { runId: 'missing' });
  assert.equal(isError, true);
  assert.match(data, /Not found/);
});
