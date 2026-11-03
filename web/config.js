// Web app settings, read once from environment variables. See docs/CONFIGURATION.md.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function loadConfig(env = process.env) {
  const port = Number(env.WEB_PORT || 4000);
  const databasePassword = env.POSTGRES_PASSWORD || 'local-dev-only';
  const list = (value) =>
    String(value || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  return {
    port,
    // Network interface to listen on. Anything other than loopback requires PERF_API_KEY.
    host: env.WEB_HOST || '127.0.0.1',
    apiKey: env.PERF_API_KEY || null,
    // Extra Host headers to accept, e.g. "perf.example.com,10.0.0.5:4000".
    allowedHosts: list(env.PERF_ALLOWED_HOSTS),
    publicDir: path.join(projectRoot, 'web', 'public'),
    uploadRoot: env.PERF_UPLOAD_DIR || path.join(projectRoot, 'data', 'scripts'),
    resultsRoot: env.PERF_RESULTS_DIR || path.join(projectRoot, 'results'),
    // Upper limit for load generators (JMeter containers) per run.
    maxGenerators: Number(env.PERF_MAX_GENERATORS || 10),
    influxdbUrl: env.INFLUXDB_URL || 'http://influxdb:8086/write?db=jmeter',
    // Shared drive with scripts/ and plugins/ (see docs/LOAD-GENERATORS.md).
    sharedDir: path.resolve(env.PERF_SHARED_DIR || path.join(projectRoot, 'data', 'shared')),
    maxBundleBytes: Number(env.PERF_MAX_BUNDLE_MB || 200) * 1024 * 1024,
    // Remote load generators. Agent endpoints are off unless PERF_AGENT_TOKEN is set.
    agentToken: env.PERF_AGENT_TOKEN || null,
    // InfluxDB write URL as seen from the load generator machines (defaults to INFLUXDB_URL).
    agentInfluxdbUrl: env.PERF_AGENT_INFLUXDB_URL || null,
    agentHeartbeatSeconds: Number(env.PERF_AGENT_HEARTBEAT_SECONDS || 5),
    agentTimeoutMs: Number(env.PERF_AGENT_TIMEOUT_SECONDS || 30) * 1000,
    agentStartTimeoutMs: Number(env.PERF_AGENT_START_TIMEOUT_SECONDS || 120) * 1000,
    // Live SLO checks (scenarios with slo.abortOnFail).
    liveSloIntervalMs: Number(env.PERF_LIVE_SLO_INTERVAL_SECONDS || 10) * 1000,
    liveSloMinSamples: Number(env.PERF_LIVE_SLO_MIN_SAMPLES || 20),
    grafanaBaseUrl: env.GRAFANA_BASE_URL || 'http://localhost:3000',
    databaseUrl:
      env.DATABASE_URL ||
      `postgres://perf_framework:${encodeURIComponent(databasePassword)}@localhost:5433/perf_framework`
  };
}
