// SLO (service-level objective) targets and pass/fail evaluation.
// Shared by the web app (automatic verdicts), the CI gate and the MCP server.

export const SLO_TARGETS = {
  averageMs: { summaryKey: 'averageResponseMs', label: 'Mean latency', suffix: ' ms' },
  p95Ms: { summaryKey: 'p95ResponseMs', label: 'p95 latency', suffix: ' ms' },
  p99Ms: { summaryKey: 'p99ResponseMs', label: 'p99 latency', suffix: ' ms' },
  maxMs: { summaryKey: 'maxResponseMs', label: 'Max latency', suffix: ' ms' },
  errorRatePercent: { summaryKey: 'errorRatePercent', label: 'Error rate', suffix: '%' }
};

const round = (value) => (Number.isFinite(value) ? Number(value.toFixed(2)) : null);

// Validate user input into a stored SLO object, or null when no targets are set.
// Empty strings and null mean "no target" so HTML forms can clear a field.
export function normalizeSlo(input) {
  if (input === undefined || input === null || input === '') return null;
  if (typeof input !== 'object' || Array.isArray(input)) throw invalid('SLO must be an object of targets.');
  const slo = {};
  for (const key of Object.keys(input)) {
    if (key !== 'applyToTransactions' && !(key in SLO_TARGETS)) throw invalid(`Unknown SLO target "${key}".`);
  }
  for (const key of Object.keys(SLO_TARGETS)) {
    const raw = input[key];
    if (raw === undefined || raw === null || raw === '') continue;
    const value = Number(raw);
    const max = key === 'errorRatePercent' ? 100 : 86_400_000;
    if (!Number.isFinite(value) || value < 0 || value > max) {
      throw invalid(`SLO target ${key} must be a number between 0 and ${max}.`);
    }
    slo[key] = value;
  }
  if (!Object.keys(slo).length) return null;
  slo.applyToTransactions = input.applyToTransactions === true || input.applyToTransactions === 'true';
  return slo;
}

function invalid(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

// Check a run summary against upper-bound targets. Missing data counts as a failure, not a pass.
export function evaluateSlo(summary, targets, { applyToTransactions = targets?.applyToTransactions === true } = {}) {
  const active = Object.entries(SLO_TARGETS).filter(([key]) => Number.isFinite(targets?.[key]));
  if (!active.length) throw new Error('Provide at least one target (averageMs, p95Ms, p99Ms, maxMs or errorRatePercent).');

  const evaluate = (scope, data) => active.map(([key, { summaryKey, label }]) => {
    const actual = data?.[summaryKey];
    const hasValue = Number.isFinite(actual);
    return {
      scope,
      metric: summaryKey,
      label,
      target: targets[key],
      actual: hasValue ? round(actual) : null,
      passed: hasValue && actual <= targets[key],
      ...(hasValue ? {} : { note: 'no data' })
    };
  });

  const checks = evaluate('overall', summary);
  if (applyToTransactions) {
    for (const [label, data] of Object.entries(summary?.transactions || {})) checks.push(...evaluate(label, data));
  }
  const failed = checks.filter((check) => !check.passed).length;
  return { passed: failed === 0, checked: checks.length, failed, checks };
}

export function describeSlo(slo) {
  if (!slo) return 'No SLO targets';
  const parts = Object.entries(SLO_TARGETS)
    .filter(([key]) => Number.isFinite(slo[key]))
    .map(([key, { label, suffix }]) => `${label} ≤ ${slo[key]}${suffix}`);
  return `${parts.join(', ')}${slo.applyToTransactions ? ' (overall and every transaction)' : ' (overall)'}`;
}
