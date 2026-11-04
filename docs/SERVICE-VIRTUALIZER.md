# Virtual services (service-virtualizer)

[service-virtualizer](https://github.com/jagsrj/service-virtualizer) stands in for the systems your application depends on (credit bureau, document verification, core banking...). It gives them realistic latency, error rates and capacity limits, records them from the real thing, and changes their behaviour on a schedule. perf-framework can hand each run to it, so:

- **Metrics line up.** The virtual services write to the same InfluxDB database (`jmeter`) tagged with the same `runId`. Its Grafana dashboard ("Virtual services") filters by the run you're looking at in the JMeter dashboard.
- **Scenarios get their dependency behaviour automatically.** If service-virtualizer has a timeline named after the scenario (`Checkout Load` → `timelines/checkout-load.yaml`), it starts with the run. For example: healthy for 5 minutes, then a 2-minute brownout of document verification, then recovery.
- **Every run leaves the services clean.** When a run ends (completed, failed, aborted, or found finished during recovery), its timeline is cancelled and the services it touched are reset to baseline.

## Setup

Run service-virtualizer next to perf-framework's Compose stack (it joins the same Docker network and InfluxDB):

```bash
cd service-virtualizer/infra
docker compose -f docker-compose.yml -f docker-compose.perf-framework.yml up -d --build
```

Then point perf-framework at its control API:

```bash
SERVICE_VIRTUALIZER_URL=http://localhost:4100 npm run web
```

| Variable | Default | Purpose |
|---|---|---|
| `SERVICE_VIRTUALIZER_URL` | (off) | service-virtualizer control API |
| `SERVICE_VIRTUALIZER_TIMEOUT_SECONDS` | `10` | Longest a run waits for it at start and end |

## What happens during a run

1. Before any load generator starts, perf-framework sends `POST /api/runs {runId, scenario}`. If the scenario has a timeline, its first step (for example "doc-verify: healthy") is in place before the first request.
2. JMeter runs. The virtual services report throughput, latency percentiles, error and rejection rates and capacity-pool state every 5 seconds, tagged with the run.
3. When the run ends, perf-framework sends `DELETE /api/runs/:runId` before the perf-insight check and notifications. service-virtualizer flushes its final metrics, stops the timeline and resets the services.

## Failure handling

Like perf-insight, this hand-off can never fail or block a run. If service-virtualizer is down, slow (beyond `SERVICE_VIRTUALIZER_TIMEOUT_SECONDS`) or rejects the request, perf-framework logs it and the test goes ahead with the virtual services in whatever state they're in. A scenario timeline that can't start, for example because it names an unknown profile, is logged as a warning and the run still starts.

Remember the virtualizer is part of the test. If a run's results look wrong, check its "Unmatched requests" panel: requests no stub answered come back as 404s from WireMock.
