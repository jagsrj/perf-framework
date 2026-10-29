// Thin HTTP clients used by the MCP tools.
// PerfApiClient talks to the existing web app REST API; InfluxClient reads live metrics.

export class PerfApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'PerfApiError';
    this.status = status;
  }
}

async function withTimeout(timeoutMs, work) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await work(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

export class PerfApiClient {
  constructor({ baseUrl, timeoutMs = 30_000, fetchImpl = fetch }) {
    this.baseUrl = baseUrl;
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
  }

  async request(method, pathname, { json, body, accept = 'json' } = {}) {
    const url = `${this.baseUrl}${pathname}`;
    let response;
    try {
      response = await withTimeout(this.timeoutMs, (signal) => this.fetch(url, {
        method,
        signal,
        headers: json === undefined ? undefined : { 'content-type': 'application/json' },
        body: json === undefined ? body : JSON.stringify(json)
      }));
    } catch (error) {
      if (error.name === 'AbortError') {
        throw new PerfApiError(`The web app did not respond within ${this.timeoutMs} ms (${method} ${pathname}).`, 504);
      }
      throw new PerfApiError(
        `Could not reach the perf-framework web app at ${this.baseUrl}. Start it with "npm run web". (${error.message})`,
        503
      );
    }

    const text = await response.text();
    if (!response.ok) {
      let message = text;
      try {
        message = JSON.parse(text).error || text;
      } catch {
        // keep raw text
      }
      throw new PerfApiError(message || `HTTP ${response.status}`, response.status);
    }
    if (accept === 'text') return text;
    return text ? JSON.parse(text) : null;
  }

  health() { return this.request('GET', '/api/health'); }
  listScenarios() { return this.request('GET', '/api/scenarios'); }
  createScenario(input) { return this.request('POST', '/api/scenarios', { json: input }); }
  updateScenario(id, input) { return this.request('PUT', `/api/scenarios/${encodeURIComponent(id)}`, { json: input }); }
  getScript(id) { return this.request('GET', `/api/scenarios/${encodeURIComponent(id)}/script`, { accept: 'text' }); }
  startRun(id) { return this.request('POST', `/api/scenarios/${encodeURIComponent(id)}/runs`); }
  abortRun(runId) { return this.request('POST', `/api/runs/${encodeURIComponent(runId)}/abort`); }
  listRuns() { return this.request('GET', '/api/runs'); }
  getRun(runId) { return this.request('GET', `/api/runs/${encodeURIComponent(runId)}`); }
  getRunResults(runId) { return this.request('GET', `/api/runs/${encodeURIComponent(runId)}/results`); }
  getTrends(id, limit) { return this.request('GET', `/api/scenarios/${encodeURIComponent(id)}/trends?limit=${limit}`); }

  async getScenario(id) {
    const scenarios = await this.listScenarios();
    const scenario = scenarios.find((item) => item.id === id);
    if (!scenario) throw new PerfApiError(`Scenario ${id} was not found.`, 404);
    return scenario;
  }

  uploadScript(id, filename, xml) {
    const form = new FormData();
    form.append('script', new Blob([xml], { type: 'application/xml' }), filename);
    return this.request('POST', `/api/scenarios/${encodeURIComponent(id)}/script`, { body: form });
  }
}

export class InfluxClient {
  constructor({ queryUrl, database, timeoutMs = 30_000, fetchImpl = fetch }) {
    this.queryUrl = queryUrl;
    this.database = database;
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
  }

  async query(influxQl) {
    const url = `${this.queryUrl}?${new URLSearchParams({ db: this.database, q: influxQl, epoch: 'ms' })}`;
    let response;
    try {
      response = await withTimeout(this.timeoutMs, (signal) => this.fetch(url, { signal }));
    } catch (error) {
      throw new PerfApiError(
        `Could not reach InfluxDB at ${this.queryUrl}. Check that the Compose stack is running and port 8086 is published. (${error.message})`,
        503
      );
    }
    if (!response.ok) throw new PerfApiError(`InfluxDB returned HTTP ${response.status}.`, 502);
    const payload = await response.json();
    const error = payload.results?.find((result) => result.error)?.error;
    if (error) throw new PerfApiError(`InfluxDB query error: ${error}`, 502);
    return payload.results?.[0]?.series || [];
  }
}

// InfluxQL string literal escaping for tag values.
export function influxString(value) {
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}
