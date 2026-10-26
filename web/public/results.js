export const resultMetrics = [
  { key: 'samples', label: 'Samples', suffix: '', lowerIsBetter: null },
  { key: 'failures', label: 'Failed samples', suffix: '', lowerIsBetter: true },
  { key: 'errorRatePercent', label: 'Error rate', suffix: '%', lowerIsBetter: true },
  { key: 'averageResponseMs', label: 'Mean latency', suffix: ' ms', lowerIsBetter: true },
  { key: 'p95ResponseMs', label: 'p95 latency', suffix: ' ms', lowerIsBetter: true },
  { key: 'p99ResponseMs', label: 'p99 latency', suffix: ' ms', lowerIsBetter: true },
  { key: 'maxResponseMs', label: 'Max latency', suffix: ' ms', lowerIsBetter: true }
];

export function compareSummaries(current, baseline) {
  return resultMetrics.map((metric) => {
    const value = current?.[metric.key] ?? null;
    const baselineValue = baseline?.[metric.key] ?? null;
    const delta = Number.isFinite(value) && Number.isFinite(baselineValue)
      ? value - baselineValue
      : null;
    return {
      ...metric,
      value,
      baselineValue,
      delta,
      percentChange: delta !== null && baselineValue !== 0
        ? delta / baselineValue * 100
        : null
    };
  });
}
