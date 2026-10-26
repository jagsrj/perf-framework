# Performance Testing Framework

A local JMeter performance-testing console. The Node.js web app manages test scenarios and launches JMeter in Docker; JMeter streams short-retention live metrics to InfluxDB, Grafana displays those metrics, and PostgreSQL preserves scenario definitions and run summaries.

## Requirements

- Docker Desktop / Docker Engine and Docker Compose
- Node.js 18 or newer
- npm

## Start the services

From the project root:

```bash
docker compose -f infra/docker-compose.yml up -d
```

This starts:

- **Ollama** on `http://localhost:11434` for optional local AI result analysis, with downloaded models retained in a Docker volume.
- **InfluxDB 1.8** for live test metrics. The `influxdb-retention` one-shot service sets the `jmeter` database's default `autogen` retention to one day.
- **Grafana** on `http://localhost:3000`, with the InfluxDB datasource and JMeter dashboard provisioned. The dashboard is configured to allow iframe embedding.
- **PostgreSQL** on `localhost:5433`, with a persistent Docker volume for scenarios and run summaries.

The local development database defaults are user `perf_framework`, password `local-dev-only`, database `perf_framework`. If you override `POSTGRES_PASSWORD`, export it in the shell used to start both Compose and the web app. Grafana's local admin username/password defaults to `admin`/`admin`; set `GRAFANA_ADMIN_PASSWORD` before first startup or change it in Grafana after signing in. Grafana anonymous Viewer access is enabled so the embedded dashboard can load without a login prompt. These hardcoded/local defaults are for development only; anonymous access is read-only but makes dashboards available to anyone who can reach the local Grafana port. Use managed secrets, authenticated access, TLS, restricted network policies, and backup/restore testing before any shared or production deployment.

### Set up local AI analysis

After starting Compose, download a model into the Ollama volume (the first download can be several GB):

```bash
docker compose -f infra/docker-compose.yml exec ollama ollama pull llama3.2:3b
```

The web app defaults to `http://localhost:11434` and model `llama3.2:3b`. Override these with `OLLAMA_BASE_URL` and `OLLAMA_MODEL` if needed. In **Test results**, select a completed run and choose **Explain with local AI**. The app sends only overall numeric summary metrics and, when available, the matching baseline summary. It does not send JMX scripts, raw JTL files, or transaction labels, and it does not save model responses. Treat the output as advisory.

On macOS, Ollama in Docker may run more slowly than native Ollama and can use substantial CPU and memory. Avoid running inference during a load test if you want to minimize resource contention. Models remain in the `ollama_data` Docker volume; deleting volumes with `docker compose down -v` removes the downloaded models.

Build the JMeter image once:

```bash
docker build -t perf-framework-jmeter:5.6.3 ./jmeter
```

The UI runner uses that image and the Compose network `infra_jmeter-network` by default. Set `JMETER_IMAGE` or `JMETER_DOCKER_NETWORK` if your local image or Compose network uses a different name.

Install the app dependencies, then run the web app in a terminal:

```bash
npm install
npm run web
```

Open **http://localhost:4000**. The app binds to `127.0.0.1` and is intended for local development; it has no user authentication. Do not expose it to a network without adding authentication and appropriate upload/run controls.

## Scenario and run workflow

1. **Create scenario:** enter a scenario name, script name, virtual users, duration, and ramp-up.
2. **Update scenario:** select the new scenario, upload a `.jmx` file, review its stored XML, and save any updated settings.
3. **Execute scenario:** select a script-ready scenario and start a test. Only one run can be active at once.
4. **Runtime monitoring:** the view automatically selects the most recent active run, or the most recent run if none is active, and embeds its Grafana dashboard filtered by scenario and run ID. Active runs show their start time and estimated time remaining; **Abort test** stops a run early. When a summary is available, **Analyze summary** displays the summary already stored in PostgreSQL.
5. **Test results:** select a run to view its saved summary and compare it with the latest earlier completed run using the same scenario, script contents, and load configuration. A baseline is only shown when a matching earlier run has a summary. **Explain with local AI** asks Ollama to explain the metric summary and baseline.

The upload endpoint accepts JMX files up to 10 MB and validates that they parse as JMeter XML. Treat uploaded test plans as executable code: run only scripts you trust.

## Data lifecycle

- PostgreSQL stores structured scenario metadata, script-version records, run configuration/status, script SHA-256 hashes, and completed-run summaries. The summary includes overall and per-label sample counts, errors, mean and percentile latency, and max latency. Its Docker volume persists across container restarts.
- InfluxDB stores the time-series data used by the live dashboard; its default JMeter retention is one day.
- Uploaded JMX versions are retained under `data/scripts/` with a version number and SHA-256 in PostgreSQL. Each run records the selected version and hash; an immutable source JMX snapshot, prepared JMX, JTL, and JMeter log are stored under `results/<run-id>/`. These artifacts are local files, not PostgreSQL blobs. Back them up separately if they must survive machine loss. Back up the PostgreSQL volume for durable scenario and baseline data.

PostgreSQL is intentional for scenario and run metadata: these records have stable fields, relationships, uniqueness and lifecycle constraints, and need reliable joins for history and baseline comparisons. JSONB leaves room for optional run summaries without moving core metadata into an unstructured document store. A NoSQL database could be justified if scenario definitions became deeply nested and highly variable or MongoDB were already an operational standard; neither is currently a strong reason to add another datastore. InfluxDB remains the time-series store, not the system of record. For a multi-host deployment, move uploaded scripts and run artifacts to durable object storage and keep only their object keys and hashes in PostgreSQL.

JTL summaries are computed as a stream with bounded-memory histograms instead of loading and sorting the entire result file. Each web-managed JMeter run starts as a detached Docker container labelled with its run ID. The web app records the container ID, waits for its exit before summarizing results, and can find the labelled container to resume monitoring after an app restart. **Abort test** stops the container with a 10-second graceful-shutdown period. This improves recovery for the local runner but does not provide distributed scheduling or high availability. The current database constraint intentionally permits one active test at a time.

The run ID is attached to metrics emitted by the framework’s InfluxDB Backend Listener and is used to filter the Grafana dashboard. Existing JMX Backend Listeners receive the run-ID tag when the framework prepares a plan.

## CLI

The original CLI remains available:

```bash
node cli/index.js run --script scripts/sample.jmx --name smoke-test --threads 10 --duration 600 --rampup 10
```

It runs a 10-minute, 10-user test and writes local JTL/log artifacts. For dashboard monitoring, start the Compose stack first.
