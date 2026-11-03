import { compareSummaries } from '/results.js';

const state = {
  scenarios: [],
  runs: [],
  currentRunId: null,
  selectedResultRunId: null,
  analyzedRunId: null,
  pollTimer: null,
  remainingTimer: null
};
const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[character]);

const SLO_KEYS = ['p95Ms', 'p99Ms', 'averageMs', 'maxMs', 'errorRatePercent'];
const SLO_LABELS = { p95Ms: 'p95', p99Ms: 'p99', averageMs: 'mean', maxMs: 'max', errorRatePercent: 'errors' };

function sloFromForm(form) {
  const slo = {};
  for (const key of SLO_KEYS) {
    const value = form.elements[`slo.${key}`].value.trim();
    if (value !== '') slo[key] = Number(value);
  }
  if (!Object.keys(slo).length) return null;
  slo.applyToTransactions = form.elements['slo.applyToTransactions'].checked;
  return slo;
}

function setSloFields(form, slo) {
  for (const key of SLO_KEYS) form.elements[`slo.${key}`].value = slo?.[key] ?? '';
  form.elements['slo.applyToTransactions'].checked = Boolean(slo?.applyToTransactions);
}

function sloText(slo) {
  if (!slo) return 'No SLO targets';
  const parts = SLO_KEYS.filter((key) => Number.isFinite(slo[key]))
    .map((key) => `${SLO_LABELS[key]} ≤ ${slo[key]}${key === 'errorRatePercent' ? '%' : ' ms'}`);
  return `SLO: ${parts.join(', ')}${slo.applyToTransactions ? ' (per transaction)' : ''}`;
}

function sloBadge(run) {
  if (!run.slo_result) return '';
  return run.slo_result.passed
    ? '<span class="status completed">SLO pass</span>'
    : `<span class="status failed">SLO fail (${run.slo_result.failed}/${run.slo_result.checked})</span>`;
}

async function api(url, options = {}) {
  const response = await fetch(url, options);
  const contentType = response.headers.get('content-type') || '';
  const body = contentType.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) throw new Error(body?.error || body || `Request failed (${response.status})`);
  return body;
}

function notify(message, success = false) {
  const notice = $('#notice');
  notice.textContent = message;
  notice.classList.toggle('success', success);
  notice.hidden = false;
  window.clearTimeout(notify.timer);
  notify.timer = window.setTimeout(() => { notice.hidden = true; }, 6000);
}

