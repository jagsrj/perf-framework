// Runtime settings for the MCP server. Everything can be overridden with environment variables.

function readInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative whole number (got "${raw}").`);
  }
  return value;
}

function readBool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

export function loadConfig() {
  return {
    // The web app is the single source of truth: the MCP server never starts JMeter itself.
    webBaseUrl: (process.env.PERF_WEB_URL || `http://localhost:${process.env.WEB_PORT || 4000}`).replace(/\/$/, ''),
    // InfluxDB query endpoint for live metrics (Compose publishes it on 127.0.0.1:8086).
    influxQueryUrl: process.env.INFLUXDB_QUERY_URL || 'http://localhost:8086/query',
    influxDatabase: process.env.INFLUXDB_DATABASE || 'jmeter',
    requestTimeoutMs: readInt('MCP_REQUEST_TIMEOUT_MS', 30_000),
    // Guardrails: an AI assistant cannot exceed these, even if the web app would allow more.
    readOnly: readBool('MCP_READ_ONLY', false),
    maxUsers: readInt('MCP_MAX_USERS', 200),
    maxDurationSeconds: readInt('MCP_MAX_DURATION_SECONDS', 3600),
    maxScriptBytes: 10 * 1024 * 1024
  };
}
