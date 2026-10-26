import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import multer from 'multer';
import { Pool } from 'pg';
import { parseStringPromise } from 'xml2js';
import { generateRunId } from '../cli/run-id.js';
import {
  findJMeterContainer,
  startJMeterInDocker,
  stopJMeterContainer,
  waitForJMeterContainer
} from '../cli/docker.js';
import { prepareJMX } from '../cli/jmx.js';
import { summarizeJtlStream } from './summary.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(projectRoot, 'web', 'public');
const uploadRoot = path.join(projectRoot, 'data', 'scripts');
const resultsRoot = path.join(projectRoot, 'results');
const port = Number(process.env.WEB_PORT || 4000);
const influxdbUrl = process.env.INFLUXDB_URL || 'http://influxdb:8086/write?db=jmeter';
const databasePassword = process.env.POSTGRES_PASSWORD || 'local-dev-only';
const databaseUrl = process.env.DATABASE_URL
  || `postgres://perf_framework:${encodeURIComponent(databasePassword)}@localhost:5433/perf_framework`;
const pool = new Pool({ connectionString: databaseUrl });
const app = express();

await mkdir(uploadRoot, { recursive: true });
await mkdir(resultsRoot, { recursive: true });

await pool.query(`
  CREATE TABLE IF NOT EXISTS scenarios (
    id UUID PRIMARY KEY,
    name TEXT NOT NULL,
    script_name TEXT NOT NULL,
    script_path TEXT,
    original_filename TEXT,
    script_version INTEGER NOT NULL DEFAULT 0,
    users INTEGER NOT NULL CHECK (users > 0),
    duration_seconds INTEGER NOT NULL CHECK (duration_seconds > 0),
    rampup_seconds INTEGER NOT NULL CHECK (rampup_seconds >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS test_runs (
    run_id TEXT PRIMARY KEY,
    scenario_id UUID NOT NULL REFERENCES scenarios(id),
    scenario_name TEXT NOT NULL,
    script_name TEXT,
    script_sha256 TEXT,
    script_version INTEGER,
    status TEXT NOT NULL CHECK (status IN ('starting', 'running', 'completed', 'failed', 'aborted')),
    users INTEGER NOT NULL,
    duration_seconds INTEGER NOT NULL,
    rampup_seconds INTEGER NOT NULL,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at TIMESTAMPTZ,
    exit_code INTEGER,
    error TEXT,
    summary JSONB,
    container_id TEXT,
    results_dir TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS scenario_script_versions (
    scenario_id UUID NOT NULL REFERENCES scenarios(id),
    version INTEGER NOT NULL CHECK (version > 0),
    original_filename TEXT NOT NULL,
    script_path TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (scenario_id, version)
  );

  CREATE INDEX IF NOT EXISTS test_runs_scenario_started_idx
    ON test_runs (scenario_id, started_at DESC);

  CREATE UNIQUE INDEX IF NOT EXISTS one_active_test_run_idx
    ON test_runs ((1)) WHERE status IN ('starting', 'running');

  ALTER TABLE test_runs ADD COLUMN IF NOT EXISTS script_name TEXT;
  ALTER TABLE test_runs ADD COLUMN IF NOT EXISTS script_sha256 TEXT;
  ALTER TABLE test_runs ADD COLUMN IF NOT EXISTS script_version INTEGER;
  ALTER TABLE test_runs ADD COLUMN IF NOT EXISTS container_id TEXT;
  ALTER TABLE scenarios ADD COLUMN IF NOT EXISTS script_version INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE test_runs DROP CONSTRAINT IF EXISTS test_runs_status_check;
  ALTER TABLE test_runs ADD CONSTRAINT test_runs_status_check
    CHECK (status IN ('starting', 'running', 'completed', 'failed', 'aborted'));
`);

