// API tests: the real Express app and a real PostgreSQL database, with a fake Docker runtime
// standing in for JMeter. They need a throwaway database and are skipped unless TEST_DATABASE_URL is set:
//
//   TEST_DATABASE_URL=postgres://perf_framework:local-dev-only@localhost:5433/perf_framework_test npm test
//
// The tests use their own schema in that database and drop and recreate it.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../web/config.js';
import { createApp } from '../web/create-app.js';
import { migrate } from '../web/db.js';
import { createTestPool } from './helpers/db.js';
import { createRunService } from '../web/run-service.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sampleJmx = path.join(projectRoot, 'scripts', 'sample.jmx');

const JTL_HEADER = 'timeStamp,elapsed,label,responseCode,success\n';
const jtl = (rows) => JTL_HEADER + rows.map(([elapsed, label, ok]) => `0,${elapsed},${label},200,${ok}`).join('\n');

// A stand-in for Docker. Each started "container" writes a JTL file and then waits until
// the test calls finish(exitCode) (or the run is stopped).
function createFakeDocker() {
  const containers = new Map();
  let counter = 0;
  const fake = {
    started: [],
    stopped: [],
    jtlRows: [
      [100, 'login', 'true'],
      [200, 'login', 'true'],
      [300, 'search', 'false']
    ],
    async start(options) {
      const id = `fake-${++counter}`;
      await writeFile(path.join(options.resultsDir, `results-${options.generator}.jtl`), jtl(fake.jtlRows));
      let resolveExit;
      const exited = new Promise((resolve) => {
        resolveExit = resolve;
      });
      containers.set(id, { options, exited, resolveExit });
      fake.started.push({ id, ...options });
      return id;
    },
    wait: (id) => containers.get(id).exited,
    async stop(id) {
      fake.stopped.push(id);
      containers.get(id)?.resolveExit(143);
    },
    remove: async () => {},
    find: async (runId) => [...containers].filter(([, c]) => c.options.runId === runId).map(([id]) => id),
    finish(exitCode = 0, index = fake.started.length - 1) {
      containers.get(fake.started[index].id).resolveExit(exitCode);
    }
  };
  return fake;
}

