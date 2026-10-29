// Self-contained HTML report for one run: metadata, SLO verdict, baseline comparison, per-transaction table.
// No external assets, so the file can be saved, emailed or attached to a ticket as-is.

import { compareSummaries } from './public/results.js';
import { describeSlo } from './slo.js';

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[character]);

function format(value, suffix = '') {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  const number = Number(value);
  return `${Number.isInteger(number) ? number : number.toFixed(2)}${suffix}`;
}

function changeCell(metric) {
  if (metric.delta === null) return '<td>—</td>';
  const cls = metric.lowerIsBetter === null || metric.delta === 0 ? '' : (metric.delta < 0 ? 'better' : 'worse');
  const sign = metric.delta > 0 ? '+' : '';
  const pct = metric.percentChange === null ? '' : ` (${sign}${metric.percentChange.toFixed(1)}%)`;
  return `<td class="${cls}">${sign}${format(metric.delta, metric.suffix)}${pct}</td>`;
}

function verdictBlock(run) {
  if (!run.slo) return '<div class="verdict none">No SLO targets set for this scenario</div>';
  if (!run.slo_result) return `<div class="verdict none">SLO not evaluated (run ${escapeHtml(run.status)})<br><small>${escapeHtml(describeSlo(run.slo))}</small></div>`;
  const { passed, failed, checked, checks } = run.slo_result;
  const rows = checks.map((check) => `<tr class="${check.passed ? '' : 'fail'}">
      <td>${escapeHtml(check.scope)}</td><td>${escapeHtml(check.label || check.metric)}</td>
      <td>${format(check.target)}</td><td>${format(check.actual)}</td><td>${check.passed ? 'PASS' : 'FAIL'}</td></tr>`).join('');
  return `<div class="verdict ${passed ? 'pass' : 'fail'}">SLO ${passed ? 'PASSED' : `FAILED (${failed} of ${checked} checks)`}<br>
    <small>${escapeHtml(describeSlo(run.slo))}</small></div>
    <table><thead><tr><th>Scope</th><th>Metric</th><th>Target</th><th>Actual</th><th>Result</th></tr></thead><tbody>${rows}</tbody></table>`;
}

export function renderRunReport({ run, baseline, generatedAt = new Date() }) {
  const summary = run.summary;
  const metrics = summary ? compareSummaries(summary, baseline?.summary) : [];
  const transactions = Object.entries(summary?.transactions || {}).sort(([, a], [, b]) => (b.p95ResponseMs ?? 0) - (a.p95ResponseMs ?? 0));
  const baselineTx = baseline?.summary?.transactions || {};

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Performance report · ${escapeHtml(run.scenario_name)} · ${escapeHtml(run.run_id)}</title>
<style>
  body { font: 14px/1.5 system-ui, -apple-system, Segoe UI, sans-serif; color: #1f2933; margin: 0; background: #f5f7fa; }
  main { max-width: 980px; margin: 0 auto; padding: 32px 20px 48px; }
  h1 { font-size: 24px; margin: 0 0 4px; } h2 { font-size: 17px; margin: 32px 0 10px; }
  .meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 8px 20px; background: #fff; border: 1px solid #d9e2ec; border-radius: 8px; padding: 14px 16px; }
  .meta strong { display: block; font-size: 12px; color: #627d98; font-weight: 600; }
  table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #d9e2ec; margin-top: 10px; }
  th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid #e4e7eb; font-variant-numeric: tabular-nums; }
  th { background: #f0f4f8; font-size: 12px; color: #486581; }
  .better { color: #1b7a43; } .worse { color: #c62828; } tr.fail td { background: #fdecea; }
  .verdict { padding: 14px 16px; border-radius: 8px; font-weight: 700; font-size: 16px; }
  .verdict small { font-weight: 400; font-size: 13px; }
  .verdict.pass { background: #e3f6ea; color: #1b7a43; } .verdict.fail { background: #fdecea; color: #c62828; } .verdict.none { background: #eef2f6; color: #486581; }
  .muted { color: #627d98; } footer { margin-top: 36px; font-size: 12px; color: #829ab1; }
</style>
</head>
<body><main>
<p class="muted">PERFORMANCE TEST REPORT</p>
<h1>${escapeHtml(run.scenario_name)}</h1>
<p class="muted">Status: <strong>${escapeHtml(run.status)}</strong>${run.error ? ` · ${escapeHtml(run.error)}` : ''}</p>
<section class="meta">
  <span><strong>Run ID</strong>${escapeHtml(run.run_id)}</span>
  <span><strong>Started</strong>${escapeHtml(new Date(run.started_at).toISOString())}</span>
  <span><strong>Ended</strong>${run.ended_at ? escapeHtml(new Date(run.ended_at).toISOString()) : '—'}</span>
  <span><strong>Load</strong>${escapeHtml(run.users)} users · ${escapeHtml(run.duration_seconds)}s · ${escapeHtml(run.rampup_seconds)}s ramp-up</span>
  <span><strong>Script</strong>${escapeHtml(run.script_name || 'unknown')} · v${escapeHtml(run.script_version ?? '?')}</span>
  <span><strong>Script SHA-256</strong>${escapeHtml((run.script_sha256 || '').slice(0, 16))}…</span>
</section>

<h2>SLO verdict</h2>
${verdictBlock(run)}

<h2>Summary${baseline ? ` vs baseline ${escapeHtml(baseline.run_id)}` : ''}</h2>
${summary ? `<table><thead><tr><th>Metric</th><th>This run</th><th>Baseline</th><th>Change</th></tr></thead><tbody>
${metrics.map((m) => `<tr><td>${escapeHtml(m.label)}</td><td>${format(m.value, m.suffix)}</td><td>${format(m.baselineValue, m.suffix)}</td>${changeCell(m)}</tr>`).join('\n')}
</tbody></table>
<p class="muted">${baseline ? `Baseline: latest earlier completed run with the same scenario, script and load (${escapeHtml(new Date(baseline.started_at).toISOString())}).` : 'No matching baseline run (same scenario, script and load) was found.'} Lower latency and error values are better.</p>` : '<p class="muted">No summary is available for this run.</p>'}

${transactions.length ? `<h2>Transactions (slowest p95 first)</h2>
<table><thead><tr><th>Transaction</th><th>Samples</th><th>Error rate</th><th>Mean</th><th>p95</th><th>p99</th><th>Max</th><th>p95 vs baseline</th></tr></thead><tbody>
${transactions.map(([label, tx]) => {
    const base = baselineTx[label]?.p95ResponseMs;
    const pct = Number.isFinite(base) && base !== 0 && Number.isFinite(tx.p95ResponseMs) ? ((tx.p95ResponseMs - base) / base) * 100 : null;
    const cls = pct === null || pct === 0 ? '' : (pct < 0 ? 'better' : 'worse');
    return `<tr><td>${escapeHtml(label)}</td><td>${format(tx.samples)}</td><td>${format(tx.errorRatePercent, '%')}</td><td>${format(tx.averageResponseMs, ' ms')}</td><td>${format(tx.p95ResponseMs, ' ms')}</td><td>${format(tx.p99ResponseMs, ' ms')}</td><td>${format(tx.maxResponseMs, ' ms')}</td><td class="${cls}">${pct === null ? '—' : `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`}</td></tr>`;
  }).join('\n')}
</tbody></table>` : ''}

<footer>Generated ${escapeHtml(generatedAt.toISOString())} by perf-framework. Percentiles are computed from the full JTL.</footer>
</main></body></html>`;
}
