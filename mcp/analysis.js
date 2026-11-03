// Pure helpers used by the MCP tools. No I/O here, so everything is unit-testable.

import { compareSummaries } from '../web/public/results.js';
import { influxString } from './clients.js';

const ACTIVE_STATUSES = new Set(['starting', 'running']);

const round = (value, digits = 2) => (Number.isFinite(value) ? Number(value.toFixed(digits)) : null);

export function runTiming(run, now = Date.now()) {
  const startedAt = new Date(run.started_at).getTime();
  const endedAt = run.ended_at ? new Date(run.ended_at).getTime() : null;
  const elapsedSeconds = Math.max(0, Math.round(((endedAt ?? now) - startedAt) / 1000));
  const active = ACTIVE_STATUSES.has(run.status);
  return {
    active,
    elapsedSeconds,
    plannedDurationSeconds: run.duration_seconds,
    remainingSeconds: active ? Math.max(0, run.duration_seconds - elapsedSeconds) : 0
  };
}

// Compact view of a run for the assistant. Per-transaction detail is left out unless asked for.
export function describeRun(run, { includeTransactions = false, now } = {}) {
  const { summary, ...rest } = run;
  let summaryView = null;
  if (summary) {
    const { transactions, ...overall } = summary;
    summaryView = {
      ...overall,
      transactionCount: transactions ? Object.keys(transactions).length : 0,
      ...(includeTransactions ? { transactions } : {})
    };
  }
  return { ...rest, ...runTiming(run, now), summary: summaryView };
}

function verdictFor(metric, percentChange, tolerancePercent) {
  if (metric.lowerIsBetter === null || percentChange === null) return 'n/a';
  if (Math.abs(percentChange) <= tolerancePercent) return 'unchanged';
  const increased = percentChange > 0;
  return increased === metric.lowerIsBetter ? 'worse' : 'better';
}

// Compare two run summaries overall and for every transaction label they share.
export function compareRunSummaries(current, baseline, { tolerancePercent = 10 } = {}) {
  const overall = compareSummaries(current, baseline).map((metric) => ({
    metric: metric.key,
    label: metric.label,
    current: round(metric.value),
    baseline: round(metric.baselineValue),
    delta: round(metric.delta),
    percentChange: round(metric.percentChange, 1),
    verdict: verdictFor(metric, metric.percentChange, tolerancePercent)
  }));

  const currentTx = current?.transactions || {};
  const baselineTx = baseline?.transactions || {};
  const shared = Object.keys(currentTx).filter((label) => label in baselineTx);
  const transactions = shared.map((label) => {
    const metrics = compareSummaries(currentTx[label], baselineTx[label])
      .filter((metric) => ['errorRatePercent', 'averageResponseMs', 'p95ResponseMs'].includes(metric.key));
    return {
      transaction: label,
      metrics: metrics.map((metric) => ({
        metric: metric.key,
        current: round(metric.value),
        baseline: round(metric.baselineValue),
        percentChange: round(metric.percentChange, 1),
        verdict: verdictFor(metric, metric.percentChange, tolerancePercent)
      }))
    };
  });

  const regressions = [
    ...overall.filter((m) => m.verdict === 'worse').map((m) => `overall ${m.metric} ${m.percentChange}%`),
    ...transactions.flatMap((tx) => tx.metrics
      .filter((m) => m.verdict === 'worse')
      .map((m) => `${tx.transaction} ${m.metric} ${m.percentChange}%`))
  ];

  return {
    tolerancePercent,
    overall,
    transactions,
    onlyInCurrent: Object.keys(currentTx).filter((label) => !(label in baselineTx)),
    onlyInBaseline: Object.keys(baselineTx).filter((label) => !(label in currentTx)),
    regressions
  };
}

const SLO_METRICS = {
  averageMs: 'averageResponseMs',
  p95Ms: 'p95ResponseMs',
  p99Ms: 'p99ResponseMs',
  maxMs: 'maxResponseMs',
  errorRatePercent: 'errorRatePercent'
};

