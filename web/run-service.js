// Test-run lifecycle: start JMeter, watch it, record the result, abort, and recover after a restart.
// Docker access is injected (see defaultDocker) so the API tests can run without Docker.

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  findJMeterContainer,
  removeJMeterContainer,
  startJMeterInDocker,
  stopJMeterContainer,
  waitForJMeterContainer
} from '../cli/docker.js';
import { prepareJMX } from '../cli/jmx.js';
import { generateRunId } from '../cli/run-id.js';
import { httpError } from './http.js';
import { notificationSettings, sendRunNotification } from './notify.js';
import { evaluateSlo } from './slo.js';
import { summarizeJtlStream } from './summary.js';

export const RUN_COLUMNS = `run_id, scenario_id, scenario_name, script_name, script_sha256, script_version, status,
  users, duration_seconds, rampup_seconds, started_at, ended_at, exit_code, error, summary, slo, slo_result`;

export const defaultDocker = {
  start: ({ runId, jmxPath, influxdbUrl, testName, users, duration, rampup, resultsDir }) =>
    startJMeterInDocker(runId, jmxPath, influxdbUrl, testName, users, duration, rampup, resultsDir),
  wait: waitForJMeterContainer,
  stop: stopJMeterContainer,
  remove: removeJMeterContainer,
  find: findJMeterContainer
};

