#!/usr/bin/env node
// perf-framework load generator agent.
//
// Runs on each load generator machine. It registers with the controller, sends heartbeats,
// and when a run is assigned to it: downloads the run bundle (JMX, data files, plugins), runs
// JMeter locally with its share of the users, streams the JTL back while the test runs, and
// reports the exit code. It only makes outbound HTTP(S) calls to the controller.
//
// Settings (environment variables):
//   PERF_CONTROLLER_URL   controller base URL, e.g. https://perf.example.com     (required)
//   PERF_AGENT_TOKEN      the controller's PERF_AGENT_TOKEN                       (required)
//   PERF_AGENT_NAME       name shown in the UI (default: host name)
//   PERF_AGENT_WORKDIR    where bundles and results are kept (default: ./agent-work)
//   PERF_AGENT_MAX_THREADS most virtual users this machine should run (optional)
//   JMETER_BIN            JMeter launcher (default: jmeter)
//   PERF_AGENT_UPLOAD_SECONDS how often to stream JTL data (default: 5)
//   PERF_AGENT_KEEP_RUNS  finished run folders to keep for troubleshooting (default: 5)
// For a private CA, set NODE_EXTRA_CA_CERTS=/path/to/ca.pem.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, open, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import * as tar from 'tar';

export const AGENT_VERSION = '1.0.0';
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function loadAgentConfig(env = process.env) {
  const controllerUrl = (env.PERF_CONTROLLER_URL || '').replace(/\/$/, '');
  if (!controllerUrl) throw new Error('Set PERF_CONTROLLER_URL to the controller address.');
  if (!env.PERF_AGENT_TOKEN) throw new Error('Set PERF_AGENT_TOKEN to the controller agent token.');
  return {
    controllerUrl,
    token: env.PERF_AGENT_TOKEN,
    name: (env.PERF_AGENT_NAME || os.hostname()).replace(/[^\w.@:-]/g, '-').slice(0, 120),
    workDir: path.resolve(env.PERF_AGENT_WORKDIR || 'agent-work'),
    maxThreads: env.PERF_AGENT_MAX_THREADS ? Number(env.PERF_AGENT_MAX_THREADS) : null,
    jmeterBin: env.JMETER_BIN || 'jmeter',
    uploadIntervalMs: Number(env.PERF_AGENT_UPLOAD_SECONDS || 5) * 1000,
    keepRuns: Number(env.PERF_AGENT_KEEP_RUNS || 5)
  };
}

export function jmeterArgs(work, { jmxPath, jtlPath, logPath, pluginDir }) {
  const args = [
    '-n',
    '-t',
    jmxPath,
    '-l',
    jtlPath,
    '-j',
    logPath,
    `-Jthreads=${work.threads}`,
    `-Jduration=${work.duration}`,
    `-Jrampup=${work.rampup}`,
    `-JinfluxdbUrl=${work.influxdbUrl}`,
    `-Japplication=${work.testName}`,
    `-JrunId=${work.runId}`,
    `-Jgenerator=${work.generator}`
  ];
  if (pluginDir) args.push(`-Jsearch_paths=${pluginDir}`, `-Juser.classpath=${pluginDir}`);
  return args;
}

