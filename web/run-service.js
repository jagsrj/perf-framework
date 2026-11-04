// Test-run lifecycle: snapshot the bundle, start JMeter (local Docker containers or remote load
// generators), watch it, record the result, abort, and recover after a restart.
// Both executors share one interface (start/wait/stop/remove/find) and are injected so the API
// tests can run without Docker or real agents.

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  findJMeterContainers,
  removeJMeterContainer,
  splitUsers,
  startJMeterContainer,
  stopJMeterContainer,
  waitForJMeterContainer
} from '../cli/docker.js';
import { prepareJMX } from '../cli/jmx.js';
import { generateRunId } from '../cli/run-id.js';
import { httpError } from './http.js';
import { startLiveSloWatcher } from './live-slo.js';
import { notificationSettings, sendRunNotification } from './notify.js';
import { analyzeWithPerfInsight, perfInsightSettings } from './perf-insight.js';
import { createServiceVirtualizerHooks } from './service-virtualizer.js';
import { copyPlugins, sharedPaths, snapshotSharedBundle } from './shared-drive.js';
import { evaluateSlo } from './slo.js';
import { summarizeJtlStreams } from './summary.js';

export const RUN_COLUMNS = `run_id, scenario_id, scenario_name, script_name, script_sha256, script_version, status,
  users, duration_seconds, rampup_seconds, generators, execution, script_source, plugins, aborted_by,
  started_at, ended_at, exit_code, error, summary, slo, slo_result, insight`;

// results.jtl (single container, older runs) or results-<n>.jtl (one per load generator).
const JTL_FILE = /^results(?:-\d+)?\.jtl$/;

// start(options) -> containerId; find(runId) -> containerId[]
export const defaultDocker = {
  start: startJMeterContainer,
  wait: waitForJMeterContainer,
  stop: stopJMeterContainer,
  remove: removeJMeterContainer,
  find: findJMeterContainers
};

async function summarizeResults(resultsDir) {
  const files = (await readdir(resultsDir)).filter((file) => JTL_FILE.test(file)).sort();
  if (!files.length) throw new Error('JMeter did not write any JTL results.');
  // Open each file only when it is read, so a failure part-way does not leak handles.
  function* streams() {
    for (const file of files) yield createReadStream(path.join(resultsDir, file));
  }
  return summarizeJtlStreams(streams());
}

