// End-to-end tests for remote load generators, the shared drive and live SLO aborts:
// the real controller (Express + PostgreSQL) and real agents (agent/agent.js) talking over HTTP,
// with test/fixtures/fake-jmeter.mjs standing in for JMeter.
// Needs TEST_DATABASE_URL like test/api.test.js (it uses its own agents_test schema).

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createAgent } from '../agent/agent.js';
import { decideExit } from '../cli/ci.js';
import { createAgentHub } from '../web/agent-hub.js';
import { loadConfig } from '../web/config.js';
import { createApp } from '../web/create-app.js';
import { migrate } from '../web/db.js';
import { createTestPool } from './helpers/db.js';
import { createRunService } from '../web/run-service.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fakeJmeter = path.join(projectRoot, 'test', 'fixtures', 'fake-jmeter.mjs');
const AGENT_TOKEN = 'agent-token-0123456789abcdef0123';
const quietLog = { log() {}, error() {} };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('load generators, shared drive and live SLO', { skip: databaseUrl ? false : 'set TEST_DATABASE_URL' }, () => {
  let pool;
  let server;
  let baseUrl;
  let workDir;
  let config;
  let hub;
  let agents;
  let localDocker;

  async function call(method, pathname, body, headers = {}) {
    const response = await fetch(`${baseUrl}${pathname}`, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json', ...headers } : headers,
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // not JSON
    }
    return { status: response.status, body: json, text };
  }

  async function until(check, what, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await check();
      if (value) return value;
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
      await sleep(25);
    }
  }

  const waitForStatus = (runId, statuses) =>
    until(async () => {
      const { body } = await call('GET', `/api/runs/${runId}`);
      return statuses.includes(body.status) ? body : null;
    }, `run ${runId} to reach ${statuses}`);

  function startAgent(name, extra = {}) {
    const agent = createAgent(
      {
        controllerUrl: baseUrl,
        token: AGENT_TOKEN,
        name,
        workDir: path.join(workDir, 'agents', name),
        maxThreads: null,
        jmeterBin: fakeJmeter,
        uploadIntervalMs: 100,
        keepRuns: 5,
        ...extra
      },
      { log: quietLog }
    );
    agent.run();
    agents.push(agent);
    return agent;
  }

  async function onlineGenerators(count) {
    return until(async () => {
      const { body } = await call('GET', '/api/load-generators');
      const online = body.generators.filter((generator) => generator.status === 'online');
      return online.length >= count ? online : null;
    }, `${count} online load generators`);
  }

  async function writeSharedTest() {
    const folder = path.join(config.sharedDir, 'scripts', 'checkout');
    await mkdir(path.join(folder, 'data'), { recursive: true });
    await writeFile(path.join(folder, 'checkout.jmx'), await readFile(path.join(projectRoot, 'scripts', 'sample.jmx')));
    await writeFile(path.join(folder, 'users.csv'), 'user,password\nalice,secret\n');
    await writeFile(path.join(folder, 'data', 'products.csv'), 'sku\n1\n2\n');
    await mkdir(path.join(config.sharedDir, 'plugins'), { recursive: true });
    await writeFile(path.join(config.sharedDir, 'plugins', 'custom-sampler.jar'), 'not really a jar');
  }

  before(async () => {
    pool = await createTestPool(databaseUrl, 'agents_test');
    await migrate(pool);
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE run_assignments, load_generators, test_runs, scenario_script_versions, scenarios');
    workDir = await mkdtemp(path.join(tmpdir(), 'perf-agents-'));
    agents = [];
    delete process.env.FAKE_JMETER_EXIT;
    process.env.FAKE_JMETER_BATCHES = '3';
    process.env.FAKE_JMETER_BATCH_MS = '100';
    process.env.FAKE_JMETER_ELAPSED = '100';
    process.env.FAKE_JMETER_REQUIRE = '';
    delete process.env.FAKE_JMETER_ROWS_PER_USER;

    server = http.createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;
    config = {
      ...loadConfig({}),
      port,
      uploadRoot: path.join(workDir, 'uploads'),
      resultsRoot: path.join(workDir, 'results'),
      sharedDir: path.join(workDir, 'shared'),
      agentToken: AGENT_TOKEN,
      agentHeartbeatSeconds: 0.1,
      liveSloIntervalMs: 50,
      liveSloMinSamples: 5
    };
    // Local "Docker" that runs the fake JMeter directly, for the live SLO test.
    const { spawn } = await import('node:child_process');
    const children = new Map();
    localDocker = {
      async start(options) {
        const id = `local-${options.generator}-${Date.now()}`;
        const child = spawn(
          fakeJmeter,
          [
            '-n',
            '-t',
            options.jmxPath,
            '-l',
            path.join(options.resultsDir, `results-${options.generator}.jtl`),
            `-Jthreads=${options.threads}`,
            `-Jgenerator=${options.generator}`
          ],
          { stdio: 'ignore' }
        );
        children.set(id, {
          child,
          exited: new Promise((resolve) => child.once('close', (code) => resolve(code ?? 143)))
        });
        return id;
      },
      wait: (id) => children.get(id).exited,
      stop: async (id) => children.get(id)?.child.kill('SIGTERM'),
      remove: async () => {},
      find: async () => []
    };
    hub = createAgentHub({ pool, config, log: quietLog });
    const runs = createRunService({ pool, config, docker: localDocker, agents: hub, notify: async () => {} });
    server.on('request', createApp({ pool, runs, config, agents: hub }));
  });

  afterEach(async () => {
    for (const agent of agents) await agent.shutdown();
    await sleep(150);
    await new Promise((resolve) => server.close(resolve));
    server.closeAllConnections?.();
    await rm(workDir, { recursive: true, force: true });
  });

  after(async () => {
    await pool?.end();
  });

  test('agent endpoints need the agent token, and are off without one', async () => {
    assert.equal((await call('POST', '/api/agent/register', { name: 'x' })).status, 401);
    const wrong = await call('POST', '/api/agent/register', { name: 'x' }, { authorization: 'Bearer nope' });
    assert.equal(wrong.status, 401);
    config.agentToken = null;
    assert.equal((await call('POST', '/api/agent/register', { name: 'x' })).status, 503);
  });

  test('lists scripts with their data files and plugins from the shared drive', async () => {
    await writeSharedTest();
    const { body } = await call('GET', '/api/shared');
    assert.deepEqual(body.scripts, [
      {
        path: 'checkout/checkout.jmx',
        folder: 'checkout',
        dataFiles: ['data/products.csv', 'users.csv'],
        bundleBytes: body.scripts[0].bundleBytes
      }
    ]);
    assert.deepEqual(
      body.plugins.map((plugin) => plugin.path),
      ['custom-sampler.jar']
    );

    const base = { name: 'x', scriptName: 'x.jmx', users: 2, duration: 10, rampup: 0, scriptSource: 'shared' };
    for (const sharedScript of [
      '../../../etc/passwd.jmx',
      '/etc/hosts.jmx',
      'checkout/missing.jmx',
      'checkout/users.csv'
    ]) {
      const result = await call('POST', '/api/scenarios', { ...base, sharedScript });
      assert.ok([400, 404].includes(result.status), `${sharedScript} -> ${result.status}`);
    }
    assert.equal(
      (await call('POST', '/api/scenarios', { ...base, sharedScript: 'checkout/checkout.jmx', plugins: ['../x.jar'] }))
        .status,
      400
    );
    const ok = await call('POST', '/api/scenarios', {
      ...base,
      sharedScript: 'checkout/checkout.jmx',
      plugins: ['custom-sampler.jar']
    });
    assert.equal(ok.status, 201, ok.text);
    assert.equal(ok.body.has_script, true);
    assert.deepEqual(ok.body.plugins, ['custom-sampler.jar']);
    const script = await call('GET', `/api/scenarios/${ok.body.id}/script`);
    assert.match(script.text, /jmeterTestPlan/);
  });

  test('runs a shared-drive scenario on two remote load generators with plugins and data files', async () => {
    await writeSharedTest();
    process.env.FAKE_JMETER_REQUIRE = 'users.csv,data/products.csv,plugins/custom-sampler.jar';
    startAgent('lg-east');
    startAgent('lg-west');
    const generators = await onlineGenerators(2);

    const created = await call('POST', '/api/scenarios', {
      name: 'checkout-remote',
      scriptName: 'checkout.jmx',
      users: 10,
      duration: 30,
      rampup: 0,
      scriptSource: 'shared',
      sharedScript: 'checkout/checkout.jmx',
      plugins: ['custom-sampler.jar'],
      loadGeneratorIds: generators.map((generator) => generator.id),
      slo: { p95Ms: 500 }
    });
    assert.equal(created.status, 201, created.text);
    assert.equal(created.body.generators, 2);

    const started = await call('POST', `/api/scenarios/${created.body.id}/runs`);
    assert.equal(started.status, 202, started.text);
    assert.equal(started.body.execution, 'agents');
    const run = await waitForStatus(started.body.run_id, ['completed', 'failed', 'aborted']);
    assert.equal(run.status, 'completed', run.error);
    assert.equal(run.summary.samples, 50, '10 users x 5 samples, merged from both generators');
    assert.equal(run.slo_result.passed, true);
    assert.deepEqual(run.plugins, ['custom-sampler.jar']);
    assert.deepEqual(run.loadGenerators.map((a) => [a.load_generator_name, a.threads, a.status, a.exit_code]).sort(), [
      ['lg-east', 5, 'finished', 0],
      ['lg-west', 5, 'finished', 0]
    ]);

    // Each agent got the bundle and was pointed at the plugin folder.
    const argsFiles = agents.map((agent) =>
      path.join(
        workDir,
        'agents',
        agent === agents[0] ? 'lg-east' : 'lg-west',
        'runs',
        run.loadGenerators.find((a) => a.load_generator_id === agent.id).id,
        'fake-jmeter-args.json'
      )
    );
    for (const file of argsFiles) {
      const { args } = JSON.parse(await readFile(file, 'utf8'));
      assert.ok(args.some((arg) => arg.startsWith('-Jsearch_paths=') && arg.endsWith(`${path.sep}plugins`)));
      assert.ok(args.includes('-Jthreads=5'));
      assert.ok(args.some((arg) => arg.endsWith('checkout-influx.jmx')));
    }

    // Results were streamed to the controller.
    const resultsDir = path.join(config.resultsRoot, run.run_id);
    assert.ok(existsSync(path.join(resultsDir, 'results-1.jtl')));
    assert.ok(existsSync(path.join(resultsDir, 'results-2.jtl')));
    assert.ok(existsSync(path.join(resultsDir, 'bundle', 'users.csv')), 'bundle snapshot kept with the run');
  });

  test('will not start when a selected generator is offline or disabled', async () => {
    startAgent('lg-1');
    startAgent('lg-2');
    const generators = await onlineGenerators(2);
    const scenario = (
      await call('POST', '/api/scenarios', {
        name: 'needs-two',
        scriptName: 'sample.jmx',
        users: 4,
        duration: 10,
        rampup: 0,
        loadGeneratorIds: generators.map((generator) => generator.id)
      })
    ).body;
    const form = new FormData();
    form.append('script', new Blob([await readFile(path.join(projectRoot, 'scripts', 'sample.jmx'))]), 'sample.jmx');
    await fetch(`${baseUrl}/api/scenarios/${scenario.id}/script`, { method: 'POST', body: form });

    await call('PATCH', `/api/load-generators/${generators[1].id}`, { enabled: false });
    const disabled = await call('POST', `/api/scenarios/${scenario.id}/runs`);
    assert.equal(disabled.status, 409);
    assert.match(disabled.body.error, /"lg-2" is disabled/);

    await call('PATCH', `/api/load-generators/${generators[1].id}`, { enabled: true });
    await agents[0].shutdown();
    await pool.query("UPDATE load_generators SET last_seen_at = now() - interval '10 minutes' WHERE name = 'lg-1'");
    const offline = await call('POST', `/api/scenarios/${scenario.id}/runs`);
    assert.equal(offline.status, 409);
    assert.match(offline.body.error, /"lg-1" is offline/);
  });

  test('aborting a remote run stops JMeter on every generator', async () => {
    await writeSharedTest();
    process.env.FAKE_JMETER_BATCHES = '200'; // ~20 s unless stopped
    process.env.FAKE_JMETER_ROWS_PER_USER = '200';
    startAgent('lg-a');
    startAgent('lg-b');
    const generators = await onlineGenerators(2);
    const scenario = (
      await call('POST', '/api/scenarios', {
        name: 'long',
        scriptName: 'checkout.jmx',
        users: 4,
        duration: 60,
        rampup: 0,
        scriptSource: 'shared',
        sharedScript: 'checkout/checkout.jmx',
        loadGeneratorIds: generators.map((generator) => generator.id)
      })
    ).body;
    const started = await call('POST', `/api/scenarios/${scenario.id}/runs`);
    await until(async () => {
      const { body } = await call('GET', `/api/runs/${started.body.run_id}`);
      return (
        body.loadGenerators.length === 2 && body.loadGenerators.every((a) => a.status === 'running' && a.jtl_bytes > 0)
      );
    }, 'both generators to be running and streaming');

    const aborted = await call('POST', `/api/runs/${started.body.run_id}/abort`);
    assert.equal(aborted.status, 200);
    await until(async () => {
      const { body } = await call('GET', `/api/runs/${started.body.run_id}`);
      return body.loadGenerators.every((a) => a.status === 'finished') ? body : null;
    }, 'generators to stop');
    // The summary is written once every generator has reported back.
    const run = await until(async () => {
      const { body } = await call('GET', `/api/runs/${started.body.run_id}`);
      return body.status === 'aborted' && body.summary ? body : null;
    }, 'the aborted run to be summarised');
    assert.equal(run.aborted_by, 'user');
    assert.ok(run.summary.samples > 0, 'partial results were kept');
    assert.ok(run.loadGenerators.every((a) => a.exit_code === 143));
  });

  test('fails the run when a load generator stops responding', async () => {
    // A hand-driven "agent" that starts its work and then goes silent.
    const auth = { authorization: `Bearer ${AGENT_TOKEN}` };
    const registered = (await call('POST', '/api/agent/register', { name: 'flaky' }, auth)).body;
    const scenario = (
      await call('POST', '/api/scenarios', {
        name: 'flaky-run',
        scriptName: 'sample.jmx',
        users: 2,
        duration: 10,
        rampup: 0,
        loadGeneratorIds: [registered.id]
      })
    ).body;
    const form = new FormData();
    form.append('script', new Blob([await readFile(path.join(projectRoot, 'scripts', 'sample.jmx'))]), 'sample.jmx');
    await fetch(`${baseUrl}/api/scenarios/${scenario.id}/script`, { method: 'POST', body: form });
    const started = await call('POST', `/api/scenarios/${scenario.id}/runs`);
    const work = await until(async () => {
      const reply = await call('POST', `/api/agent/${registered.id}/heartbeat`, {}, auth);
      return reply.body.assignments[0];
    }, 'the assignment');
    assert.equal(work.threads, 2);
    const agentHeaders = { ...auth, 'x-agent-id': registered.id };
    assert.equal((await call('POST', `/api/agent/assignments/${work.id}/start`, undefined, agentHeaders)).status, 200);
    assert.equal(
      (
        await call('POST', `/api/agent/assignments/${work.id}/start`, undefined, {
          ...auth,
          'x-agent-id': '00000000-0000-4000-8000-000000000000'
        })
      ).status,
      403,
      'another agent cannot touch this assignment'
    );

    // Streamed JTL must arrive in order.
    const chunk = (offset, text) =>
      fetch(`${baseUrl}/api/agent/assignments/${work.id}/jtl?offset=${offset}`, {
        method: 'POST',
        headers: agentHeaders,
        body: text
      });
    const header = 'timeStamp,elapsed,label,responseCode,success\n';
    assert.equal((await chunk(0, header)).status, 200);
    const conflict = await chunk(0, header);
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).expectedOffset, header.length);
    assert.equal((await chunk(header.length, '1,120,login,200,true\n')).status, 200);

    await pool.query("UPDATE load_generators SET last_seen_at = now() - interval '10 minutes' WHERE id = $1", [
      registered.id
    ]);
    const lost = await hub.sweep();
    assert.equal(lost.length, 1);
    const run = await waitForStatus(started.body.run_id, ['failed']);
    assert.match(run.error, /"flaky" stopped responding/);
    assert.equal(run.summary.samples, 1, 'what was streamed before the failure is kept');
  });

  test('live SLO check aborts a run that breaches its targets after the warm-up', async () => {
    process.env.FAKE_JMETER_BATCHES = '100';
    process.env.FAKE_JMETER_ROWS_PER_USER = '100';
    process.env.FAKE_JMETER_ELAPSED = '900';
    const scenario = (
      await call('POST', '/api/scenarios', {
        name: 'slow-service',
        scriptName: 'sample.jmx',
        users: 4,
        duration: 60,
        rampup: 0,
        slo: { p95Ms: 300, abortOnFail: true, abortDelaySeconds: 0 }
      })
    ).body;
    assert.equal(scenario.slo.abortOnFail, true);
    const form = new FormData();
    form.append('script', new Blob([await readFile(path.join(projectRoot, 'scripts', 'sample.jmx'))]), 'sample.jmx');
    await fetch(`${baseUrl}/api/scenarios/${scenario.id}/script`, { method: 'POST', body: form });

    const started = await call('POST', `/api/scenarios/${scenario.id}/runs`);
    const run = await until(async () => {
      const { body } = await call('GET', `/api/runs/${started.body.run_id}`);
      return ['completed', 'failed'].includes(body.status) || (body.status === 'aborted' && body.summary) ? body : null;
    }, 'the run to end');
    assert.equal(run.status, 'aborted');
    assert.equal(run.aborted_by, 'slo');
    assert.ok(run.summary.samples < 400, 'stopped well before the end');
    assert.match(run.error, /Aborted by live SLO check: p95 latency 900 > 300/);
    assert.equal(run.slo_result.passed, false);
    assert.equal(decideExit(run).code, 1, 'CI treats a live SLO abort as an SLO failure, not an error');
  });
});