function showView(name, preferredRunId = null) {
  document.querySelectorAll('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.view === name));
  document.querySelectorAll('.view').forEach((view) => { view.hidden = view.id !== `view-${name}`; });
  if (name === 'runtime') showCurrentRun(preferredRunId).catch((error) => notify(error.message));
  if (name === 'execute') loadRuns();
  if (name === 'results') loadResults().catch((error) => notify(error.message));
}

function scenarioOptions(select, selectedId = '') {
  const previous = selectedId || select.value;
  select.innerHTML = '<option value="">Choose a scenario</option>' + state.scenarios.map((scenario) =>
    `<option value="${escapeHtml(scenario.id)}">${escapeHtml(scenario.name)}</option>`
  ).join('');
  if (state.scenarios.some((scenario) => scenario.id === previous)) select.value = previous;
}

function renderScenarios() {
  $('#scenario-list').innerHTML = state.scenarios.length ? state.scenarios.map((scenario) => `
    <article class="scenario-card">
      <div class="card-title">${escapeHtml(scenario.name)}<span class="status">${scenario.has_script ? 'Script ready' : 'Needs script'}</span></div>
      <div class="card-meta">${escapeHtml(scenario.script_name)}${scenario.has_script ? ` · Script v${scenario.script_version}` : ''} · ${scenario.users} users · ${scenario.duration_seconds}s duration · ${scenario.rampup_seconds}s ramp-up<br>${escapeHtml(sloText(scenario.slo))}</div>
      <div class="card-actions">
        <button class="quiet" data-edit="${escapeHtml(scenario.id)}">Update</button>
        <button class="secondary" data-run="${escapeHtml(scenario.id)}" ${scenario.has_script ? '' : 'disabled'}>Execute</button>
      </div>
    </article>`).join('') : '<p class="muted">No scenarios yet. Create one above.</p>';
  scenarioOptions($('#update-select'));
  scenarioOptions($('#execute-select'));
}

async function loadScenarios() {
  state.scenarios = await api('/api/scenarios');
  renderScenarios();
  selectUpdateScenario($('#update-select').value);
  renderExecuteDetails();
}

function setForm(form, scenario) {
  form.elements.name.value = scenario.name;
  form.elements.scriptName.value = scenario.script_name;
  form.elements.users.value = scenario.users;
  form.elements.duration.value = scenario.duration_seconds;
  form.elements.rampup.value = scenario.rampup_seconds;
  setSloFields(form, scenario.slo);
}

function selectedUpdateScenario() {
  return state.scenarios.find((scenario) => scenario.id === $('#update-select').value);
}

async function loadScriptPreview(scenario) {
  $('#script-preview').textContent = 'Loading script…';
  try {
    $('#script-preview').textContent = await api(`/api/scenarios/${encodeURIComponent(scenario.id)}/script`);
    $('#script-title').textContent = scenario.original_filename || scenario.script_name;
    $('#script-status').textContent = `Stored JMX · version ${scenario.script_version}`;
  } catch (error) {
    $('#script-preview').textContent = 'No JMX uploaded for this scenario yet.';
    $('#script-title').textContent = scenario.script_name;
    $('#script-status').textContent = 'Upload required';
  }
}

function selectUpdateScenario(id) {
  const scenario = state.scenarios.find((item) => item.id === id);
  const form = $('#update-form');
  if (!scenario) {
    form.reset();
    $('#script-preview').textContent = 'Choose a scenario to view its uploaded JMX script.';
    $('#script-status').textContent = '';
    $('#update-run').disabled = true;
    return;
  }
  setForm(form, scenario);
  $('#update-run').disabled = !scenario.has_script;
  loadScriptPreview(scenario);
}

function renderExecuteDetails() {
  const scenario = state.scenarios.find((item) => item.id === $('#execute-select').value);
  $('#execute-run').disabled = !scenario?.has_script;
  $('#execute-details').innerHTML = scenario ? `
    <strong>${escapeHtml(scenario.name)}</strong><br>
    Script: ${escapeHtml(scenario.original_filename || scenario.script_name)}${scenario.has_script ? ` · version ${scenario.script_version}` : ''}<br>
    Load: ${scenario.users} users · ${scenario.duration_seconds}s duration · ${scenario.rampup_seconds}s ramp-up<br>
    ${escapeHtml(sloText(scenario.slo))}
    ${scenario.has_script ? '' : '<br><span class="status failed">Upload a script before running</span>'}
  ` : 'Select a scenario to review its configuration.';
}

async function saveCreateScenario(event) {
  event.preventDefault();
  const createForm = event.currentTarget;
  const form = new FormData(createForm);
  const scriptFile = $('#create-script-file').files[0];
  const created = await api('/api/scenarios', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: form.get('name'),
      scriptName: form.get('scriptName'),
      users: form.get('users'),
      duration: form.get('duration'),
      rampup: form.get('rampup'),
      slo: sloFromForm(createForm)
    })
  });
  if (scriptFile) {
    const scriptForm = new FormData();
    scriptForm.append('script', scriptFile);
    try {
      await api(`/api/scenarios/${encodeURIComponent(created.id)}/script`, { method: 'POST', body: scriptForm });
    } catch (error) {
      createForm.reset();
      await loadScenarios();
      $('#update-select').value = created.id;
      selectUpdateScenario(created.id);
      notify(`Scenario created, but the script could not be uploaded: ${error.message} Upload it in Update Scenario.`);
      return;
    }
  }
  createForm.reset();
  $('#create-script-file').value = '';
  await loadScenarios();
  $('#update-select').value = created.id;
  selectUpdateScenario(created.id);
  notify(
    scriptFile ? 'Scenario created and JMX script uploaded.' : 'Scenario created. Upload its JMX script in Update Scenario.',
    true
  );
}