export function createAgent(config, { log = console, spawnImpl = spawn, fetchImpl = fetch } = {}) {
  let agentId = null;
  let stopping = false;
  let heartbeatMs = 5000;
  const active = new Map(); // assignmentId -> { child, stop() }

  async function call(method, pathname, { json, body, headers = {}, raw = false } = {}) {
    const response = await fetchImpl(`${config.controllerUrl}${pathname}`, {
      method,
      headers: {
        authorization: `Bearer ${config.token}`,
        ...(agentId ? { 'x-agent-id': agentId } : {}),
        ...(json === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers
      },
      body: json === undefined ? body : JSON.stringify(json),
      ...(body && !(body instanceof Buffer) ? { duplex: 'half' } : {})
    });
    if (raw) return response;
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { error: text };
    }
    if (!response.ok) {
      const error = new Error(data?.error || `HTTP ${response.status} from ${pathname}`);
      error.status = response.status;
      error.data = data;
      throw error;
    }
    return data;
  }

  async function identity() {
    const file = path.join(config.workDir, 'agent.json');
    try {
      return JSON.parse(await readFile(file, 'utf8'));
    } catch {
      const created = { id: randomUUID() };
      await mkdir(config.workDir, { recursive: true });
      await writeFile(file, JSON.stringify(created));
      return created;
    }
  }

  async function jmeterVersion() {
    return new Promise((resolve) => {
      try {
        const child = spawnImpl(config.jmeterBin, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
        let out = '';
        child.stdout?.on('data', (chunk) => (out += chunk));
        child.on('error', () => resolve(null));
        child.on('close', () => resolve(/(\d+\.\d+(?:\.\d+)?)/.exec(out)?.[1] || null));
      } catch {
        resolve(null);
      }
    });
  }

  async function register() {
    const saved = await identity();
    const registered = await call('POST', '/api/agent/register', {
      json: {
        id: saved.id,
        name: config.name,
        hostname: os.hostname(),
        agentVersion: AGENT_VERSION,
        jmeterVersion: await jmeterVersion(),
        maxThreads: config.maxThreads
      }
    });
    agentId = registered.id;
    heartbeatMs = (registered.heartbeatSeconds || 5) * 1000;
    if (registered.id !== saved.id)
      await writeFile(path.join(config.workDir, 'agent.json'), JSON.stringify({ id: agentId }));
    log.log(`Registered as "${registered.name}" (${agentId}) with ${config.controllerUrl}`);
    return registered;
  }

  // Sends the bytes of the JTL written since the last upload. Returns the new offset.
  async function uploadJtl(work, jtlPath, offset) {
    let size;
    try {
      size = (await stat(jtlPath)).size;
    } catch {
      return { offset, stop: false };
    }
    let stop = false;
    while (offset < size) {
      const length = Math.min(size - offset, MAX_UPLOAD_BYTES);
      const buffer = Buffer.alloc(length);
      const handle = await open(jtlPath, 'r');
      try {
        await handle.read(buffer, 0, length, offset);
      } finally {
        await handle.close();
      }
      try {
        const result = await call('POST', `/api/agent/assignments/${work.id}/jtl?offset=${offset}`, {
          body: gzipSync(buffer),
          headers: { 'content-type': 'application/octet-stream', 'content-encoding': 'gzip' }
        });
        offset = result.size;
        stop ||= Boolean(result.stop);
      } catch (error) {
        if (error.status === 409 && Number.isSafeInteger(error.data?.expectedOffset)) {
          offset = error.data.expectedOffset; // resync, then continue
          if (offset > size) break;
          continue;
        }
        throw error;
      }
    }
    return { offset, stop };
  }

  async function downloadBundle(work, bundleDir) {
    await mkdir(bundleDir, { recursive: true });
    const response = await call('GET', `/api/agent/assignments/${work.id}/bundle`, { raw: true });
    if (!response.ok) throw new Error(`Bundle download failed with HTTP ${response.status}.`);
    const archive = path.join(path.dirname(bundleDir), 'bundle.tar.gz');
    await pipeline(Readable.fromWeb(response.body), createWriteStream(archive));
    await tar.extract({ file: archive, cwd: bundleDir, strict: true, preservePaths: false });
    await rm(archive, { force: true });
  }

  async function tail(file, bytes = 200_000) {
    try {
      const content = await readFile(file, 'utf8');
      return content.slice(-bytes);
    } catch {
      return '';
    }
  }

  async function finish(work, exitCode, error = null, logTail = '') {
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        await call('POST', `/api/agent/assignments/${work.id}/finish`, { json: { exitCode, error, logTail } });
        return;
      } catch (failure) {
        if (failure.status && failure.status < 500) return;
        await sleep(Math.min(30_000, 1000 * 2 ** attempt));
      }
    }
  }

  async function runAssignment(work) {
    const runDir = path.join(config.workDir, 'runs', work.id);
    const bundleDir = path.join(runDir, 'bundle');
    const jtlPath = path.join(runDir, 'results.jtl');
    const logPath = path.join(runDir, 'jmeter.log');
    let child = null;
    let stopRequested = false;
    const entry = {
      stop() {
        stopRequested = true;
        if (child && child.exitCode === null) {
          child.kill('SIGTERM');
          setTimeout(() => child.exitCode === null && child.kill('SIGKILL'), 15_000).unref();
        }
      }
    };
    active.set(work.id, entry);
    try {
      await call('POST', `/api/agent/assignments/${work.id}/start`);
      log.log(`Run ${work.runId}: generator ${work.generator}, ${work.threads} users`);
      await rm(runDir, { recursive: true, force: true });
      await downloadBundle(work, bundleDir);
      if (stopRequested) return finish(work, 143, 'Stopped before JMeter started.');

      const jmxPath = path.join(bundleDir, work.jmx);
      if (path.relative(bundleDir, jmxPath).startsWith('..')) throw new Error('Invalid JMX path in assignment.');
      const pluginDir = work.plugins ? path.join(bundleDir, 'plugins') : null;
      child = spawnImpl(config.jmeterBin, jmeterArgs(work, { jmxPath, jtlPath, logPath, pluginDir }), {
        cwd: bundleDir,
        stdio: ['ignore', 'inherit', 'inherit']
      });
      const exited = new Promise((resolve) => {
        child.once('error', (error) => resolve({ code: 1, error: `Could not start JMeter: ${error.message}` }));
        child.once('close', (code, signal) => resolve({ code: code ?? (signal ? 143 : 1) }));
      });

      let offset = 0;
      let result = null;
      while (!result) {
        result = await Promise.race([exited, sleep(config.uploadIntervalMs).then(() => null)]);
        try {
          const uploaded = await uploadJtl(work, jtlPath, offset);
          offset = uploaded.offset;
          if (uploaded.stop && !stopRequested) entry.stop();
        } catch (error) {
          log.error(`Run ${work.runId}: JTL upload failed, will retry: ${error.message}`);
        }
      }
      // Final upload of everything JMeter wrote.
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          offset = (await uploadJtl(work, jtlPath, offset)).offset;
          break;
        } catch (error) {
          log.error(`Run ${work.runId}: final JTL upload failed: ${error.message}`);
          await sleep(2000 * (attempt + 1));
        }
      }
      const exitCode = stopRequested && result.code !== 0 ? 143 : result.code;
      log.log(`Run ${work.runId}: JMeter exited with ${exitCode}`);
      await finish(work, exitCode, result.error || null, await tail(logPath));
    } catch (error) {
      log.error(`Run ${work.runId}: ${error.message}`);
      if (error.status !== 409) await finish(work, 1, error.message, await tail(logPath));
    } finally {
      active.delete(work.id);
      await pruneRuns().catch(() => {});
    }
  }

  async function pruneRuns() {
    const dir = path.join(config.workDir, 'runs');
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const folders = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && !active.has(entry.name))
        .map(async (entry) => ({ name: entry.name, time: (await stat(path.join(dir, entry.name))).mtimeMs }))
    );
    folders.sort((a, b) => b.time - a.time);
    for (const folder of folders.slice(config.keepRuns)) {
      await rm(path.join(dir, folder.name), { recursive: true, force: true });
    }
  }

  async function heartbeat() {
    const reply = await call('POST', `/api/agent/${agentId}/heartbeat`, { json: { running: [...active.keys()] } });
    heartbeatMs = (reply.heartbeatSeconds || 5) * 1000;
    for (const id of reply.stop || []) {
      if (active.has(id)) active.get(id).stop();
      else finish({ id }, 143, 'Stopped before JMeter started.').catch(() => {});
    }
    for (const work of reply.assignments || []) {
      if (!active.has(work.id)) runAssignment(work);
    }
  }

  async function run() {
    let delay = 1000;
    while (!stopping) {
      try {
        if (!agentId) await register();
        await heartbeat();
        delay = 1000;
        await sleep(active.size ? Math.min(heartbeatMs, 2000) : heartbeatMs);
      } catch (error) {
        if (error.status === 404) agentId = null; // controller forgot us: register again
        log.error(`Controller unreachable or refused the request: ${error.message}. Retrying in ${delay / 1000}s.`);
        await sleep(delay);
        delay = Math.min(delay * 2, 30_000);
      }
    }
  }

  async function shutdown() {
    stopping = true;
    for (const entry of active.values()) entry.stop();
  }

  return {
    run,
    register,
    heartbeat,
    shutdown,
    get id() {
      return agentId;
    },
    active
  };
}

// Started directly: `node agent.js`
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let agent;
  try {
    agent = createAgent(loadAgentConfig());
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, async () => {
      await agent.shutdown();
      setTimeout(() => process.exit(0), 2000).unref();
    });
  }
  agent.run();
}
