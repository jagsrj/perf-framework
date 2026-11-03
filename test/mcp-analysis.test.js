import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertWithinGuardrails,
  checkSlo,
  compareRunSummaries,
  describeRun,
  liveMetricsQueries,
  parseLiveMetrics,
  runTiming
} from '../mcp/analysis.js';

const summary = {
  samples: 1000,
  failures: 10,
  errorRatePercent: 1,
  averageResponseMs: 200,
  p95ResponseMs: 450,
  p99ResponseMs: 900,
  maxResponseMs: 2000,
  successful: 990,
  transactions: {
    login: { samples: 500, failures: 0, errorRatePercent: 0, averageResponseMs: 150, p95ResponseMs: 300, p99ResponseMs: 400, maxResponseMs: 600 },
    search: { samples: 500, failures: 10, errorRatePercent: 2, averageResponseMs: 250, p95ResponseMs: 700, p99ResponseMs: 1200, maxResponseMs: 2000 }
  }
};

test('runTiming reports elapsed and remaining time for active runs', () => {
  const run = { status: 'running', started_at: '2026-01-01T00:00:00Z', ended_at: null, duration_seconds: 600 };
  const timing = runTiming(run, Date.parse('2026-01-01T00:04:00Z'));
  assert.deepEqual(timing, { active: true, elapsedSeconds: 240, plannedDurationSeconds: 600, remainingSeconds: 360 });
});

test('describeRun hides per-transaction detail unless requested', () => {
  const run = { run_id: 'r1', status: 'completed', started_at: '2026-01-01T00:00:00Z', ended_at: '2026-01-01T00:10:00Z', duration_seconds: 600, summary };
  assert.equal(describeRun(run).summary.transactions, undefined);
  assert.equal(describeRun(run).summary.transactionCount, 2);
  assert.ok(describeRun(run, { includeTransactions: true }).summary.transactions.login);
});

test('compareRunSummaries flags regressions beyond the tolerance', () => {
  const baseline = structuredClone(summary);
  baseline.p95ResponseMs = 300;
  baseline.transactions.search.p95ResponseMs = 500;
  baseline.transactions.checkout = { samples: 1 };

  const result = compareRunSummaries(summary, baseline, { tolerancePercent: 10 });
  const p95 = result.overall.find((m) => m.metric === 'p95ResponseMs');
  assert.equal(p95.verdict, 'worse');
  assert.equal(p95.percentChange, 50);
  assert.equal(result.overall.find((m) => m.metric === 'averageResponseMs').verdict, 'unchanged');
  assert.equal(result.overall.find((m) => m.metric === 'samples').verdict, 'n/a');
  assert.deepEqual(result.onlyInBaseline, ['checkout']);
  assert.ok(result.regressions.includes('overall p95ResponseMs 50%'));
  assert.ok(result.regressions.includes('search p95ResponseMs 40%'));
});

test('checkSlo passes and fails per metric, including per transaction', () => {
  const overallOnly = checkSlo(summary, { p95Ms: 500, errorRatePercent: 2 });
  assert.equal(overallOnly.passed, true);
  assert.equal(overallOnly.checked, 2);

  const perTx = checkSlo(summary, { p95Ms: 500 }, { applyToTransactions: true });
  assert.equal(perTx.passed, false);
  assert.deepEqual(perTx.checks.filter((c) => !c.passed).map((c) => c.scope), ['search']);

  assert.throws(() => checkSlo(summary, {}), /at least one target/);
  assert.equal(checkSlo({ samples: 0, p95ResponseMs: null }, { p95Ms: 100 }).passed, false);
});

test('liveMetricsQueries escapes tag values', () => {
  const { byTransaction } = liveMetricsQueries("it's", 'run-1', 60);
  assert.match(byTransaction, /"application" = 'it\\'s'/);
  assert.match(byTransaction, /now\(\) - 60s/);
});

test('parseLiveMetrics computes throughput and separates transactions', () => {
  const columns = ['time', 'samples', 'errors', 'avg_ms', 'p95_ms', 'p99_ms'];
  const live = parseLiveMetrics(
    [
      { tags: { transaction: 'all' }, columns, values: [[0, 600, 6, 120.4, 300, 500]] },
      { tags: { transaction: 'login' }, columns, values: [[0, 200, 0, 80, 150, 200]] },
      { tags: { transaction: 'search' }, columns, values: [[0, 400, 6, 140, 320, 520]] },
      { tags: { transaction: 'internal' }, columns, values: [[0, null, null, null, null, null]] }
    ],
    [{ columns: ['time', 'active_threads'], values: [[0, 50]] }],
    60
  );
  assert.equal(live.overall.throughputPerSecond, 10);
  assert.equal(live.overall.errorRatePercent, 1);
  assert.equal(live.activeThreads, 50);
  assert.deepEqual(live.transactions.map((t) => t.transaction), ['search', 'login']);
  assert.equal(parseLiveMetrics([], [], 60).overall, null);
});

test('assertWithinGuardrails blocks oversized load', () => {
  const config = { maxUsers: 100, maxDurationSeconds: 600 };
  assert.doesNotThrow(() => assertWithinGuardrails({ users: 100, duration: 600, rampup: 60 }, config));
  assert.throws(() => assertWithinGuardrails({ users: 101, duration: 600, rampup: 0 }, config), /MCP_MAX_USERS=100/);
  assert.throws(() => assertWithinGuardrails({ users: 1, duration: 601, rampup: 0 }, config), /MCP_MAX_DURATION_SECONDS=600/);
});
