# Remote load generators and the shared drive

For enterprise-scale tests, JMeter runs on separate **load generator** machines instead of the controller. Each one runs the small perf-framework **agent**. Scripts, their data files and JMeter plugins live on a **shared drive** mounted on the controller. When a test starts, they are bundled and sent to every selected load generator.

```
                         ┌──────────────── controller ────────────────┐
  shared drive  ───────► │ web app (UI/API)   PostgreSQL   InfluxDB   │
  scripts/ plugins/      └──────▲──────────────────▲─────────────▲────┘
                                │ HTTPS (agents     │ JTL stream  │ live metrics
                                │ call out only)    │             │ (Backend Listener)
              ┌─────────────────┴───┐   ┌───────────┴─────────┐   │
              │ lg-toronto-01       │   │ lg-toronto-02       │───┘
              │ agent + JMeter      │   │ agent + JMeter      │
              └─────────────────────┘   └─────────────────────┘
```

## How a run works

1. In **Create scenario** or **Update scenario**, choose:
   - **Script source → Shared drive**, and a `.jmx` from the list. Every file in that script's folder (CSV files, payloads, sub-folders) goes with it.
   - **JMeter plugins**: tick the jars the test needs.
   - **Load generators → Remote load generators**, and tick the machines to use. Each one shows whether it is online, busy, offline or disabled.
2. When you execute the scenario, the controller checks that every selected generator is online and free. It refuses to start otherwise, naming the ones that are not.
3. The script folder and plugins are copied into `results/<run-id>/bundle` (a snapshot, so editing the drive mid-run changes nothing). The JMX gets the InfluxDB Backend Listener and run-ID tag added.
4. Users are split evenly across the generators (20 users on 2 generators → 10 each). Each agent picks up its assignment on its next heartbeat, downloads the bundle and starts JMeter. Plugins are loaded via `search_paths` and `user.classpath`, so nothing is installed on the machine.
5. While JMeter runs, each agent streams its JTL to the controller every few seconds. Live metrics also flow to InfluxDB/Grafana as before.
6. When every generator has finished, their results are merged into one summary, SLO verdict, report and baseline comparison.

**Abort** stops JMeter on every generator within a heartbeat or two. If a generator **stops responding** for `PERF_AGENT_TIMEOUT_SECONDS` (30 s), the run fails, the other generators are stopped, and whatever was streamed so far is kept. If JMeter fails on one generator, the others are stopped too.

## 1. Set up the shared drive

Mount your network share (NFS, SMB/CIFS, Azure Files, …) on the controller and point `PERF_SHARED_DIR` at it. The default is `data/shared` in the repository. Use this layout:

```
<PERF_SHARED_DIR>/
  scripts/
    checkout/
      checkout.jmx
      users.csv
      data/products.csv
    login/
      login.jmx
  plugins/
    jmeter-plugins-casutg-2.10.jar
    jmeter-plugins-cmn-jmeter-0.7.jar
```

- **One folder per test.** A script's whole folder is sent with it (limit `PERF_MAX_BUNDLE_MB`, default 200 MB), so don't put scripts directly in `scripts/` next to unrelated large files.
- **Use relative paths for data files** in CSV Data Set Config and similar elements (for example `users.csv` or `data/products.csv`). JMeter resolves them relative to the `.jmx`, so they work on every generator.
- **Plugins:** include each plugin's dependency jars too (the Plugins Manager's `lib/` jars), and tick them all in the scenario. Only `.jar` files in `plugins/` (including sub-folders) can be selected.
- The controller only reads from the drive. The load generators never need access to it.

Uploading a `.jmx` through the browser still works as before. A scenario can use uploaded scripts with shared-drive plugins too.

## 2. Configure the controller

Load generators reach the controller over the network, so it must listen beyond localhost, which requires an API key.

```bash
export PERF_API_KEY=$(openssl rand -hex 32)          # for the UI, CI and MCP
export PERF_AGENT_TOKEN=$(openssl rand -hex 32)      # for load generators (must differ)
export WEB_HOST=0.0.0.0
export PERF_ALLOWED_HOSTS=perf.example.com           # host name the generators use
export PERF_SHARED_DIR=/mnt/perf-shared
# InfluxDB address as seen from the generators, for live Grafana metrics:
export PERF_AGENT_INFLUXDB_URL=http://perf.example.com:8086/write?db=jmeter
npm run web
```

