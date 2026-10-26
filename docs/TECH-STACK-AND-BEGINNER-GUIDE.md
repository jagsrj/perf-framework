# Performance Testing Framework: Tech Stack and Beginner Guide

This guide explains the technologies used by the current application, how they fit together, how to run the project, and where to look when adding features.

For a more visual, browser-friendly presentation of this guide, open [tech-stack-and-beginner-guide.html](./tech-stack-and-beginner-guide.html).

The current implementation is a **local, single-host JMeter runner**. It is not yet a distributed load-testing platform.

## 1. What the application does

The application lets a user:

1. Create a test scenario with a name, JMeter script, virtual-user count, duration, and ramp-up.
2. Upload and version a JMeter `.jmx` file.
3. Start JMeter in a Docker container on the same machine.
4. Watch run status and live metrics through Grafana.
5. Review a completed run summary and compare it with a matching earlier run.

The app uses different storage for different kinds of data:

| Data | Where it lives | Why |
|---|---|---|
| Scenario, script-version, and run metadata | PostgreSQL | Relational records with IDs, constraints, and queryable relationships |
| JMX files, JTL output, JMeter logs, prepared plans | Local project filesystem | Large files stay outside the relational database |
| Live time-series metrics | InfluxDB | Efficient storage and querying of timestamped measurements |
| Charts and dashboards | Grafana | Visualization of InfluxDB data |

PostgreSQL stores paths, hashes, statuses, and summaries; it does **not** store the JMX or JTL file contents.

## 2. Architecture at a glance

```text
Browser
  │  HTTP, HTML/CSS, browser JavaScript
  ▼
Node.js + Express web application (localhost:4000)
  ├── PostgreSQL (localhost:5433)
  ├── local files: data/scripts/ and results/<run-id>/
  └── Docker CLI
        └── JMeter container
              └── InfluxDB (Docker network)
                    └── Grafana dashboard (localhost:3000)
```

Docker Desktop runs the PostgreSQL, InfluxDB, and Grafana services. The Node.js application runs directly on the host. For each web run, the application asks Docker to start one JMeter container, mounts the prepared script and results directory, and then monitors the container.

Only one web-managed run may be active at a time. Remote worker registration and distributed execution are not implemented.

## 3. Technology stack

### JavaScript and Node.js

**JavaScript** is the programming language used for the command-line program, server, and browser interface. **Node.js** is the runtime that executes JavaScript outside a browser.

The project uses modern JavaScript **ES modules**:

```js
import path from 'node:path';
import express from 'express';

export function helper() {
  // ...
}
```

- `import` loads another module.
- `export` makes a function or value available to other modules.
- `async`/`await` is used for operations that take time, such as database queries, file access, and HTTP requests.
- `Promise` represents a result that will be available later.
- Node's `node:fs/promises` APIs access files asynchronously.
- Node's `node:child_process` APIs start external programs such as Docker.

The `package.json` field `"type": "module"` tells Node to use ES module syntax. The supported minimum Node version is 18.

### npm

**npm** installs JavaScript packages and runs project scripts.

- `package.json` lists the direct dependencies and named commands.
- `package-lock.json` records the resolved dependency tree so installs are repeatable.
- `node_modules/` contains installed packages and is generated; it should not be committed.

Examples:

```bash
npm install       # Install packages from package-lock.json
npm run web       # Start the web app
npm test          # Run the test suite
```

### Express

**Express** is the web framework used by the Node.js application. It receives HTTP requests and maps them to handler functions called **routes**.

Examples from the app:

- `GET /api/scenarios` lists scenarios.
- `POST /api/scenarios` creates a scenario.
- `POST /api/scenarios/:id/script` accepts a script upload.
- `POST /api/scenarios/:id/runs` starts a run.
- `GET /api/runs/:runId/results` returns run and baseline data.

`:id` and `:runId` are route parameters. Middleware runs before route handlers to apply shared behavior, such as JSON parsing, static-file serving, and local Host/Origin checks.

The server and routes are in [`web/server.js`](../web/server.js).

### HTML, CSS, and browser JavaScript

The browser interface is built without a front-end framework:

- **HTML** in `web/public/index.html` describes forms, navigation, sections, and containers.
- **CSS** in `web/public/styles.css` controls layout, colors, responsive behavior, and status styles.
- **Browser JavaScript** in `web/public/app.js` responds to clicks and form submissions, calls the API with `fetch`, and updates the page.

The browser JavaScript uses the DOM (Document Object Model), which is the browser's in-memory representation of the HTML page. For example, `document.querySelector('#notice')` finds the element with ID `notice`.

The interface sends JSON for regular API operations. File uploads use `FormData`, which allows the browser to send a file as multipart form data.

### PostgreSQL and SQL

**PostgreSQL** is a relational database. Data is stored in tables made of rows and columns. A primary key identifies a row; a foreign key links related rows.

The app currently creates its schema at server startup in `web/server.js`.

Main tables:

