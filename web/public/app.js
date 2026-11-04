import { compareSummaries } from '/results.js';

const state = {
  scenarios: [],
  runs: [],
  currentRunId: null,
  selectedResultRunId: null,
  analyzedRunId: null,
  pollTimer: null,
  remainingTimer: null,
  shared: { scripts: [], plugins: [] },
  loadGenerators: { enabled: false, generators: [] }
};
const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
      })[character]
  );

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
  if (form.elements['slo.abortOnFail'].checked) {
    slo.abortOnFail = true;
    const delay = form.elements['slo.abortDelaySeconds'].value.trim();
    if (delay !== '') slo.abortDelaySeconds = Number(delay);
  }
  return slo;
}

function setSloFields(form, slo) {
  for (const key of SLO_KEYS) form.elements[`slo.${key}`].value = slo?.[key] ?? '';
  form.elements['slo.applyToTransactions'].checked = Boolean(slo?.applyToTransactions);
  form.elements['slo.abortOnFail'].checked = Boolean(slo?.abortOnFail);
  form.elements['slo.abortDelaySeconds'].value = slo?.abortOnFail ? (slo.abortDelaySeconds ?? 60) : '';
}

function sloText(slo) {
  if (!slo) return 'No SLO targets';
  const parts = SLO_KEYS.filter((key) => Number.isFinite(slo[key])).map(
    (key) => `${SLO_LABELS[key]} ≤ ${slo[key]}${key === 'errorRatePercent' ? '%' : ' ms'}`
  );
  return `SLO: ${parts.join(', ')}${slo.applyToTransactions ? ' (per transaction)' : ''}${
    slo.abortOnFail ? ` · aborts early after ${slo.abortDelaySeconds ?? 60}s` : ''
  }`;
}

function sloBadge(run) {
  if (!run.slo_result) return '';
  return run.slo_result.passed
    ? '<span class="status completed">SLO pass</span>'
    : `<span class="status failed">SLO fail (${run.slo_result.failed}/${run.slo_result.checked})</span>`;
}

function insightBadge(run) {
  const insight = run.insight;
  if (!insight) return '';
  if (insight.status === 'pending') return '<span class="status running">Regression check…</span>';
  if (insight.status !== 'ok') return '';
  const cls = { pass: 'completed', warn: 'running', fail: 'failed' }[insight.verdict] || 'aborted';
  return `<span class="status ${cls}" title="perf-insight regression check">Regression ${escapeHtml(insight.verdict)}</span>`;
}

// When the server has PERF_API_KEY set, the UI asks for the key once and keeps it in this browser.
const API_KEY_STORAGE = 'perf-framework.apiKey';

function storedApiKey() {
  try {
    return localStorage.getItem(API_KEY_STORAGE);
  } catch {
    return null;
  }
}

let pendingKeyPrompt = null;

// Several requests can be rejected at once (e.g. on page load); ask only once for all of them.
function askForApiKey() {
  pendingKeyPrompt ??= Promise.resolve().then(() => {
    const entered = window.prompt('This perf-framework server needs an API key. Enter it to continue:')?.trim();
    if (entered) {
      try {
        localStorage.setItem(API_KEY_STORAGE, entered);
      } catch {
        // storage unavailable: the key is used for the retried requests only
      }
    }
    setTimeout(() => {
      pendingKeyPrompt = null;
    }, 0);
    return entered || null;
  });
  return pendingKeyPrompt;
}

async function authorizedFetch(url, options = {}, keyOverride = null, askIfRejected = true) {
  const headers = new Headers(options.headers || {});
  const key = keyOverride || storedApiKey();
  if (key) headers.set('authorization', `Bearer ${key}`);
  const response = await fetch(url, { ...options, headers });
  if (response.status === 401 && askIfRejected) {
    const entered = await askForApiKey();
    if (entered) return authorizedFetch(url, options, entered, false);
  }
  return response;
}

