// Optional webhook notification when a run finishes (Slack, Microsoft Teams Workflows, or plain JSON).

export function notificationSettings(env = process.env) {
  const url = env.NOTIFY_WEBHOOK_URL || '';
  const format = (env.NOTIFY_WEBHOOK_FORMAT || 'slack').toLowerCase();
  if (url && !['slack', 'teams', 'json'].includes(format)) {
    throw new Error('NOTIFY_WEBHOOK_FORMAT must be slack, teams or json.');
  }
  return { url, format, appUrl: (env.APP_BASE_URL || `http://localhost:${env.WEB_PORT || 4000}`).replace(/\/$/, '') };
}

function headline(run) {
  const slo = run.slo_result ? (run.slo_result.passed ? 'SLO passed' : `SLO FAILED (${run.slo_result.failed}/${run.slo_result.checked})`) : null;
  const icon = run.status !== 'completed' || run.slo_result?.passed === false ? '❌' : '✅';
  return `${icon} ${run.scenario_name}: run ${run.status}${slo ? ` · ${slo}` : ''}`;
}

function facts(run) {
  const s = run.summary;
  const n = (value, digits = 1) => (Number.isFinite(value) ? Number(value).toFixed(digits) : '—');
  const list = [
    ['Run ID', run.run_id],
    ['Load', `${run.users} users · ${run.duration_seconds}s`]
  ];
  if (s) {
    list.push(['Samples', String(s.samples)], ['Error rate', `${n(s.errorRatePercent, 2)}%`],
      ['p95', `${n(s.p95ResponseMs)} ms`], ['p99', `${n(s.p99ResponseMs)} ms`]);
  }
  if (run.error) list.push(['Error', run.error]);
  return list;
}

export function buildNotification(run, { format, appUrl }) {
  const reportUrl = `${appUrl}/api/runs/${encodeURIComponent(run.run_id)}/report`;
  const title = headline(run);
  const items = facts(run);

  if (format === 'json') {
    return {
      event: 'run.finished',
      title,
      run: {
        runId: run.run_id, scenario: run.scenario_name, status: run.status, startedAt: run.started_at,
        endedAt: run.ended_at, users: run.users, durationSeconds: run.duration_seconds, error: run.error,
        summary: run.summary ? Object.fromEntries(Object.entries(run.summary).filter(([key]) => key !== 'transactions')) : null,
        sloPassed: run.slo_result ? run.slo_result.passed : null
      },
      reportUrl
    };
  }
  if (format === 'teams') {
    return {
      type: 'message',
      attachments: [{
        contentType: 'application/vnd.microsoft.card.adaptive',
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.4',
          body: [
            { type: 'TextBlock', text: title, weight: 'Bolder', size: 'Medium', wrap: true },
            { type: 'FactSet', facts: items.map(([t, v]) => ({ title: t, value: v })) }
          ],
          actions: [{ type: 'Action.OpenUrl', title: 'Open report', url: reportUrl }]
        }
      }]
    };
  }
  return {
    text: `${title}\n${items.map(([t, v]) => `• *${t}:* ${v}`).join('\n')}\n<${reportUrl}|Open report> (local)`
  };
}

export async function sendRunNotification(run, { settings = notificationSettings(), fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  if (!settings.url) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(settings.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(buildNotification(run, settings)),
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`webhook returned HTTP ${response.status}`);
    return true;
  } finally {
    clearTimeout(timer);
  }
}
