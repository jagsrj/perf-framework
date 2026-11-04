// Optional hand-off to perf-insight (https://github.com/jagsrj/perf-insight) when a run finishes:
// it compares the run statistically against a rolling baseline of earlier good runs, checks its
// own SLOs, pulls Dynatrace/Splunk data for the same window, adds an AI diagnosis and writes a
// report. The verdict (pass / warn / fail) is stored on the run as `insight`.
//
// Off unless PERF_INSIGHT_URL is set. A perf-insight outage never fails or delays a run's own
// status: errors are recorded on the run as { status: 'error' } and the CI gate treats them as
// "no regression check" unless --require-insight is used.

import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';

const JTL_FILE = /^results(?:-\d+)?\.jtl$/;

export function perfInsightSettings(env = process.env) {
  const url = (env.PERF_INSIGHT_URL || '').replace(/\/$/, '');
  return {
    url,
    enabled: Boolean(url),
    apiKey: env.PERF_INSIGHT_API_KEY || null,
    environment: env.PERF_INSIGHT_ENVIRONMENT || null,
    skipAi: ['1', 'true', 'yes'].includes(String(env.PERF_INSIGHT_SKIP_AI || '').toLowerCase()),
    timeoutMs: Number(env.PERF_INSIGHT_TIMEOUT_SECONDS || 300) * 1000
  };
}

export async function listJtlFiles(resultsDir) {
  return (await readdir(resultsDir))
    .filter((file) => JTL_FILE.test(file))
    .sort()
    .map((file) => path.join(resultsDir, file));
}

// One CSV stream from several JTL files (one per load generator): the header row is kept from the
// first file only, and every file must have the same header so columns line up.
export async function* concatJtl(files) {
  let header = null;
  for (const file of files) {
    let pending = '';
    let headerDone = false;
    let lastChar = '\n';
    for await (const chunk of createReadStream(file, { encoding: 'utf8' })) {
      let text = chunk;
      if (!headerDone) {
        pending += text;
        const newline = pending.indexOf('\n');
        if (newline === -1) continue;
        const line = pending.slice(0, newline).replace(/\r$/, '');
        text = pending.slice(newline + 1);
        pending = '';
        headerDone = true;
        if (header === null) {
          header = line;
          yield `${line}\n`;
        } else if (line !== header) {
          throw new Error(`${path.basename(file)} has a different CSV header from the first JTL file.`);
        }
      }
      if (text) {
        lastChar = text[text.length - 1];
        yield text;
      }
    }
    if (!headerDone && pending) {
      // File with a header and no newline: header only, or a single row without a trailing newline.
      if (header === null) {
        header = pending.replace(/\r$/, '');
        yield `${header}\n`;
      }
    } else if (lastChar !== '\n') {
      yield '\n';
    }
  }
  if (header === null) throw new Error('No JTL results to send.');
}

function shortVerdict(gate, settings) {
  const reportUrl = gate.reportUrl ? `${settings.url}${gate.reportUrl}` : null;
  return {
    status: 'ok',
    verdict: gate.verdict,
    insightRunId: gate.runId,
    totals: gate.totals,
    baselineRuns: gate.baselineRuns?.length ?? 0,
    failing: (gate.failing || []).slice(0, 20),
    warnings: (gate.warnings || []).slice(0, 20),
    missingTransactions: gate.missingTransactions || [],
    aiSummary: gate.aiSummary || null,
    collectErrors: gate.collectErrors || [],
    reportUrl,
    analyzedAt: new Date().toISOString()
  };
}

/**
 * Registers the run with perf-insight (same run ID), streams its JTL results, then asks for the
 * analysis. Resolves to the value stored in test_runs.insight; never rejects.
 */
export async function analyzeWithPerfInsight(run, { resultsDir, settings = perfInsightSettings(), fetchImpl = fetch }) {
  if (!settings.enabled) return null;
  const deadline = AbortSignal.timeout(settings.timeoutMs);
  const headers = { ...(settings.apiKey ? { 'x-api-key': settings.apiKey } : {}) };
  const call = async (method, route, body, extraHeaders = {}) => {
    const response = await fetchImpl(`${settings.url}${route}`, {
      method,
      headers: { ...headers, ...extraHeaders },
      body,
      signal: deadline,
      ...(body && typeof body !== 'string' ? { duplex: 'half' } : {})
    });
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { error: text.slice(0, 200) };
    }
    return { status: response.status, ok: response.ok, data };
  };

  try {
    const files = await listJtlFiles(resultsDir);
    if (!files.length) return { status: 'error', error: 'No JTL results to send to perf-insight.' };

    const created = await call(
      'POST',
      '/runs',
      JSON.stringify({
        id: run.run_id,
        scenario: run.scenario_name,
        environment: settings.environment,
        build:
          run.script_version != null ? `script v${run.script_version}` : (run.script_sha256 || '').slice(0, 12) || null,
        label: `${run.users} users · ${run.duration_seconds}s`,
        startMs: run.started_at ? new Date(run.started_at).getTime() : undefined,
        endMs: run.ended_at ? new Date(run.ended_at).getTime() : undefined,
        metadata: {
          source: 'perf-framework',
          users: run.users,
          durationSeconds: run.duration_seconds,
          rampupSeconds: run.rampup_seconds,
          generators: run.generators,
          execution: run.execution,
          scriptName: run.script_name,
          scriptSha256: run.script_sha256
        }
      }),
      { 'content-type': 'application/json' }
    );
    // 409 = already registered (for example a re-analysis); upload again so results are current.
    if (!created.ok && created.status !== 409) {
      return {
        status: 'error',
        error: `perf-insight POST /runs: HTTP ${created.status} ${created.data?.error || ''}`.trim()
      };
    }

    const route = `/runs/${encodeURIComponent(run.run_id)}`;
    const uploaded = await call('POST', `${route}/results/jtl`, Readable.from(concatJtl(files)), {
      'content-type': 'text/csv'
    });
    if (!uploaded.ok) {
      return {
        status: 'error',
        error: `perf-insight JTL upload: HTTP ${uploaded.status} ${uploaded.data?.error || ''}`.trim()
      };
    }

    const analyzed = await call(
      'POST',
      `${route}/analyze`,
      JSON.stringify({ collect: true, skipAi: settings.skipAi }),
      {
        'content-type': 'application/json'
      }
    );
    if (!analyzed.ok) {
      return {
        status: 'error',
        error: `perf-insight analyze: HTTP ${analyzed.status} ${analyzed.data?.error || ''}`.trim()
      };
    }
    return shortVerdict(analyzed.data, settings);
  } catch (error) {
    const reason =
      error.name === 'TimeoutError'
        ? `timed out after ${settings.timeoutMs / 1000}s`
        : error.cause?.message || error.message;
    return { status: 'error', error: `perf-insight: ${reason}` };
  }
}

export function describeInsight(insight) {
  if (!insight) return null;
  if (insight.status === 'pending') return 'regression check running';
  if (insight.status !== 'ok') return 'regression check unavailable';
  return `regression check ${insight.verdict.toUpperCase()}`;
}
