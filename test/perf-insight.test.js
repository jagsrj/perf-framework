import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { analyzeWithPerfInsight, concatJtl, describeInsight, perfInsightSettings } from '../web/perf-insight.js';
import { buildNotification } from '../web/notify.js';
import { renderRunReport } from '../web/report.js';

const HEADER = 'timeStamp,elapsed,label,responseCode,success';

async function collect(iterable) {
  let out = '';
  for await (const chunk of iterable) out += chunk;
  return out;
}

async function resultsDir(files) {
  const dir = await mkdtemp(path.join(tmpdir(), 'perf-insight-'));
  for (const [name, content] of Object.entries(files)) await writeFile(path.join(dir, name), content);
  return dir;
}

const run = {
  run_id: '1793311043290-37306672',
  scenario_name: 'checkout',
  users: 20,
  duration_seconds: 300,
  rampup_seconds: 30,
  generators: 2,
  execution: 'local',
  script_name: 'checkout.jmx',
  script_version: 3,
  script_sha256: 'abcdef0123456789',
  started_at: '2026-11-04T14:00:00.000Z',
  ended_at: '2026-11-04T14:05:00.000Z'
};

// --- A stand-in perf-insight server -------------------------------------------------------------
let server;
let baseUrl;
let requests = [];
let behaviour = {};

before(async () => {
  server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      requests.push({ method: request.method, url: request.url, headers: request.headers, body });
      const send = (status, data) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(data));
      };
      if (request.url === '/runs') return send(behaviour.createStatus || 201, { id: JSON.parse(body).id });
      if (request.url.endsWith('/results/jtl')) return send(200, { transactions: 2 });
      if (request.url.endsWith('/analyze')) {
        if (behaviour.analyzeStatus) return send(behaviour.analyzeStatus, { error: 'boom' });
        return send(200, {
          runId: run.run_id,
          verdict: 'fail',
          totals: { transactions: 2, samples: 4 },
          baselineRuns: ['a', 'b'],
          failing: [{ name: 'login', reasons: ['Regression: p95 +35% vs baseline (fail threshold 20%)'] }],
          warnings: [],
          missingTransactions: [],
          aiSummary: 'Login regressed.',
          collectErrors: [],
          reportUrl: `/runs/${run.run_id}/report`
        });
      }
      send(404, { error: 'Not found' });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

const settings = (overrides = {}) => ({
  ...perfInsightSettings({
    PERF_INSIGHT_URL: `${baseUrl}/`,
    PERF_INSIGHT_API_KEY: 'k',
    PERF_INSIGHT_ENVIRONMENT: 'perf'
  }),
  ...overrides
});

// --- Tests --------------------------------------------------------------------------------------
test('settings are off unless PERF_INSIGHT_URL is set', () => {
  assert.equal(perfInsightSettings({}).enabled, false);
  const s = perfInsightSettings({
    PERF_INSIGHT_URL: 'http://x/',
    PERF_INSIGHT_SKIP_AI: 'true',
    PERF_INSIGHT_TIMEOUT_SECONDS: '60'
  });
  assert.equal(s.url, 'http://x');
  assert.equal(s.skipAi, true);
  assert.equal(s.timeoutMs, 60000);
});

test('concatJtl merges generator files with one header and line breaks between files', async () => {
  const dir = await resultsDir({
    'results-1.jtl': `${HEADER}\n1,100,login,200,true\n2,110,login,200,true`,
    'results-2.jtl': `${HEADER}\r\n3,120,search,200,true\n`,
    'other.csv': 'ignored'
  });
  const files = ['results-1.jtl', 'results-2.jtl'].map((f) => path.join(dir, f));
  assert.equal(
    await collect(concatJtl(files)),
    `${HEADER}\n1,100,login,200,true\n2,110,login,200,true\n3,120,search,200,true\n`
  );

  const bad = await resultsDir({
    'results-1.jtl': `${HEADER}\n1,1,a,200,true\n`,
    'results-2.jtl': 'other,header\n1,2\n'
  });
  await assert.rejects(
    collect(concatJtl(['results-1.jtl', 'results-2.jtl'].map((f) => path.join(bad, f)))),
    /different CSV header/
  );
});