app.use((request, response, next) => {
  const allowedHosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`]);
  if (!allowedHosts.has(request.headers.host)) {
    return response.status(403).json({ error: 'This local service only accepts localhost requests.' });
  }
  const origin = request.headers.origin;
  if (origin) {
    try {
      const originUrl = new URL(origin);
      if (originUrl.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(originUrl.hostname)
        || Number(originUrl.port || 80) !== port) {
        return response.status(403).json({ error: 'Cross-origin requests are not allowed.' });
      }
    } catch {
      return response.status(403).json({ error: 'Invalid request origin.' });
    }
  }
  next();
});
app.use(express.json({ limit: '1mb' }));
app.use(express.static(publicDir));

const asyncHandler = (handler) => (request, response, next) => {
  Promise.resolve(handler(request, response, next)).catch(next);
};

app.param('id', (request, response, next, id) => {
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id)) {
    return response.status(400).json({ error: 'Invalid scenario ID.' });
  }
  next();
});

const storage = multer.diskStorage({
  destination: (request, file, callback) => {
    callback(null, path.join(uploadRoot, request.params.id));
  },
  filename: (request, file, callback) => {
    const safeName = path.basename(file.originalname).replace(/[^a-zA-Z0-9._-]/g, '_');
    callback(null, `${Date.now()}-${safeName}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (request, file, callback) => {
    if (path.extname(file.originalname).toLowerCase() !== '.jmx') {
      callback(new Error('Upload a JMeter .jmx script file.'));
      return;
    }
    callback(null, true);
  }
});

app.get('/api/health', asyncHandler(async (request, response) => {
  await pool.query('SELECT 1');
  response.json({ status: 'ok' });
}));

function toScenarioInput(body) {
  const invalid = (message) => Object.assign(new Error(message), { statusCode: 400 });
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const scriptName = typeof body.scriptName === 'string' ? body.scriptName.trim() : '';
  const users = Number(body.users);
  const duration = Number(body.duration);
  const rampup = Number(body.rampup);

  if (!name || name.length > 120) throw invalid('Scenario name is required (maximum 120 characters).');
  if (!scriptName || scriptName.length > 255) throw invalid('Script name is required (maximum 255 characters).');
  if (!Number.isSafeInteger(users) || users < 1 || users > 100000) {
    throw invalid('Users must be a whole number between 1 and 100000.');
  }
  if (!Number.isSafeInteger(duration) || duration < 1 || duration > 86400) {
    throw invalid('Duration must be a whole number between 1 and 86400 seconds.');
  }
  if (!Number.isSafeInteger(rampup) || rampup < 0 || rampup > duration) {
    throw invalid('Ramp-up must be a whole number between 0 and the test duration.');
  }
  return { name, scriptName, users, duration, rampup };
}

function respondError(response, error, status = error.statusCode || 500) {
  response.status(status).json({ error: error.message || String(error) });
}

function grafanaUrl(run) {
  const dashboardBaseUrl = process.env.GRAFANA_BASE_URL || 'http://localhost:3000';
  const params = new URLSearchParams({
    orgId: '1',
    'var-application': run.scenario_name,
    'var-runId': run.run_id,
    from: String(new Date(run.started_at).getTime()),
    to: 'now',
    refresh: '5s',
    kiosk: 'tv'
  });
  return `${dashboardBaseUrl.replace(/\/$/, '')}/d/jmeter-performance/jmeter-performance-test?${params.toString()}`;
}

async function monitorRunContainer(runId, containerId) {
  let exitCode;
  let errorMessage = null;
  try {
    exitCode = await waitForJMeterContainer(containerId);
    if (exitCode !== 0) errorMessage = `JMeter container exited with code ${exitCode}.`;
  } catch (error) {
    exitCode = 1;
    errorMessage = `Could not monitor JMeter container: ${error.message}`;
  }
  try {
    await finishRun(runId, exitCode, errorMessage);
  } finally {
    await pool.query('UPDATE test_runs SET container_id = NULL WHERE run_id = $1', [runId]);
    const { spawnSync } = await import('node:child_process');
    const removed = spawnSync('docker', ['rm', '--force', containerId], { encoding: 'utf8' });
    if (removed.error) console.error(`Could not remove completed container ${containerId}: ${removed.error.message}`);
    else if (removed.status !== 0 && !removed.stderr.includes('No such container')) {
      console.error(`Could not remove completed container ${containerId}: ${removed.stderr.trim()}`);
    }
  }
}

