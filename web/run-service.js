// Test-run lifecycle: start JMeter, watch it, record the result, abort, and recover after a restart.
// Docker access is injected (see defaultDocker) so the API tests can run without Docker.

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
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
import { notificationSettings, sendRunNotification } from './notify.js';
import { evaluateSlo } from './slo.js';
import { summarizeJtlStreams } from './summary.js';

export const RUN_COLUMNS = `run_id, scenario_id, scenario_name, script_name, script_sha256, script_version, status,
  users, duration_seconds, rampup_seconds, generators, started_at, ended_at, exit_code, error, summary, slo, slo_result`;

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

  // Waits for every container of a run. If one load generator fails, the others are stopped
  // so a broken run does not keep generating partial load.
  async function monitorRunContainers(runId, containerIds) {
    let exitCode = 0;
    let errorMessage = null;
    const several = containerIds.length > 1;
    await Promise.all(
      containerIds.map(async (containerId) => {
        let code;
        try {
          code = await docker.wait(containerId);
        } catch (error) {
          code = 1;
          errorMessage ??= `Could not monitor JMeter container: ${error.message}`;
        }
        if (code !== 0 && exitCode === 0) {
          exitCode = code;
          errorMessage ??= several
            ? `A load generator exited with code ${code}; the other generators were stopped.`
            : `JMeter container exited with code ${code}.`;
          await Promise.all(
            containerIds.filter((other) => other !== containerId).map((other) => docker.stop(other).catch(() => {}))
          );
        }
      })
    );
    try {
      await finishRun(runId, exitCode, errorMessage);
    } finally {
      await pool.query("UPDATE test_runs SET container_ids = '{}' WHERE run_id = $1", [runId]);
      for (const containerId of containerIds) {
        await docker.remove(containerId).catch((error) => {
          console.error(`Could not remove completed container ${containerId}: ${error.message}`);
        });
      }
    }
  }

  async function launch(run, scenario, scriptSnapshotPath) {
    const containerIds = [];
    try {
      const preparedJmx = await prepareJMX(scriptSnapshotPath, run.run_id, scenario.name, run.results_dir);
      const shares = splitUsers(run.users, run.generators);
      for (const [index, threads] of shares.entries()) {
        containerIds.push(
          await docker.start({
            runId: run.run_id,
            jmxPath: preparedJmx,
            influxdbUrl: config.influxdbUrl,
            testName: scenario.name,
            threads,
            duration: run.duration_seconds,
            rampup: run.rampup_seconds,
            resultsDir: run.results_dir,
            generator: index + 1
          })
        );
      }
      const started = await pool.query(
        `UPDATE test_runs SET status = 'running', container_ids = $2, started_at = now()
         WHERE run_id = $1 AND status = 'starting' RETURNING run_id`,
        [run.run_id, containerIds]
      );
      if (!started.rowCount) {
        // Aborted while the containers were starting.
        await Promise.all(containerIds.map((id) => docker.stop(id).catch(() => {})));
      }
      await monitorRunContainers(run.run_id, containerIds);
    } catch (error) {
      // A generator failed to start: clean up the ones that did.
      for (const id of containerIds) {
        await docker.stop(id).catch(() => {});
        await docker.remove(id).catch(() => {});
      }
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
    const generators = scenario.generators ?? 1;
    if (generators > config.maxGenerators) {
      throw httpError(400, `This scenario uses ${generators} load generators; the limit is ${config.maxGenerators}.`);
    }
    try {
      splitUsers(scenario.users, generators);
    } catch (error) {
      throw httpError(400, error.message);
    }

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
          users, duration_seconds, rampup_seconds, results_dir, slo, generators)
         VALUES ($1, $2, $3, $4, $5, $6, 'starting', $7, $8, $9, $10, $11, $12)
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
          scenario.slo,
          generators
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
    const existing = await pool.query('SELECT status, container_ids FROM test_runs WHERE run_id = $1', [runId]);
    if (!existing.rowCount) throw httpError(404, 'Run not found.');
    if (!['starting', 'running'].includes(existing.rows[0].status)) {
      throw httpError(409, 'Only an active run can be aborted.');
    }

    const knownIds = existing.rows[0].container_ids;
    const discoveredIds = knownIds.length ? knownIds : await docker.find(runId);
    const aborted = await pool.query(
      `UPDATE test_runs
       SET status = 'aborted', ended_at = now(), error = 'Run aborted by user.'
       WHERE run_id = $1 AND status IN ('starting', 'running')
       RETURNING status, container_ids`,
      [runId]
    );
    if (!aborted.rowCount) throw httpError(409, 'The run is no longer active.');

    const containerIds = aborted.rows[0].container_ids.length ? aborted.rows[0].container_ids : discoveredIds;
    await Promise.all(containerIds.map((id) => docker.stop(id)));
    return { runId, status: 'aborted' };
  }

  async function recoverActiveRuns() {
    const activeRuns = await pool.query(
      "SELECT run_id FROM test_runs WHERE status IN ('starting', 'running') ORDER BY started_at"
    );
    for (const run of activeRuns.rows) {
      try {
        const containerIds = await docker.find(run.run_id);
        if (!containerIds.length) {
          await finishRun(run.run_id, 1, 'No matching JMeter container was found during application recovery.');
          continue;
        }
        await pool.query("UPDATE test_runs SET status = 'running', container_ids = $2 WHERE run_id = $1", [
          run.run_id,
          containerIds
        ]);
        monitorRunContainers(run.run_id, containerIds).catch((error) => {
          console.error(`Run recovery failed for ${run.run_id}: ${error.message}`);
        });
      } catch (error) {
        console.error(`Could not recover run ${run.run_id}: ${error.message}`);
      }
    }
  }

  return { startRun, abortRun, finishRun, recoverActiveRuns, findMatchingBaseline };
}
