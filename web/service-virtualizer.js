// Optional hand-off to service-virtualizer (https://github.com/jagsrj/service-virtualizer):
// when a run starts, the virtual services are told its runId and scenario, so their metrics in
// InfluxDB carry the same runId as JMeter's, and a timeline named after the scenario (degrade a
// dependency at minute 5, recover at minute 7...) plays for the run. When the run ends, the
// virtualizer flushes its last metrics interval, stops the timeline and resets the services.
//
// Off unless SERVICE_VIRTUALIZER_URL is set. Like perf-insight, it can never fail or block a run:
// errors are logged and the test goes ahead against whatever state the virtual services are in.

export function serviceVirtualizerSettings(env = process.env) {
  const url = (env.SERVICE_VIRTUALIZER_URL || '').replace(/\/+$/, '');
  return {
    url,
    enabled: Boolean(url),
    timeoutMs: Number(env.SERVICE_VIRTUALIZER_TIMEOUT_SECONDS || 10) * 1000
  };
}

export function createServiceVirtualizerHooks({
  settings = serviceVirtualizerSettings(),
  fetchImpl = fetch,
  log = console
} = {}) {
  async function call(method, pathname, body) {
    const res = await fetchImpl(`${settings.url}${pathname}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(settings.timeoutMs)
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text.slice(0, 200) };
    }
    if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
    return data;
  }

  return {
    enabled: settings.enabled,

    // Returns what the virtualizer reported, or { status: 'error' } / null; never throws.
    async runStarted(runId, scenarioName) {
      if (!settings.enabled) return null;
      try {
        const result = await call('POST', '/api/runs', { runId, scenario: scenarioName });
        if (result?.timeline) log.log(`service-virtualizer: run ${runId} playing timeline "${result.timeline}"`);
        if (result?.warning) log.error(`service-virtualizer: ${result.warning}`);
        return result;
      } catch (error) {
        log.error(`service-virtualizer: could not start run ${runId}: ${error.message}`);
        return { status: 'error', error: error.message };
      }
    },

    async runEnded(runId) {
      if (!settings.enabled) return null;
      try {
        return await call('DELETE', `/api/runs/${encodeURIComponent(runId)}`);
      } catch (error) {
        log.error(`service-virtualizer: could not end run ${runId}: ${error.message}`);
        return { status: 'error', error: error.message };
      }
    }
  };
}