export function createRunService({ pool, config, docker = defaultDocker, notify = sendRunNotification }) {
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

  async function finishRun(runId, exitCode, errorMessage = null) {
    const runResult = await pool.query('SELECT results_dir, slo FROM test_runs WHERE run_id = $1', [runId]);
    if (!runResult.rowCount) return;

    let summary = null;
    let failure = errorMessage;
    try {
      summary = await summarizeJtlStream(createReadStream(path.join(runResult.rows[0].results_dir, 'results.jtl')));
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

    const updated = await pool.query(
      `UPDATE test_runs
       SET status = CASE WHEN status = 'aborted' THEN status ELSE $2 END,
           ended_at = COALESCE(ended_at, now()), exit_code = $3,
           error = COALESCE(error, $4), summary = $5, slo_result = $6
       WHERE run_id = $1 AND status IN ('starting', 'running', 'aborted')
       RETURNING run_id, scenario_name, status, users, duration_seconds, started_at, ended_at, error,
                 summary, slo, slo_result`,
      [runId, exitCode === 0 && !failure ? 'completed' : 'failed', exitCode, failure, summary, sloResult]
    );
    if (updated.rowCount) {
      notify(updated.rows[0], { settings: notifications }).catch((error) => {
        console.error(`Run notification failed for ${runId}: ${error.message}`);
      });
    }
  }

  async function monitorRunContainer(runId, containerId) {
    let exitCode;
    let errorMessage = null;
    try {
      exitCode = await docker.wait(containerId);
      if (exitCode !== 0) errorMessage = `JMeter container exited with code ${exitCode}.`;
    } catch (error) {
      exitCode = 1;
      errorMessage = `Could not monitor JMeter container: ${error.message}`;
    }
    try {
      await finishRun(runId, exitCode, errorMessage);
    } finally {
      await pool.query('UPDATE test_runs SET container_id = NULL WHERE run_id = $1', [runId]);
      await docker.remove(containerId).catch((error) => {
        console.error(`Could not remove completed container ${containerId}: ${error.message}`);
      });
    }
  }

  async function launch(run, scenario, scriptSnapshotPath) {
    try {
      const preparedJmx = await prepareJMX(scriptSnapshotPath, run.run_id, scenario.name, run.results_dir);
      const containerId = await docker.start({
        runId: run.run_id,
        jmxPath: preparedJmx,
        influxdbUrl: config.influxdbUrl,
        testName: scenario.name,
        users: scenario.users,
        duration: scenario.duration_seconds,
        rampup: scenario.rampup_seconds,
        resultsDir: run.results_dir
      });
      const started = await pool.query(
        `UPDATE test_runs SET status = 'running', container_id = $2, started_at = now()
         WHERE run_id = $1 AND status = 'starting' RETURNING run_id`,
        [run.run_id, containerId]
      );
      if (!started.rowCount) {
        // Aborted while the container was starting.
        await docker.stop(containerId);
      }
      await monitorRunContainer(run.run_id, containerId);
    } catch (error) {
      await finishRun(run.run_id, 1, error.message);
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
    if (!scenario.script_path) throw httpError(400, 'Upload a JMX script before executing this scenario.');

    const runId = generateRunId();
    const resultsDir = path.join(config.resultsRoot, runId);
    await mkdir(resultsDir, { recursive: true });
    const scriptSnapshot = await readFile(scenario.script_path);
    const scriptHash = createHash('sha256').update(scriptSnapshot).digest('hex');
    const scriptSnapshotPath = path.join(resultsDir, 'script.jmx');
    await writeFile(scriptSnapshotPath, scriptSnapshot);

    let inserted;
    try {
      inserted = await pool.query(
        `INSERT INTO test_runs
         (run_id, scenario_id, scenario_name, script_name, script_sha256, script_version, status,
          users, duration_seconds, rampup_seconds, results_dir, slo)
         VALUES ($1, $2, $3, $4, $5, $6, 'starting', $7, $8, $9, $10, $11)
         RETURNING ${RUN_COLUMNS}, results_dir`,
        [
          runId,
          scenario.id,
          scenario.name,
          scenario.original_filename || scenario.script_name,
          scriptHash,
          scenario.script_version,
          scenario.users,
          scenario.duration_seconds,
          scenario.rampup_seconds,
          resultsDir,
          scenario.slo
        ]
      );
    } catch (error) {
      if (error.code === '23505') throw httpError(409, 'Another test run started at the same time.');
      throw error;
    }

    const { results_dir: _resultsDir, ...run } = inserted.rows[0];
    const done = launch(inserted.rows[0], scenario, scriptSnapshotPath).catch((error) => {
      console.error(`Run ${runId} failed unexpectedly: ${error.message}`);
    });
    return { run, done };
  }

  async function abortRun(runId) {
    const existing = await pool.query('SELECT status, container_id FROM test_runs WHERE run_id = $1', [runId]);
    if (!existing.rowCount) throw httpError(404, 'Run not found.');
    if (!['starting', 'running'].includes(existing.rows[0].status)) {
      throw httpError(409, 'Only an active run can be aborted.');
    }

    const discoveredContainerId = existing.rows[0].container_id || (await docker.find(runId));
    const aborted = await pool.query(
      `UPDATE test_runs
       SET status = 'aborted', ended_at = now(), error = 'Run aborted by user.'
       WHERE run_id = $1 AND status IN ('starting', 'running')
       RETURNING status, container_id`,
      [runId]
    );
    if (!aborted.rowCount) throw httpError(409, 'The run is no longer active.');

    const containerId = aborted.rows[0].container_id || discoveredContainerId;
    if (containerId) await docker.stop(containerId);
    return { runId, status: 'aborted' };
  }

  async function recoverActiveRuns() {
    const activeRuns = await pool.query(
      "SELECT run_id FROM test_runs WHERE status IN ('starting', 'running') ORDER BY started_at"
    );
    for (const run of activeRuns.rows) {
      try {
        const containerId = await docker.find(run.run_id);
        if (!containerId) {
          await finishRun(run.run_id, 1, 'No matching JMeter container was found during application recovery.');
          continue;
        }
        await pool.query("UPDATE test_runs SET status = 'running', container_id = $2 WHERE run_id = $1", [
          run.run_id,
          containerId
        ]);
        monitorRunContainer(run.run_id, containerId).catch((error) => {
          console.error(`Run recovery failed for ${run.run_id}: ${error.message}`);
        });
      } catch (error) {
        console.error(`Could not recover run ${run.run_id}: ${error.message}`);
      }
    }
  }

  return { startRun, abortRun, finishRun, recoverActiveRuns, findMatchingBaseline };
}