async function openReport(runId, download) {
  // Open the tab straight away so the browser does not treat it as an unrequested pop-up.
  const tab = download ? null : window.open('', '_blank');
  try {
    const response = await authorizedFetch(
      `/api/runs/${encodeURIComponent(runId)}/report${download ? '?download' : ''}`
    );
    if (!response.ok) throw new Error(`Could not load the report (${response.status}).`);
    const url = URL.createObjectURL(new Blob([await response.text()], { type: 'text/html' }));
    if (download) {
      const filename = /filename="?([^"]+)"?/.exec(response.headers.get('content-disposition') || '')?.[1];
      const link = document.createElement('a');
      link.href = url;
      link.download = filename || `perf-report-${runId}.html`;
      link.click();
    } else {
      tab.location = url;
    }
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (error) {
    tab?.close();
    notify(error.message);
  }
}

async function api(url, options = {}) {
  const response = await authorizedFetch(url, options);
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
  notify.timer = window.setTimeout(() => {
    notice.hidden = true;
  }, 6000);
}

function showView(name, preferredRunId = null) {
  document.querySelectorAll('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.view === name));
  document.querySelectorAll('.view').forEach((view) => {
    view.hidden = view.id !== `view-${name}`;
  });
  if (name === 'runtime') showCurrentRun(preferredRunId).catch((error) => notify(error.message));
  if (name === 'execute') loadRuns();
  if (name === 'results') loadResults().catch((error) => notify(error.message));
  if (['generators', 'create', 'update', 'execute'].includes(name))
    loadInfrastructure().catch((error) => notify(error.message));
}

function scenarioOptions(select, selectedId = '') {
  const previous = selectedId || select.value;
  select.innerHTML =
    '<option value="">Choose a scenario</option>' +
    state.scenarios
      .map((scenario) => `<option value="${escapeHtml(scenario.id)}">${escapeHtml(scenario.name)}</option>`)
      .join('');
  if (state.scenarios.some((scenario) => scenario.id === previous)) select.value = previous;
}

// ---- Scenario design: script source, plugins and load generators ----

const checkedValues = (container) =>
  [...container.querySelectorAll('input[type="checkbox"]:checked')].map((input) => input.value);
const STATUS_CLASS = { online: 'completed', busy: 'running', offline: 'failed', disabled: 'aborted' };

function generatorLabel(id) {
  return state.loadGenerators.generators.find((generator) => generator.id === id)?.name || 'unknown generator';
}

function placeText(scenario) {
  const remote = scenario.load_generator_ids || [];
  if (remote.length) return ` · on ${remote.map((id) => escapeHtml(generatorLabel(id))).join(', ')}`;
  return (scenario.generators ?? 1) > 1 ? ` · ${scenario.generators} local containers` : '';
}

function sourceText(scenario) {
  const plugins = scenario.plugins?.length
    ? ` · ${scenario.plugins.length} plugin${scenario.plugins.length > 1 ? 's' : ''}`
    : '';
  if (scenario.script_source === 'shared') return `Shared drive: ${escapeHtml(scenario.shared_script)}${plugins}`;
  return `${escapeHtml(scenario.script_name)}${scenario.has_script ? ` · Script v${scenario.script_version}` : ''}${plugins}`;
}

function renderSourceFields(form, { source = 'upload', sharedScript = null, plugins = [] } = {}) {
  const select = form.elements.sharedScript;
  const scripts = state.shared.scripts;
  const options = scripts.map(
    (script) =>
      `<option value="${escapeHtml(script.path)}">${escapeHtml(script.path)}${
        script.dataFiles.length
          ? ` (+${script.dataFiles.length} data file${script.dataFiles.length > 1 ? 's' : ''})`
          : ''
      }</option>`
  );
  if (sharedScript && !scripts.some((script) => script.path === sharedScript)) {
    options.unshift(
      `<option value="${escapeHtml(sharedScript)}">${escapeHtml(sharedScript)} (not found on the drive)</option>`
    );
  }
  select.innerHTML = options.length
    ? options.join('')
    : '<option value="">No .jmx files on the shared drive yet</option>';
  if (sharedScript) select.value = sharedScript;
  form.querySelector(`input[name="scriptSource"][value="${source}"]`).checked = true;

  const pluginList = form.querySelector('.plugin-list');
  const known = new Set(state.shared.plugins.map((plugin) => plugin.path));
  const all = [...state.shared.plugins.map((plugin) => plugin.path), ...plugins.filter((plugin) => !known.has(plugin))];
  pluginList.innerHTML = all.length
    ? all
        .map(
          (plugin) =>
            `<label class="checkbox"><input type="checkbox" value="${escapeHtml(plugin)}" ${
              plugins.includes(plugin) ? 'checked' : ''
            } /> ${escapeHtml(plugin)}${known.has(plugin) ? '' : ' <span class="muted">(missing)</span>'}</label>`
        )
        .join('')
    : '<p class="muted">No plugins in the shared drive\'s plugins folder.</p>';
  updateSourceVisibility(form);
}

function updateSourceVisibility(form) {
  const shared = form.elements.scriptSource.value === 'shared';
  form.querySelector('.shared-only').hidden = !shared;
  const script = state.shared.scripts.find((item) => item.path === form.elements.sharedScript.value);
  form.querySelector('.shared-files').textContent = script
    ? script.dataFiles.length
      ? `Sent with the script: ${script.dataFiles.join(', ')}`
      : 'No data files next to this script.'
    : '';
  if (shared && script) form.elements.scriptName.value = script.path.split('/').pop();
  const locate = form.querySelector('.script-name-field .help');
  if (locate) locate.hidden = shared;
  const locateButton = form.querySelector('#locate-script');
  if (locateButton) locateButton.disabled = shared;
}

function renderGeneratorFields(form, { ids = [], localCount = 1 } = {}) {
  const { enabled, generators } = state.loadGenerators;
  const list = form.querySelector('.generator-list');
  const known = new Set(generators.map((generator) => generator.id));
  list.innerHTML = generators.length
    ? generators
        .map((generator) => {
          const details = [
            generator.hostname,
            generator.jmeter_version ? `JMeter ${generator.jmeter_version}` : null,
            generator.max_threads ? `max ${generator.max_threads} users` : null
          ]
            .filter(Boolean)
            .map(escapeHtml)
            .join(' · ');
          return `<label class="checkbox generator-option"><input type="checkbox" value="${escapeHtml(generator.id)}" ${
            ids.includes(generator.id) ? 'checked' : ''
          } /> <strong>${escapeHtml(generator.name)}</strong> <span class="status ${STATUS_CLASS[generator.status] || ''}">${escapeHtml(
            generator.status
          )}</span> <span class="muted">${details}</span></label>`;
        })
        .join('') +
      ids
        .filter((id) => !known.has(id))
        .map(
          (id) =>
            `<label class="checkbox"><input type="checkbox" value="${escapeHtml(id)}" checked /> Removed generator</label>`
        )
        .join('')
    : '';
  form.querySelector('.generator-help').textContent = !enabled
    ? 'Remote load generators are off. Set PERF_AGENT_TOKEN on the controller and start the agent on each machine (docs/LOAD-GENERATORS.md).'
    : generators.length
      ? 'Users are split evenly across the selected generators. Every selected generator must be online when the run starts.'
      : 'No load generators have registered yet. Start the agent on a machine and refresh.';
  form.querySelector(`input[name="runOn"][value="${ids.length ? 'remote' : 'local'}"]`).checked = true;
  form.elements.generators.value = localCount;
  updateGeneratorVisibility(form);
}

function updateGeneratorVisibility(form) {
  const remote = form.elements.runOn.value === 'remote';
  form.querySelector('.remote-only').hidden = !remote;
  form.querySelector('.local-only').hidden = remote;
}

function designFromForm(form) {
  const shared = form.elements.scriptSource.value === 'shared';
  const remote = form.elements.runOn.value === 'remote';
  const loadGeneratorIds = remote ? checkedValues(form.querySelector('.generator-list')) : [];
  if (remote && !loadGeneratorIds.length) throw new Error('Select at least one remote load generator.');
  if (shared && !form.elements.sharedScript.value) throw new Error('Choose a script from the shared drive.');
  return {
    scriptSource: shared ? 'shared' : 'upload',
    ...(shared ? { sharedScript: form.elements.sharedScript.value } : {}),
    plugins: checkedValues(form.querySelector('.plugin-list')),
    loadGeneratorIds,
    ...(remote ? {} : { generators: form.elements.generators.value || 1 })
  };
}

function currentDesign(form) {
  return {
    source: form.elements.scriptSource.value,
    sharedScript: form.elements.sharedScript.value || null,
    plugins: checkedValues(form.querySelector('.plugin-list')),
    ids: form.elements.runOn.value === 'remote' ? checkedValues(form.querySelector('.generator-list')) : [],
    localCount: form.elements.generators.value || 1
  };
}

async function loadInfrastructure() {
  const [shared, generators] = await Promise.all([
    api('/api/shared').catch(() => ({ scripts: [], plugins: [] })),
    api('/api/load-generators').catch(() => ({ enabled: false, generators: [] }))
  ]);
  state.shared = shared;
  state.loadGenerators = generators;
  for (const form of [$('#create-form'), $('#update-form')]) {
    const design = currentDesign(form);
    renderSourceFields(form, design);
    renderGeneratorFields(form, design);
  }
  renderGeneratorTable();
  renderScenarios();
}

function renderGeneratorTable() {
  const { enabled, generators } = state.loadGenerators;
  $('#generator-table').innerHTML = !enabled
    ? '<p class="muted">Remote load generators are off. Set <code>PERF_AGENT_TOKEN</code> on the controller to enable them.</p>'
    : generators.length
      ? `<table class="results-table"><thead><tr><th>Name</th><th>Status</th><th>Host</th><th>JMeter</th><th>Max users</th><th>Last seen</th><th></th></tr></thead><tbody>${generators
          .map(
            (generator) => `<tr>
          <td><strong>${escapeHtml(generator.name)}</strong><br><span class="muted">agent ${escapeHtml(generator.agent_version || '?')}</span></td>
          <td><span class="status ${STATUS_CLASS[generator.status] || ''}">${escapeHtml(generator.status)}</span>${
            generator.active_run ? `<br><span class="muted">run ${escapeHtml(generator.active_run)}</span>` : ''
          }</td>
          <td>${escapeHtml(generator.hostname || '—')}</td>
          <td>${escapeHtml(generator.jmeter_version || '—')}</td>
          <td>${generator.max_threads ?? '—'}</td>
          <td>${new Date(generator.last_seen_at).toLocaleString()}</td>
          <td class="row-actions">
            <button class="quiet" type="button" data-toggle-generator="${escapeHtml(generator.id)}" data-enabled="${generator.enabled}">${generator.enabled ? 'Disable' : 'Enable'}</button>
            <button class="quiet" type="button" data-remove-generator="${escapeHtml(generator.id)}">Remove</button>
          </td></tr>`
          )
          .join('')}</tbody></table>`
      : '<p class="muted">No load generators have registered yet. Start the agent on a load generator machine (see docs/LOAD-GENERATORS.md).</p>';
  const { scripts, plugins } = state.shared;
  $('#shared-summary').innerHTML =
    `${scripts.length} script${scripts.length === 1 ? '' : 's'} and ${plugins.length} plugin${
      plugins.length === 1 ? '' : 's'
    } available.${
      scripts.length
        ? `<ul class="plain-list">${scripts.map((script) => `<li>${escapeHtml(script.path)}${script.dataFiles.length ? ` <span class="muted">+ ${escapeHtml(script.dataFiles.join(', '))}</span>` : ''}</li>`).join('')}</ul>`
        : ' Put each test in its own folder under <code>scripts/</code> on the shared drive, with its data files next to it, and plugin jars in <code>plugins/</code>.'
    }`;
}

async function updateGenerator(button) {
  if (button.dataset.toggleGenerator) {
    await api(`/api/load-generators/${encodeURIComponent(button.dataset.toggleGenerator)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: button.dataset.enabled !== 'true' })
    });
  } else if (button.dataset.removeGenerator) {
    const result = await api(`/api/load-generators/${encodeURIComponent(button.dataset.removeGenerator)}`, {
      method: 'DELETE'
    });
    notify(
      result.deleted ? 'Load generator removed.' : 'It has run history, so it was disabled instead of removed.',
      true
    );
  }
  await loadInfrastructure();
}

function renderScenarios() {
  $('#scenario-list').innerHTML = state.scenarios.length
    ? state.scenarios
        .map(
          (scenario) => `
    <article class="scenario-card">
      <div class="card-title">${escapeHtml(scenario.name)}<span class="status">${scenario.has_script ? 'Script ready' : 'Needs script'}</span></div>
      <div class="card-meta">${sourceText(scenario)} · ${scenario.users} users · ${scenario.duration_seconds}s duration · ${scenario.rampup_seconds}s ramp-up${placeText(scenario)}<br>${escapeHtml(sloText(scenario.slo))}</div>
      <div class="card-actions">
        <button class="quiet" data-edit="${escapeHtml(scenario.id)}">Update</button>
        <button class="secondary" data-run="${escapeHtml(scenario.id)}" ${scenario.has_script ? '' : 'disabled'}>Execute</button>
      </div>
    </article>`
        )
        .join('')
    : '<p class="muted">No scenarios yet. Create one above.</p>';
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
  renderSourceFields(form, {
    source: scenario.script_source || 'upload',
    sharedScript: scenario.shared_script,
    plugins: scenario.plugins || []
  });
  renderGeneratorFields(form, {
    ids: scenario.load_generator_ids || [],
    localCount: (scenario.load_generator_ids || []).length ? 1 : (scenario.generators ?? 1)
  });
}

function selectedUpdateScenario() {
  return state.scenarios.find((scenario) => scenario.id === $('#update-select').value);
}

async function loadScriptPreview(scenario) {
  $('#script-preview').textContent = 'Loading script…';
  try {
    $('#script-preview').textContent = await api(`/api/scenarios/${encodeURIComponent(scenario.id)}/script`);
    $('#script-title').textContent =
      scenario.script_source === 'shared' ? scenario.shared_script : scenario.original_filename || scenario.script_name;
    $('#script-status').textContent =
      scenario.script_source === 'shared'
        ? 'Shared drive · current file'
        : `Stored JMX · version ${scenario.script_version}`;
  } catch {
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
  $('#execute-details').innerHTML = scenario
    ? `
    <strong>${escapeHtml(scenario.name)}</strong><br>
    Script: ${sourceText(scenario)}<br>
    Load: ${scenario.users} users · ${scenario.duration_seconds}s duration · ${scenario.rampup_seconds}s ramp-up${placeText(scenario)}<br>
    ${escapeHtml(sloText(scenario.slo))}
    ${scenario.has_script ? '' : '<br><span class="status failed">Upload a script before running</span>'}
    ${(scenario.load_generator_ids || [])
      .map((id) => state.loadGenerators.generators.find((generator) => generator.id === id))
      .filter((generator) => generator && generator.status !== 'online')
      .map(
        (generator) =>
          `<br><span class="status failed">${escapeHtml(generator.name)} is ${escapeHtml(generator.status)}</span>`
      )
      .join('')}
  `
    : 'Select a scenario to review its configuration.';
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
      ...designFromForm(createForm),
      slo: sloFromForm(createForm)
    })
  });
  const useUpload = createForm.elements.scriptSource.value === 'upload';
  if (scriptFile && useUpload) {
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
  renderSourceFields(createForm);
  renderGeneratorFields(createForm);
  await loadScenarios();
  $('#update-select').value = created.id;
  selectUpdateScenario(created.id);
  notify(
    !useUpload
      ? 'Scenario created from the shared drive.'
      : scriptFile
        ? 'Scenario created and JMX script uploaded.'
        : 'Scenario created. Upload its JMX script in Update Scenario.',
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
      ...designFromForm(event.currentTarget),
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
    list.innerHTML = state.runs
      .map(
        (run) => `
      <article class="run-card">
        <div class="card-title">${escapeHtml(run.scenario_name)}<span class="status ${escapeHtml(run.status)}">${escapeHtml(run.status)}</span>${sloBadge(run)}${insightBadge(run)}</div>
        <div class="card-meta">Run ${escapeHtml(run.run_id)}<br>${new Date(run.started_at).toLocaleString()} · ${run.users} users · ${run.duration_seconds}s</div>
        <div class="card-actions"><button class="secondary" data-monitor="${escapeHtml(run.run_id)}">Monitor run</button></div>
      </article>`
      )
      .join('');
  }
  const selector = $('#runtime-select');
  if (!state.runs.some((run) => run.run_id === state.currentRunId)) {
    const activeRun = state.runs.find((run) => ['starting', 'running'].includes(run.status));
    state.currentRunId = activeRun?.run_id || state.runs[0]?.run_id || null;
  }
  const current = state.currentRunId || selector.value;
  selector.innerHTML =
    '<option value="">Choose a run</option>' +
    state.runs
      .map(
        (run) =>
          `<option value="${escapeHtml(run.run_id)}">${escapeHtml(run.scenario_name)} · ${escapeHtml(run.run_id)} · ${escapeHtml(run.status)}</option>`
      )
      .join('');
  if (state.runs.some((run) => run.run_id === current)) selector.value = current;
  const resultsSelector = $('#results-select');
  resultsSelector.innerHTML =
    '<option value="">Choose a run</option>' +
    state.runs
      .map(
        (run) =>
          `<option value="${escapeHtml(run.run_id)}">${escapeHtml(run.scenario_name)} · ${new Date(run.started_at).toLocaleString()} · ${escapeHtml(run.status)}</option>`
      )
      .join('');
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
  const secondsLeft = Math.max(
    0,
    Math.ceil(Number(timeLeft.dataset.duration) - (Date.now() - new Date(timeLeft.dataset.startedAt).getTime()) / 1000)
  );
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
      Script: ${escapeHtml(run.script_name || 'unknown')} · ${run.script_source === 'shared' ? 'shared drive' : `version ${run.script_version ?? 'unknown'}`} · SHA-256: ${escapeHtml((run.script_sha256 || '').slice(0, 16))}…<br>
      Test start time: ${isActive && run.status === 'starting' ? 'Waiting for JMeter to start' : new Date(run.started_at).toLocaleString()} · Ended: ${escapeHtml(ended)}<br>
      Time remaining: <strong id="time-left" data-status="${escapeHtml(run.status)}" data-started-at="${escapeHtml(run.started_at)}" data-duration="${escapeHtml(run.duration_seconds)}"></strong><br>
      Configured load: ${run.users} users · ${run.duration_seconds}s · ${run.rampup_seconds}s ramp-up${(run.generators ?? 1) > 1 ? ` · ${run.generators} load generators` : ''}
      ${run.error ? `<br><span class="status failed">${escapeHtml(run.error)}</span>` : ''}
    </div>
    ${
      run.loadGenerators?.length
        ? `<table class="results-table generator-runs"><thead><tr><th>Load generator</th><th>Users</th><th>Status</th><th>Results received</th></tr></thead><tbody>${run.loadGenerators
            .map(
              (assignment) => `<tr><td>${escapeHtml(assignment.load_generator_name)}</td><td>${assignment.threads}</td>
            <td><span class="status ${assignment.status === 'finished' ? (assignment.exit_code === 0 ? 'completed' : 'failed') : assignment.status === 'lost' ? 'failed' : 'running'}">${escapeHtml(
              assignment.status === 'finished' ? `exit ${assignment.exit_code}` : assignment.status
            )}</span>${assignment.error ? `<br><span class="muted">${escapeHtml(assignment.error)}</span>` : ''}</td>
            <td>${(Number(assignment.jtl_bytes) / 1024).toFixed(1)} KB</td></tr>`
            )
            .join('')}</tbody></table>`
        : ''
    }
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
  ]
    .map(([name, value]) => `<div class="metric-card"><span>${name}</span><strong>${value ?? '—'}</strong></div>`)
    .join('');
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
    ${
      failedChecks.length
        ? `<ul>${failedChecks
            .slice(0, 8)
            .map(
              (check) =>
                `<li>${escapeHtml(check.scope)} · ${escapeHtml(check.label || check.metric)}: ${check.actual ?? 'no data'} (target ≤ ${check.target})</li>`
            )
            .join('')}</ul>`
        : ''
    }
  </div>`;
}

function renderInsightVerdict(run) {
  const insight = run.insight;
  if (!insight) return '';
  if (insight.status === 'pending')
    return '<div class="slo-verdict none">perf-insight regression check is running…</div>';
  if (insight.status !== 'ok') {
    return `<div class="slo-verdict none">perf-insight regression check unavailable: ${escapeHtml(insight.error)}</div>`;
  }
  const flagged = [
    ...(insight.failing || []).map((t) => ['FAIL', t]),
    ...(insight.warnings || []).map((t) => ['WARN', t])
  ];
  const cls = insight.verdict === 'pass' ? 'pass' : insight.verdict === 'fail' ? 'fail' : 'warn';
  return `<div class="slo-verdict ${cls}">
    <strong>Regression check ${escapeHtml(insight.verdict.toUpperCase())}</strong>
    <span>${insight.baselineRuns ? `vs ${insight.baselineRuns} earlier good run(s)` : 'no baseline yet (SLOs only)'}${
      insight.reportUrl
        ? ` · <a href="${escapeHtml(insight.reportUrl)}" target="_blank" rel="noopener">perf-insight report</a>`
        : ''
    }</span>
    ${
      flagged.length
        ? `<ul>${flagged
            .slice(0, 8)
            .map(([level, t]) => `<li>${level} ${escapeHtml(t.name)}: ${escapeHtml(t.reasons[0] || '')}</li>`)
            .join('')}</ul>`
        : ''
    }
    ${insight.aiSummary ? `<span>${escapeHtml(insight.aiSummary)}</span>` : ''}
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
      <p class="muted">${
        ['starting', 'running'].includes(run.status)
          ? 'The test is still running. A report will be available when its summary has been generated.'
          : 'No summary is available for this run.'
      }</p>`;
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
      <span><strong>Load</strong>${escapeHtml(run.users)} users · ${escapeHtml(run.duration_seconds)}s duration · ${escapeHtml(run.rampup_seconds)}s ramp-up${(run.generators ?? 1) > 1 ? ` · ${escapeHtml(run.generators)} load generators` : ''}</span>
    </div>
    ${renderSloVerdict(run)}
    ${renderInsightVerdict(run)}
    <div class="baseline-note">${baselineDescription}</div>
    <div class="results-table-wrap">
      <table class="results-table">
        <thead><tr><th scope="col">Metric</th><th scope="col">Selected run</th><th scope="col">Baseline</th><th scope="col">Change</th></tr></thead>
        <tbody>${metrics
          .map((metric) => {
            const suffix = metric.suffix;
            const deltaText =
              metric.delta === null
                ? '—'
                : `${metric.delta > 0 ? '+' : ''}${resultValue(metric.delta, suffix)}${metric.percentChange === null ? '' : ` (${metric.percentChange > 0 ? '+' : ''}${metric.percentChange.toFixed(1)}%)`}`;
            const changeClass =
              metric.lowerIsBetter === null || metric.delta === null || metric.delta === 0
                ? ''
                : metric.delta < 0
                  ? 'improved'
                  : 'regressed';
            return `<tr>
            <th scope="row">${escapeHtml(metric.label)}</th>
            <td>${resultValue(metric.value, suffix)}</td>
            <td>${resultValue(metric.baselineValue, suffix)}</td>
            <td class="${changeClass}">${deltaText}</td>
          </tr>`;
          })
          .join('')}</tbody>
      </table>
    </div>
    <div class="report-actions">
      <button class="secondary-link" type="button" data-report="${escapeHtml(run.run_id)}">Open HTML report ↗</button>
      <button class="secondary-link" type="button" data-report="${escapeHtml(run.run_id)}" data-download>Download report</button>
    </div>
    <p class="results-footnote">For latency and error metrics, a decrease is an improvement. Positive changes are increases; compare them in the context of your test goals.</p>
    ${
      run.status === 'completed'
        ? `
      <div class="ai-analysis-controls">
        <button class="secondary" type="button" data-ai-analyze="${escapeHtml(run.run_id)}">Explain with local AI</button>
        <span class="muted">Ollama receives summary metrics only. Its response is advisory and is not saved.</span>
      </div>
      <section id="ai-analysis-output" class="ai-analysis-output" aria-live="polite" hidden></section>
    `
        : ''
    }`;
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
      output.insertAdjacentHTML(
        'beforeend',
        `<p class="results-footnote">Compared with baseline ${escapeHtml(result.baseline.runId)}.</p>`
      );
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
$('#create-form').addEventListener('submit', (event) =>
  saveCreateScenario(event).catch((error) => notify(error.message))
);
$('#locate-script').addEventListener('click', () => $('#create-script-file').click());
$('#create-script-file').addEventListener('change', (event) => {
  const file = event.target.files[0];
  if (file) $('#create-script-name').value = file.name;
});
$('#update-form').addEventListener('submit', (event) =>
  saveUpdatedScenario(event).catch((error) => notify(error.message))
);
$('#upload-form').addEventListener('submit', (event) =>
  uploadScenarioScript(event).catch((error) => notify(error.message))
);
$('#update-select').addEventListener('change', (event) => selectUpdateScenario(event.target.value));
$('#execute-select').addEventListener('change', renderExecuteDetails);
$('#runtime-select').addEventListener('change', (event) =>
  loadRun(event.target.value).catch((error) => notify(error.message))
);
$('#results-select').addEventListener('change', (event) =>
  loadSelectedResults(event.target.value).catch((error) => notify(error.message))
);
$('#refresh-results').addEventListener('click', () => loadResults().catch((error) => notify(error.message)));
$('#results-report').addEventListener('click', (event) => {
  const reportButton = event.target.closest('[data-report]');
  if (reportButton) return openReport(reportButton.dataset.report, reportButton.hasAttribute('data-download'));
  const button = event.target.closest('[data-ai-analyze]');
  if (button) analyzeResultsWithAi(button.dataset.aiAnalyze, button);
});
$('#update-run').addEventListener('click', () =>
  startRun($('#update-select').value).catch((error) => notify(error.message))
);
$('#execute-run').addEventListener('click', () =>
  startRun($('#execute-select').value).catch((error) => notify(error.message))
);
$('#refresh-scenarios').addEventListener('click', () => loadScenarios().catch((error) => notify(error.message)));
$('#refresh-runs').addEventListener('click', () => loadRuns().catch((error) => notify(error.message)));
$('#refresh-runtime').addEventListener('click', () =>
  loadRun($('#runtime-select').value).catch((error) => notify(error.message))
);
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

for (const form of [$('#create-form'), $('#update-form')]) {
  form.addEventListener('change', (event) => {
    if (['scriptSource', 'sharedScript'].includes(event.target.name)) updateSourceVisibility(form);
    if (event.target.name === 'runOn') updateGeneratorVisibility(form);
  });
  form
    .querySelector('.refresh-generators')
    .addEventListener('click', () => loadInfrastructure().catch((error) => notify(error.message)));
}
$('#refresh-generators').addEventListener('click', () => loadInfrastructure().catch((error) => notify(error.message)));
$('#generator-table').addEventListener('click', (event) => {
  const button = event.target.closest('[data-toggle-generator], [data-remove-generator]');
  if (button) updateGenerator(button).catch((error) => notify(error.message));
});

loadInfrastructure()
  .catch((error) => notify(error.message))
  .finally(() => loadScenarios().catch((error) => notify(error.message)));
loadRuns().catch((error) => notify(error.message));