- Put **HTTPS** in front of the controller (a reverse proxy or tunnel). Tokens, scripts and test data travel over this connection.
- **InfluxDB:** the Compose file publishes it on `127.0.0.1:8086` only. For live Grafana metrics from remote generators, publish it on an interface the generators can reach (ideally behind a firewall rule that only allows them), and set `PERF_AGENT_INFLUXDB_URL`. Final results, the SLO verdict and live SLO checks do **not** depend on InfluxDB: they use the streamed JTL.
- Firewalls: generators need outbound access to the controller (HTTPS) and InfluxDB. Nothing needs to connect **to** the generators.

## 3. Start a load generator

**With Docker (recommended).** On each generator machine, with this repository checked out:

```bash
docker build -t perf-framework-jmeter:5.6.3 ./jmeter
docker build -t perf-framework-agent:1.0.0 ./agent

export PERF_CONTROLLER_URL=https://perf.example.com
export PERF_AGENT_TOKEN=<the controller's PERF_AGENT_TOKEN>
export PERF_AGENT_NAME=lg-toronto-01
export JVM_ARGS="-Xms4g -Xmx4g"          # size the heap to the machine
docker compose -f infra/load-generator-compose.yml up -d
```

In an enterprise you would build the two images once and push them to your registry, then set `PERF_AGENT_IMAGE` on each machine.

**Without Docker.** Install Java 17 and JMeter 5.6.3, Node.js 18+, then:

```bash
cd agent && npm ci --omit=dev
PERF_CONTROLLER_URL=https://perf.example.com PERF_AGENT_TOKEN=... JMETER_BIN=/opt/jmeter/bin/jmeter node agent.js
```

Run it as a service (systemd, Windows service wrapper) so it restarts with the machine.

The generator appears in the **Load generators** tab within a few seconds. Use the same JMeter version on every generator.

### Agent settings

| Variable | Default | Purpose |
|---|---|---|
| `PERF_CONTROLLER_URL` | (required) | Controller address |
| `PERF_AGENT_TOKEN` | (required) | Must match the controller |
| `PERF_AGENT_NAME` | host name | Name shown in the UI. Re-using a name re-attaches to the existing entry |
| `PERF_AGENT_MAX_THREADS` | (none) | Most users this machine should run; runs that would exceed it are refused |
| `PERF_AGENT_WORKDIR` | `./agent-work` | Downloaded bundles and local results |
| `PERF_AGENT_KEEP_RUNS` | `5` | Finished run folders kept for troubleshooting |
| `PERF_AGENT_UPLOAD_SECONDS` | `5` | How often JTL data is streamed |
| `JMETER_BIN` | `jmeter` | JMeter launcher |
| `NODE_EXTRA_CA_CERTS` | (none) | CA bundle if the controller uses a private certificate authority |

## Live SLO aborts

Tick **Abort the run early if a target is breached** under SLO targets, and set a **warm-up**. After the warm-up, the controller checks the targets every `PERF_LIVE_SLO_INTERVAL_SECONDS` (10 s) against an exact running summary of all generators' results. If they are breached on two checks in a row, the run is aborted with a message such as `Aborted by live SLO check: p95 latency 912 > 800`. The CI gate exits `1` (SLO failed) for these runs. This works for local and remote runs.

## Managing generators

The **Load generators** tab lists every registered machine with its status, host, JMeter version, capacity and last heartbeat.

- **Disable** keeps a machine out of new runs (for maintenance).
- **Remove** deletes it. A generator with run history is disabled instead, so old runs keep their details.

API: `GET /api/load-generators`, `PATCH /api/load-generators/:id` with `{ "enabled": false }`, and `DELETE /api/load-generators/:id`.

## Security notes

- Anyone with `PERF_AGENT_TOKEN` can register a generator and receive the scripts and data files of runs assigned to it. Treat it like a password, rotate it by changing it on the controller and the generators, and keep sensitive test data off the shared drive where possible.
- An agent can only fetch bundles and upload results for its own assignments.
- Shared-drive paths are resolved inside `scripts/` and `plugins/` only; `..` and symbolic links pointing outside are refused.

## Troubleshooting

| Symptom | Check |
|---|---|
| Generator never appears | Agent logs (`docker compose logs agent`). `401`: token mismatch. `403 host name`: add the controller's host name to `PERF_ALLOWED_HOSTS`. TLS errors: `NODE_EXTRA_CA_CERTS`. |
| Generator shows offline | It has not sent a heartbeat for 30 s: network, or the agent stopped. |
| Run fails with "did not start the test in time" | The agent was busy or could not download the bundle within `PERF_AGENT_START_TIMEOUT_SECONDS` (120 s). |
| JMeter exits with an error on a generator | `results/<run-id>/jmeter-<n>.log` on the controller has the end of that generator's JMeter log. Missing plugin classes usually mean a dependency jar was not ticked. |
| No live Grafana data from generators | `PERF_AGENT_INFLUXDB_URL` must be reachable from the generator machines. |
