// Live SLO checks: while a run is in progress, read the JTL files as they grow (local containers
// write them directly; remote load generators stream them to the controller), keep an exact
// running summary across all generators, and abort the run when its SLO targets are breached.
//
// Enabled per scenario with slo.abortOnFail. slo.abortDelaySeconds is a warm-up period during
// which breaches are ignored (start-up is usually slow). A breach must be seen on two checks in a
// row before the run is aborted, so one bad interval does not stop a test.

import { open, readdir } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseSync } from 'csv-parse/sync';
import { evaluateSlo } from './slo.js';
import { createCollector } from './summary.js';

const JTL_FILE = /^results(?:-\d+)?\.jtl$/;
const READ_CHUNK = 4 * 1024 * 1024;

// Reads only the bytes added since the last call, so each check costs O(new samples).
export class LiveJtlReader {
  constructor(resultsDir) {
    this.resultsDir = resultsDir;
    this.files = new Map(); // name -> { offset, header, pending }
    this.collector = createCollector();
  }

  async poll() {
    let names;
    try {
      names = (await readdir(this.resultsDir)).filter((name) => JTL_FILE.test(name));
    } catch (error) {
      if (error.code === 'ENOENT') return this.summary();
      throw error;
    }
    for (const name of names) await this.#readFile(name);
    return this.summary();
  }

  summary() {
    return this.collector.finish();
  }

  async #readFile(name) {
    const state = this.files.get(name) || { offset: 0, header: null, pending: '' };
    this.files.set(name, state);
    const handle = await open(path.join(this.resultsDir, name), 'r');
    try {
      for (;;) {
        const buffer = Buffer.alloc(READ_CHUNK);
        const { bytesRead } = await handle.read(buffer, 0, READ_CHUNK, state.offset);
        if (!bytesRead) break;
        state.offset += bytesRead;
        state.pending += buffer.subarray(0, bytesRead).toString('utf8');
        this.#consume(state);
        if (bytesRead < READ_CHUNK) break;
      }
    } finally {
      await handle.close();
    }
  }

  #consume(state) {
    if (state.header === null) {
      const end = state.pending.indexOf('\n');
      if (end === -1) return;
      state.header = state.pending
        .slice(0, end)
        .replace(/^\uFEFF/, '')
        .replace(/\r$/, '');
      state.pending = state.pending.slice(end + 1);
    }
    const lastNewline = state.pending.lastIndexOf('\n');
    if (lastNewline === -1) return;
    const complete = state.pending.slice(0, lastNewline + 1);
    let rows;
    try {
      rows = parseSync(`${state.header}\n${complete}`, {
        columns: true,
        skip_empty_lines: true,
        relax_column_count: true
      });
    } catch {
      // Most likely a quoted field with a line break that is not complete yet: wait for more data.
      return;
    }
    state.pending = state.pending.slice(lastNewline + 1);
    for (const row of rows) {
      if (row.elapsed !== undefined && row.success !== undefined) this.collector.add(row);
    }
  }
}

export function failedChecks(result) {
  return result.checks.filter((check) => !check.passed && check.actual !== null);
}

export function describeBreach(result) {
  return failedChecks(result)
    .map(
      (check) => `${check.scope === 'overall' ? '' : `${check.scope} `}${check.label} ${check.actual} > ${check.target}`
    )
    .join('; ');
}

// Starts checking a run. Returns { stop() }. onBreach(reason) is called at most once.
export function startLiveSloWatcher({
  runId,
  resultsDir,
  slo,
  startedAt = Date.now(),
  config,
  onBreach,
  log = console
}) {
  if (!slo?.abortOnFail) return { stop() {}, check: async () => null };
  const reader = new LiveJtlReader(resultsDir);
  const warmUpMs = (slo.abortDelaySeconds ?? 60) * 1000;
  let consecutive = 0;
  let stopped = false;
  let running = false;

  async function check(now = Date.now()) {
    if (stopped || running) return null;
    running = true;
    try {
      const summary = await reader.poll();
      if (now - startedAt < warmUpMs || summary.samples < config.liveSloMinSamples) return null;
      const result = evaluateSlo(summary, slo);
      // Missing data ("no data") is not a breach while the run is still warming up its transactions.
      const breached = failedChecks(result).length > 0;
      consecutive = breached ? consecutive + 1 : 0;
      if (consecutive >= 2) {
        stopped = true;
        clearInterval(timer);
        const reason = `Aborted by live SLO check: ${describeBreach(result)} (after ${summary.samples} samples).`;
        await onBreach(reason, result);
        return reason;
      }
      return null;
    } catch (error) {
      log.error(`Live SLO check failed for ${runId}: ${error.message}`);
      return null;
    } finally {
      running = false;
    }
  }

  const timer = setInterval(() => check(), config.liveSloIntervalMs);
  timer.unref?.();
  return {
    check,
    stop() {
      stopped = true;
      clearInterval(timer);
    }
  };
}
