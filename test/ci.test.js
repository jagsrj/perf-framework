import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EXIT, decideExit, resolveScenario, runGate, toJUnit } from '../cli/ci.js';

const scenarios = [
  { id: 'a', name: 'checkout', has_script: true, users: 10, duration_seconds: 60, rampup_seconds: 5 },
  { id: 'b', name: 'dup', has_script: true }, { id: 'c', name: 'dup', has_script: true }
];
const sloResult = (passed) => ({
  passed, checked: 2, failed: passed ? 0 : 1,
  checks: [
    { scope: 'overall', metric: 'p95ResponseMs', label: 'p95 latency', target: 500, actual: passed ? 400 : 650, passed },
    { scope: 'overall', metric: 'errorRatePercent', label: 'Error rate', target: 1, actual: 0.5, passed: true }
  ]
});
const completed = (overrides = {}) => ({
  run_id: 'r1', scenario_name: 'checkout', status: 'completed', started_at: '2026-01-01T00:00:00Z', ended_at: '2026-01-01T00:01:00Z',
  summary: { samples: 10, failures: 0, errorRatePercent: 0, averageResponseMs: 100, p95ResponseMs: 400, p99ResponseMs: 450, maxResponseMs: 500 },
  slo: { p95Ms: 500 }, slo_result: sloResult(true), ...overrides
});

function fakeClient(statuses, final) {
  const calls = [];
  let index = 0;
  return {
    calls,
    listScenarios: async () => scenarios,
    startRun: async (id) => { calls.push(['start', id]); return { run_id: 'r1', status: 'starting' }; },
    getRun: async () => (index < statuses.length ? { run_id: 'r1', status: statuses[index++] } : final),
    abortRun: async (id) => { calls.push(['abort', id]); },
    request: async () => '<html>report</html>'
  };
}

test('resolveScenario matches by ID or unique name', () => {
  assert.equal(resolveScenario(scenarios, 'a').name, 'checkout');
  assert.equal(resolveScenario(scenarios, 'checkout').id, 'a');
  assert.throws(() => resolveScenario(scenarios, 'dup'), /Several scenarios/);
  assert.throws(() => resolveScenario(scenarios, 'nope'), /No scenario/);
});

test('decideExit maps run outcomes to exit codes', () => {
  assert.equal(decideExit(completed()).code, EXIT.PASS);
  assert.equal(decideExit(completed({ slo_result: sloResult(false) })).code, EXIT.SLO_FAILED);
  assert.equal(decideExit(completed({ slo: null, slo_result: null })).code, EXIT.PASS);
  assert.equal(decideExit(completed({ slo: null, slo_result: null }), { requireSlo: true }).code, EXIT.SLO_FAILED);
  assert.equal(decideExit(completed({ status: 'failed', error: 'x' })).code, EXIT.ERROR);
});

test('runGate polls until the run finishes and writes JUnit and report files', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ci-gate-'));
  const client = fakeClient(['running', 'running'], completed({ slo_result: sloResult(false) }));
  const logs = [];
  const result = await runGate({
    client, scenario: 'checkout', wait: async () => {}, log: (line) => logs.push(line),
    junitPath: path.join(dir, 'junit.xml'), reportPath: path.join(dir, 'report.html')
  });
  assert.equal(result.code, EXIT.SLO_FAILED);
  assert.deepEqual(client.calls, [['start', 'a']]);
  assert.ok(logs.some((line) => line.includes('✗ overall p95 latency: 650')));
  const junit = await readFile(path.join(dir, 'junit.xml'), 'utf8');
  assert.match(junit, /tests="3" failures="1"/);
  assert.match(junit, /overall p95 latency &lt;= 500/);
  assert.equal(await readFile(path.join(dir, 'report.html'), 'utf8'), '<html>report</html>');
});

test('runGate aborts the run on timeout', async () => {
  let clock = 0;
  const client = fakeClient(Array(100).fill('running'), null);
  const result = await runGate({
    client, scenario: 'a', timeoutSeconds: 30, pollSeconds: 10, log: () => {},
    wait: async (ms) => { clock += ms; }, now: () => clock
  });
  assert.equal(result.code, EXIT.ERROR);
  assert.match(result.reason, /Timed out/);
  assert.deepEqual(client.calls.at(-1), ['abort', 'r1']);
});

test('runGate reports start errors as exit code 2', async () => {
  const client = { listScenarios: async () => [{ id: 'x', name: 'noscript', has_script: false }] };
  const result = await runGate({ client, scenario: 'noscript', log: () => {} });
  assert.equal(result.code, EXIT.ERROR);
  assert.match(result.reason, /no JMX script/);
});

test('toJUnit marks a failed run', () => {
  const xml = toJUnit(completed({ status: 'aborted', slo_result: null }), { reason: 'Run aborted' });
  assert.match(xml, /tests="1" failures="1"/);
  assert.match(xml, /Run aborted/);
});