test('registers the run, streams merged JTL results and stores a compact verdict', async () => {
  requests = [];
  behaviour = {};
  const dir = await resultsDir({
    'results-1.jtl': `${HEADER}\n1,100,login,200,true\n`,
    'results-2.jtl': `${HEADER}\n2,300,search,200,true\n`
  });
  const insight = await analyzeWithPerfInsight(run, { resultsDir: dir, settings: settings() });

  assert.deepEqual(
    requests.map((r) => `${r.method} ${r.url}`),
    [`POST /runs`, `POST /runs/${run.run_id}/results/jtl`, `POST /runs/${run.run_id}/analyze`]
  );
  assert.ok(requests.every((r) => r.headers['x-api-key'] === 'k'));
  const registered = JSON.parse(requests[0].body);
  assert.equal(registered.id, run.run_id);
  assert.equal(registered.scenario, 'checkout');
  assert.equal(registered.environment, 'perf');
  assert.equal(registered.build, 'script v3');
  assert.equal(registered.startMs, Date.parse(run.started_at));
  assert.equal(registered.metadata.generators, 2);
  assert.equal(requests[1].body, `${HEADER}\n1,100,login,200,true\n2,300,search,200,true\n`);
  assert.deepEqual(JSON.parse(requests[2].body), { collect: true, skipAi: false });

  assert.equal(insight.status, 'ok');
  assert.equal(insight.verdict, 'fail');
  assert.equal(insight.baselineRuns, 2);
  assert.equal(insight.failing[0].name, 'login');
  assert.equal(insight.reportUrl, `${baseUrl}/runs/${run.run_id}/report`);
  assert.equal(describeInsight(insight), 'regression check FAIL');
});

test('an already registered run is uploaded again (re-analysis)', async () => {
  requests = [];
  behaviour = { createStatus: 409 };
  const dir = await resultsDir({ 'results.jtl': `${HEADER}\n1,100,login,200,true\n` });
  const insight = await analyzeWithPerfInsight(run, { resultsDir: dir, settings: settings() });
  assert.equal(insight.status, 'ok');
  assert.equal(requests.length, 3);
});

test('perf-insight errors become { status: "error" } and never throw', async () => {
  const dir = await resultsDir({ 'results.jtl': `${HEADER}\n1,100,login,200,true\n` });
  behaviour = { analyzeStatus: 500 };
  const failed = await analyzeWithPerfInsight(run, { resultsDir: dir, settings: settings() });
  assert.equal(failed.status, 'error');
  assert.match(failed.error, /analyze: HTTP 500 boom/);

  const down = await analyzeWithPerfInsight(run, {
    resultsDir: dir,
    settings: settings({ url: 'http://127.0.0.1:1' })
  });
  assert.equal(down.status, 'error');
  assert.match(down.error, /^perf-insight: /);

  const empty = await analyzeWithPerfInsight(run, { resultsDir: await resultsDir({}), settings: settings() });
  assert.match(empty.error, /No JTL results/);

  assert.equal(await analyzeWithPerfInsight(run, { resultsDir: dir, settings: perfInsightSettings({}) }), null);
});

test('notifications and the HTML report show the regression check', () => {
  const insight = {
    status: 'ok',
    verdict: 'fail',
    baselineRuns: 3,
    failing: [{ name: 'login', reasons: ['Regression: p95 +35%'] }],
    warnings: [{ name: 'search', reasons: ['Regression: p95 +12%'] }],
    missingTransactions: [],
    aiSummary: 'Login regressed after the auth change.',
    reportUrl: 'http://insight/runs/r1/report'
  };
  const finished = {
    ...run,
    status: 'completed',
    summary: null,
    slo_result: { passed: true, failed: 0, checked: 2 },
    insight
  };
  const slack = buildNotification(finished, { format: 'slack', appUrl: 'http://app' });
  assert.match(slack.text, /❌ checkout: run completed · SLO passed · regression check FAIL/);
  assert.match(slack.text, /Regression check:\* FAIL \(login, search\)/);
  const json = buildNotification(finished, { format: 'json', appUrl: 'http://app' });
  assert.equal(json.run.insight.verdict, 'fail');

  const warn = buildNotification(
    { ...finished, insight: { ...insight, verdict: 'warn', failing: [] } },
    { format: 'slack', appUrl: 'x' }
  );
  assert.match(warn.text, /^⚠️/);

  const html = renderRunReport({ run: { ...finished, rampup_seconds: 30 }, baseline: null });
  assert.match(html, /Regression check \(perf-insight\)/);
  assert.match(html, /verdict fail/);
  assert.match(html, /Login regressed after the auth change/);
  assert.match(html, /href="http:\/\/insight\/runs\/r1\/report"/);
  assert.doesNotMatch(renderRunReport({ run: { ...finished, insight: null }, baseline: null }), /perf-insight/);
});
