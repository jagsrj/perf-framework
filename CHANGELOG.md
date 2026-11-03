# Changelog

All notable changes to this project are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- **Load generators**: a scenario's users can be split across several JMeter containers (`generators`, up to `PERF_MAX_GENERATORS`). Results from all generators are merged into one summary and SLO verdict; if one generator fails, the others are stopped. Available in the UI, API and MCP tools.
- **API key authentication** (`PERF_API_KEY`) and remote access (`WEB_HOST`, `PERF_ALLOWED_HOSTS`). The server refuses to listen beyond localhost without a key. The CI gate, MCP server and browser UI send the key; the perf-gate example has a GitHub-hosted-runner job.
- **Versioned database migrations** (`web/migrations/`, `npm run migrate`); existing databases are adopted automatically.
- **API tests** against a real PostgreSQL database (`TEST_DATABASE_URL`), run in CI with a Postgres service.
- ESLint, Prettier (`npm run lint`, `npm run format`) and Dependabot.
- **SLO targets per scenario** (p95, p99, mean, max, error rate; optionally per transaction). Targets are snapshotted at run start and every run gets an automatic pass/fail verdict (`slo_result`) shown in the UI, API, reports and notifications.
- **CI gate**: `node cli/index.js ci` runs a scenario and exits `0` (pass), `1` (SLO failed) or `2` (run failed), with optional JUnit XML and HTML report output. Includes a GitHub Actions perf-gate example and a Jenkins snippet (`docs/CI.md`).
- **HTML run report** (`/api/runs/:runId/report`, with view and download links on the Test results page).
- **Trends API** (`/api/scenarios/:id/trends`) for regression tracking across runs.
- **Run-finished notifications** for Slack, Microsoft Teams (Workflows) or JSON webhooks.
- MCP tools `get_trends` and `get_report_url`. `create_scenario` and `update_scenario` accept SLOs, and `check_slo` returns the stored verdict when no targets are given.
- GitHub Actions workflow that runs the test suite on Node 18, 20 and 22.
- MCP server (`mcp/`, `npm run mcp`) so AI assistants can list and manage scenarios, upload scripts, start and abort runs, read live metrics, compare runs and check SLO targets. It wraps the existing REST API and adds guardrails (`MCP_MAX_USERS`, `MCP_MAX_DURATION_SECONDS`, `MCP_READ_ONLY`).
- Project-scoped `.mcp.json` for Claude Code.
- Documentation: `docs/MCP.md`, `docs/API.md`, `docs/CONFIGURATION.md`, `docs/ARCHITECTURE.md`, `docs/README.md`, `CONTRIBUTING.md`, `.env.example` and `LICENSE`.
- Unit and end-to-end tests for the MCP layer.

### Changed
- JMeter image: the download is checked against a pinned SHA-512, curl is removed after use, and JMeter runs as a non-root user (on Linux, as the web app's own user so results stay writable) with `no-new-privileges`. **Rebuild the image** (`docker build -t perf-framework-jmeter:5.6.3 ./jmeter`).
- Compose images pinned: `ollama/ollama:0.40.6` (was `latest`) and `influxdb:1.11` (was 1.8; it reads existing 1.8 data in place). CI builds the JMeter image and checks every Compose image tag exists.
- `web/server.js` split into `config`, `db`, `auth`, `run-service`, `routes/` and `create-app` modules. Unknown `/api/*` paths now return a JSON 404.
- InfluxDB is published on `127.0.0.1:8086` so live metrics can be queried from the host.
- README reorganised into a quick start with links to detailed docs. Data-lifecycle details moved to `docs/ARCHITECTURE.md`.
- `package.json` description now reflects the local single-host design.

### Fixed
- Latency percentiles are capped at the observed maximum. HDR histogram rounding could report a p99 slightly above max.
- The Ollama timeout test no longer gets cancelled because the event loop exits before the timer fires.

### Removed
- Committed `.DS_Store`, which is now ignored.

## [1.0.0]

- Web console for scenarios, versioned JMX uploads, Dockerised JMeter runs, Grafana live monitoring, PostgreSQL run history with automatic baselines, and optional local AI analysis with Ollama.
- Original CLI runner.
