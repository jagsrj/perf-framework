import assert from 'node:assert/strict';
import test from 'node:test';
import { buildNotification, notificationSettings, sendRunNotification } from '../web/notify.js';
import { renderRunReport } from '../web/report.js';
import { evaluateSlo } from '../web/slo.js';

const summary = {
  samples: 200, failures: 4, errorRatePercent: 2, averageResponseMs: 120, p95ResponseMs: 300, p99ResponseMs: 500, maxResponseMs: 900, successful: 196,
  transactions: { '<script>alert(1)</script>': { samples: 200, failures: 4, errorRatePercent: 2, averageResponseMs: 120, p95ResponseMs: 300, p99ResponseMs: 500, maxResponseMs: 900 } }
};
const slo = { p95Ms: 250, errorRatePercent: 5, applyToTransactions: false };
const run = {
  run_id: 'run-9', scenario_name: 'checkout', status: 'completed', users: 20, duration_seconds: 120, rampup_seconds: 10,
  started_at: '2026-01-01T00:00:00Z', ended_at: '2026-01-01T00:02:00Z', script_name: 'checkout.jmx', script_version: 3,
  script_sha256: 'abcdef0123456789abcdef', summary, slo, slo_result: evaluateSlo(summary, slo)
};

test('HTML report shows the verdict, baseline change and escapes labels', () => {
  const baseline = { run_id: 'run-8', started_at: '2025-12-31T00:00:00Z', summary: { ...summary, p95ResponseMs: 200 } };
  const html = renderRunReport({ run, baseline, generatedAt: new Date('2026-01-02T00:00:00Z') });
  assert.match(html, /SLO FAILED \(1 of 2 checks\)/);
  assert.match(html, /vs baseline run-8/);
  assert.match(html, /\+50\.0%/);
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('&lt;script&gt;'));
});

test('HTML report handles runs without summary or SLO', () => {
  const html = renderRunReport({ run: { ...run, status: 'failed', summary: null, slo: null, slo_result: null, error: 'boom' }, baseline: null });
  assert.match(html, /No SLO targets set/);
  assert.match(html, /No summary is available/);
  assert.match(html, /boom/);
});

test('notification payloads for slack, teams and json', () => {
  const settings = { appUrl: 'http://localhost:4000' };
  const slack = buildNotification(run, { ...settings, format: 'slack' });
  assert.match(slack.text, /❌ checkout: run completed · SLO FAILED \(1\/2\)/);
  assert.match(slack.text, /api\/runs\/run-9\/report/);

  const teams = buildNotification(run, { ...settings, format: 'teams' });
  assert.equal(teams.attachments[0].contentType, 'application/vnd.microsoft.card.adaptive');
  assert.ok(teams.attachments[0].content.body[1].facts.some((f) => f.title === 'p95'));

  const json = buildNotification({ ...run, slo_result: { ...run.slo_result, passed: true } }, { ...settings, format: 'json' });
  assert.equal(json.run.sloPassed, true);
  assert.equal(json.run.summary.transactions, undefined);
  assert.match(json.title, /^✅/);
});

test('notification settings validate the format and are off without a URL', async () => {
  assert.throws(() => notificationSettings({ NOTIFY_WEBHOOK_URL: 'https://x', NOTIFY_WEBHOOK_FORMAT: 'email' }), /slack, teams or json/);
  const off = notificationSettings({});
  assert.equal(await sendRunNotification(run, { settings: off }), false);

  let posted;
  const sent = await sendRunNotification(run, {
    settings: notificationSettings({ NOTIFY_WEBHOOK_URL: 'https://hooks.example/x', NOTIFY_WEBHOOK_FORMAT: 'json' }),
    fetchImpl: async (url, init) => { posted = { url, body: JSON.parse(init.body) }; return new Response('ok'); }
  });
  assert.equal(sent, true);
  assert.equal(posted.url, 'https://hooks.example/x');
  assert.equal(posted.body.event, 'run.finished');

  await assert.rejects(sendRunNotification(run, {
    settings: notificationSettings({ NOTIFY_WEBHOOK_URL: 'https://hooks.example/x' }),
    fetchImpl: async () => new Response('no', { status: 500 })
  }), /HTTP 500/);
});