describe('web API', { skip: databaseUrl ? false : 'set TEST_DATABASE_URL to run the API tests' }, () => {
  let pool;
  let server;
  let baseUrl;
  let docker;
  let workDir;
  let config;

  async function call(method, pathname, body, headers = {}) {
    const isForm = body instanceof FormData;
    const response = await fetch(`${baseUrl}${pathname}`, {
      method,
      headers: body && !isForm ? { 'content-type': 'application/json', ...headers } : headers,
      body: body && !isForm ? JSON.stringify(body) : body
    });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // not JSON
    }
    return { status: response.status, body: json, text, headers: response.headers };
  }

  async function createScenario(overrides = {}) {
    const { status, body } = await call('POST', '/api/scenarios', {
      name: 'checkout',
      scriptName: 'sample.jmx',
      users: 10,
      duration: 60,
      rampup: 10,
      ...overrides
    });
    assert.equal(status, 201, JSON.stringify(body));
    return body;
  }

  async function uploadScript(scenarioId, { content, filename = 'sample.jmx' } = {}) {
    const form = new FormData();
    const xml = content ?? (await readFile(sampleJmx, 'utf8'));
    form.append('script', new Blob([xml], { type: 'application/xml' }), filename);
    return call('POST', `/api/scenarios/${scenarioId}/script`, form);
  }

  async function waitForStatus(runId, statuses, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const { body } = await call('GET', `/api/runs/${runId}`);
      if (statuses.includes(body.status)) return body;
      if (Date.now() > deadline) throw new Error(`Run ${runId} stayed ${body.status}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  async function waitForContainer(count) {
    const deadline = Date.now() + 5000;
    while (docker.started.length < count) {
      if (Date.now() > deadline) throw new Error('JMeter container was never started.');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  before(async () => {
    pool = await createTestPool(databaseUrl, 'api_test');
    await migrate(pool);
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE run_assignments, load_generators, test_runs, scenario_script_versions, scenarios');
    workDir = await mkdtemp(path.join(tmpdir(), 'perf-api-'));
    docker = createFakeDocker();

    server = http.createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;
    config = {
      ...loadConfig({}),
      port,
      uploadRoot: path.join(workDir, 'scripts'),
      resultsRoot: path.join(workDir, 'results'),
      sharedDir: path.join(workDir, 'shared')
    };
    const runs = createRunService({ pool, config, docker, notify: async () => {} });
    const analyze = async () => ({ model: 'fake', analysis: 'looks fine' });
    server.on('request', createApp({ pool, runs, config, analyze }));
  });

  after(async () => {
    await pool?.end();
  });

  // Close the per-test server and temp dir after each test.
  const cleanup = async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(workDir, { recursive: true, force: true });
  };

  test('migrations are recorded and re-running them is a no-op', async (t) => {
    t.after(cleanup);
    assert.deepEqual(await migrate(pool), []);
    const { rows } = await pool.query('SELECT name FROM schema_migrations ORDER BY name');
    assert.ok(rows.some((row) => row.name === '001_initial_schema.sql'));
  });

  test('health check and unknown API routes', async (t) => {
    t.after(cleanup);
    assert.deepEqual((await call('GET', '/api/health')).body, { status: 'ok' });
    const missing = await call('GET', '/api/does-not-exist');
    assert.equal(missing.status, 404);
  });

  test('rejects requests for a non-localhost Host header', async (t) => {
    t.after(cleanup);
    const status = await new Promise((resolve, reject) => {
      const request = http.request(`${baseUrl}/api/health`, { headers: { host: 'evil.example' } }, (response) => {
        response.resume();
        resolve(response.statusCode);
      });
      request.on('error', reject);
      request.end();
    });
    assert.equal(status, 403);
  });

  test('validates, creates, updates and lists scenarios', async (t) => {
    t.after(cleanup);
    const bad = await call('POST', '/api/scenarios', { name: '', scriptName: 'x.jmx', users: 1, duration: 1 });
    assert.equal(bad.status, 400);
    const badRampup = await call('POST', '/api/scenarios', {
      name: 'a',
      scriptName: 'x.jmx',
      users: 1,
      duration: 10,
      rampup: 20
    });
    assert.equal(badRampup.status, 400);
    assert.equal((await call('POST', '/api/scenarios', { name: 'a', slo: { nope: 1 } })).status, 400);

    const scenario = await createScenario({ slo: { p95Ms: 500 } });
    assert.equal(scenario.has_script, false);
    assert.equal(scenario.slo.p95Ms, 500);

    const updated = await call('PUT', `/api/scenarios/${scenario.id}`, {
      name: 'checkout v2',
      scriptName: 'sample.jmx',
      users: 20,
      duration: 120,
      rampup: 0
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.users, 20);
    assert.equal(updated.body.slo.p95Ms, 500, 'omitting slo keeps the existing targets');

    const list = await call('GET', '/api/scenarios');
    assert.equal(list.body.length, 1);
    assert.equal((await call('PUT', '/api/scenarios/not-a-uuid', {})).status, 400);
    assert.equal(
      (
        await call('PUT', '/api/scenarios/00000000-0000-4000-8000-000000000000', {
          name: 'x',
          scriptName: 'x.jmx',
          users: 1,
          duration: 1,
          rampup: 0
        })
      ).status,
      404
    );
  });

  test('uploads and versions JMX scripts, rejecting non-JMeter files', async (t) => {
    t.after(cleanup);
    const scenario = await createScenario();
    assert.equal((await uploadScript(scenario.id, { filename: 'notes.txt' })).status, 400);
    assert.equal((await uploadScript(scenario.id, { content: '<html></html>' })).status, 400);
    assert.equal((await uploadScript(scenario.id, { content: 'not xml at all <' })).status, 400);

    const first = await uploadScript(scenario.id);
    assert.equal(first.status, 200, first.text);
    assert.equal(first.body.script_version, 1);
    assert.equal(first.body.has_script, true);
    const second = await uploadScript(scenario.id);
    assert.equal(second.body.script_version, 2);

    const script = await call('GET', `/api/scenarios/${scenario.id}/script`);
    assert.match(script.text, /jmeterTestPlan/);
  });

  test('runs a scenario end to end: summary, SLO verdict, report and baseline', async (t) => {
    t.after(cleanup);
    const scenario = await createScenario({ slo: { p95Ms: 1000, errorRatePercent: 50 } });
    assert.equal((await call('POST', `/api/scenarios/${scenario.id}/runs`)).status, 400, 'no script yet');
    await uploadScript(scenario.id);

    const started = await call('POST', `/api/scenarios/${scenario.id}/runs`);
    assert.equal(started.status, 202);
    assert.equal(started.body.status, 'starting');
    assert.equal(started.body.results_dir, undefined, 'internal paths are not exposed');
    await waitForContainer(1);
    await waitForStatus(started.body.run_id, ['running']);

    const second = await call('POST', `/api/scenarios/${scenario.id}/runs`);
    assert.equal(second.status, 409, 'only one active run at a time');

    docker.finish(0);
    const run = await waitForStatus(started.body.run_id, ['completed', 'failed']);
    assert.equal(run.status, 'completed', run.error);
    assert.equal(run.summary.samples, 3);
    assert.equal(run.summary.failures, 1);
    assert.equal(run.slo_result.passed, true);
    assert.match(run.grafanaUrl, /var-runId=/);
    assert.equal(docker.started.length, 1);
    assert.equal(docker.started[0].threads, 10);
    assert.equal(docker.started[0].generator, 1);
    assert.equal(run.generators, 1);

    const report = await call('GET', `/api/runs/${run.run_id}/report`);
    assert.equal(report.status, 200);
    assert.match(report.headers.get('content-type'), /html/);
    const download = await call('GET', `/api/runs/${run.run_id}/report?download`);
    assert.match(download.headers.get('content-disposition'), /attachment/);

    // A second identical run uses the first as its baseline.
    const again = await call('POST', `/api/scenarios/${scenario.id}/runs`);
    await waitForContainer(2);
    await waitForStatus(again.body.run_id, ['running']);
    docker.finish(0);
    await waitForStatus(again.body.run_id, ['completed']);
    const results = await call('GET', `/api/runs/${again.body.run_id}/results`);
    assert.equal(results.body.baseline.run_id, run.run_id);

    const analysis = await call('POST', `/api/runs/${again.body.run_id}/ai-analysis`);
    assert.equal(analysis.status, 200);
    assert.equal(analysis.body.baseline.runId, run.run_id);

    const trends = await call('GET', `/api/scenarios/${scenario.id}/trends`);
    assert.equal(trends.body.points.length, 2);

    const runs = await call('GET', '/api/runs');
    assert.equal(runs.body.length, 2);
  });

  test('hands completed runs to perf-insight before notifying, and can re-run the check', async (t) => {
    t.after(cleanup);
    const calls = [];
    const notified = [];
    const insight = async (finishedRun, { resultsDir, settings }) => {
      calls.push({ runId: finishedRun.run_id, status: finishedRun.status, resultsDir, url: settings.url });
      if (calls.length === 1) {
        const pending = await pool.query('SELECT insight FROM test_runs WHERE run_id = $1', [finishedRun.run_id]);
        assert.deepEqual(pending.rows[0].insight, { status: 'pending' }, 'marked pending while it runs');
      }
      return { status: 'ok', verdict: calls.length === 1 ? 'fail' : 'pass', failing: [], warnings: [] };
    };
    const runs = createRunService({
      pool,
      config,
      docker,
      notify: async (finished) => notified.push(finished),
      insight,
      insightSettings: { enabled: true, url: 'http://insight.test' }
    });
    // Swap this test's server over to a run service with the perf-insight hand-off enabled.
    const plainApp = server.listeners('request')[0];
    server.removeAllListeners('request');
    server.on('request', createApp({ pool, runs, config, analyze: async () => ({}) }));
    const get = async (p) => (await call('GET', p)).body;

    const scenario = await createScenario();
    await uploadScript(scenario.id);
    const started = (await call('POST', `/api/scenarios/${scenario.id}/runs`)).body;
    await waitForContainer(1);
    docker.finish(0);
    const deadline = Date.now() + 5000;
    let run;
    do {
      await new Promise((resolve) => setTimeout(resolve, 20));
      run = await get(`/api/runs/${started.run_id}`);
    } while ((run.status !== 'completed' || run.insight?.status === 'pending') && Date.now() < deadline);

    assert.equal(run.insight.verdict, 'fail');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].status, 'completed');
    assert.match(calls[0].resultsDir, new RegExp(started.run_id));
    assert.equal(notified.length, 1);
    assert.equal(notified[0].insight.verdict, 'fail', 'the notification carries the verdict');
    assert.equal(notified[0].results_dir, undefined, 'internal paths stay out of notifications');

    const report = (await call('GET', `/api/runs/${started.run_id}/report`)).text;
    assert.match(report, /Regression check \(perf-insight\)/);

    const again = await call('POST', `/api/runs/${started.run_id}/insight`);
    assert.equal(again.status, 200);
    assert.equal(again.body.verdict, 'pass');
    assert.equal((await get(`/api/runs/${started.run_id}`)).insight.verdict, 'pass');

    // Disabled integration: the re-run endpoint explains why.
    server.removeAllListeners('request');
    server.on('request', plainApp);
    const plain = await call('POST', `/api/runs/${started.run_id}/insight`);
    assert.equal(plain.status, 409);
    assert.match(plain.body.error, /PERF_INSIGHT_URL/);
  });

  test('tells service-virtualizer when a run starts (before any load) and when it ends', async (t) => {
    t.after(cleanup);
    const events = [];
    const virtualServices = {
      enabled: true,
      runStarted: async (runId, scenarioName) => {
        events.push({ event: 'started', runId, scenarioName, containersAlreadyStarted: docker.started.length });
        return { runId, timeline: null };
      },
      runEnded: async (runId) => {
        events.push({ event: 'ended', runId });
        // A failing virtualizer reports an error but must not affect the run.
        return { status: 'error', error: 'unreachable' };
      }
    };
    const runs = createRunService({ pool, config, docker, notify: async () => {}, virtualServices });
    server.removeAllListeners('request');
    server.on('request', createApp({ pool, runs, config, analyze: async () => ({}) }));

    const scenario = await createScenario();
    await uploadScript(scenario.id);

    // A run that completes.
    const completed = (await call('POST', `/api/scenarios/${scenario.id}/runs`)).body;
    await waitForContainer(1);
    docker.finish(0);
    const done = await waitForStatus(completed.run_id, ['completed']);
    assert.equal(done.status, 'completed', 'a virtualizer error never fails the run');

    // A run that is aborted.
    const aborted = (await call('POST', `/api/scenarios/${scenario.id}/runs`)).body;
    await waitForContainer(2);
    await waitForStatus(aborted.run_id, ['running']);
    await call('POST', `/api/runs/${aborted.run_id}/abort`);
    await waitForStatus(aborted.run_id, ['aborted']);
    const deadline = Date.now() + 5000;
    while (events.filter((e) => e.event === 'ended').length < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    assert.deepEqual(events, [
      { event: 'started', runId: completed.run_id, scenarioName: scenario.name, containersAlreadyStarted: 0 },
      { event: 'ended', runId: completed.run_id },
      { event: 'started', runId: aborted.run_id, scenarioName: scenario.name, containersAlreadyStarted: 1 },
      { event: 'ended', runId: aborted.run_id }
    ]);
  });

  test('marks a run failed when JMeter exits non-zero, and fails the SLO when breached', async (t) => {
    t.after(cleanup);
    const scenario = await createScenario({ slo: { p95Ms: 10 } });
    await uploadScript(scenario.id);
    const started = await call('POST', `/api/scenarios/${scenario.id}/runs`);
    await waitForContainer(1);
    await waitForStatus(started.body.run_id, ['running']);
    docker.finish(1);
    const run = await waitForStatus(started.body.run_id, ['completed', 'failed']);
    assert.equal(run.status, 'failed');
    assert.match(run.error, /exited with code 1/);
    assert.equal(run.slo_result.passed, false);
  });

  test('aborts an active run and stops its container', async (t) => {
    t.after(cleanup);
    const scenario = await createScenario();
    await uploadScript(scenario.id);
    const started = await call('POST', `/api/scenarios/${scenario.id}/runs`);
    await waitForContainer(1);
    await waitForStatus(started.body.run_id, ['running']);

    const aborted = await call('POST', `/api/runs/${started.body.run_id}/abort`);
    assert.equal(aborted.status, 200);
    assert.deepEqual(docker.stopped, [docker.started[0].id]);
    const run = await waitForStatus(started.body.run_id, ['aborted']);
    assert.equal(run.error, 'Run aborted by user.');

    assert.equal((await call('POST', `/api/runs/${started.body.run_id}/abort`)).status, 409);
    assert.equal((await call('POST', '/api/runs/no-such-run/abort')).status, 404);
    assert.equal((await call('GET', '/api/runs/no-such-run')).status, 404);
  });

  test('validates load generators on create and update', async (t) => {
    t.after(cleanup);
    const base = { name: 'a', scriptName: 'x.jmx', users: 5, duration: 60, rampup: 0 };
    assert.equal((await call('POST', '/api/scenarios', { ...base, generators: 6 })).status, 400, 'more than users');
    assert.equal(
      (await call('POST', '/api/scenarios', { ...base, users: 500, generators: 11 })).status,
      400,
      'over max'
    );
    assert.equal((await call('POST', '/api/scenarios', { ...base, generators: 0 })).status, 400);

    const scenario = await createScenario({ users: 10, generators: 3 });
    assert.equal(scenario.generators, 3);
    const kept = await call('PUT', `/api/scenarios/${scenario.id}`, { ...base, users: 10 });
    assert.equal(kept.body.generators, 3, 'omitting generators keeps the current value');
    const shrunk = await call('PUT', `/api/scenarios/${scenario.id}`, { ...base, users: 2 });
    assert.equal(shrunk.status, 400, 'users cannot drop below the generator count');
    assert.match(shrunk.body.error, /generators/);
    assert.equal((await createScenario()).generators, 1, 'defaults to one generator');
  });

  test('splits users across load generators and merges their results', async (t) => {
    t.after(cleanup);
    const scenario = await createScenario({ users: 10, generators: 3, slo: { p95Ms: 1000, errorRatePercent: 50 } });
    await uploadScript(scenario.id);
    const started = await call('POST', `/api/scenarios/${scenario.id}/runs`);
    assert.equal(started.body.generators, 3);
    await waitForContainer(3);
    const running = await waitForStatus(started.body.run_id, ['running']);
    assert.equal(running.generators, 3);

    assert.deepEqual(
      docker.started.map((c) => c.threads),
      [4, 3, 3]
    );
    assert.deepEqual(
      docker.started.map((c) => c.generator),
      [1, 2, 3]
    );
    assert.ok(docker.started.every((c) => c.runId === started.body.run_id && c.duration === 60));

    docker.finish(0, 0);
    docker.finish(0, 1);
    assert.equal((await call('GET', `/api/runs/${started.body.run_id}`)).body.status, 'running', 'waits for all');
    docker.finish(0, 2);
    const run = await waitForStatus(started.body.run_id, ['completed', 'failed']);
    assert.equal(run.status, 'completed', run.error);
    assert.equal(run.summary.samples, 9, 'three generators x three samples');
    assert.equal(run.summary.transactions.login.samples, 6);
    assert.equal(run.slo_result.passed, true);
  });

  test('stops the other generators when one fails', async (t) => {
    t.after(cleanup);
    const scenario = await createScenario({ users: 4, generators: 2 });
    await uploadScript(scenario.id);
    const started = await call('POST', `/api/scenarios/${scenario.id}/runs`);
    await waitForContainer(2);
    await waitForStatus(started.body.run_id, ['running']);
    docker.finish(1, 0);
    const run = await waitForStatus(started.body.run_id, ['completed', 'failed']);
    assert.equal(run.status, 'failed');
    assert.match(run.error, /load generator exited with code 1/);
    assert.deepEqual(docker.stopped, [docker.started[1].id]);
  });

  test('aborting a distributed run stops every generator', async (t) => {
    t.after(cleanup);
    const scenario = await createScenario({ users: 6, generators: 3 });
    await uploadScript(scenario.id);
    const started = await call('POST', `/api/scenarios/${scenario.id}/runs`);
    await waitForContainer(3);
    await waitForStatus(started.body.run_id, ['running']);
    assert.equal((await call('POST', `/api/runs/${started.body.run_id}/abort`)).status, 200);
    assert.deepEqual(docker.stopped.slice(0, 3).sort(), docker.started.map((c) => c.id).sort());
    await waitForStatus(started.body.run_id, ['aborted']);
  });

  test('fails the run cleanly if a generator cannot start', async (t) => {
    t.after(cleanup);
    const scenario = await createScenario({ users: 4, generators: 2 });
    await uploadScript(scenario.id);
    const realStart = docker.start;
    docker.start = async (options) => {
      if (options.generator === 2) throw new Error('docker: image not found');
      return realStart(options);
    };
    const started = await call('POST', `/api/scenarios/${scenario.id}/runs`);
    const run = await waitForStatus(started.body.run_id, ['failed']);
    assert.match(run.error, /image not found/);
    assert.deepEqual(docker.stopped, [docker.started[0].id], 'the generator that did start is stopped');
  });
});
