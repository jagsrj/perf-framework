import express from 'express';
import { analyzeWithOllama } from '../ai-analysis.js';
import { asyncHandler, httpError } from '../http.js';
import { renderRunReport } from '../report.js';
import { RUN_COLUMNS } from '../run-service.js';

export function grafanaUrl(run, baseUrl) {
  const params = new URLSearchParams({
    orgId: '1',
    'var-application': run.scenario_name,
    'var-runId': run.run_id,
    from: String(new Date(run.started_at).getTime()),
    to: 'now',
    refresh: '5s',
    kiosk: 'tv'
  });
  return `${baseUrl.replace(/\/$/, '')}/d/jmeter-performance/jmeter-performance-test?${params.toString()}`;
}

export function runsRouter({ pool, runs, config, analyze = analyzeWithOllama, agents = null }) {
  const router = express.Router();
  const withGrafana = (run) => ({ ...run, grafanaUrl: grafanaUrl(run, config.grafanaBaseUrl) });

  async function getRun(runId) {
    const result = await pool.query(`SELECT ${RUN_COLUMNS} FROM test_runs WHERE run_id = $1`, [runId]);
    if (!result.rowCount) throw httpError(404, 'Run not found.');
    return result.rows[0];
  }

  router.get(
    '/',
    asyncHandler(async (request, response) => {
      const result = await pool.query(`SELECT ${RUN_COLUMNS} FROM test_runs ORDER BY started_at DESC LIMIT 100`);
      response.json(result.rows.map(withGrafana));
    })
  );

  router.get(
    '/:runId',
    asyncHandler(async (request, response) => {
      const run = await getRun(request.params.runId);
      const loadGenerators = run.execution === 'agents' && agents ? await agents.listAssignments(run.run_id) : [];
      response.json({ ...withGrafana(run), loadGenerators });
    })
  );

  router.post(
    '/:runId/abort',
    asyncHandler(async (request, response) => {
      response.json(await runs.abortRun(request.params.runId));
    })
  );

  router.get(
    '/:runId/results',
    asyncHandler(async (request, response) => {
      const run = await getRun(request.params.runId);
      response.json({ run, baseline: await runs.findMatchingBaseline(run) });
    })
  );

  router.post(
    '/:runId/ai-analysis',
    asyncHandler(async (request, response) => {
      const run = await getRun(request.params.runId);
      if (run.status !== 'completed' || !run.summary) {
        throw httpError(409, 'AI analysis is available only for completed runs with a summary.');
      }
      const baseline = await runs.findMatchingBaseline(run);
      const analysis = await analyze(run.summary, baseline?.summary);
      response.json({
        ...analysis,
        baseline: baseline ? { runId: baseline.run_id, startedAt: baseline.started_at } : null
      });
    })
  );

  // Re-run the perf-insight regression check (for example after fixing its configuration).
  router.post(
    '/:runId/insight',
    asyncHandler(async (request, response) => {
      response.json(await runs.reanalyzeRun(request.params.runId));
    })
  );

  router.get(
    '/:runId/report',
    asyncHandler(async (request, response) => {
      const run = await getRun(request.params.runId);
      const baseline = run.summary ? await runs.findMatchingBaseline(run) : null;
      const html = renderRunReport({ run, baseline });
      if (request.query.download !== undefined) {
        const safeName = `${run.scenario_name}-${run.run_id}`.replace(/[^a-zA-Z0-9._-]/g, '_');
        response.attachment(`perf-report-${safeName}.html`);
      }
      response.type('html').send(html);
    })
  );

  return router;
}
