// Controller side of remote load generators.
//
// Each load generator runs the perf-framework agent (agent/agent.js). The agent only makes
// outbound HTTPS calls to the controller, so generators can sit behind firewalls:
//
//   POST /api/agent/register                     -> { id }
//   POST /api/agent/:agentId/heartbeat           -> { assignments: [...new work], stop: [ids] }
//   POST /api/agent/assignments/:id/start        JMeter has started
//   GET  /api/agent/assignments/:id/bundle       tar.gz of the run bundle (JMX, data files, plugins)
//   POST /api/agent/assignments/:id/jtl?offset=N append streamed JTL bytes (live SLO + final results)
//   POST /api/agent/assignments/:id/finish       { exitCode, error, logTail }
//
// Agents authenticate with PERF_AGENT_TOKEN and identify themselves with X-Agent-Id.
// For the run service, the hub is an "executor" like local Docker: wait / stop / remove / find,
// where each handle is a run_assignments ID.

import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import express from 'express';
import * as tar from 'tar';
import { extractApiKey, keysMatch } from './auth.js';
import { asyncHandler, httpError } from './http.js';

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const ACTIVE = ['pending', 'running'];

export function createAgentHub({ pool, config, now = () => Date.now(), log = console }) {
  const waiters = new Map(); // assignmentId -> [{ resolve, reject }]
  const uploadLocks = new Map(); // assignmentId -> Promise (serialises JTL appends)
  let sweepTimer = null;

  // ---- status ---------------------------------------------------------------------------

  function statusOf(generator) {
    if (!generator.enabled) return 'disabled';
    if (now() - new Date(generator.last_seen_at).getTime() > config.agentTimeoutMs) return 'offline';
    return generator.active_run ? 'busy' : 'online';
  }

  async function listGenerators() {
    const result = await pool.query(
      `SELECT g.*,
              (SELECT a.run_id FROM run_assignments a
               WHERE a.load_generator_id = g.id AND a.status IN ('pending', 'running')
               ORDER BY a.created_at DESC LIMIT 1) AS active_run
       FROM load_generators g ORDER BY g.name`
    );
    return result.rows.map((row) => ({ ...row, status: statusOf(row) }));
  }

  // Throws a 409 naming every selected generator that cannot take a run right now.
  async function checkAvailable(ids) {
    const all = await listGenerators();
    const byId = new Map(all.map((generator) => [generator.id, generator]));
    const problems = [];
    const selected = ids.map((id) => {
      const generator = byId.get(id);
      if (!generator) problems.push(`load generator ${id} no longer exists`);
      else if (generator.status !== 'online') problems.push(`"${generator.name}" is ${generator.status}`);
      return generator;
    });
    if (problems.length) throw httpError(409, `Cannot start the run: ${problems.join('; ')}.`);
    return selected;
  }

  async function createAssignments(run, generators, shares) {
    const ids = [];
    for (const [index, generator] of generators.entries()) {
      const id = randomUUID();
      await pool.query(
        `INSERT INTO run_assignments (id, run_id, generator_index, load_generator_id, threads)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, run.run_id, index + 1, generator.id, shares[index]]
      );
      ids.push(id);
    }
    return ids;
  }

  async function listAssignments(runId) {
    const result = await pool.query(
      `SELECT a.id, a.generator_index, a.load_generator_id, g.name AS load_generator_name, a.threads, a.status,
              a.stop_requested, a.exit_code, a.error, a.jtl_bytes::float8 AS jtl_bytes, a.started_at, a.finished_at
       FROM run_assignments a JOIN load_generators g ON g.id = a.load_generator_id
       WHERE a.run_id = $1 ORDER BY a.generator_index`,
      [runId]
    );
    return result.rows;
  }

  // ---- executor interface used by the run service ---------------------------------------

  function settle(id, outcome) {
    const pending = waiters.get(id) || [];
    waiters.delete(id);
    for (const waiter of pending) {
      if (outcome.error) waiter.reject(Object.assign(new Error(outcome.error), { userMessage: outcome.error }));
      else waiter.resolve(outcome.exitCode);
    }
  }

  async function outcomeFromRow(row) {
    if (row.status === 'finished') return { exitCode: row.exit_code ?? 1 };
    if (row.status === 'lost') return { error: row.error || 'The load generator stopped responding.' };
    return null;
  }

  const executor = {
    async wait(id) {
      const promise = new Promise((resolve, reject) => {
        const list = waiters.get(id) || [];
        list.push({ resolve, reject });
        waiters.set(id, list);
      });
      // It may already have finished (e.g. while the controller was restarting).
      const result = await pool.query('SELECT status, exit_code, error FROM run_assignments WHERE id = $1', [id]);
      if (!result.rowCount) settle(id, { error: 'Unknown load generator assignment.' });
      else {
        const outcome = await outcomeFromRow(result.rows[0]);
        if (outcome) settle(id, outcome);
      }
      return promise;
    },
    async stop(id) {
      await pool.query('UPDATE run_assignments SET stop_requested = true WHERE id = $1', [id]);
    },
    async remove() {},
    async find(runId) {
      const result = await pool.query('SELECT id FROM run_assignments WHERE run_id = $1 ORDER BY generator_index', [
        runId
      ]);
      return result.rows.map((row) => row.id);
    }
  };

  // Marks assignments lost when their generator stops sending heartbeats, or never starts.
  async function sweep() {
    const silentSince = new Date(now() - config.agentTimeoutMs);
    const notStartedSince = new Date(now() - config.agentStartTimeoutMs);
    const lost = await pool.query(
      `UPDATE run_assignments a
       SET status = 'lost', finished_at = now(),
           error = CASE
             WHEN g.last_seen_at < $1 THEN 'Load generator "' || g.name || '" stopped responding.'
             ELSE 'Load generator "' || g.name || '" did not start the test in time.'
           END
       FROM load_generators g
       WHERE g.id = a.load_generator_id AND a.status IN ('pending', 'running')
         AND (g.last_seen_at < $1 OR (a.status = 'pending' AND a.created_at < $2))
       RETURNING a.id, a.error`,
      [silentSince, notStartedSince]
    );
    for (const row of lost.rows) settle(row.id, { error: row.error });
    return lost.rows;
  }

  function startSweeper() {
    sweepTimer ??= setInterval(
      () => sweep().catch((error) => log.error(`Load generator sweep failed: ${error.message}`)),
      Math.min(5000, config.agentTimeoutMs / 3)
    );
    sweepTimer.unref?.();
  }

  function stopSweeper() {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }

  // ---- agent-facing HTTP API -------------------------------------------------------------

  function agentAuth(request, response, next) {
    if (!config.agentToken) {
      return response
        .status(503)
        .json({ error: 'Remote load generators are disabled. Set PERF_AGENT_TOKEN on the controller.' });
    }
    if (!keysMatch(extractApiKey(request), config.agentToken)) {
      return response.status(401).json({ error: 'A valid agent token is required.' });
    }
    next();
  }

  async function touch(agentId) {
    const result = await pool.query('UPDATE load_generators SET last_seen_at = now() WHERE id = $1 RETURNING id', [
      agentId
    ]);
    if (!result.rowCount) throw httpError(404, 'Unknown load generator. Register again.');
  }

  // Loads an assignment and checks it belongs to the calling agent.
  async function assignmentFor(request) {
    const { id } = request.params;
    const agentId = request.get('x-agent-id');
    if (!UUID.test(id) || !UUID.test(agentId || '')) throw httpError(400, 'Invalid assignment or agent ID.');
    const result = await pool.query(
      `SELECT a.*, r.results_dir, r.bundle_jmx, r.status AS run_status
       FROM run_assignments a JOIN test_runs r ON r.run_id = a.run_id WHERE a.id = $1`,
      [id]
    );
    if (!result.rowCount) throw httpError(404, 'Assignment not found.');
    const assignment = result.rows[0];
    if (assignment.load_generator_id !== agentId) throw httpError(403, 'This assignment belongs to another agent.');
    await touch(agentId);
    return assignment;
  }

  function jtlPath(assignment) {
    return path.join(assignment.results_dir, `results-${assignment.generator_index}.jtl`);
  }

  const router = express.Router();
  router.use(agentAuth);

  router.post(
    '/register',
    express.json({ limit: '64kb' }),
    asyncHandler(async (request, response) => {
      const body = request.body || {};
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name || name.length > 120 || !/^[\w.@:-]+$/.test(name)) {
        throw httpError(400, 'Agent name is required (letters, digits, . _ - @ :, up to 120 characters).');
      }
      const text = (value, max = 200) => (typeof value === 'string' ? value.slice(0, max) : null);
      const maxThreads =
        Number.isSafeInteger(Number(body.maxThreads)) && Number(body.maxThreads) > 0 ? Number(body.maxThreads) : null;
      const requestedId = UUID.test(body.id || '') ? body.id : randomUUID();
      // Re-registering with the same name re-attaches to the existing record.
      const result = await pool.query(
        `INSERT INTO load_generators (id, name, hostname, agent_version, jmeter_version, max_threads)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (name) DO UPDATE
           SET hostname = EXCLUDED.hostname, agent_version = EXCLUDED.agent_version,
               jmeter_version = EXCLUDED.jmeter_version, max_threads = EXCLUDED.max_threads, last_seen_at = now()
         RETURNING id, name, enabled`,
        [requestedId, name, text(body.hostname), text(body.agentVersion, 40), text(body.jmeterVersion, 40), maxThreads]
      );
      response.json({ ...result.rows[0], heartbeatSeconds: config.agentHeartbeatSeconds });
    })
  );

  router.post(
    '/:agentId/heartbeat',
    express.json({ limit: '64kb' }),
    asyncHandler(async (request, response) => {
      const { agentId } = request.params;
      if (!UUID.test(agentId)) throw httpError(400, 'Invalid agent ID.');
      await touch(agentId);
      const generator = (await pool.query('SELECT enabled FROM load_generators WHERE id = $1', [agentId])).rows[0];
      const work = generator.enabled
        ? await pool.query(
            `SELECT a.id, a.run_id, a.generator_index, a.threads, r.scenario_name, r.duration_seconds,
                    r.rampup_seconds, r.bundle_jmx, cardinality(r.plugins) > 0 AS has_plugins
             FROM run_assignments a JOIN test_runs r ON r.run_id = a.run_id
             WHERE a.load_generator_id = $1 AND a.status = 'pending' AND NOT a.stop_requested
               AND r.bundle_jmx IS NOT NULL
             ORDER BY a.created_at`,
            [agentId]
          )
        : { rows: [] };
      const stop = await pool.query(
        `SELECT id FROM run_assignments
         WHERE load_generator_id = $1 AND stop_requested AND status IN ('pending', 'running')`,
        [agentId]
      );
      response.json({
        heartbeatSeconds: config.agentHeartbeatSeconds,
        assignments: work.rows.map((row) => ({
          id: row.id,
          runId: row.run_id,
          generator: row.generator_index,
          threads: row.threads,
          duration: row.duration_seconds,
          rampup: row.rampup_seconds,
          testName: row.scenario_name,
          jmx: row.bundle_jmx,
          plugins: row.has_plugins,
          influxdbUrl: config.agentInfluxdbUrl || config.influxdbUrl
        })),
        stop: stop.rows.map((row) => row.id)
      });
    })
  );

  router.post(
    '/assignments/:id/start',
    asyncHandler(async (request, response) => {
      const assignment = await assignmentFor(request);
      if (assignment.status !== 'pending') throw httpError(409, `Assignment is already ${assignment.status}.`);
      await pool.query("UPDATE run_assignments SET status = 'running', started_at = now() WHERE id = $1", [
        assignment.id
      ]);
      response.json({ status: 'running', stop: assignment.stop_requested });
    })
  );

  router.get(
    '/assignments/:id/bundle',
    asyncHandler(async (request, response) => {
      const assignment = await assignmentFor(request);
      if (!ACTIVE.includes(assignment.status)) throw httpError(409, `Assignment is already ${assignment.status}.`);
      const bundleDir = path.join(assignment.results_dir, 'bundle');
      response.type('application/gzip');
      response.attachment(`bundle-${assignment.run_id}.tar.gz`);
      await pipeline(tar.create({ gzip: true, cwd: bundleDir, portable: true }, ['.']), response);
    })
  );

  router.post(
    '/assignments/:id/jtl',
    asyncHandler(async (request, response) => {
      const assignment = await assignmentFor(request);
      if (!ACTIVE.includes(assignment.status)) throw httpError(409, `Assignment is already ${assignment.status}.`);
      const offset = Number(request.query.offset);
      if (!Number.isSafeInteger(offset) || offset < 0) throw httpError(400, 'offset must be a non-negative integer.');

      const previous = uploadLocks.get(assignment.id) || Promise.resolve();
      const current = previous.then(async () => {
        const file = jtlPath(assignment);
        const size = await stat(file).then(
          (info) => info.size,
          () => 0
        );
        if (offset !== size) return { conflict: true, size };
        const source = request.get('content-encoding') === 'gzip' ? [request, createGunzip()] : [request];
        await pipeline(...source, createWriteStream(file, { flags: 'a' }));
        const written = (await stat(file)).size;
        await pool.query('UPDATE run_assignments SET jtl_bytes = $2 WHERE id = $1', [assignment.id, written]);
        return { size: written };
      });
      uploadLocks.set(
        assignment.id,
        current.catch(() => {})
      );
      const result = await current;
      if (result.conflict) {
        request.resume();
        return response.status(409).json({ error: 'Offset does not match.', expectedOffset: result.size });
      }
      response.json({ size: result.size, stop: assignment.stop_requested });
    })
  );

  router.post(
    '/assignments/:id/finish',
    express.json({ limit: '1mb' }),
    asyncHandler(async (request, response) => {
      const assignment = await assignmentFor(request);
      if (!ACTIVE.includes(assignment.status)) return response.json({ status: assignment.status });
      const exitCode = Number.isSafeInteger(request.body?.exitCode) ? request.body.exitCode : 1;
      const error = typeof request.body?.error === 'string' ? request.body.error.slice(0, 2000) : null;
      if (typeof request.body?.logTail === 'string') {
        await writeFile(
          path.join(assignment.results_dir, `jmeter-${assignment.generator_index}.log`),
          request.body.logTail.slice(-500_000)
        ).catch(() => {});
      }
      await pool.query(
        `UPDATE run_assignments SET status = 'finished', exit_code = $2, error = $3, finished_at = now()
         WHERE id = $1`,
        [assignment.id, exitCode, error]
      );
      settle(assignment.id, { exitCode });
      response.json({ status: 'finished' });
    })
  );

  // ---- management API used by the UI ------------------------------------------------------

  const adminRouter = express.Router();
  adminRouter.get(
    '/',
    asyncHandler(async (request, response) => {
      response.json({ enabled: Boolean(config.agentToken), generators: await listGenerators() });
    })
  );
  adminRouter.patch(
    '/:id',
    express.json(),
    asyncHandler(async (request, response) => {
      if (!UUID.test(request.params.id)) throw httpError(400, 'Invalid load generator ID.');
      if (typeof request.body?.enabled !== 'boolean') throw httpError(400, 'Send { "enabled": true | false }.');
      const result = await pool.query('UPDATE load_generators SET enabled = $2 WHERE id = $1 RETURNING id', [
        request.params.id,
        request.body.enabled
      ]);
      if (!result.rowCount) throw httpError(404, 'Load generator not found.');
      response.json((await listGenerators()).find((generator) => generator.id === request.params.id));
    })
  );
  adminRouter.delete(
    '/:id',
    asyncHandler(async (request, response) => {
      if (!UUID.test(request.params.id)) throw httpError(400, 'Invalid load generator ID.');
      const used = await pool.query(
        "SELECT 1 FROM run_assignments WHERE load_generator_id = $1 AND status IN ('pending', 'running') LIMIT 1",
        [request.params.id]
      );
      if (used.rowCount) throw httpError(409, 'This load generator is taking part in an active run.');
      const history = await pool.query('SELECT 1 FROM run_assignments WHERE load_generator_id = $1 LIMIT 1', [
        request.params.id
      ]);
      if (history.rowCount) {
        // Keep run history intact: disable instead of deleting.
        await pool.query('UPDATE load_generators SET enabled = false WHERE id = $1', [request.params.id]);
        return response.json({ deleted: false, disabled: true });
      }
      const result = await pool.query('DELETE FROM load_generators WHERE id = $1', [request.params.id]);
      if (!result.rowCount) throw httpError(404, 'Load generator not found.');
      response.json({ deleted: true });
    })
  );

  return {
    executor,
    router,
    adminRouter,
    listGenerators,
    listAssignments,
    checkAvailable,
    createAssignments,
    sweep,
    startSweeper,
    stopSweeper
  };
}
