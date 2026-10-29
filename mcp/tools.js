// MCP tool definitions. Each tool is a small wrapper around the existing web app API or InfluxDB.

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  assertWithinGuardrails,
  checkSlo,
  compareRunSummaries,
  describeRun,
  liveMetricsQueries,
  parseLiveMetrics
} from './analysis.js';

const scenarioId = z.string().uuid().describe('Scenario ID (UUID) from list_scenarios.');
const runId = z.string().min(1).max(200).describe('Run ID from list_runs or run_scenario.');

function ok(data) {
  return { content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] };
}

function fail(error) {
  return { isError: true, content: [{ type: 'text', text: error.message || String(error) }] };
}

function guarded(handler) {
  return async (args) => {
    try {
      return await handler(args ?? {});
    } catch (error) {
      return fail(error);
    }
  };
}

function toScenarioBody(scenario) {
  return {
    name: scenario.name,
    scriptName: scenario.script_name,
    users: scenario.users,
    duration: scenario.duration_seconds,
    rampup: scenario.rampup_seconds
  };
}

export function registerTools(server, { api, influx, config }) {
  const readOnly = { readOnlyHint: true, openWorldHint: false };
  const register = (name, definition, handler) => server.registerTool(name, definition, guarded(handler));
  const registerWrite = (name, definition, handler) => {
    if (config.readOnly) return;
    register(name, { ...definition, annotations: { readOnlyHint: false, openWorldHint: false, ...definition.annotations } }, handler);
  };

  register('check_health', {
    title: 'Check framework health',
    description: 'Checks that the perf-framework web app and its PostgreSQL database are reachable, and shows the MCP guardrail limits.',
    annotations: readOnly
  }, async () => {
    const health = await api.health();
    return ok({
      webApp: config.webBaseUrl,
      ...health,
      guardrails: { readOnly: config.readOnly, maxUsers: config.maxUsers, maxDurationSeconds: config.maxDurationSeconds }
    });
  });

  register('list_scenarios', {
    title: 'List scenarios',
    description: 'Lists test scenarios with their load settings (users, duration, ramp-up) and whether a JMX script is uploaded.',
    annotations: readOnly
  }, async () => ok(await api.listScenarios()));

  register('get_script', {
    title: 'Get scenario script',
    description: 'Returns the current JMX (JMeter XML) script for a scenario, for review or editing.',
    inputSchema: { scenarioId },
    annotations: readOnly
  }, async ({ scenarioId: id }) => ok(await api.getScript(id)));

  registerWrite('create_scenario', {
    title: 'Create scenario',
    description: 'Creates a new test scenario. Upload a JMX script with upload_script before running it. Load settings must stay within the MCP guardrails.',
    inputSchema: {
      name: z.string().min(1).max(120).describe('Scenario name, e.g. "login-smoke".'),
      scriptName: z.string().min(1).max(255).describe('Display name for the script, e.g. "login.jmx".'),
      users: z.number().int().min(1).describe('Virtual users (threads).'),
      duration: z.number().int().min(1).describe('Test duration in seconds.'),
      rampup: z.number().int().min(0).describe('Ramp-up in seconds (must not exceed duration).')
    }
  }, async (input) => {
    assertWithinGuardrails(input, config);
    return ok(await api.createScenario(input));
  });

  registerWrite('update_scenario', {
    title: 'Update scenario settings',
    description: 'Changes a scenario name or load settings. Only the fields you pass are changed.',
    inputSchema: {
      scenarioId,
      name: z.string().min(1).max(120).optional(),
      scriptName: z.string().min(1).max(255).optional(),
      users: z.number().int().min(1).optional(),
      duration: z.number().int().min(1).optional(),
      rampup: z.number().int().min(0).optional()
    },
    annotations: { idempotentHint: true }
  }, async ({ scenarioId: id, ...changes }) => {
    const current = toScenarioBody(await api.getScenario(id));
    const next = { ...current, ...Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined)) };
    assertWithinGuardrails(next, config);
    return ok(await api.updateScenario(id, next));
  });

  registerWrite('upload_script', {
    title: 'Upload JMX script',
    description: 'Uploads a JMeter .jmx script to a scenario as a new version. Pass either jmxContent (the XML text) or filePath (a .jmx file on this machine). The web app validates that it is a JMeter test plan.',
    inputSchema: {
      scenarioId,
      jmxContent: z.string().optional().describe('Full JMX XML text.'),
      filePath: z.string().optional().describe('Path to a .jmx file. Relative paths resolve from the repository root.'),
      filename: z.string().optional().describe('File name to store, e.g. "checkout.jmx". Defaults to the file name of filePath or "script.jmx".')
    }
  }, async ({ scenarioId: id, jmxContent, filePath, filename }) => {
    if (!jmxContent === !filePath) throw new Error('Provide exactly one of jmxContent or filePath.');
    let xml = jmxContent;
    let name = filename;
    if (filePath) {
      const resolved = path.resolve(config.projectRoot, filePath);
      if (path.extname(resolved).toLowerCase() !== '.jmx') throw new Error('filePath must point to a .jmx file.');
      if ((await stat(resolved)).size > config.maxScriptBytes) throw new Error('The JMX file is larger than 10 MB.');
      xml = await readFile(resolved, 'utf8');
      name = name || path.basename(resolved);
    }
    if (Buffer.byteLength(xml) > config.maxScriptBytes) throw new Error('The JMX content is larger than 10 MB.');
    name = path.basename(name || 'script.jmx');
    if (!name.toLowerCase().endsWith('.jmx')) name += '.jmx';
    return ok(await api.uploadScript(id, name, xml));
  });

  registerWrite('run_scenario', {
    title: 'Run scenario',
    description: 'Starts a load test for a scenario using its saved script and load settings. Only one run can be active at a time. Returns the run ID; poll get_run or get_live_metrics while it runs.',
    inputSchema: { scenarioId }
  }, async ({ scenarioId: id }) => {
    const scenario = await api.getScenario(id);
    if (!scenario.has_script) throw new Error('This scenario has no JMX script yet. Use upload_script first.');
    assertWithinGuardrails(toScenarioBody(scenario), config);
    const run = await api.startRun(id);
    const details = await api.getRun(run.run_id).catch(() => run);
    return ok({
      message: `Run ${run.run_id} started: ${scenario.users} users for ${scenario.duration_seconds}s (ramp-up ${scenario.rampup_seconds}s).`,
      run: describeRun(details)
    });
  });

  registerWrite('abort_run', {
    title: 'Abort run',
    description: 'Stops an active run early (10-second graceful shutdown).',
    inputSchema: { runId },
    annotations: { destructiveHint: true }
  }, async ({ runId: id }) => ok(await api.abortRun(id)));

  register('list_runs', {
    title: 'List runs',
    description: 'Lists recent runs (newest first) with status, timing and headline metrics. Optionally filter by scenario or status.',
    inputSchema: {
      scenarioId: scenarioId.optional(),
      status: z.enum(['starting', 'running', 'completed', 'failed', 'aborted']).optional(),
      limit: z.number().int().min(1).max(100).default(10)
    },
    annotations: readOnly
  }, async ({ scenarioId: id, status, limit = 10 }) => {
    const runs = (await api.listRuns())
      .filter((run) => (!id || run.scenario_id === id) && (!status || run.status === status))
      .slice(0, limit)
      .map((run) => describeRun(run));
    return ok(runs);
  });

  register('get_run', {
    title: 'Get run status',
    description: 'Shows one run: status, elapsed and remaining time, Grafana dashboard link and summary metrics.',
    inputSchema: {
      runId,
      includeTransactions: z.boolean().default(false).describe('Include per-transaction metrics in the summary.')
    },
    annotations: readOnly
  }, async ({ runId: id, includeTransactions = false }) => ok(describeRun(await api.getRun(id), { includeTransactions })));

  register('get_live_metrics', {
    title: 'Get live metrics',
    description: 'Reads live metrics for a running test from InfluxDB over a recent window: throughput, error rate, latency and active threads, overall and per transaction.',
    inputSchema: {
      runId,
      windowSeconds: z.number().int().min(10).max(3600).default(60).describe('How far back to look, in seconds.')
    },
    annotations: readOnly
  }, async ({ runId: id, windowSeconds = 60 }) => {
    const run = await api.getRun(id);
    const queries = liveMetricsQueries(run.scenario_name, run.run_id, windowSeconds);
    const [byTransaction, threads] = await Promise.all([
      influx.query(queries.byTransaction),
      influx.query(queries.threads)
    ]);
    return ok({
      runId: run.run_id,
      status: run.status,
      grafanaUrl: run.grafanaUrl,
      ...parseLiveMetrics(byTransaction, threads, windowSeconds)
    });
  });

  register('get_run_results', {
    title: 'Get run results',
    description: 'Returns the final summary of a run and compares it with the automatic baseline: the latest earlier completed run with the same scenario, script and load settings.',
    inputSchema: {
      runId,
      tolerancePercent: z.number().min(0).max(100).default(10).describe('Changes within this percentage count as "unchanged".')
    },
    annotations: readOnly
  }, async ({ runId: id, tolerancePercent = 10 }) => {
    const { run, baseline } = await api.getRunResults(id);
    if (!run.summary) return ok({ run: describeRun(run), message: 'This run has no summary yet (still running, failed, or aborted before results were written).' });
    return ok({
      run: describeRun(run, { includeTransactions: true }),
      baseline: baseline ? { runId: baseline.run_id, startedAt: baseline.started_at } : null,
      comparison: baseline ? compareRunSummaries(run.summary, baseline.summary, { tolerancePercent }) : 'No matching baseline run was found.'
    });
  });

  register('compare_runs', {
    title: 'Compare two runs',
    description: 'Compares any two runs side by side (overall and per shared transaction) and lists regressions. Use when the automatic baseline is not the run you want.',
    inputSchema: {
      runId: runId.describe('The run being evaluated.'),
      baselineRunId: runId.describe('The run to compare against.'),
      tolerancePercent: z.number().min(0).max(100).default(10)
    },
    annotations: readOnly
  }, async ({ runId: id, baselineRunId, tolerancePercent = 10 }) => {
    const [current, baseline] = await Promise.all([api.getRun(id), api.getRun(baselineRunId)]);
    if (!current.summary || !baseline.summary) throw new Error('Both runs need a completed summary to compare.');
    const sameSetup = current.script_sha256 === baseline.script_sha256
      && current.users === baseline.users
      && current.duration_seconds === baseline.duration_seconds
      && current.rampup_seconds === baseline.rampup_seconds;
    return ok({
      runId: id,
      baselineRunId,
      sameScriptAndLoad: sameSetup,
      warning: sameSetup ? undefined : 'The runs used a different script or load profile, so differences may not be like-for-like.',
      ...compareRunSummaries(current.summary, baseline.summary, { tolerancePercent })
    });
  });

  register('check_slo', {
    title: 'Check SLO targets',
    description: 'Checks a completed run against latency and error-rate targets (upper limits) and reports pass/fail per metric, overall and optionally per transaction.',
    inputSchema: {
      runId,
      p95Ms: z.number().positive().optional(),
      p99Ms: z.number().positive().optional(),
      averageMs: z.number().positive().optional(),
      maxMs: z.number().positive().optional(),
      errorRatePercent: z.number().min(0).max(100).optional(),
      applyToTransactions: z.boolean().default(false).describe('Also apply the same targets to every transaction.')
    },
    annotations: readOnly
  }, async ({ runId: id, applyToTransactions = false, ...targets }) => {
    const run = await api.getRun(id);
    if (!run.summary) throw new Error(`Run ${id} has no summary (status: ${run.status}).`);
    return ok({ runId: id, status: run.status, ...checkSlo(run.summary, targets, { applyToTransactions }) });
  });
}