- `scenarios`: scenario name, load settings, and current script metadata.
- `scenario_script_versions`: one record per uploaded script revision, with path and SHA-256 hash.
- `test_runs`: one record per execution, with a snapshot of the tested configuration, status, timestamps, and JSONB summary.

Relationships:

```text
scenarios 1 ── many scenario_script_versions
scenarios 1 ── many test_runs
```

The app uses the `pg` package to connect to PostgreSQL. Queries with user-provided values use placeholders:

```js
await pool.query(
  'SELECT * FROM scenarios WHERE id = $1',
  [scenarioId]
);
```

The `$1` placeholder keeps the value separate from the SQL statement. Continue using parameterized queries rather than concatenating user input into SQL.

The run summary uses PostgreSQL's `JSONB` type, which stores JSON in a form PostgreSQL can query. The summary contains overall and per-label sample counts and latency statistics.

### Apache JMeter

**Apache JMeter** is the load-testing engine. A `.jmx` file is an XML test plan describing the test steps. JMeter runs in non-GUI mode inside the project's custom Docker image, built from `jmeter/Dockerfile`.

The app supplies runtime properties such as thread count, duration, ramp-up, InfluxDB URL, application name, and run ID. The run ID lets charts distinguish one execution from another.

`cli/jmx.js` validates and prepares the JMX plan. It adds an InfluxDB Backend Listener when needed and tags its metrics with the run ID.

### Docker and Docker Compose

**Docker** runs an application in a container with an isolated filesystem and process environment. In this project:

- Docker Compose starts PostgreSQL, InfluxDB, and Grafana.
- The web app starts a JMeter container for an individual run.
- Docker volumes retain database and Grafana data when containers are recreated.
- A Docker bridge network lets the JMeter and Grafana containers reach InfluxDB by service name.
- Bind mounts give JMeter access to the prepared JMX file and run output directory.

The Compose configuration is [`infra/docker-compose.yml`](../infra/docker-compose.yml). The JMeter container command and mounts are assembled in [`cli/docker.js`](../cli/docker.js).

Useful commands:

```bash
docker compose -f infra/docker-compose.yml up -d
docker compose -f infra/docker-compose.yml ps
docker compose -f infra/docker-compose.yml logs
docker compose -f infra/docker-compose.yml down
```

`down` retains named volumes by default. `down -v` removes them and deletes their stored data.

### InfluxDB and Grafana

**InfluxDB** is a time-series database: measurements have values recorded at times and can be tagged for filtering. JMeter's Backend Listener sends live performance metrics to the `jmeter` database. The project configures a one-day retention policy for those metrics.

**Grafana** connects to InfluxDB as a data source and displays charts on a provisioned dashboard. The dashboard is filtered by scenario/application and run ID. The provisioning files and dashboard definition are in `infra/grafana/provisioning/`.

PostgreSQL run summaries and InfluxDB live metrics serve different needs: the summary supports durable history and comparison, while InfluxDB supports time-based charts.

### Other npm dependencies

| Package | Purpose in this project |
|---|---|
| `commander` | Parses CLI commands and options |
| `pg` | PostgreSQL client and connection pool |
| `multer` | Receives uploaded files in Express |
| `xml2js` | Parses uploaded JMeter XML |
| `csv-parse` | Parses JTL CSV output |
| `hdr-histogram-js` | Calculates latency percentiles with bounded memory |

## 4. Repository map

```text
cli/
  index.js       CLI entry point
  docker.js      Builds and runs Docker/JMeter commands
  jmx.js         Validates and prepares JMeter test plans
  run-id.js      Creates run identifiers

web/
  server.js      Express app, database schema, API routes, run lifecycle
  summary.js     JTL streaming parser and summary calculator
  public/
    index.html   UI structure
    app.js       Browser behavior and API calls
    results.js   Browser-side metric comparison helper
    styles.css   UI styling

infra/
  docker-compose.yml
  grafana/provisioning/  Grafana data source and dashboard setup

jmeter/
  Dockerfile     Custom JMeter runtime image

scripts/         Example JMeter plans
test/            Automated tests
data/scripts/    Uploaded script versions (generated/local data)
results/         Per-run output files (generated/local data)
docs/            Project documentation
```

## 5. How a web run works

1. The user chooses a scenario and starts it from the UI.
2. Browser JavaScript sends `POST /api/scenarios/:id/runs`.
3. Express loads the scenario and verifies it has an uploaded script.
4. The server creates a run ID and a `results/<run-id>/` directory.
5. It snapshots the selected source JMX into the run directory and records the script hash/version and load settings in PostgreSQL.
6. `cli/jmx.js` prepares a JMX copy with the InfluxDB listener and run-ID tag.
7. `cli/docker.js` builds a Docker argument array and starts a detached JMeter container. The script directory is mounted read-only; the result directory is mounted for JMeter output.
8. JMeter writes a JTL and log file and streams metrics to InfluxDB.
9. The server waits for the container to exit. It streams the JTL through the summary code and stores the aggregate summary in PostgreSQL.
10. The UI polls the run API. Grafana charts use the same run ID to filter metrics.