async function recoverActiveRuns() {
  const activeRuns = await pool.query(
    "SELECT run_id FROM test_runs WHERE status IN ('starting', 'running') ORDER BY started_at"
  );
  for (const run of activeRuns.rows) {
    try {
      const containerId = await findJMeterContainer(run.run_id);
      if (!containerId) {
        await finishRun(run.run_id, 1, 'No matching JMeter container was found during application recovery.');
        continue;
      }
      await pool.query(
        "UPDATE test_runs SET status = 'running', container_id = $2 WHERE run_id = $1",
        [run.run_id, containerId]
      );
      monitorRunContainer(run.run_id, containerId).catch((error) => {
        console.error(`Run recovery failed for ${run.run_id}: ${error.message}`);
      });
    } catch (error) {
      console.error(`Could not recover run ${run.run_id}: ${error.message}`);
    }
  }
}

async function finishRun(runId, exitCode, errorMessage = null) {
  const runResult = await pool.query(
    'SELECT results_dir FROM test_runs WHERE run_id = $1',
    [runId]
  );
  if (!runResult.rowCount) return;

  let summary = null;
  let failure = errorMessage;
  try {
    summary = await summarizeJtlStream(createReadStream(path.join(runResult.rows[0].results_dir, 'results.jtl')));
  } catch (error) {
    failure = failure || `Could not read JTL results: ${error.message}`;
  }

  await pool.query(
    `UPDATE test_runs
     SET status = CASE WHEN status = 'aborted' THEN status ELSE $2 END,
         ended_at = COALESCE(ended_at, now()), exit_code = $3,
         error = COALESCE(error, $4), summary = $5
     WHERE run_id = $1 AND status IN ('starting', 'running', 'aborted')`,
    [runId, exitCode === 0 && !failure ? 'completed' : 'failed', exitCode, failure, summary]
  );
}

app.get('/api/scenarios', asyncHandler(async (request, response) => {
  const result = await pool.query(
    `SELECT id, name, script_name, original_filename, script_version, users, duration_seconds, rampup_seconds,
            (script_path IS NOT NULL) AS has_script, created_at, updated_at
     FROM scenarios ORDER BY updated_at DESC`
  );
  response.json(result.rows);
}));

app.post('/api/scenarios', async (request, response) => {
  try {
    const scenario = toScenarioInput(request.body);
    const result = await pool.query(
      `INSERT INTO scenarios (id, name, script_name, users, duration_seconds, rampup_seconds)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, name, script_name, original_filename, script_version, users, duration_seconds, rampup_seconds,
                 (script_path IS NOT NULL) AS has_script, created_at, updated_at`,
      [randomUUID(), scenario.name, scenario.scriptName, scenario.users, scenario.duration, scenario.rampup]
    );
    response.status(201).json(result.rows[0]);
  } catch (error) {
    respondError(response, error);
  }
});

app.put('/api/scenarios/:id', async (request, response) => {
  try {
    const scenario = toScenarioInput(request.body);
    const result = await pool.query(
      `UPDATE scenarios
       SET name = $2, script_name = $3, users = $4, duration_seconds = $5,
           rampup_seconds = $6, updated_at = now()
       WHERE id = $1
       RETURNING id, name, script_name, original_filename, script_version, users, duration_seconds, rampup_seconds,
                 (script_path IS NOT NULL) AS has_script, created_at, updated_at`,
      [request.params.id, scenario.name, scenario.scriptName, scenario.users, scenario.duration, scenario.rampup]
    );
    if (!result.rowCount) return response.status(404).json({ error: 'Scenario not found.' });
    response.json(result.rows[0]);
  } catch (error) {
    respondError(response, error);
  }
});

