import assert from 'node:assert/strict';
import test from 'node:test';
import { compareSummaries } from '../web/public/results.js';

test('compares run metrics with a previous baseline', () => {
  const comparison = compareSummaries(
    { samples: 120, failures: 6, errorRatePercent: 5, averageResponseMs: 110 },
    { samples: 100, failures: 2, errorRatePercent: 2, averageResponseMs: 100 }
  );

  assert.deepEqual(
    comparison.slice(0, 4).map(({ key, value, baselineValue, delta, percentChange }) => ({
      key,
      value,
      baselineValue,
      delta,
      percentChange
    })),
    [
      { key: 'samples', value: 120, baselineValue: 100, delta: 20, percentChange: 20 },
      { key: 'failures', value: 6, baselineValue: 2, delta: 4, percentChange: 200 },
      { key: 'errorRatePercent', value: 5, baselineValue: 2, delta: 3, percentChange: 150 },
      { key: 'averageResponseMs', value: 110, baselineValue: 100, delta: 10, percentChange: 10 }
    ]
  );
});

test('leaves differences unavailable when a baseline value is missing or zero', () => {
  const comparison = compareSummaries(
    { samples: 12, failures: 0, averageResponseMs: 10 },
    { samples: 0, failures: 0, averageResponseMs: null }
  );

  assert.equal(comparison[0].delta, 12);
  assert.equal(comparison[0].percentChange, null);
  assert.equal(comparison[1].delta, 0);
  assert.equal(comparison[1].percentChange, null);
  assert.equal(comparison[3].delta, null);
  assert.equal(comparison[3].percentChange, null);
});
