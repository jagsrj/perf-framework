// CI gate: run a scenario through the web app, wait for it to finish and turn the result into an exit code.
//   0 = completed and SLO passed (or no SLO set)
//   1 = completed but SLO failed (or no SLO when --require-slo is set)
//   2 = run failed, was aborted, timed out, or could not start

import { writeFile } from 'node:fs/promises';
import { PerfApiClient } from '../mcp/clients.js';

export const EXIT = { PASS: 0, SLO_FAILED: 1, ERROR: 2 };
const TERMINAL = new Set(['completed', 'failed', 'aborted']);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const escapeXml = (value) => String(value ?? '').replace(/[<>&"']/g, (c) => ({
  '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;'
})[c]);

export function resolveScenario(scenarios, nameOrId) {
  const byId = scenarios.find((scenario) => scenario.id === nameOrId);
  if (byId) return byId;
  const byName = scenarios.filter((scenario) => scenario.name === nameOrId);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) throw new Error(`Several scenarios are named "${nameOrId}". Use the scenario ID instead.`);
  throw new Error(`No scenario matches "${nameOrId}".`);
}

export function decideExit(run, { requireSlo = false } = {}) {
  if (run.status !== 'completed') return { code: EXIT.ERROR, reason: `Run ${run.status}${run.error ? `: ${run.error}` : ''}` };
  if (!run.slo_result) {
    return requireSlo
      ? { code: EXIT.SLO_FAILED, reason: 'No SLO targets are set for this scenario (--require-slo).' }
      : { code: EXIT.PASS, reason: 'Run completed (no SLO targets set).' };
  }
  return run.slo_result.passed
    ? { code: EXIT.PASS, reason: `SLO passed (${run.slo_result.checked} checks).` }
    : { code: EXIT.SLO_FAILED, reason: `SLO failed (${run.slo_result.failed} of ${run.slo_result.checked} checks).` };
}

export function toJUnit(run, decision) {
  const name = `perf.${run.scenario_name}`;
  const seconds = run.ended_at ? (new Date(run.ended_at) - new Date(run.started_at)) / 1000 : 0;
  const cases = [];
  cases.push(`    <testcase classname="${escapeXml(name)}" name="run status" time="${seconds}">${
    run.status === 'completed' ? '' : `\n      <failure message="${escapeXml(decision.reason)}"/>\n    `}</testcase>`);
  for (const check of run.slo_result?.checks || []) {
    const label = `${check.scope} ${check.label || check.metric} <= ${check.target}`;
    cases.push(`    <testcase classname="${escapeXml(name)}" name="${escapeXml(label)}">${check.passed ? ''
      : `\n      <failure message="${escapeXml(`actual ${check.actual ?? 'no data'}, target <= ${check.target}`)}"/>\n    `}</testcase>`);
  }
  const failures = cases.filter((c) => c.includes('<failure')).length;
  return `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="${escapeXml(name)}" tests="${cases.length}" failures="${failures}" time="${seconds}">
${cases.join('\n')}
  </testsuite>
</testsuites>
`;
}

function summaryLines(run) {
  const s = run.summary;
  if (!s) return ['  (no summary)'];
  const n = (v, d = 1) => (Number.isFinite(v) ? Number(v).toFixed(d) : '—');
  return [
    `  samples ${s.samples} · errors ${s.failures} (${n(s.errorRatePercent, 2)}%)`,
    `  mean ${n(s.averageResponseMs)} ms · p95 ${n(s.p95ResponseMs)} ms · p99 ${n(s.p99ResponseMs)} ms · max ${n(s.maxResponseMs, 0)} ms`
  ];
}

export async function runGate({
  client,
  scenario: nameOrId,
  timeoutSeconds,
  pollSeconds = 10,
  requireSlo = false,
  junitPath,
  reportPath,
  log = console.log,
  wait = sleep,
  now = Date.now
}) {
  let run;
  try {
    const scenario = resolveScenario(await client.listScenarios(), nameOrId);
    if (!scenario.has_script) throw new Error(`Scenario "${scenario.name}" has no JMX script.`);
    const limitSeconds = timeoutSeconds ?? scenario.duration_seconds + 600;
    log(`Starting "${scenario.name}": ${scenario.users} users, ${scenario.duration_seconds}s, ramp-up ${scenario.rampup_seconds}s`);
    run = await client.startRun(scenario.id);
    log(`Run ID: ${run.run_id}`);

    const deadline = now() + limitSeconds * 1000;
    let lastStatus = run.status;
    while (!TERMINAL.has(run.status)) {
      if (now() > deadline) {
        log(`Timed out after ${limitSeconds}s; aborting run ${run.run_id}.`);
        await client.abortRun(run.run_id).catch(() => {});
        return { code: EXIT.ERROR, reason: `Timed out after ${limitSeconds}s.`, run };
      }
      await wait(pollSeconds * 1000);
      run = await client.getRun(run.run_id);
      if (run.status !== lastStatus) {
        log(`Status: ${run.status}`);
        lastStatus = run.status;
      }
    }
  } catch (error) {
    return { code: EXIT.ERROR, reason: error.message, run };
  }

  const decision = decideExit(run, { requireSlo });
  log(`Run ${run.run_id} ${run.status}`);
  for (const line of summaryLines(run)) log(line);
  for (const check of (run.slo_result?.checks || []).filter((c) => !c.passed)) {
    log(`  ✗ ${check.scope} ${check.label || check.metric}: ${check.actual ?? 'no data'} (target ≤ ${check.target})`);
  }
  if (junitPath) {
    await writeFile(junitPath, toJUnit(run, decision));
    log(`JUnit results written to ${junitPath}`);
  }
  if (reportPath) {
    const html = await client.request('GET', `/api/runs/${encodeURIComponent(run.run_id)}/report`, { accept: 'text' });
    await writeFile(reportPath, html);
    log(`HTML report written to ${reportPath}`);
  }
  return { ...decision, run };
}

export function createClient(url) {
  return new PerfApiClient({ baseUrl: url.replace(/\/$/, ''), timeoutMs: 30_000 });
}
