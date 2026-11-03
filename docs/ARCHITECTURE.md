# Architecture and Data Lifecycle

For a beginner-friendly walkthrough of each technology, see [TECH-STACK-AND-BEGINNER-GUIDE.md](./TECH-STACK-AND-BEGINNER-GUIDE.md). For slides, see `Perf-Framework-System-Design.pptx`.

## Components

```
                    ┌──────────────── MCP client (Claude Code / Desktop)
                    │ stdio
 Browser UI ──► web app (Node/Express, :4000) ◄── mcp/server.js ──► InfluxDB (live metrics read)
                    │        │
                    │        └── PostgreSQL (:5433)  scenarios, script versions, runs, summaries
                    │
                    └── docker run ──► JMeter container ──► InfluxDB (:8086) ──► Grafana (:3000)
                                            │
                                            └── results/<run-id>/  JTL, log, prepared JMX
 Ollama (:11434) ◄── web app (optional local AI explanation)
```

| Component | Role |
|---|---|
| `web/` | UI, REST API, run orchestration, JTL summarising, baseline lookup, SLO verdicts (`slo.js`), HTML reports (`report.js`), notifications (`notify.js`) |
| `cli/` | Original command-line runner and the CI gate (`ci.js`), plus shared helpers (JMX preparation, Docker, run IDs) used by the web app |
| `mcp/` | MCP server wrapping the REST API for AI assistants ([MCP.md](./MCP.md)) |
| `jmeter/` | JMeter 5.6.3 Docker image |
| `infra/` | Docker Compose stack and Grafana provisioning |

## Run flow

1. A run request (UI or MCP) hits `POST /api/scenarios/:id/runs`. A partial unique index in PostgreSQL ensures that only one run is `starting` or `running` at a time.
2. The current script is snapshotted to `results/<run-id>/script.jmx` and its SHA-256 is recorded.
3. `prepareJMX` adds the run-ID tag and InfluxDB Backend Listener settings, producing the prepared plan.
4. The scenario's users are split across its **load generators** as evenly as possible (10 users over 3 generators → 4, 3, 3). One detached JMeter container starts per generator, labelled `perf-framework.run-id=<run-id>` and `perf-framework.generator=<n>`, each writing `results-<n>.jtl` and `jmeter-<n>.log`. The web app stores the container IDs and waits for all of them to exit. If one generator fails, the others are stopped and the run is marked failed.
5. When every generator has exited, their JTL files are summarised together (percentiles are computed over all samples, not averaged per generator) as a stream with bounded-memory HDR histograms (overall and per label). The summary is saved as JSONB. If the scenario had SLO targets when the run started (they are snapshotted into the run record), the pass/fail verdict is computed and saved as `slo_result`. An optional webhook notification is then sent.
6. If the web app restarts mid-run, it finds the labelled containers and resumes monitoring. **Abort** stops every container with a 10-second graceful shutdown.

The run ID is attached to metrics emitted by the InfluxDB Backend Listener and is used to filter the Grafana dashboard. With several generators, each one reports its own series under the same run ID, so live counts and throughput add up correctly, while live percentiles are per generator; the final summary and SLO verdict use the merged JTL data. Existing Backend Listeners in an uploaded JMX receive the run-ID tag when the plan is prepared.

## Data lifecycle

- **PostgreSQL** stores scenario metadata, script-version records, run configuration and status, script SHA-256 hashes, and completed-run summaries (overall and per-label sample counts, errors, mean, percentile and max latency). Its Docker volume persists across container restarts. Back it up for durable scenario and baseline data.
- **InfluxDB** stores the time-series data for the live dashboard. The default retention for the `jmeter` database is one day.
- **Local files:** uploaded JMX versions live under `data/scripts/`, each with a version number and SHA-256 in PostgreSQL. Each run records the selected version and hash. An immutable source JMX snapshot, the prepared JMX, the JTL and the JMeter log are stored under `results/<run-id>/`. These are local files, not database blobs, so back them up separately if they must survive machine loss.

## Baselines

A run's baseline is the latest earlier **completed** run with the same scenario, the same script SHA-256 and the same users, duration and ramp-up. This keeps comparisons like-for-like. The MCP `compare_runs` tool can compare any two runs and warns when their setup differs.

## Design decisions

**Why PostgreSQL for metadata?** Scenario and run records have stable fields, relationships, uniqueness and lifecycle constraints, and need reliable joins for history and baseline comparisons. JSONB leaves room for optional run summaries without moving core metadata into an unstructured store. A NoSQL database would be worth considering only if scenario definitions became deeply nested and highly variable, or if MongoDB were already an operational standard. InfluxDB remains the time-series store, not the system of record.

**Why does the MCP server call the REST API instead of the database?** All validation, versioning and run orchestration stay in one place. The MCP layer adds only guardrails and analysis, so the UI and the assistant can never disagree about state.

## Limits and next steps

Load generators currently all run on the Docker host the web app talks to, so they add JVMs and threads but share one machine's CPU, memory and network. There is one active run at a time, no scheduling and no high availability.

The natural next step is generators on several hosts: run each generator through its own `DOCKER_HOST` (for example `ssh://` to other machines) or as a Kubernetes Job on AKS, copying the script in and the JTL out instead of using bind mounts. For a multi-host deployment, move uploaded scripts and run artifacts to durable object storage and keep only their object keys and hashes in PostgreSQL. API key authentication is available ([CONFIGURATION.md](./CONFIGURATION.md#remote-access)); add TLS, managed secrets and network policies before any shared deployment.
