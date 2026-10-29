# Configuration

Everything has a local-development default, so nothing needs to be set to get started. To override a value, export it in your shell. [`.env.example`](../.env.example) lists every variable. The app does not load `.env` files automatically, so use `set -a; source .env; set +a` or your own tooling.

## Web app (`npm run web`)

| Variable | Default | Purpose |
|---|---|---|
| `WEB_PORT` | `4000` | UI/API port (bound to `127.0.0.1`) |
| `POSTGRES_PASSWORD` | `local-dev-only` | Used to build the default database URL. Set the same value for Compose. |
| `DATABASE_URL` | `postgres://perf_framework:<password>@localhost:5433/perf_framework` | Full PostgreSQL connection string |
| `INFLUXDB_URL` | `http://influxdb:8086/write?db=jmeter` | Where JMeter (inside Docker) writes live metrics |
| `GRAFANA_BASE_URL` | `http://localhost:3000` | Base for dashboard links |
| `JMETER_IMAGE` | `perf-framework-jmeter:5.6.3` | JMeter Docker image |
| `JMETER_DOCKER_NETWORK` | `infra_jmeter-network` | Docker network shared with InfluxDB |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Local AI analysis endpoint |
| `OLLAMA_MODEL` | `llama3.2:3b` | Ollama model name |

## Docker Compose (`infra/docker-compose.yml`)

| Variable | Default | Purpose |
|---|---|---|
| `POSTGRES_PASSWORD` | `local-dev-only` | PostgreSQL password |
| `GRAFANA_ADMIN_PASSWORD` | `admin` | Grafana admin password (first start only) |

Published ports, all bound to `127.0.0.1`: Grafana `3000`, PostgreSQL `5433`, InfluxDB `8086`, Ollama `11434`.

## MCP server (`npm run mcp`)

| Variable | Default | Purpose |
|---|---|---|
| `PERF_WEB_URL` | `http://localhost:<WEB_PORT>` | Web app the tools call |
| `INFLUXDB_QUERY_URL` | `http://localhost:8086/query` | InfluxDB query endpoint for live metrics |
| `INFLUXDB_DATABASE` | `jmeter` | InfluxDB database |
| `MCP_READ_ONLY` | `false` | Hide all tools that change something |
| `MCP_MAX_USERS` | `200` | Maximum virtual users the assistant may set or run |
| `MCP_MAX_DURATION_SECONDS` | `3600` | Maximum duration the assistant may set or run |
| `MCP_REQUEST_TIMEOUT_MS` | `30000` | Timeout for each web app or InfluxDB request |

See [MCP.md](./MCP.md) for details.

## CLI (`node cli/index.js run`)

The CLI takes its settings as flags (`--script`, `--name`, `--threads`, `--duration`, `--rampup`) and uses `JMETER_IMAGE` and `JMETER_DOCKER_NETWORK` for Docker.
