# Web App REST API

The web app (`web/server.js`) serves the UI and a JSON API on `http://localhost:4000`. The UI, the MCP server and any scripts you write all use this API.

**Access:** requests must use host `localhost:4000`, `127.0.0.1:4000` or a name listed in `PERF_ALLOWED_HOSTS`. Cross-origin browser requests are rejected.

**Authentication:** off by default (the app only listens on `127.0.0.1`). When `PERF_API_KEY` is set, every request except `GET /api/health` must send `Authorization: Bearer <key>` or `X-API-Key: <key>`, otherwise it gets `401`. See [CONFIGURATION.md](./CONFIGURATION.md#remote-access).

**Errors** come back as `{ "error": "message" }` with a 4xx/5xx status.

## Health

| Method | Path | Description |
|---|---|---|
| GET | `/api/health` | `{ "status": "ok" }` when PostgreSQL is reachable |

## Scenarios

| Method | Path | Description |
|---|---|---|
| GET | `/api/scenarios` | All scenarios, most recently updated first |
| POST | `/api/scenarios` | Create a scenario. Returns `201` |
| PUT | `/api/scenarios/:id` | Replace a scenario's name and load settings |
| POST | `/api/scenarios/:id/script` | Upload a JMX (`multipart/form-data`, field `script`, max 10 MB). Creates a new script version |
| GET | `/api/scenarios/:id/script` | Current JMX as `text/plain` |
| POST | `/api/scenarios/:id/runs` | Start a run. Returns `202` with the run record, or `409` if a run is already active |
| GET | `/api/scenarios/:id/trends?limit=20` | Completed runs, oldest first, with throughput, error rate, mean/p95/p99 and `sloPassed` (limit 1–200) |

Create/update body:

```json
{
  "name": "login-smoke", "scriptName": "login.jmx", "users": 10, "duration": 300, "rampup": 30, "generators": 2,
  "slo": { "p95Ms": 800, "errorRatePercent": 1, "applyToTransactions": true }
}
```

Validation: name ≤ 120 characters, script name ≤ 255, users 1–100000, duration 1–86400 seconds, ramp-up 0–duration. `:id` must be a UUID.

`generators` is optional: the number of JMeter containers that share the users (1 to `PERF_MAX_GENERATORS`, default limit 10, and never more than `users`). New scenarios default to 1; on `PUT`, leaving it out keeps the current value. Runs record the `generators` they used.

`slo` is optional. The allowed targets are `p95Ms`, `p99Ms`, `averageMs`, `maxMs` and `errorRatePercent` (0–100), plus `applyToTransactions`. On `PUT`, leaving out `slo` keeps the current targets, and `"slo": null` removes them. Unknown keys are rejected with `400`. Scenario responses include `slo`.

### Script source, plugins and load generators

Optional fields on create/update (omitted = default for a new scenario, unchanged on `PUT`):

| Field | Meaning |
|---|---|
| `scriptSource` | `"upload"` (default) or `"shared"` |
| `sharedScript` | Path of a `.jmx` under the shared drive's `scripts/`, e.g. `"checkout/checkout.jmx"`. Its folder's files go with it |
| `plugins` | Jar paths under the shared drive's `plugins/`, e.g. `["jmeter-plugins-casutg-2.10.jar"]` |
| `loadGeneratorIds` | Remote load generator IDs to run on. `[]` = local Docker (then `generators` sets the local container count) |

`slo` also accepts `abortOnFail: true` and `abortDelaySeconds` (warm-up, default 60) for live aborts.

## Shared drive and load generators

| Method | Path | Description |
|---|---|---|
| GET | `/api/shared` | `{ scripts: [{ path, folder, dataFiles, bundleBytes }], plugins: [{ path, sizeBytes }] }` |
| GET | `/api/load-generators` | `{ enabled, generators: [{ id, name, hostname, jmeter_version, max_threads, enabled, last_seen_at, status, active_run }] }`. `status` is `online`, `busy`, `offline` or `disabled` |
| PATCH | `/api/load-generators/:id` | `{ "enabled": false }` to keep a generator out of new runs |
| DELETE | `/api/load-generators/:id` | Remove (disables instead if it has run history) |

The agent-facing endpoints under `/api/agent/` use `PERF_AGENT_TOKEN` and are described in [LOAD-GENERATORS.md](./LOAD-GENERATORS.md).

## Runs

| Method | Path | Description |
|---|---|---|
| GET | `/api/runs` | Latest 100 runs, newest first. Each includes `grafanaUrl` |
| GET | `/api/runs/:runId` | One run, with `grafanaUrl` |
| GET | `/api/runs/:runId/results` | `{ run, baseline }`, where `baseline` is the latest earlier completed run with the same scenario, script hash and load settings, or `null` |
| GET | `/api/runs/:runId/report` | Self-contained HTML report. Add `?download` to get it as an attachment |
| POST | `/api/runs/:runId/abort` | Stop an active run (`409` if not active) |
| POST | `/api/runs/:runId/insight` | Re-run the [perf-insight](./PERF-INSIGHT.md) regression check for a completed run (409 if `PERF_INSIGHT_URL` is not set) |
| POST | `/api/runs/:runId/ai-analysis` | Ollama explanation of a completed run's summary and baseline |

Run `status` values: `starting`, `running`, `completed`, `failed`, `aborted`. Aborted runs have `aborted_by`: `user` or `slo` (live SLO check). Runs record `execution` (`local` or `agents`), `script_source` and `plugins`, and `GET /api/runs/:runId` adds `loadGenerators`: each remote generator's users, status, exit code and bytes of results received.

Run records also include `slo`, the targets snapshotted at start, and `slo_result`, the verdict computed when the run finishes:

```json
{ "passed": false, "checked": 2, "failed": 1,
  "checks": [ { "scope": "overall", "metric": "p95ResponseMs", "label": "p95 latency", "target": 800, "actual": 912, "passed": false } ] }
```

`summary` (completed runs) has this shape:

```json
{
  "samples": 1000, "successful": 990, "failures": 10, "errorRatePercent": 1,
  "averageResponseMs": 200, "p95ResponseMs": 450, "p99ResponseMs": 900, "maxResponseMs": 2000,
  "transactions": { "<label>": { "samples": 0, "failures": 0, "errorRatePercent": 0, "averageResponseMs": 0, "p95ResponseMs": 0, "p99ResponseMs": 0, "maxResponseMs": 0 } }
}
```