The run lifecycle is:

```text
starting → running → completed
                    ↘ failed
                    ↘ aborted
```

The server also searches Docker labels on application startup to reconnect to an active local JMeter container.

## 6. How the summary and baseline work

JTL is a CSV file containing sample-level outcomes such as elapsed time, label, and success. `web/summary.js` reads it as a stream instead of loading the entire file into memory. For each sample, it updates total and per-label aggregates and records response times in HDR histograms.

The aggregate summary includes:

- Total and failed samples
- Error percentage
- Mean, p95, p99, and maximum response time
- Per-label summaries

The Test Results page requests a selected run and the latest earlier completed run that matches the same scenario, script hash, virtual users, duration, and ramp-up. The browser formats the values into a report table.

## 7. Run the application locally

Prerequisites: Docker Desktop/Engine, Docker Compose, Node.js 18+, and npm.

From the project root:

```bash
# Start PostgreSQL, InfluxDB, and Grafana
docker compose -f infra/docker-compose.yml up -d

# Build the JMeter image (first time, or when its Dockerfile changes)
docker build -t perf-framework-jmeter:5.6.3 ./jmeter

# Install JavaScript dependencies
npm install

# Start the web app
npm run web
```

Open `http://localhost:4000`. Create a scenario, upload a trusted `.jmx` plan, start a run, then use Runtime Monitoring and Test Results.

To run the test suite:

```bash
npm test
```

To use the CLI:

```bash
node cli/index.js run \
  --script scripts/sample.jmx \
  --name smoke-test \
  --threads 10 \
  --duration 60 \
  --rampup 10
```

The CLI and web app both invoke JMeter in Docker. For live InfluxDB monitoring, start the Compose stack first.

## 8. Tests and development workflow

Tests use Node's built-in test runner (`node:test`) and assertions (`node:assert/strict`), so no separate test framework is required.

- `test/docker.test.js` checks Docker argument construction and stop behavior.
- `test/jmx.test.js` checks run-ID tagging and JMX preparation.
- `test/summary.test.js` checks JTL summary values and stream error handling.
- `test/results.test.js` checks baseline metric comparisons.

When adding a feature:

1. Identify the UI, API, persistence, and external-service layers it touches.
2. Add or update API validation and database behavior using existing patterns.
3. Keep SQL parameterized and handle failures explicitly.
4. Add a focused test for the behavior or computation.
5. Run `npm test` and `node --check path/to/changed-file.js` for changed JavaScript.
6. Update this guide or the README when user-facing behavior or setup changes.

### Example: add a read-only API endpoint

An Express route generally follows this shape:

```js
app.get('/api/example', asyncHandler(async (request, response) => {
  const result = await pool.query(
    'SELECT run_id, status FROM test_runs ORDER BY started_at DESC LIMIT 20'
  );
  response.json(result.rows);
}));
```

The frontend can call it with the shared `api()` helper in `web/public/app.js`:

```js
const recentRuns = await api('/api/example');
```

For routes that accept an ID or other user input, validate it and use SQL parameters. Do not expose filesystem paths directly as arbitrary user-controlled paths.

## 9. Important safety and operations notes

- Uploaded JMX files are executable test plans. Upload and run only scripts you trust and are authorized to use.
- The web app is intended for local development, binds to loopback, and has no user authentication.
- Compose contains development-only credentials and enables anonymous read-only Grafana viewing for the local dashboard. Do not expose these defaults as a shared service.
- Run artifacts and uploaded scripts are files outside PostgreSQL. Back them up separately if they matter.
- Docker volumes contain PostgreSQL, InfluxDB, and Grafana data. Removing volumes deletes that data.
- The current design is one host, one active web-managed test at a time. There is no remote worker registry, job queue, distributed scheduler, or high availability.

## 10. Suggested next learning steps

1. Learn basic JavaScript: functions, objects, arrays, modules, promises, and `async`/`await`.
2. Learn HTTP basics: methods, paths, status codes, JSON, and request/response.
3. Follow one UI action from its event handler in `web/public/app.js` to its route in `web/server.js`.
4. Learn SQL basics: `SELECT`, `INSERT`, `UPDATE`, primary keys, foreign keys, indexes, and transactions.
5. Run `npm test`, then read a test and the code it covers.
6. Modify a small isolated feature, add a test, and verify existing flows still work.
7. Learn Docker images, containers, volumes, bind mounts, and networks before changing the execution environment.

## 11. Where to find more

- [`README.md`](../README.md) — concise installation and user workflow.
- [`Perf-Framework-System-Design.pptx`](./Perf-Framework-System-Design.pptx) — current-state architecture diagrams and design summary.
- [`web/server.js`](../web/server.js) — server routes, startup schema, persistence, and run orchestration.
- [`cli/docker.js`](../cli/docker.js) — JMeter Docker invocation.
- [`cli/jmx.js`](../cli/jmx.js) — JMX preparation and metrics tagging.
- [`web/summary.js`](../web/summary.js) — JTL parsing and summary calculation.