export function createRunService({
  pool,
  config,
  docker = defaultDocker,
  agents = null,
  notify = sendRunNotification,
  insight = analyzeWithPerfInsight,
  insightSettings = perfInsightSettings(),
  virtualServices = createServiceVirtualizerHooks()
}) {
  const notifications = notificationSettings();

  async function findMatchingBaseline(run) {
    const result = await pool.query(
      `SELECT run_id, started_at, summary
       FROM test_runs
       WHERE scenario_id = $1 AND run_id <> $2 AND status = 'completed' AND summary IS NOT NULL
         AND started_at < $3 AND script_sha256 = $4
         AND users = $5 AND duration_seconds = $6 AND rampup_seconds = $7
       ORDER BY started_at DESC
       LIMIT 1`,
      [
        run.scenario_id,
        run.run_id,
        run.started_at,
        run.script_sha256,
        run.users,
        run.duration_seconds,
        run.rampup_seconds
      ]
    );
    return result.rows[0] || null;
  }

  // Records the result. Returns the finished run (with results_dir) for followUpRun, or null.
  async function finishRun(runId, exitCode, errorMessage = null) {
    const runResult = await pool.query('SELECT results_dir, slo FROM test_runs WHERE run_id = $1', [runId]);
    if (!runResult.rowCount) return null;

    let summary = null;
    let failure = errorMessage;
    try {
      summary = await summarizeResults(runResult.rows[0].results_dir);
    } catch (error) {
      failure = failure || `Could not read JTL results: ${error.message}`;
    }

    let sloResult = null;
    const sloTargets = runResult.rows[0].slo;
    if (summary && sloTargets) {
      try {
        sloResult = evaluateSlo(summary, sloTargets);
      } catch (error) {
        console.error(`Could not evaluate SLO for ${runId}: ${error.message}`);
      }
    }

    const newStatus = exitCode === 0 && !failure ? 'completed' : 'failed';
    // Completed runs are queued for the perf-insight regression check (if configured), so the
    // CI gate knows to wait for the verdict.
    const pendingInsight = insightSettings.enabled && newStatus === 'completed' ? { status: 'pending' } : null;
    const updated = await pool.query(
      `UPDATE test_runs
       SET status = CASE WHEN status = 'aborted' THEN status ELSE $2 END,
           ended_at = COALESCE(ended_at, now()), exit_code = $3,
           error = COALESCE(error, $4), summary = $5, slo_result = $6,
           insight = CASE WHEN status = 'aborted' THEN insight ELSE $7 END
       WHERE run_id = $1 AND status IN ('starting', 'running', 'aborted')
       RETURNING ${RUN_COLUMNS}, results_dir`,
      [runId, newStatus, exitCode, failure, summary, sloResult, pendingInsight]
    );
    return updated.rowCount ? updated.rows[0] : null;
  }

  // After a run is recorded: end the run in service-virtualizer (when configured), then the
  // perf-insight regression check (when queued), then the notification, so the message can
  // include the verdict. None of these can change the run's own status.
  async function followUpRun(finished) {
    if (!finished) return;
    const { results_dir: resultsDir, ...run } = finished;
    // First, so virtual services return to baseline promptly (perf-insight can take minutes).
    await virtualServices.runEnded(run.run_id);
    if (run.insight?.status === 'pending') {
      let result;
      try {
        result = await insight(run, { resultsDir, settings: insightSettings });
      } catch (error) {
        result = { status: 'error', error: `perf-insight: ${error.message}` };
      }
      run.insight = result || { status: 'error', error: 'perf-insight returned no result.' };
      await pool
        .query('UPDATE test_runs SET insight = $2 WHERE run_id = $1', [run.run_id, run.insight])
        .catch((error) => console.error(`Could not save perf-insight result for ${run.run_id}: ${error.message}`));
      if (run.insight.status === 'error')
        console.error(`perf-insight check failed for ${run.run_id}: ${run.insight.error}`);
    }
    await notify(run, { settings: notifications }).catch((error) => {
      console.error(`Run notification failed for ${run.run_id}: ${error.message}`);
    });
  }

  // Re-runs the perf-insight check for a finished run (API: POST /api/runs/:id/insight).
  async function reanalyzeRun(runId) {
    if (!insightSettings.enabled) throw httpError(409, 'perf-insight is not configured (set PERF_INSIGHT_URL).');
    const result = await pool.query(`SELECT ${RUN_COLUMNS}, results_dir FROM test_runs WHERE run_id = $1`, [runId]);
    if (!result.rowCount) throw httpError(404, 'Run not found.');
    const { results_dir: resultsDir, ...run } = result.rows[0];
    if (run.status !== 'completed') throw httpError(409, 'Only completed runs can be checked by perf-insight.');
    const outcome = (await insight(run, { resultsDir, settings: insightSettings })) || {
      status: 'error',
      error: 'perf-insight returned no result.'
    };
    await pool.query('UPDATE test_runs SET insight = $2 WHERE run_id = $1', [runId, outcome]);
    return outcome;
  }

  function executorFor(execution) {
    if (execution !== 'agents') return docker;
    if (!agents) throw new Error('Remote load generators are not configured on this controller.');
    return agents.executor;
  }

  // Waits for every container / remote generator of a run. If one fails, the others are stopped
  // so a broken run does not keep generating partial load.
  async function monitorRun(runId, handles, executor) {
    let exitCode = 0;
    let errorMessage = null;
    const several = handles.length > 1;
    await Promise.all(
      handles.map(async (handle) => {
        let code;
        try {
          code = await executor.wait(handle);
        } catch (error) {
          code = 1;
          errorMessage ??= error.userMessage || `Could not monitor JMeter container: ${error.message}`;
        }
        if (code !== 0 && exitCode === 0) {
          exitCode = code;
          errorMessage ??= several
            ? `A load generator exited with code ${code}; the other generators were stopped.`
            : `JMeter container exited with code ${code}.`;
          await Promise.all(
            handles.filter((other) => other !== handle).map((other) => executor.stop(other).catch(() => {}))
          );
        }
      })
    );
    let finished = null;
    try {
      finished = await finishRun(runId, exitCode, errorMessage);
    } finally {
      await pool.query("UPDATE test_runs SET container_ids = '{}' WHERE run_id = $1", [runId]);
      for (const handle of handles) {
        await executor.remove(handle).catch((error) => {
          console.error(`Could not remove completed container ${handle}: ${error.message}`);
        });
      }
    }
    await followUpRun(finished);
  }

  function watchSlo(run, startedAt) {
    return startLiveSloWatcher({
      runId: run.run_id,
      resultsDir: run.results_dir,
      slo: run.slo,
      startedAt,
      config,
      onBreach: (reason) =>
        abortRun(run.run_id, { by: 'slo', reason }).catch((error) => {
          console.error(`Live SLO abort failed for ${run.run_id}: ${error.message}`);
        })
    });
  }

  // Copies the script (and its data files and plugins) into results/<run-id>/bundle.
  async function snapshotBundle(scenario, resultsDir) {
    const bundleDir = path.join(resultsDir, 'bundle');
    await mkdir(bundleDir, { recursive: true });
    if (scenario.script_source === 'shared') {
      return snapshotSharedBundle(
        config,
        { sharedScript: scenario.shared_script, plugins: scenario.plugins },
        bundleDir
      );
    }
    const jmxPath = path.join(bundleDir, 'script.jmx');
    await writeFile(jmxPath, await readFile(scenario.script_path));
    const pluginDir = await copyPlugins(sharedPaths(config).plugins, scenario.plugins || [], bundleDir);
    return { jmxPath, pluginDir };
  }

  async function launch(run, scenario, bundle, generators) {
    const executor = executorFor(run.execution);
    const handles = [];
    let watcher = null;
    try {
      const preparedJmx = await prepareJMX(bundle.jmxPath, run.run_id, scenario.name, run.results_dir);
      const bundleDir = path.join(run.results_dir, 'bundle');
      await pool.query('UPDATE test_runs SET bundle_jmx = $2 WHERE run_id = $1', [
        run.run_id,
        path.relative(bundleDir, preparedJmx).split(path.sep).join('/')
      ]);
      const shares = splitUsers(run.users, run.generators);
      // Before any load: tag virtual-service metrics with this run and apply the scenario's
      // timeline, so its first profile is in place for the first request. Never blocks the run.
      await virtualServices.runStarted(run.run_id, scenario.name);

      if (run.execution === 'agents') {
        handles.push(...(await agents.createAssignments(run, generators, shares)));
      } else {
        for (const [index, threads] of shares.entries()) {
          handles.push(
            await docker.start({
              runId: run.run_id,
              jmxPath: preparedJmx,
              influxdbUrl: config.influxdbUrl,
              testName: scenario.name,
              threads,
              duration: run.duration_seconds,
              rampup: run.rampup_seconds,
              resultsDir: run.results_dir,
              generator: index + 1,
              pluginDir: bundle.pluginDir
            })
          );
        }
      }
      const started = await pool.query(
        `UPDATE test_runs SET status = 'running', container_ids = $2, started_at = now()
         WHERE run_id = $1 AND status = 'starting' RETURNING run_id`,
        [run.run_id, handles]
      );
      if (!started.rowCount) {
        // Aborted while starting.
        await Promise.all(handles.map((handle) => executor.stop(handle).catch(() => {})));
      } else {
        watcher = watchSlo(run, Date.now());
      }
      await monitorRun(run.run_id, handles, executor);
    } catch (error) {
      // Something failed to start: clean up what did.
      for (const handle of handles) {
        await executor.stop(handle).catch(() => {});
        await executor.remove(handle).catch(() => {});
      }
      await followUpRun(await finishRun(run.run_id, 1, error.message));
    } finally {
      watcher?.stop();
    }
  }

  // Validates and records a new run, then starts JMeter in the background.
  // Returns the new run row plus `done`, a promise that settles when the run has finished.
  async function startRun(scenarioId) {
    const activeRuns = await pool.query("SELECT run_id FROM test_runs WHERE status IN ('starting', 'running') LIMIT 1");
    if (activeRuns.rowCount) throw httpError(409, `Run ${activeRuns.rows[0].run_id} is already active.`);

    const scenarioResult = await pool.query('SELECT * FROM scenarios WHERE id = $1', [scenarioId]);
    if (!scenarioResult.rowCount) throw httpError(404, 'Scenario not found.');
    const scenario = scenarioResult.rows[0];
    const shared = scenario.script_source === 'shared';
    if (shared ? !scenario.shared_script : !scenario.script_path) {
      throw httpError(400, 'Upload a JMX script or choose one from the shared drive before executing this scenario.');
    }

    const remoteIds = scenario.load_generator_ids || [];
    const execution = remoteIds.length ? 'agents' : 'local';
    let selectedGenerators = [];
    let generatorCount = scenario.generators ?? 1;
    if (execution === 'agents') {
      if (!agents || !config.agentToken) {
        throw httpError(
          409,
          'This scenario uses remote load generators, but PERF_AGENT_TOKEN is not set on the controller.'
        );
      }
      selectedGenerators = await agents.checkAvailable(remoteIds);
      generatorCount = selectedGenerators.length;
    } else if (generatorCount > config.maxGenerators) {
      throw httpError(
        400,
        `This scenario uses ${generatorCount} load generators; the limit is ${config.maxGenerators}.`
      );
    }
    let shares;
    try {
      shares = splitUsers(scenario.users, generatorCount);
    } catch (error) {
      throw httpError(400, error.message);
    }
    selectedGenerators.forEach((generator, index) => {
      if (generator.max_threads && shares[index] > generator.max_threads) {
        throw httpError(
          400,
          `"${generator.name}" would get ${shares[index]} users but accepts at most ${generator.max_threads}. ` +
            'Select more load generators or reduce the users.'
        );
      }
    });

    const runId = generateRunId();
    const resultsDir = path.join(config.resultsRoot, runId);
    await mkdir(resultsDir, { recursive: true });
    let bundle;
    try {
      bundle = await snapshotBundle(scenario, resultsDir);
    } catch (error) {
      await rm(resultsDir, { recursive: true, force: true }).catch(() => {});
      throw error.statusCode ? error : httpError(400, `Could not prepare the test bundle: ${error.message}`);
    }
    const scriptHash = createHash('sha256')
      .update(await readFile(bundle.jmxPath))
      .digest('hex');

    let inserted;
    try {
      inserted = await pool.query(
        `INSERT INTO test_runs
         (run_id, scenario_id, scenario_name, script_name, script_sha256, script_version, status,
          users, duration_seconds, rampup_seconds, results_dir, slo, generators, execution, script_source, plugins)
         VALUES ($1, $2, $3, $4, $5, $6, 'starting', $7, $8, $9, $10, $11, $12, $13, $14, $15)
         RETURNING ${RUN_COLUMNS}, results_dir`,
        [
          runId,
          scenario.id,
          scenario.name,
          shared ? scenario.shared_script : scenario.original_filename || scenario.script_name,
          scriptHash,
          shared ? null : scenario.script_version,
          scenario.users,
          scenario.duration_seconds,
          scenario.rampup_seconds,
          resultsDir,
          scenario.slo,
          generatorCount,
          execution,
          scenario.script_source,
          scenario.plugins || []
        ]
      );
    } catch (error) {
      if (error.code === '23505') throw httpError(409, 'Another test run started at the same time.');
      throw error;
    }

    const { results_dir: _resultsDir, ...run } = inserted.rows[0];
    const done = launch(inserted.rows[0], scenario, bundle, selectedGenerators).catch((error) => {
      console.error(`Run ${runId} failed unexpectedly: ${error.message}`);
    });
    return { run, done };
  }

  async function abortRun(runId, { by = 'user', reason = 'Run aborted by user.' } = {}) {
    const existing = await pool.query('SELECT status, container_ids, execution FROM test_runs WHERE run_id = $1', [
      runId
    ]);
    if (!existing.rowCount) throw httpError(404, 'Run not found.');
    if (!['starting', 'running'].includes(existing.rows[0].status)) {
      throw httpError(409, 'Only an active run can be aborted.');
    }
    const executor = executorFor(existing.rows[0].execution);

    const knownIds = existing.rows[0].container_ids;
    const discoveredIds = knownIds.length ? knownIds : await executor.find(runId);
    const aborted = await pool.query(
      `UPDATE test_runs
       SET status = 'aborted', ended_at = now(), error = $2, aborted_by = $3
       WHERE run_id = $1 AND status IN ('starting', 'running')
       RETURNING status, container_ids`,
      [runId, reason, by]
    );
    if (!aborted.rowCount) throw httpError(409, 'The run is no longer active.');

    const handles = aborted.rows[0].container_ids.length ? aborted.rows[0].container_ids : discoveredIds;
    await Promise.all(handles.map((handle) => executor.stop(handle)));
    return { runId, status: 'aborted', abortedBy: by };
  }

  async function recoverActiveRuns() {
    const activeRuns = await pool.query(
      `SELECT ${RUN_COLUMNS}, results_dir FROM test_runs WHERE status IN ('starting', 'running') ORDER BY started_at`
    );
    for (const run of activeRuns.rows) {
      try {
        const executor = executorFor(run.execution);
        const handles = await executor.find(run.run_id);
        if (!handles.length) {
          await followUpRun(
            await finishRun(run.run_id, 1, 'No matching JMeter container was found during application recovery.')
          );
          continue;
        }
        await pool.query("UPDATE test_runs SET status = 'running', container_ids = $2 WHERE run_id = $1", [
          run.run_id,
          handles
        ]);
        const watcher = watchSlo(run, new Date(run.started_at).getTime());
        monitorRun(run.run_id, handles, executor)
          .catch((error) => {
            console.error(`Run recovery failed for ${run.run_id}: ${error.message}`);
          })
          .finally(() => watcher.stop());
      } catch (error) {
        console.error(`Could not recover run ${run.run_id}: ${error.message}`);
      }
    }
  }

  return { startRun, abortRun, finishRun, followUpRun, reanalyzeRun, recoverActiveRuns, findMatchingBaseline };
}
