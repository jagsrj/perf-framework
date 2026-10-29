# Performance Testing Framework

A local JMeter performance-testing console. A Node.js web app manages test scenarios and launches JMeter in Docker. JMeter streams short-retention live metrics to InfluxDB, Grafana displays them, and PostgreSQL keeps scenario definitions, script versions and run summaries with automatic baselines.

An **MCP server** lets AI assistants such as Claude drive the same framework in plain English: create scenarios, upload scripts, run and abort tests, watch live metrics, compare runs and check SLOs. See [docs/MCP.md](docs/MCP.md).

## Features

- Scenarios with versioned, validated JMX uploads (SHA-256 tracked)
- One-click runs in Docker, with abort and crash recovery
- Live Grafana dashboard filtered by run ID
- Exact p95/p99 summaries per transaction, computed from the JTL in bounded memory
- Automatic like-for-like baseline comparison
- Optional local AI explanation via Ollama
- MCP tools for AI-assisted testing, with load guardrails
- Original CLI runner

## Requirements

- Docker Desktop / Docker Engine with Docker Compose
- Node.js 18 or newer, and npm

## Quick start

```bash
# 1. Start InfluxDB, Grafana, PostgreSQL and Ollama
docker compose -f infra/docker-compose.yml up -d

# 2. Build the JMeter image (once)
docker build -t perf-framework-jmeter:5.6.3 ./jmeter

# 3. Install dependencies and start the web app
npm install
npm run web
```

Open **http://localhost:4000**. Grafana is at **http://localhost:3000**.

Services started by Compose (all bound to `127.0.0.1`):

| Service | Port | Purpose |
|---|---|---|
| Grafana | 3000 | Provisioned InfluxDB datasource and JMeter dashboard (embeddable) |
| PostgreSQL | 5433 | Scenarios, script versions, runs, summaries (persistent volume) |
| InfluxDB 1.8 | 8086 | Live metrics. The `influxdb-retention` one-shot service sets retention to one day |
| Ollama | 11434 | Optional local AI analysis (models kept in a volume) |

The UI runner uses the image above and the Compose network `infra_jmeter-network`. Set `JMETER_IMAGE` or `JMETER_DOCKER_NETWORK` if yours differ. All settings are in [docs/CONFIGURATION.md](docs/CONFIGURATION.md).

### Optional: local AI analysis

```bash
docker compose -f infra/docker-compose.yml exec ollama ollama pull llama3.2:3b
```

The first download can be several GB. Override the model with `OLLAMA_BASE_URL` and `OLLAMA_MODEL`. In **Test results**, choose **Explain with local AI**. The app sends only overall numeric summary metrics and the matching baseline. It never sends JMX scripts, raw JTL files or transaction labels, and it doesn't save responses. Treat the output as advisory. On macOS, Ollama in Docker can be slow and resource-hungry, so avoid running inference during a load test. `docker compose down -v` deletes downloaded models.

### Optional: connect Claude with MCP

With the web app running, open Claude Code in this folder. It picks up [`.mcp.json`](.mcp.json) automatically. Or run `npm run mcp` from any MCP client. Setup, the tool list, guardrails and example prompts are in [docs/MCP.md](docs/MCP.md).

## Using the console

1. **Create scenario:** enter a scenario name, script name, virtual users, duration and ramp-up.
2. **Update scenario:** select it, upload a `.jmx` (max 10 MB, validated as JMeter XML), review the stored XML and save any setting changes.
3. **Execute scenario:** start a test. Only one run can be active at a time.
4. **Runtime monitoring:** the most recent active run (or most recent run) is selected automatically, with its embedded Grafana dashboard, start time and estimated time remaining. **Abort test** stops it early. **Analyze summary** shows the stored summary.
5. **Test results:** view a run's summary next to its baseline, which is the latest earlier completed run with the same scenario, script contents and load settings. **Explain with local AI** asks Ollama to interpret it.

Treat uploaded test plans as executable code and run only scripts you trust.

## CLI

```bash
node cli/index.js run --script scripts/sample.jmx --name smoke-test --threads 10 --duration 600 --rampup 10
```

This runs a 10-minute, 10-user test and writes JTL and log files under `results/`. Start the Compose stack first if you want dashboard monitoring.

## Project structure

```
cli/        Command-line runner, plus JMX/Docker/run-ID helpers shared with the web app
web/        Express server (REST API, run orchestration), JTL summary, Ollama analysis
web/public/ Browser UI
mcp/        MCP server: config, HTTP clients, analysis helpers, tool definitions
jmeter/     JMeter 5.6.3 Docker image
infra/      Docker Compose stack and Grafana provisioning
scripts/    Sample JMX plans
test/       node:test suites (no services needed)
docs/       Architecture, MCP, API, configuration and beginner guides
data/       Uploaded script versions (git-ignored)
results/    Per-run artifacts (git-ignored)
```

## Documentation

| | |
|---|---|
| [Architecture and data lifecycle](docs/ARCHITECTURE.md) | Components, run flow, storage, design decisions |
| [MCP server](docs/MCP.md) | AI-assisted testing with Claude |
| [REST API](docs/API.md) | Endpoints and payloads |
| [Configuration](docs/CONFIGURATION.md) | Environment variables and ports |
| [Tech stack and beginner guide](docs/TECH-STACK-AND-BEGINNER-GUIDE.md) | Learn the stack from scratch |
| [Contributing](CONTRIBUTING.md) / [Changelog](CHANGELOG.md) | Conventions and history |

## Testing

```bash
npm test
```

## Security notes

This project is for **local development only**:

- The web app binds to `127.0.0.1` and has no authentication.
- The local database password is `local-dev-only` and Grafana's admin login is `admin`/`admin`. Override them with `POSTGRES_PASSWORD` and `GRAFANA_ADMIN_PASSWORD` before first start, and export the same `POSTGRES_PASSWORD` for the web app.
- Grafana anonymous Viewer access is enabled for dashboard embedding. It is read-only, but anyone who can reach port 3000 can see dashboards.

Before any shared or production deployment, add authentication, managed secrets, TLS, restricted network policies, and tested backup and restore.

## License

[MIT](LICENSE)