async function saveUpdatedScenario(event) {
  event.preventDefault();
  const scenario = selectedUpdateScenario();
  if (!scenario) throw new Error('Choose a scenario first.');
  const form = new FormData(event.currentTarget);
  await api(`/api/scenarios/${encodeURIComponent(scenario.id)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: form.get('name'),
      scriptName: form.get('scriptName'),
      users: form.get('users'),
      duration: form.get('duration'),
      rampup: form.get('rampup'),
      slo: sloFromForm(event.currentTarget)
    })
  });
  await loadScenarios();
  $('#update-select').value = scenario.id;
  selectUpdateScenario(scenario.id);
  notify('Scenario updated.', true);
}

async function uploadScenarioScript(event) {
  event.preventDefault();
  const scenario = selectedUpdateScenario();
  if (!scenario) throw new Error('Choose a scenario first.');
  const uploadForm = event.currentTarget;
  const form = new FormData(uploadForm);
  await api(`/api/scenarios/${encodeURIComponent(scenario.id)}/script`, { method: 'POST', body: form });
  uploadForm.reset();
  await loadScenarios();
  $('#update-select').value = scenario.id;
  selectUpdateScenario(scenario.id);
  notify('JMeter script uploaded and validated.', true);
}

function renderRuns() {
  const list = $('#run-list');
  if (!state.runs.length) {
    list.innerHTML = '<p class="muted">No runs have been started yet.</p>';
  } else {
    list.innerHTML = state.runs.map((run) => `
      <article class="run-card">
        <div class="card-title">${escapeHtml(run.scenario_name)}<span class="status ${escapeHtml(run.status)}">${escapeHtml(run.status)}</span>${sloBadge(run)}</div>
        <div class="card-meta">Run ${escapeHtml(run.run_id)}<br>${new Date(run.started_at).toLocaleString()} · ${run.users} users · ${run.duration_seconds}s</div>
        <div class="card-actions"><button class="secondary" data-monitor="${escapeHtml(run.run_id)}">Monitor run</button></div>
      </article>`).join('');
  }
  const selector = $('#runtime-select');
  if (!state.runs.some((run) => run.run_id === state.currentRunId)) {
    const activeRun = state.runs.find((run) => ['starting', 'running'].includes(run.status));
    state.currentRunId = activeRun?.run_id || state.runs[0]?.run_id || null;
  }
  const current = state.currentRunId || selector.value;
  selector.innerHTML = '<option value="">Choose a run</option>' + state.runs.map((run) =>
    `<option value="${escapeHtml(run.run_id)}">${escapeHtml(run.scenario_name)} · ${escapeHtml(run.run_id)} · ${escapeHtml(run.status)}</option>`
  ).join('');
  if (state.runs.some((run) => run.run_id === current)) selector.value = current;
  const resultsSelector = $('#results-select');
  resultsSelector.innerHTML = '<option value="">Choose a run</option>' + state.runs.map((run) =>
    `<option value="${escapeHtml(run.run_id)}">${escapeHtml(run.scenario_name)} · ${new Date(run.started_at).toLocaleString()} · ${escapeHtml(run.status)}</option>`
  ).join('');
  if (state.runs.some((run) => run.run_id === state.selectedResultRunId)) {
    resultsSelector.value = state.selectedResultRunId;
  }
}

async function loadRuns() {
  state.runs = await api('/api/runs');
  renderRuns();
}

async function showCurrentRun(preferredRunId = null) {
  await loadRuns();
  const activeRun = state.runs.find((run) => ['starting', 'running'].includes(run.status));
  const preferredRun = state.runs.find((run) => run.run_id === preferredRunId);
  state.currentRunId = preferredRun?.run_id || activeRun?.run_id || state.runs[0]?.run_id || null;
  renderRuns();
  if (!state.currentRunId) {
    $('#runtime-details').textContent = 'No test runs are available yet. Start a run to monitor it here.';
    $('#summary-cards').innerHTML = '';
    $('#summary-cards').hidden = true;
    state.analyzedRunId = null;
    const frame = $('#dashboard-frame');
    frame.classList.add('empty');
    frame.textContent = 'Start a run to load its Grafana dashboard.';
    frame.dataset.runId = '';
    return;
  }
  $('#runtime-select').value = state.currentRunId;
  await loadRun(state.currentRunId);
}

function formatMetric(value, suffix = '') {
  return value === null || value === undefined ? '—' : `${Number(value).toFixed(1)}${suffix}`;
}

function updateTimeRemaining() {
  const timeLeft = $('#time-left');
  if (!timeLeft) return;
  if (timeLeft.dataset.status === 'starting') {
    timeLeft.textContent = 'Waiting for JMeter to start';
    return;
  }
  if (timeLeft.dataset.status !== 'running') {
    timeLeft.textContent = '—';
    return;
  }
  const secondsLeft = Math.max(0, Math.ceil(
    Number(timeLeft.dataset.duration) - (Date.now() - new Date(timeLeft.dataset.startedAt).getTime()) / 1000
  ));
  const hours = Math.floor(secondsLeft / 3600);
  const minutes = Math.floor((secondsLeft % 3600) / 60);
  const seconds = secondsLeft % 60;
  timeLeft.textContent = hours
    ? `${hours}h ${minutes}m ${seconds}s`
    : `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

function renderRunDetails(run) {
  const runDetails = $('#runtime-details');
  const ended = run.ended_at ? new Date(run.ended_at).toLocaleString() : 'In progress';
  const isActive = ['starting', 'running'].includes(run.status);
  runDetails.innerHTML = `
    <div class="card-title">${escapeHtml(run.scenario_name)}<span class="status ${escapeHtml(run.status)}">${escapeHtml(run.status)}</span></div>
    <div class="card-meta">Run ID: <strong>${escapeHtml(run.run_id)}</strong><br>
      Script: ${escapeHtml(run.script_name || 'unknown')} · version ${run.script_version ?? 'unknown'} · SHA-256: ${escapeHtml((run.script_sha256 || '').slice(0, 16))}…<br>
      Test start time: ${isActive && run.status === 'starting' ? 'Waiting for JMeter to start' : new Date(run.started_at).toLocaleString()} · Ended: ${escapeHtml(ended)}<br>
      Time remaining: <strong id="time-left" data-status="${escapeHtml(run.status)}" data-started-at="${escapeHtml(run.started_at)}" data-duration="${escapeHtml(run.duration_seconds)}"></strong><br>
      Configured load: ${run.users} users · ${run.duration_seconds}s · ${run.rampup_seconds}s ramp-up
      ${run.error ? `<br><span class="status failed">${escapeHtml(run.error)}</span>` : ''}
    </div>
    <div class="runtime-actions">
      ${isActive ? `<button class="danger" type="button" data-abort="${escapeHtml(run.run_id)}">Abort test</button>` : ''}
      ${!isActive && run.summary ? `<button class="secondary" type="button" data-analyze="${escapeHtml(run.run_id)}">Analyze summary</button>` : ''}
    </div>`;
  updateTimeRemaining();
  if (state.remainingTimer) window.clearInterval(state.remainingTimer);
  state.remainingTimer = isActive ? window.setInterval(updateTimeRemaining, 1000) : null;

  const summary = run.summary || {};
  const summaryCards = $('#summary-cards');
  summaryCards.innerHTML = [
    ['Samples', summary.samples],
    ['Errors', summary.failures],
    ['Error rate', formatMetric(summary.errorRatePercent, '%')],
    ['Mean latency', formatMetric(summary.averageResponseMs, ' ms')],
    ['p95 latency', formatMetric(summary.p95ResponseMs, ' ms')]
  ].map(([name, value]) => `<div class="metric-card"><span>${name}</span><strong>${value ?? '—'}</strong></div>`).join('');
  summaryCards.hidden = !run.summary || state.analyzedRunId !== run.run_id;

  const iframeSrc = run.grafanaUrl;
  const container = $('#dashboard-frame');
  if (container.dataset.runId !== run.run_id) {
    container.classList.remove('empty');
    container.dataset.runId = run.run_id;
    container.innerHTML = `<iframe title="Grafana performance dashboard for ${escapeHtml(run.run_id)}" src="${escapeHtml(iframeSrc)}" loading="lazy" referrerpolicy="no-referrer"></iframe>`;
  }
  $('#open-run-dashboard').href = iframeSrc;
}

async function loadRun(runId) {
  if (!runId) return;
  const run = await api(`/api/runs/${encodeURIComponent(runId)}`);
  if (state.currentRunId !== run.run_id) state.analyzedRunId = null;
  state.currentRunId = run.run_id;
  renderRunDetails(run);
  await loadRuns();
  if (state.pollTimer) window.clearInterval(state.pollTimer);
  if (['starting', 'running'].includes(run.status)) {
    state.pollTimer = window.setInterval(async () => {
      try {
        const latest = await api(`/api/runs/${encodeURIComponent(run.run_id)}`);
        renderRunDetails(latest);
        await loadRuns();
        if (!['starting', 'running'].includes(latest.status)) {
          window.clearInterval(state.pollTimer);
          state.pollTimer = null;
        }
      } catch (error) {
        notify(error.message);
      }
    }, 3000);
  }
}

function resultValue(value, suffix = '') {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  const formatted = Number.isInteger(Number(value)) ? String(value) : Number(value).toFixed(2);
  return `${formatted}${suffix}`;
}

function renderSloVerdict(run) {
  if (!run.slo) return '<div class="slo-verdict none">No SLO targets were set for this run.</div>';
  if (!run.slo_result) return `<div class="slo-verdict none">SLO not evaluated · ${escapeHtml(sloText(run.slo))}</div>`;
  const failedChecks = run.slo_result.checks.filter((check) => !check.passed);
  return `<div class="slo-verdict ${run.slo_result.passed ? 'pass' : 'fail'}">
    <strong>${run.slo_result.passed ? 'SLO passed' : `SLO failed · ${run.slo_result.failed} of ${run.slo_result.checked} checks`}</strong>
    <span>${escapeHtml(sloText(run.slo))}</span>
    ${failedChecks.length ? `<ul>${failedChecks.slice(0, 8).map((check) =>
      `<li>${escapeHtml(check.scope)} · ${escapeHtml(check.label || check.metric)}: ${check.actual ?? 'no data'} (target ≤ ${check.target})</li>`).join('')}</ul>` : ''}
  </div>`;
}

function renderResultsReport({ run, baseline }) {
  const report = $('#results-report');
  report.classList.remove('empty');
  const startedAt = new Date(run.started_at).toLocaleString();
  const endedAt = run.ended_at ? new Date(run.ended_at).toLocaleString() : 'In progress';
  const baselineSummary = baseline?.summary || null;

  if (!run.summary) {
    report.innerHTML = `
      <header class="results-header">
        <div><p class="eyebrow">TEST REPORT</p><h3>${escapeHtml(run.scenario_name)}</h3></div>
        <span class="status ${escapeHtml(run.status)}">${escapeHtml(run.status)}</span>
      </header>
      <p class="muted">${['starting', 'running'].includes(run.status)
        ? 'The test is still running. A report will be available when its summary has been generated.'
        : 'No summary is available for this run.'}</p>`;
    return;
  }

  const metrics = compareSummaries(run.summary, baselineSummary);
  const baselineDescription = baseline
    ? `Baseline run ${escapeHtml(baseline.run_id)} · ${new Date(baseline.started_at).toLocaleString()}`
    : 'No earlier completed run matches this scenario, script, and load configuration.';
  report.innerHTML = `
    <header class="results-header">
      <div><p class="eyebrow">TEST REPORT</p><h3>${escapeHtml(run.scenario_name)}</h3></div>
      <span class="status ${escapeHtml(run.status)}">${escapeHtml(run.status)}</span>
    </header>
    <div class="results-meta">
      <span><strong>Run ID</strong>${escapeHtml(run.run_id)}</span>
      <span><strong>Script</strong>${escapeHtml(run.script_name || 'unknown')} · v${escapeHtml(run.script_version ?? 'unknown')}</span>
      <span><strong>Started</strong>${escapeHtml(startedAt)}</span>
      <span><strong>Ended</strong>${escapeHtml(endedAt)}</span>
      <span><strong>Load</strong>${escapeHtml(run.users)} users · ${escapeHtml(run.duration_seconds)}s duration · ${escapeHtml(run.rampup_seconds)}s ramp-up</span>
    </div>
    ${renderSloVerdict(run)}
    <div class="baseline-note">${baselineDescription}</div>
    <div class="results-table-wrap">
      <table class="results-table">
        <thead><tr><th scope="col">Metric</th><th scope="col">Selected run</th><th scope="col">Baseline</th><th scope="col">Change</th></tr></thead>
        <tbody>${metrics.map((metric) => {
          const suffix = metric.suffix;
          const deltaText = metric.delta === null
            ? '—'
            : `${metric.delta > 0 ? '+' : ''}${resultValue(metric.delta, suffix)}${metric.percentChange === null ? '' : ` (${metric.percentChange > 0 ? '+' : ''}${metric.percentChange.toFixed(1)}%)`}`;
          const changeClass = metric.lowerIsBetter === null || metric.delta === null || metric.delta === 0
            ? ''
            : (metric.delta < 0 ? 'improved' : 'regressed');
          return `<tr>
            <th scope="row">${escapeHtml(metric.label)}</th>
            <td>${resultValue(metric.value, suffix)}</td>
            <td>${resultValue(metric.baselineValue, suffix)}</td>
            <td class="${changeClass}">${deltaText}</td>
          </tr>`;
        }).join('')}</tbody>
      </table>
    </div>
    <div class="report-actions">
      <a class="secondary-link" href="/api/runs/${encodeURIComponent(run.run_id)}/report" target="_blank" rel="noreferrer">Open HTML report ↗</a>
      <a class="secondary-link" href="/api/runs/${encodeURIComponent(run.run_id)}/report?download">Download report</a>
    </div>
    <p class="results-footnote">For latency and error metrics, a decrease is an improvement. Positive changes are increases; compare them in the context of your test goals.</p>
    ${run.status === 'completed' ? `
      <div class="ai-analysis-controls">
        <button class="secondary" type="button" data-ai-analyze="${escapeHtml(run.run_id)}">Explain with local AI</button>
        <span class="muted">Ollama receives summary metrics only. Its response is advisory and is not saved.</span>
      </div>
      <section id="ai-analysis-output" class="ai-analysis-output" aria-live="polite" hidden></section>
    ` : ''}`;
}

async function loadSelectedResults(runId) {
  const report = $('#results-report');
  if (!runId) {
    report.classList.add('empty');
    report.textContent = 'Select a run to view its results.';
    return;
  }
  state.selectedResultRunId = runId;
  report.classList.add('empty');
  report.textContent = 'Loading test report…';
  const results = await api(`/api/runs/${encodeURIComponent(runId)}/results`);
  if (state.selectedResultRunId !== runId) return;
  renderResultsReport(results);
}

async function analyzeResultsWithAi(runId, button) {
  button.disabled = true;
  button.textContent = 'Analyzing with Ollama…';
  const output = $('#ai-analysis-output');
  output.hidden = false;
  output.textContent = 'Waiting for the local model. The first request may take a few minutes while the model loads.';
  try {
    const result = await api(`/api/runs/${encodeURIComponent(runId)}/ai-analysis`, { method: 'POST' });
    if (state.selectedResultRunId !== runId) return;
    output.innerHTML = `<h4>AI analysis · ${escapeHtml(result.model)}</h4><p>${escapeHtml(result.analysis).replace(/\n/g, '<br>')}</p>`;
    if (result.baseline) {
      output.insertAdjacentHTML('beforeend', `<p class="results-footnote">Compared with baseline ${escapeHtml(result.baseline.runId)}.</p>`);
    }
  } catch (error) {
    if (state.selectedResultRunId === runId) output.textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = 'Explain with local AI';
  }
}

async function loadResults() {
  await loadRuns();
  const selector = $('#results-select');
  if (!state.runs.some((run) => run.run_id === state.selectedResultRunId)) {
    state.selectedResultRunId = state.runs[0]?.run_id || null;
  }
  selector.value = state.selectedResultRunId || '';
  await loadSelectedResults(state.selectedResultRunId);
}

async function abortRun(runId) {
  if (!window.confirm('Abort this test run?')) return;
  await api(`/api/runs/${encodeURIComponent(runId)}/abort`, { method: 'POST' });
  await loadRun(runId);
  notify(`Run ${runId} aborted.`, true);
}

async function analyzeRun(runId) {
  const run = await api(`/api/runs/${encodeURIComponent(runId)}`);
  if (!run.summary) throw new Error('No completed-run summary is available to analyze yet.');
  state.analyzedRunId = run.run_id;
  renderRunDetails(run);
  $('#summary-cards').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function startRun(scenarioId) {
  if (!scenarioId) throw new Error('Choose a scenario to run.');
  const run = await api(`/api/scenarios/${encodeURIComponent(scenarioId)}/runs`, { method: 'POST' });
  state.currentRunId = run.run_id;
  await loadRuns();
  $('#runtime-select').value = run.run_id;
  showView('runtime');
  notify(`Run ${run.run_id} started.`, true);
}

document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => showView(tab.dataset.view)));
$('#create-form').addEventListener('submit', (event) => saveCreateScenario(event).catch((error) => notify(error.message)));
$('#locate-script').addEventListener('click', () => $('#create-script-file').click());
$('#create-script-file').addEventListener('change', (event) => {
  const file = event.target.files[0];
  if (file) $('#create-script-name').value = file.name;
});
$('#update-form').addEventListener('submit', (event) => saveUpdatedScenario(event).catch((error) => notify(error.message)));
$('#upload-form').addEventListener('submit', (event) => uploadScenarioScript(event).catch((error) => notify(error.message)));
$('#update-select').addEventListener('change', (event) => selectUpdateScenario(event.target.value));
$('#execute-select').addEventListener('change', renderExecuteDetails);
$('#runtime-select').addEventListener('change', (event) => loadRun(event.target.value).catch((error) => notify(error.message)));
$('#results-select').addEventListener('change', (event) => loadSelectedResults(event.target.value).catch((error) => notify(error.message)));
$('#refresh-results').addEventListener('click', () => loadResults().catch((error) => notify(error.message)));
$('#results-report').addEventListener('click', (event) => {
  const button = event.target.closest('[data-ai-analyze]');
  if (button) analyzeResultsWithAi(button.dataset.aiAnalyze, button);
});
$('#update-run').addEventListener('click', () => startRun($('#update-select').value).catch((error) => notify(error.message)));
$('#execute-run').addEventListener('click', () => startRun($('#execute-select').value).catch((error) => notify(error.message)));
$('#refresh-scenarios').addEventListener('click', () => loadScenarios().catch((error) => notify(error.message)));
$('#refresh-runs').addEventListener('click', () => loadRuns().catch((error) => notify(error.message)));
$('#refresh-runtime').addEventListener('click', () => loadRun($('#runtime-select').value).catch((error) => notify(error.message)));
$('#runtime-details').addEventListener('click', (event) => {
  const abort = event.target.closest('[data-abort]');
  const analyze = event.target.closest('[data-analyze]');
  if (abort) abortRun(abort.dataset.abort).catch((error) => notify(error.message));
  else if (analyze) analyzeRun(analyze.dataset.analyze).catch((error) => notify(error.message));
});
$('#scenario-list').addEventListener('click', (event) => {
  const edit = event.target.closest('[data-edit]');
  const run = event.target.closest('[data-run]');
  if (edit) {
    $('#update-select').value = edit.dataset.edit;
    selectUpdateScenario(edit.dataset.edit);
    showView('update');
  } else if (run) {
    startRun(run.dataset.run).catch((error) => notify(error.message));
  }
});
$('#run-list').addEventListener('click', (event) => {
  const monitor = event.target.closest('[data-monitor]');
  if (!monitor) return;
  showView('runtime', monitor.dataset.monitor);
});

loadScenarios().catch((error) => notify(error.message));
loadRuns().catch((error) => notify(error.message));
