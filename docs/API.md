# Web App REST API

The web app (`web/server.js`) serves the UI and a JSON API on `http://localhost:4000`. The UI, the MCP server and any scripts you write all use this API.

**Access:** requests must use host `localhost:4000` or `127.0.0.1:4000`. Cross-origin browser requests are rejected. There is no authentication, so do not expose the port to a network.

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
  "name": "login-smoke", "scriptName": "login.jmx", "users": 10, "duration": 300, "rampup": 30,
  "slo": { "p95Ms": 800, "errorRatePercent": 1, "applyToTransactions": true }
}
```

Validation: name ≤ 120 characters, script name ≤ 255, users 1–100000, duration 1–86400 seconds, ramp-up 0–duration. `:id` must be a UUID.

`slo` is optional. The allowed targets are `p95Ms`, `p99Ms`, `averageMs`, `maxMs` and `errorRatePercent` (0–100), plus `applyToTransactions`. On `PUT`, leaving out `slo` keeps the current targets, and `"slo": null` removes them. Unknown keys are rejected with `400`. Scenario responses include `slo`.

## Runs

| Method | Path | Description |
|---|---|---|
| GET | `/api/runs` | Latest 100 runs, newest first. Each includes `grafanaUrl` |
| GET | `/api/runs/:runId` | One run, with `grafanaUrl` |
| GET | `/api/runs/:runId/results` | `{ run, baseline }`, where `baseline` is the latest earlier completed run with the same scenario, script hash and load settings, or `null` |
| GET | `/api/runs/:runId/report` | Self-contained HTML report. Add `?download` to get it as an attachment |
| POST | `/api/runs/:runId/abort` | Stop an active run (`409` if not active) |
| POST | `/api/runs/:runId/ai-analysis` | Ollama explanation of a completed run's summary and baseline |

Run `status` values: `starting`, `running`, `completed`, `failed`, `aborted`.

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
