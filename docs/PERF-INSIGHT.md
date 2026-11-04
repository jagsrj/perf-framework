# Regression checks with perf-insight

perf-framework's SLO verdict answers one question: *is this run within its fixed limits?* It misses a build that got **30% slower but is still under the SLO**. [perf-insight](https://github.com/jagsrj/perf-insight) answers the second question: *is this run worse than the runs before it?*

When `PERF_INSIGHT_URL` is set, every **completed** run is handed to perf-insight automatically:

```
run completes ─► summary + SLO verdict (as before)
              └► perf-insight:  POST /runs  (same run ID, scenario, load, script version)
                                POST /runs/:id/results/jtl   (all generators' JTLs, merged)
                                POST /runs/:id/analyze       (+ Dynatrace / Splunk if configured there)
              ◄─ verdict pass / warn / fail  ─► stored on the run as `insight`
              └► notification (now includes the regression verdict)
```

perf-insight compares each transaction against the median of the last N good runs of the same scenario. It uses a Mann-Whitney U test with an effect-size floor, so normal run-to-run noise doesn't fail builds. It also tests error-rate changes, checks its own SLOs, flags transactions that disappeared, and can add an AI-written diagnosis. Runs that fail never join the baseline. See its README for the method and thresholds.

## Set it up

1. Run perf-insight somewhere the controller can reach (`docker run -p 8080:8080 …`, or `npx perf-insight serve`).
2. Set on the perf-framework web app:

   | Variable | Default | |
   |---|---|---|
   | `PERF_INSIGHT_URL` | (off) | e.g. `http://perf-insight:8080`. Setting it turns the hand-off on |
   | `PERF_INSIGHT_API_KEY` | (none) | Sent as `x-api-key` when perf-insight requires a key |
   | `PERF_INSIGHT_ENVIRONMENT` | (none) | Environment label (e.g. `perf`, `uat`), shown in reports and usable in perf-insight connector queries |
   | `PERF_INSIGHT_SKIP_AI` | `false` | Skip the AI diagnosis (statistics only) |
   | `PERF_INSIGHT_TIMEOUT_SECONDS` | `300` | Give up after this long and record the check as unavailable |

3. Run `npm run migrate` (or restart the web app) to add the `insight` column.

Scenario names become perf-insight scenario names, so baselines build up per scenario automatically. The first run of a scenario is checked against perf-insight's SLOs only, and every later passing run becomes part of the baseline.

## What you see

- **Run cards and Test results:** a "Regression pass/warn/fail" badge, the flagged transactions with the reason, the AI summary and a link to the full perf-insight report (statistics, APM metrics, log searches, findings).
- **HTML report** (`/api/runs/:runId/report`): a "Regression check (perf-insight)" section.
- **Notifications:** the headline adds `· regression check FAIL` (⚠️ for warn) and lists the flagged transactions. The JSON format includes the full `insight` object.
- **API:** `insight` on every run: `null` (not configured), `{ "status": "pending" }`, `{ "status": "ok", "verdict": "fail", "failing": [...], "warnings": [...], "baselineRuns": 3, "reportUrl": "...", "aiSummary": "..." }` or `{ "status": "error", "error": "..." }`.
- **Re-run the check:** `POST /api/runs/:runId/insight` (for example after fixing perf-insight's configuration).

## CI gate

`node cli/index.js ci` waits for the regression check after the run completes, prints it, and adds it to the exit code and JUnit output:

| Situation | Exit code |
|---|---|
| perf-insight verdict `fail` | `1` |
| verdict `warn` with `--insight-fail-on warn` | `1` |
| check unavailable (not configured, error, still running at `--timeout`) | unchanged; or `2` with `--require-insight` |

```
Run 1793805709548-8fd16539 completed
  samples 1600 · errors 0 (0.00%)
  mean 247.3 ms · p95 512.0 ms · p99 640.0 ms · max 1210 ms
  perf-insight: FAIL vs 3 baseline run(s)
  ✗ login: Regression: p95 +36.4% vs baseline (fail threshold 20%)
  perf-insight report: http://perf-insight:8080/runs/1793805709548-8fd16539/report
FAIL: perf-insight regression check FAILED: login.
```

## Failure handling

perf-insight is optional and never changes a run's own status. If it is down, slow or rejects the results, the run stays `completed`. `insight` records the error, the notification still goes out (after at most `PERF_INSIGHT_TIMEOUT_SECONDS`), and the CI gate ignores the check unless `--require-insight` is set. Aborted and failed runs are not sent.