// Check a summary against upper-bound targets. Missing data counts as a failure, not a pass.
export function checkSlo(summary, targets, { applyToTransactions = false } = {}) {
  const active = Object.entries(SLO_METRICS).filter(([targetKey]) => Number.isFinite(targets[targetKey]));
  if (!active.length) throw new Error('Provide at least one target (averageMs, p95Ms, p99Ms, maxMs or errorRatePercent).');

  const evaluate = (scope, data) => active.map(([targetKey, summaryKey]) => {
    const actual = data?.[summaryKey];
    const hasValue = Number.isFinite(actual);
    return {
      scope,
      metric: summaryKey,
      target: targets[targetKey],
      actual: hasValue ? round(actual) : null,
      passed: hasValue && actual <= targets[targetKey],
      note: hasValue ? undefined : 'no data'
    };
  });

  const checks = evaluate('overall', summary);
  if (applyToTransactions) {
    for (const [label, data] of Object.entries(summary?.transactions || {})) checks.push(...evaluate(label, data));
  }
  const failures = checks.filter((check) => !check.passed);
  return { passed: failures.length === 0, checked: checks.length, failed: failures.length, checks };
}

export function liveMetricsQueries(scenarioName, runId, windowSeconds) {
  const where = `time > now() - ${windowSeconds}s AND "application" = ${influxString(scenarioName)} AND "runId" = ${influxString(runId)}`;
  return {
    byTransaction: `SELECT sum("count") AS samples, sum("countError") AS errors, mean("avg") AS avg_ms, `
      + `max("pct95.0") AS p95_ms, max("pct99.0") AS p99_ms FROM "jmeter" WHERE ${where} GROUP BY "transaction"`,
    threads: `SELECT last("meanAT") AS active_threads FROM "jmeter" WHERE ${where} AND "transaction" = 'internal'`
  };
}

function rowFromSeries(series) {
  const values = series.values?.[0] || [];
  return Object.fromEntries(series.columns.map((column, index) => [column, values[index]]));
}

export function parseLiveMetrics(transactionSeries, threadSeries, windowSeconds) {
  const toMetrics = (row) => {
    const samples = Number(row.samples) || 0;
    const errors = Number(row.errors) || 0;
    return {
      samples,
      errors,
      throughputPerSecond: round(samples / windowSeconds),
      errorRatePercent: samples ? round((errors / samples) * 100) : 0,
      averageMs: round(Number(row.avg_ms)),
      worstIntervalP95Ms: round(Number(row.p95_ms)),
      worstIntervalP99Ms: round(Number(row.p99_ms))
    };
  };

  let overall = null;
  const transactions = [];
  for (const series of transactionSeries) {
    const label = series.tags?.transaction;
    if (label === 'internal') continue;
    const metrics = toMetrics(rowFromSeries(series));
    if (label === 'all') overall = metrics;
    else transactions.push({ transaction: label, ...metrics });
  }
  transactions.sort((a, b) => (b.worstIntervalP95Ms ?? 0) - (a.worstIntervalP95Ms ?? 0));

  const threadRow = threadSeries[0] ? rowFromSeries(threadSeries[0]) : {};
  return {
    windowSeconds,
    activeThreads: Number.isFinite(threadRow.active_threads) ? round(threadRow.active_threads, 0) : null,
    overall,
    transactions,
    note: overall
      ? 'Latency percentiles are the worst JMeter backend-listener interval in the window, not exact window percentiles.'
      : 'No metrics found in this window. The run may not have started sending data yet, or it has finished.'
  };
}

export function assertWithinGuardrails({ users, duration, rampup }, config) {
  const problems = [];
  if (users > config.maxUsers) problems.push(`users ${users} exceeds MCP_MAX_USERS=${config.maxUsers}`);
  if (duration > config.maxDurationSeconds) {
    problems.push(`duration ${duration}s exceeds MCP_MAX_DURATION_SECONDS=${config.maxDurationSeconds}`);
  }
  if (rampup > duration) problems.push(`ramp-up ${rampup}s is longer than duration ${duration}s`);
  if (problems.length) {
    throw new Error(`Blocked by MCP guardrails: ${problems.join('; ')}. A person can raise the limits in the MCP server environment.`);
  }
}
