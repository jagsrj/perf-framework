import assert from 'node:assert/strict';
import test from 'node:test';
import { describeSlo, evaluateSlo, normalizeSlo } from '../web/slo.js';

const summary = {
  samples: 100, failures: 2, errorRatePercent: 2, averageResponseMs: 120, p95ResponseMs: 300, p99ResponseMs: 500, maxResponseMs: 900,
  transactions: {
    login: { samples: 50, failures: 0, errorRatePercent: 0, averageResponseMs: 80, p95ResponseMs: 150, p99ResponseMs: 200, maxResponseMs: 300 },
    search: { samples: 50, failures: 2, errorRatePercent: 4, averageResponseMs: 160, p95ResponseMs: 450, p99ResponseMs: 700, maxResponseMs: 900 }
  }
};

test('normalizeSlo keeps numeric targets and treats blanks as unset', () => {
  assert.equal(normalizeSlo(undefined), null);
  assert.equal(normalizeSlo(null), null);
  assert.equal(normalizeSlo({ p95Ms: '', errorRatePercent: null }), null);
  assert.deepEqual(normalizeSlo({ p95Ms: '500', errorRatePercent: 1, applyToTransactions: 'true' }), {
    p95Ms: 500, errorRatePercent: 1, applyToTransactions: true
  });
});

test('normalizeSlo rejects bad input with a 400', () => {
  assert.throws(() => normalizeSlo({ p95: 5 }), { statusCode: 400, message: /Unknown SLO target "p95"/ });
  assert.throws(() => normalizeSlo({ errorRatePercent: 150 }), { statusCode: 400 });
  assert.throws(() => normalizeSlo({ p95Ms: 'fast' }), { statusCode: 400 });
  assert.throws(() => normalizeSlo([1]), { statusCode: 400 });
});

test('evaluateSlo uses the stored applyToTransactions flag by default', () => {
  const overall = evaluateSlo(summary, { p95Ms: 400, errorRatePercent: 3 });
  assert.equal(overall.passed, true);
  assert.equal(overall.checked, 2);

  const perTx = evaluateSlo(summary, { p95Ms: 400, errorRatePercent: 3, applyToTransactions: true });
  assert.equal(perTx.passed, false);
  const failed = perTx.checks.filter((c) => !c.passed).map((c) => `${c.scope}:${c.metric}`).sort();
  assert.deepEqual(failed, ['search:errorRatePercent', 'search:p95ResponseMs']);
});

test('evaluateSlo treats missing data as a failure', () => {
  const result = evaluateSlo({ samples: 0, p95ResponseMs: null }, { p95Ms: 100 });
  assert.equal(result.passed, false);
  assert.equal(result.checks[0].note, 'no data');
});

test('describeSlo renders a readable sentence', () => {
  assert.equal(describeSlo(null), 'No SLO targets');
  assert.equal(describeSlo({ p95Ms: 500, errorRatePercent: 1, applyToTransactions: false }), 'p95 latency ≤ 500 ms, Error rate ≤ 1% (overall)');
});
