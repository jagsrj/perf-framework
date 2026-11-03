import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import multer from 'multer';
import { parseStringPromise } from 'xml2js';
import { asyncHandler, httpError, respondError, validateScenarioIdParam } from '../http.js';
import { normalizeSlo } from '../slo.js';

const SCENARIO_COLUMNS = `id, name, script_name, original_filename, script_version, users, duration_seconds,
  rampup_seconds, (script_path IS NOT NULL) AS has_script, slo, created_at, updated_at`;

export function toScenarioInput(body = {}) {
  const invalid = (message) => httpError(400, message);
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
  // slo is optional: omitted = keep the current targets, null/{} = clear them.
  const hasSlo = Object.prototype.hasOwnProperty.call(body, 'slo');
  const slo = hasSlo ? normalizeSlo(body.slo) : null;
  return { name, scriptName, users, duration, rampup, hasSlo, slo };
}

export function scenariosRouter({ pool, runs, config }) {
  const router = express.Router();
  router.param('id', validateScenarioIdParam);

  const upload = multer({
    storage: multer.diskStorage({
      destination: (request, file, callback) => callback(null, path.join(config.uploadRoot, request.params.id)),
      filename: (request, file, callback) => {
        const safeName = path.basename(file.originalname).replace(/[^a-zA-Z0-9._-]/g, '_');
        callback(null, `${Date.now()}-${safeName}`);
      }
    }),
    limits: { fileSize: 10 * 1024 * 1024, files: 1 },
    fileFilter: (request, file, callback) => {
      if (path.extname(file.originalname).toLowerCase() !== '.jmx') {
        callback(new Error('Upload a JMeter .jmx script file.'));
        return;
      }
      callback(null, true);
    }
  });

  router.get(
    '/',
    asyncHandler(async (request, response) => {
      const result = await pool.query(`SELECT ${SCENARIO_COLUMNS} FROM scenarios ORDER BY updated_at DESC`);
      response.json(result.rows);
    })
  );

  router.post(
    '/',
    asyncHandler(async (request, response) => {
      const scenario = toScenarioInput(request.body);
      const result = await pool.query(
        `INSERT INTO scenarios (id, name, script_name, users, duration_seconds, rampup_seconds, slo)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING ${SCENARIO_COLUMNS}`,
        [
          randomUUID(),
          scenario.name,
          scenario.scriptName,
          scenario.users,
          scenario.duration,
          scenario.rampup,
          scenario.slo
        ]
      );
      response.status(201).json(result.rows[0]);
    })
  );

  router.put(
    '/:id',
    asyncHandler(async (request, response) => {
      const scenario = toScenarioInput(request.body);
      const result = await pool.query(
        `UPDATE scenarios
         SET name = $2, script_name = $3, users = $4, duration_seconds = $5, rampup_seconds = $6,
             slo = CASE WHEN $7::boolean THEN $8::jsonb ELSE slo END, updated_at = now()
         WHERE id = $1
         RETURNING ${SCENARIO_COLUMNS}`,
        [
          request.params.id,
          scenario.name,
          scenario.scriptName,
          scenario.users,
          scenario.duration,
          scenario.rampup,
          scenario.hasSlo,
          scenario.slo
        ]
      );
      if (!result.rowCount) throw httpError(404, 'Scenario not found.');
      response.json(result.rows[0]);
    })
  );

  router.post(
    '/:id/script',
    asyncHandler(async (request, response) => {
      await mkdir(path.join(config.uploadRoot, request.params.id), { recursive: true });
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
            const locked = await client.query('SELECT id FROM scenarios WHERE id = $1 FOR UPDATE', [request.params.id]);
            if (!locked.rowCount) throw httpError(404, 'Scenario not found.');
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
               RETURNING ${SCENARIO_COLUMNS}`,
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
    })
  );

  router.get(
    '/:id/script',
    asyncHandler(async (request, response) => {
      const result = await pool.query('SELECT script_path FROM scenarios WHERE id = $1', [request.params.id]);
      if (!result.rowCount || !result.rows[0].script_path) {
        throw httpError(404, 'No script has been uploaded for this scenario.');
      }
      response.type('text/plain').send(await readFile(result.rows[0].script_path, 'utf8'));
    })
  );

  router.post(
    '/:id/runs',
    asyncHandler(async (request, response) => {
      const { run } = await runs.startRun(request.params.id);
      response.status(202).json(run);
    })
  );

  router.get(
    '/:id/trends',
    asyncHandler(async (request, response) => {
      const limit = Math.min(Math.max(Number.parseInt(request.query.limit, 10) || 20, 1), 200);
      const result = await pool.query(
        `SELECT run_id, started_at, script_version, script_sha256, users, duration_seconds, rampup_seconds,
                summary, slo_result
         FROM test_runs
         WHERE scenario_id = $1 AND status = 'completed' AND summary IS NOT NULL
         ORDER BY started_at DESC
         LIMIT $2`,
        [request.params.id, limit]
      );
      const points = result.rows.reverse().map((run) => ({
        runId: run.run_id,
        startedAt: run.started_at,
        scriptVersion: run.script_version,
        users: run.users,
        durationSeconds: run.duration_seconds,
        samples: run.summary.samples,
        throughputPerSecond: run.duration_seconds ? run.summary.samples / run.duration_seconds : null,
        errorRatePercent: run.summary.errorRatePercent,
        averageResponseMs: run.summary.averageResponseMs,
        p95ResponseMs: run.summary.p95ResponseMs,
        p99ResponseMs: run.summary.p99ResponseMs,
        sloPassed: run.slo_result ? run.slo_result.passed : null
      }));
      response.json({ scenarioId: request.params.id, points });
    })
  );

  return router;
}
