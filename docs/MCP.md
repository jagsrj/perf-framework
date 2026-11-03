# MCP Server: AI-Assisted Performance Testing

The `mcp/` folder adds a [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server to the framework. With it, an AI assistant such as Claude Code or Claude Desktop can operate the framework when you ask in plain English, for example:

> "Run the login scenario, tell me how it's going every few minutes, then compare it with the last run and check p95 < 500 ms and errors < 1%."

## How it fits

The MCP server is a **thin wrapper**. It does not start JMeter or write to the database itself. It calls the existing web app REST API, which keeps all of its current behaviour: script validation, versioning, the one-active-run rule and container monitoring. The only exception is live metrics, which the server reads straight from InfluxDB.

```
 AI assistant (Claude)
        │  MCP over stdio
        ▼
 mcp/server.js ── guardrails (max users / duration, read-only mode)
        │ HTTP                         │ InfluxQL (read-only)
        ▼                              ▼
 web app :4000  ── PostgreSQL       InfluxDB :8086
        │
        ▼
 JMeter in Docker ──► InfluxDB ──► Grafana
```

You can keep using the web UI at the same time. Both drive the same engine and data.

## Tools

| Tool | What it does | Changes anything? |
|---|---|---|
| `check_health` | Web app and database reachable; shows guardrail limits | No |
| `list_scenarios` | Scenarios with load settings and script status | No |
| `get_script` | Current JMX for a scenario | No |
| `create_scenario` | New scenario (name, script name, users, duration, ramp-up, optional SLO targets) | Yes |
| `update_scenario` | Change only the fields you pass, including SLO targets (`slo: null` clears them) | Yes |
| `upload_script` | Upload JMX from text (`jmxContent`) or a file (`filePath`) as a new version | Yes |
| `run_scenario` | Start a run with the scenario's saved settings | Yes |
| `abort_run` | Stop an active run | Yes |
| `list_runs` | Recent runs, filterable by scenario and status | No |
| `get_run` | Status, elapsed/remaining time, Grafana link, summary | No |
| `get_live_metrics` | Throughput, error rate, latency, active threads over a recent window | No |
| `get_run_results` | Final summary compared with the automatic baseline | No |
| `compare_runs` | Any two runs side by side, with a list of regressions | No |
| `check_slo` | With no targets, returns the run's stored automatic SLO verdict. With targets, runs an ad-hoc pass/fail check | No |
| `get_trends` | A scenario's recent completed runs: p95/p99, errors, throughput, SLO verdicts | No |
| `get_report_url` | Links to the run's HTML report (view or download) | No |

Comparisons mark each metric as `better`, `worse`, `unchanged` (within `tolerancePercent`, 10% by default) or `n/a`. The tools return numbers and pass/fail results. The assistant writes the explanation on top of them.

## Setup

1. Start the stack and web app as described in the [README](../README.md). The Compose file publishes InfluxDB on `127.0.0.1:8086` so live metrics work. Re-run `docker compose -f infra/docker-compose.yml up -d` if your stack started before this change.
2. Install dependencies with `npm install`. This adds `@modelcontextprotocol/sdk` and `zod`.
3. Connect an MCP client:

**Claude Code:** the repository ships a project-scoped [`.mcp.json`](../.mcp.json). Open Claude Code in the repo root and approve the `perf-framework` server when prompted. You can also add it manually:

```bash
claude mcp add perf-framework -- node mcp/server.js
```

**Claude Desktop:** add this to `claude_desktop_config.json`, using the absolute path to your clone:

```json
{
  "mcpServers": {
    "perf-framework": {
      "command": "node",
      "args": ["/absolute/path/to/perf-framework/mcp/server.js"],
      "env": { "MCP_MAX_USERS": "200" }
    }
  }
}
```

**Debugging:** you can inspect the tools interactively:

```bash
npx @modelcontextprotocol/inspector node mcp/server.js
```

## Guardrails

| Variable | Default | Effect |
|---|---|---|
| `MCP_READ_ONLY` | `false` | `true` hides every tool that changes something. The assistant can only read and analyse. |
| `MCP_MAX_USERS` | `200` | `create_scenario`, `update_scenario` and `run_scenario` refuse to go above this |
| `MCP_MAX_DURATION_SECONDS` | `3600` | Same, for test duration |

The limits are checked again at `run_scenario`, so a scenario someone enlarged in the UI can't be started by the assistant beyond the limit. Only a person can change these values, in the MCP client configuration. MCP clients also ask you to approve tool calls. Keep approval on for `run_scenario` and `abort_run`.

Other connection settings (`PERF_WEB_URL`, `INFLUXDB_QUERY_URL`, `INFLUXDB_DATABASE`, `MCP_REQUEST_TIMEOUT_MS`) are listed in [CONFIGURATION.md](./CONFIGURATION.md).

## Example prompts

- "What scenarios do I have, and which ones are ready to run?"
- "Create a scenario `search-baseline` with 50 users, 10 minutes and 60 s ramp-up, and upload `scripts/sample.jmx`."
- "Here's a HAR export of the checkout flow. Write a JMX script with a CSV data set and correlation for the session token, upload it to the `checkout` scenario, and run it for 2 minutes with 5 users as a smoke test."
- "Run `search-baseline`, check live metrics every couple of minutes, and abort if the error rate goes above 5%."
- "Did the last run pass p95 ≤ 800 ms and errors ≤ 1% for every transaction?"
- "Set the SLO for `checkout` to p95 ≤ 800 ms and errors ≤ 1% per transaction."
- "Has `checkout` been getting slower over the last 10 runs?"
- "Compare run X with run Y and summarise the regressions in a short report I can paste into Jira."

## Notes and limitations

- **Live latency** in `get_live_metrics` is the worst backend-listener interval in the window, not an exact window percentile. Final percentiles in `get_run_results` are exact, computed from the JTL.
- **Data sent to the assistant:** tool results go to whichever AI model your MCP client uses. Summaries contain transaction labels and metrics. `get_script` returns the full JMX, which may contain hostnames or test credentials. Use `MCP_READ_ONLY` and approval prompts according to your data-handling rules. The local Ollama analysis in the web UI stays fully local.
- **Single host:** like the rest of the framework, this is built for one machine. The web app accepts only `localhost` requests, so run the MCP server on the same host.