app.post('/api/scenarios/:id/script', asyncHandler(async (request, response) => {
  await mkdir(path.join(uploadRoot, request.params.id), { recursive: true });
  upload.single('script')(request, response, async (uploadError) => {
    if (uploadError) return respondError(response, uploadError, 400);
    if (!request.file) return response.status(400).json({ error: 'Choose a .jmx script to upload.' });

    try {
      const scenarioResult = await pool.query('SELECT id FROM scenarios WHERE id = $1', [request.params.id]);
      if (!scenarioResult.rowCount) {
        await unlink(request.file.path);
        return response.status(404).json({ error: 'Scenario not found.' });
      }

      const xml = await readFile(request.file.path, 'utf8');
      try {
        const parsed = await parseStringPromise(xml);
        if (!parsed.jmeterTestPlan) throw new Error('The uploaded XML is not a JMeter test plan.');
      } catch (error) {
        await unlink(request.file.path).catch(() => {});
        return response.status(400).json({ error: `Invalid JMeter script: ${error.message}` });
      }

      const scriptHash = createHash('sha256').update(xml).digest('hex');
      const client = await pool.connect();
      let updated;
      try {
        await client.query('BEGIN');
        const lockedScenario = await client.query('SELECT id FROM scenarios WHERE id = $1 FOR UPDATE', [request.params.id]);
        if (!lockedScenario.rowCount) throw Object.assign(new Error('Scenario not found.'), { statusCode: 404 });
        const versionResult = await client.query(
          'SELECT COALESCE(MAX(version), 0) + 1 AS next_version FROM scenario_script_versions WHERE scenario_id = $1',
          [request.params.id]
        );
        const version = Number(versionResult.rows[0].next_version);
        await client.query(
          `INSERT INTO scenario_script_versions (scenario_id, version, original_filename, script_path, sha256)
           VALUES ($1, $2, $3, $4, $5)`,
          [request.params.id, version, request.file.originalname, request.file.path, scriptHash]
        );
        updated = await client.query(
          `UPDATE scenarios
           SET script_path = $2, original_filename = $3, script_version = $4, updated_at = now()
           WHERE id = $1
           RETURNING id, name, script_name, original_filename, script_version, users, duration_seconds, rampup_seconds,
                     (script_path IS NOT NULL) AS has_script, created_at, updated_at`,
          [request.params.id, request.file.path, request.file.originalname, version]
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
      response.json(updated.rows[0]);
    } catch (error) {
      await unlink(request.file.path).catch(() => {});
      respondError(response, error);
    }
  });
}));

app.get('/api/scenarios/:id/script', asyncHandler(async (request, response) => {
  const result = await pool.query('SELECT script_path FROM scenarios WHERE id = $1', [request.params.id]);
  if (!result.rowCount || !result.rows[0].script_path) {
    return response.status(404).json({ error: 'No script has been uploaded for this scenario.' });
  }
  response.type('text/plain').send(await readFile(result.rows[0].script_path, 'utf8'));
}));

app.post('/api/scenarios/:id/runs', asyncHandler(async (request, response) => {
  const activeRuns = await pool.query("SELECT run_id FROM test_runs WHERE status IN ('starting', 'running') LIMIT 1");
  if (activeRuns.rowCount) {
    return response.status(409).json({ error: `Run ${activeRuns.rows[0].run_id} is already active.` });
  }

  const scenarioResult = await pool.query('SELECT * FROM scenarios WHERE id = $1', [request.params.id]);
  if (!scenarioResult.rowCount) return response.status(404).json({ error: 'Scenario not found.' });
  const scenario = scenarioResult.rows[0];
  if (!scenario.script_path) return response.status(400).json({ error: 'Upload a JMX script before executing this scenario.' });

  const runId = generateRunId();
  const resultsDir = path.join(resultsRoot, runId);
  await mkdir(resultsDir, { recursive: true });
  const scriptSnapshot = await readFile(scenario.script_path);
  const scriptHash = createHash('sha256').update(scriptSnapshot).digest('hex');
  const scriptSnapshotPath = path.join(resultsDir, 'script.jmx');
  await writeFile(scriptSnapshotPath, scriptSnapshot);
  let runInsert;
  try {
    runInsert = await pool.query(
      `INSERT INTO test_runs
       (run_id, scenario_id, scenario_name, script_name, script_sha256, script_version, status,
        users, duration_seconds, rampup_seconds, results_dir)
       VALUES ($1, $2, $3, $4, $5, $6, 'starting', $7, $8, $9, $10)
       RETURNING run_id, scenario_id, scenario_name, script_name, script_sha256, script_version, status,
                 users, duration_seconds, rampup_seconds, started_at, ended_at, exit_code, error, summary`,
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
        resultsDir
      ]
    );
  } catch (error) {
    if (error.code === '23505') return response.status(409).json({ error: 'Another test run started at the same time.' });
    throw error;
  }

  response.status(202).json(runInsert.rows[0]);

  try {
    const preparedJmx = await prepareJMX(scriptSnapshotPath, runId, scenario.name, resultsDir);
    const containerId = await startJMeterInDocker(
      runId,
      preparedJmx,
      influxdbUrl,
      scenario.name,
      scenario.users,
      scenario.duration_seconds,
      scenario.rampup_seconds,
      resultsDir
    );
    const started = await pool.query(
      `UPDATE test_runs SET status = 'running', container_id = $2, started_at = now()
       WHERE run_id = $1 AND status = 'starting' RETURNING run_id`,
      [runId, containerId]
    );
    if (!started.rowCount) {
      await stopJMeterContainer(containerId);
      monitorRunContainer(runId, containerId).catch((error) => {
        console.error(`Aborted run cleanup failed for ${runId}: ${error.message}`);
      });
      return;
    }
    monitorRunContainer(runId, containerId).catch((error) => {
      console.error(`Run monitor failed for ${runId}: ${error.message}`);
    });
  } catch (error) {
    await finishRun(runId, 1, error.message);
  }
}));

app.post('/api/runs/:runId/abort', asyncHandler(async (request, response) => {
  const existing = await pool.query(
    "SELECT status, container_id FROM test_runs WHERE run_id = $1",
    [request.params.runId]
  );
  if (!existing.rowCount) return response.status(404).json({ error: 'Run not found.' });
  if (!['starting', 'running'].includes(existing.rows[0].status)) {
    return response.status(409).json({ error: 'Only an active run can be aborted.' });
  }

  const discoveredContainerId = existing.rows[0].container_id
    || await findJMeterContainer(request.params.runId);
  const aborted = await pool.query(
    `UPDATE test_runs
     SET status = 'aborted', ended_at = now(), error = 'Run aborted by user.'
     WHERE run_id = $1 AND status IN ('starting', 'running')
     RETURNING status, container_id`,
    [request.params.runId]
  );
  if (!aborted.rowCount) return response.status(409).json({ error: 'The run is no longer active.' });

  const containerId = aborted.rows[0].container_id || discoveredContainerId;
  if (containerId) await stopJMeterContainer(containerId);
  response.json({ runId: request.params.runId, status: 'aborted' });
}));

app.get('/api/runs', asyncHandler(async (request, response) => {
  const result = await pool.query(
    `SELECT run_id, scenario_id, scenario_name, script_name, script_sha256, script_version, status,
            users, duration_seconds, rampup_seconds,
            started_at, ended_at, exit_code, error, summary
     FROM test_runs ORDER BY started_at DESC LIMIT 100`
  );
  response.json(result.rows.map((run) => ({ ...run, grafanaUrl: grafanaUrl(run) })));
}));

app.get('/api/runs/:runId', asyncHandler(async (request, response) => {
  const result = await pool.query(
    `SELECT run_id, scenario_id, scenario_name, script_name, script_sha256, script_version, status,
            users, duration_seconds, rampup_seconds,
            started_at, ended_at, exit_code, error, summary
     FROM test_runs WHERE run_id = $1`,
    [request.params.runId]
  );
  if (!result.rowCount) return response.status(404).json({ error: 'Run not found.' });
  response.json({ ...result.rows[0], grafanaUrl: grafanaUrl(result.rows[0]) });
}));

app.get('/api/runs/:runId/results', asyncHandler(async (request, response) => {
  const result = await pool.query(
    `SELECT run_id, scenario_id, scenario_name, script_name, script_sha256, script_version, status,
            users, duration_seconds, rampup_seconds, started_at, ended_at, summary
     FROM test_runs WHERE run_id = $1`,
    [request.params.runId]
  );
  if (!result.rowCount) return response.status(404).json({ error: 'Run not found.' });
  const run = result.rows[0];
  const baselineResult = await pool.query(
    `SELECT run_id, started_at, summary
     FROM test_runs
     WHERE scenario_id = $1
       AND run_id <> $2
       AND status = 'completed'
       AND summary IS NOT NULL
       AND started_at < $3
       AND script_sha256 = $4
       AND users = $5
       AND duration_seconds = $6
       AND rampup_seconds = $7
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
  response.json({
    run,
    baseline: baselineResult.rows[0] || null
  });
}));

app.get('*', (request, response) => {
  response.sendFile(path.join(publicDir, 'index.html'));
});

app.use((error, request, response, next) => {
  console.error(error);
  if (response.headersSent) return next(error);
  respondError(response, error, 500);
});

const server = http.createServer(app);
server.listen(port, '127.0.0.1', () => {
  console.log(`Performance test UI listening at http://localhost:${port}`);
  recoverActiveRuns().catch((error) => console.error(`Could not recover active runs: ${error.message}`));
});

async function shutdown() {
  server.close();
  await pool.end();
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
