# SLOs and CI/CD Gates

## SLO targets per scenario

Each scenario can store **SLO targets**, which are upper limits a run must stay within:

| Target | Field | Example |
|---|---|---|
| p95 latency | `p95Ms` | 800 |
| p99 latency | `p99Ms` | 1500 |
| Mean latency | `averageMs` | 400 |
| Max latency | `maxMs` | 5000 |
| Error rate | `errorRatePercent` | 1 |
| Apply to every transaction | `applyToTransactions` | `true` checks each label as well as the overall result |

You can set them in the UI (**Create scenario** / **Update scenario → SLO targets**), through the API (`slo` on `POST`/`PUT /api/scenarios`), or with the MCP tools `create_scenario` and `update_scenario`.

How the verdict works:

- The targets are **snapshotted when a run starts**, so later edits never change an old run's verdict.
- When the run finishes, the verdict is computed from the exact JTL summary and stored as `slo_result` on the run: overall pass/fail plus every individual check.
- A metric with no data (for example, a transaction that never ran) counts as a **failure**, not a pass.
- Verdicts appear on run cards, on the **Test results** page, in the HTML report, in webhook notifications, and in `/api/scenarios/:id/trends`.

## The CI gate

`node cli/index.js ci` runs a scenario through the web app, waits for it to finish and returns an exit code your pipeline can act on:

| Exit code | Meaning |
|---|---|
| `0` | Run completed and its SLO passed, or no SLO is set |
| `1` | Run completed but the SLO failed, or no SLO is set and `--require-slo` was used |
| `2` | Run failed, was aborted, timed out, or couldn't start |

```bash
node cli/index.js ci --scenario checkout-smoke --require-slo \
  --junit perf-junit.xml --report perf-report.html
```

| Option | Default | |
|---|---|---|
| `--scenario <nameOrId>` | required | Scenario name (must be unique) or ID |
| `--url <url>` | `$PERF_WEB_URL` or `http://localhost:4000` | Web app |
| `--timeout <s>` | duration + 600 | Abort the run and exit `2` after this long |
| `--poll <s>` | `10` | Status polling interval |
| `--require-slo` | off | Treat "no SLO set" as a failure |
| `--junit <path>` | | JUnit XML with one test case per SLO check. GitHub, Jenkins, Azure DevOps and GitLab can display it |
| `--report <path>` | | Saves the self-contained HTML report |

Example output:

```
Starting "checkout": 6 users, 600s, ramp-up 60s
Run ID: 1793311043290-37306672
Status: running
Status: completed
Run 1793311043290-37306672 completed
  samples 400 · errors 4 (1.00%)
  mean 156.8 ms · p95 283.0 ms · p99 299.0 ms · max 900 ms
  ✗ overall p95 latency: 283 (target ≤ 200)
FAIL: SLO failed (1 of 2 checks).
```

### GitHub Actions

The web app accepts **localhost requests only**, so the job must run on a **self-hosted runner** on the machine where the framework runs. Copy [`examples/github-actions/perf-gate.yml`](../examples/github-actions/perf-gate.yml) into the repository you want to gate, give your runner the label `perf`, and set the repository variable `PERF_FRAMEWORK_DIR` to the path of your clone on that machine. The workflow uploads the HTML report and JUnit file as artifacts.

### Jenkins

```groovy
stage('Performance gate') {
  agent { label 'perf' }
  steps {
    dir(env.PERF_FRAMEWORK_DIR) {
      sh 'node cli/index.js ci --scenario checkout-smoke --require-slo --junit perf-junit.xml --report perf-report.html'
    }
  }
  post {
    always {
      junit "${env.PERF_FRAMEWORK_DIR}/perf-junit.xml"
      archiveArtifacts artifacts: "${env.PERF_FRAMEWORK_DIR}/perf-report.html", allowEmptyArchive: true
    }
  }
}
```

## Notifications

Set `NOTIFY_WEBHOOK_URL` (and optionally `NOTIFY_WEBHOOK_FORMAT`) before starting the web app to post a message whenever a run finishes:

| Format | Use with |
|---|---|
| `slack` (default) | Slack incoming webhook |
| `teams` | Microsoft Teams **Workflows** webhook (Adaptive Card) |
| `json` | Your own endpoint. Payload: `{ event: "run.finished", title, run: {...}, reportUrl }` |

Messages include status, the SLO verdict, samples, error rate, p95/p99 and a report link. The link uses `APP_BASE_URL` (default `http://localhost:4000`), so it only opens on the framework machine unless you change it. Notification failures are logged and never affect the run.

## Reports and trends

- `GET /api/runs/:runId/report` returns a self-contained HTML report with run details, the SLO verdict and every check, a baseline comparison, and transactions ordered slowest first. Add `?download` to save it as a file. The **Test results** page links to both.
- `GET /api/scenarios/:id/trends?limit=20` returns the scenario's completed runs (oldest first) with throughput, error rate, mean/p95/p99 and SLO verdict. Useful for spotting gradual regressions across releases. The MCP tool `get_trends` summarises it.
