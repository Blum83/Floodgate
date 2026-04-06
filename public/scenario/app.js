// Floodgate — Scenario mode frontend

const api = {
  environments: '/api/environments',
  scenarios:    '/api/scenarios',
  runs:         '/api/runs',
  runScenario:  (id) => `/api/scenarios/${id}/run`,
  run:          (id) => `/api/runs/${id}`,
};

// ── State ────────────────────────────────────────────────────────────────────
let state = {
  environments: [],
  scenarios: [],
  currentEnvId: localStorage.getItem('fg_env') || '',
  runsPage: 1,
  runsTotal: 0,
  runsLimit: 20,
  histScenarioId: null,
  histMode: 'latency',
  histChart: null,
  histRuns: [],
};

// ── Navigation ───────────────────────────────────────────────────────────────
function navigate(page, params = {}) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.page === page);
  });

  const pageEl = document.getElementById('page-' + page);
  if (pageEl) pageEl.classList.add('active');

  switch (page) {
    case 'dashboard':    loadDashboard(); break;
    case 'scenarios':    loadScenarios(); break;
    case 'runs':         loadRuns(); break;
    case 'environments': loadEnvironments(); break;
    case 'run-detail':   loadRunDetail(params.id); break;
    case 'history':      loadHistory(params.scenarioId); break;
  }
}

document.querySelectorAll('.nav-tab').forEach(btn => {
  btn.addEventListener('click', () => navigate(btn.dataset.page));
});

// ── Environment selector ─────────────────────────────────────────────────────
async function loadEnvSelector() {
  const envs = await fetchJSON(api.environments);
  state.environments = envs;

  const sel = document.getElementById('globalEnvSelect');
  sel.innerHTML = '<option value="">— Select Environment —</option>' +
    envs.map(e => `<option value="${e.id}" ${e.id === state.currentEnvId ? 'selected' : ''}>${e.name}</option>`).join('');
}

// ── Dashboard ────────────────────────────────────────────────────────────────
async function loadDashboard() {
  const [scenarios, runsData] = await Promise.all([
    fetchJSON(api.scenarios),
    fetchJSON(api.runs + '?limit=100'),
  ]);

  state.scenarios = scenarios;
  const runs = runsData.items || [];

  const env = state.environments.find(e => e.id === state.currentEnvId);
  document.getElementById('dash-env-label').textContent = env ? env.name : 'No environment selected';

  document.getElementById('dash-scenarios-count').textContent = scenarios.length;

  const envRuns = state.currentEnvId ? runs.filter(r => r.environmentId === state.currentEnvId) : runs;
  document.getElementById('dash-runs-env-count').textContent = envRuns.length;

  const yesterday = Date.now() - 86400000;
  const runs24h = runs.filter(r => new Date(r.startedAt).getTime() > yesterday);
  document.getElementById('dash-runs-24h-count').textContent = runs24h.length;

  const latest = runs[0];
  if (latest) {
    const statusEl = document.getElementById('dash-latest-status');
    statusEl.textContent = latest.status.toUpperCase();
    statusEl.className = 'stat-val ' + (latest.status === 'completed' ? 'green' : latest.status === 'failed' ? 'red' : 'purple');
    document.getElementById('dash-latest-link').onclick = () => navigate('run-detail', { id: latest.id });
  }

  const tbody = document.getElementById('dash-runs-tbody');
  if (runs.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:24px">No runs yet</td></tr>';
    return;
  }
  tbody.innerHTML = runs.slice(0, 10).map(r => `
    <tr onclick="navigate('run-detail',{id:'${r.id}'})" class="clickable">
      <td><span class="uid-badge">${r.id.slice(0,8)}</span></td>
      <td style="color:var(--text)">${esc(r.scenarioName)}</td>
      <td>${esc(r.environmentName)}</td>
      <td>
        ${statusBadge(r.status)}
        ${r.status === 'running' ? `<span class="gatling-badge checking" style="margin-left:6px;font-size:0.58rem"><span id="run-live-log-${r.id}">starting…</span></span>` : ''}
      </td>
      <td>${fmtDate(r.startedAt)}</td>
    </tr>
  `).join('');
  // Start polling for any running run
  const running = runs.find(r => r.status === 'running');
  if (running) startRunPoller(running.id);
}

// ── Scenarios ────────────────────────────────────────────────────────────────
async function loadScenarios() {
  const scenarios = await fetchJSON(api.scenarios);
  state.scenarios = scenarios;

  const grid = document.getElementById('scenarios-grid');
  if (scenarios.length === 0) {
    grid.innerHTML = `<div class="empty-state">
      <div class="empty-icon">📋</div>
      <p>No scenarios yet</p>
      <button class="btn btn-primary" onclick="showScenarioEditor(null)">Create your first scenario</button>
    </div>`;
    return;
  }

  grid.innerHTML = scenarios.map(s => {
    const stepBadges = (s.steps || []).slice(0, 4).map(step =>
      `<span class="method-badge method-${step.method || 'GET'}">${step.method || 'GET'}</span>
       <span style="font-size:0.65rem;color:var(--muted)">${esc(step.path || '/')}</span>`
    ).join(' ');
    const moreSteps = (s.steps || []).length > 4 ? `<span style="font-size:0.62rem;color:var(--muted)">+${s.steps.length - 4} more</span>` : '';

    return `<div class="scenario-card">
      <div class="scenario-card-title">${esc(s.name)}</div>
      <div class="scenario-card-desc">${esc(s.description || 'No description')}</div>
      <div class="scenario-card-meta">Created by: admin &nbsp;·&nbsp; ${(s.steps||[]).length} step${(s.steps||[]).length !== 1 ? 's' : ''}</div>
      <div class="scenario-card-steps">${stepBadges}${moreSteps}</div>
      <div class="scenario-card-actions">
        <button class="btn btn-ghost btn-sm" onclick="showScenarioEditor('${s.id}')">Edit</button>
        <button class="btn btn-ghost btn-sm" onclick="navigate('history',{scenarioId:'${s.id}'})">History</button>
        <button class="btn btn-primary btn-sm" onclick="showNewRunModal('${s.id}')">▶ Run</button>
        <button class="btn btn-danger btn-sm" onclick="deleteScenario('${s.id}')">Delete</button>
      </div>
    </div>`;
  }).join('');
}

// ── Scenario Editor ──────────────────────────────────────────────────────────
let editorSteps = [];
let stepCounter = 0;

async function showScenarioEditor(scenarioId) {
  editorSteps = [];
  stepCounter = 0;
  document.getElementById('steps-container').innerHTML = '';
  document.getElementById('editor-scenario-id').value = '';
  document.getElementById('editor-name').value = '';
  document.getElementById('editor-desc').value = '';

  if (scenarioId) {
    const s = await fetchJSON(api.scenarios + '/' + scenarioId);
    document.getElementById('editor-scenario-id').value = s.id;
    document.getElementById('editor-name').value = s.name;
    document.getElementById('editor-desc').value = s.description || '';
    document.getElementById('editor-title').textContent = 'Edit Scenario';
    document.getElementById('save-scenario-btn').textContent = 'Update Scenario';
    (s.steps || []).forEach(step => addStep(step));
  } else {
    document.getElementById('editor-title').textContent = 'New Scenario';
    document.getElementById('save-scenario-btn').textContent = 'Create Scenario';
    addStep();
  }

  navigate('scenario-editor');
}

function addStep(data = {}) {
  stepCounter++;
  const sid = 'step-' + stepCounter;
  editorSteps.push({ id: sid, ...data });

  const div = document.createElement('div');
  div.className = 'step-card';
  div.id = 'stepcard-' + sid;
  div.innerHTML = `
    <div class="step-header">
      <span class="step-num">STEP ${editorSteps.length}</span>
      <input class="step-name-input" type="text" placeholder="Step name (optional)" value="${esc(data.name || '')}">
      <div class="step-reorder">
        <button onclick="moveStep('${sid}', -1)" title="Move up">↑</button>
        <button onclick="moveStep('${sid}', 1)" title="Move down">↓</button>
      </div>
      <button class="step-del" onclick="removeStep('${sid}')" title="Remove step">✕</button>
    </div>
    <div class="step-body">
      <div class="field"><label>Method &amp; Endpoint Path</label>
        <div class="step-url-row">
          <select id="${sid}-method">
            ${['GET','POST','PUT','DELETE','PATCH'].map(m => `<option ${(data.method||'GET')===m?'selected':''}>${m}</option>`).join('')}
          </select>
          <input type="text" id="${sid}-path" placeholder="/api/endpoint" value="${esc(data.path || '')}">
        </div>
      </div>

      <div class="field">
        <label>Headers <span style="color:var(--muted);font-weight:400">(one per line: Key: Value. Use {{variable}} for vars)</span></label>
        <textarea id="${sid}-headers" rows="2" style="font-size:0.72rem">${esc(data.headers || '')}</textarea>
      </div>

      <div class="field">
        <label>Think Time (s) <span style="color:var(--muted);font-weight:400">(e.g. <b>1</b> fixed · <b>0.5-3</b> random range · <b>0</b> none)</span></label>
        <input type="text" id="${sid}-thinktime" placeholder="1" value="${esc(String(data.thinkTime !== undefined ? data.thinkTime : '1'))}">
      </div>

      <button class="step-expand-btn" onclick="toggleAdvanced('${sid}')">▸ Show Body, Checks &amp; Extraction</button>

      <div class="step-advanced" id="${sid}-advanced">
        <div class="field">
          <label>Request Body Template <span style="color:var(--muted);font-weight:400">(JSON with {{variables}})</span></label>
          <textarea id="${sid}-body" rows="4" style="font-size:0.72rem">${esc(data.body || '')}</textarea>
        </div>
        <div class="field">
          <label>Query Parameters <span style="color:var(--muted);font-weight:400">(one per line: key=value)</span></label>
          <textarea id="${sid}-query" rows="2" style="font-size:0.72rem">${esc(data.queryParams || '')}</textarea>
        </div>
        <div class="field">
          <label>Checks</label>
          <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px">
            <div class="field">
              <label style="font-size:0.58rem">Expected Status</label>
              <input type="number" id="${sid}-check-status" placeholder="200" value="${data.checks?.statusCode || 200}">
            </div>
            <div class="field">
              <label style="font-size:0.58rem">Max Response Time (ms)</label>
              <input type="number" id="${sid}-check-rt" placeholder="optional" value="${data.checks?.maxResponseTime || ''}">
            </div>
            <div class="field">
              <label style="font-size:0.58rem">Body Contains</label>
              <input type="text" id="${sid}-check-body" placeholder="optional" value="${esc(data.checks?.bodyContains || '')}">
            </div>
          </div>
        </div>
        <div class="field">
          <label>Response Extraction Rules</label>
          <div class="extraction-list" id="${sid}-extractions"></div>
          <button class="btn btn-outline btn-sm" style="margin-top:6px" onclick="addExtraction('${sid}')">+ Add Extraction Rule</button>
        </div>
      </div>
    </div>
  `;

  document.getElementById('steps-container').appendChild(div);

  // Render existing extractions
  (data.extractions || []).forEach(ex => addExtraction(sid, ex));

  // Auto-open advanced if there's body/query/extractions/checks
  if (data.body || data.queryParams ||
      (data.extractions && data.extractions.length > 0) ||
      (data.checks && Object.keys(data.checks).length > 0)) {
    toggleAdvanced(sid, true);
  }

  renumberSteps();
}

function toggleAdvanced(sid, forceOpen = null) {
  const adv = document.getElementById(sid + '-advanced');
  const btn = adv.previousElementSibling;
  const isOpen = adv.classList.contains('open');
  const open = forceOpen !== null ? forceOpen : !isOpen;
  adv.classList.toggle('open', open);
  btn.textContent = open ? '▾ Hide Body & Extraction' : '▸ Show Body & Extraction';
}

function addExtraction(sid, data = {}) {
  const list = document.getElementById(sid + '-extractions');
  if (!list) return;
  const row = document.createElement('div');
  row.className = 'extraction-row';
  row.innerHTML = `
    <input type="text" placeholder="varName" value="${esc(data.varName || '')}" style="max-width:130px">
    <span class="eq">←</span>
    <input type="text" placeholder="$.json.path" value="${esc(data.jsonPath || '')}">
    <button class="btn btn-danger btn-sm" onclick="this.closest('.extraction-row').remove()">✕</button>
  `;
  list.appendChild(row);
}

function removeStep(sid) {
  const idx = editorSteps.findIndex(s => s.id === sid);
  if (idx !== -1) editorSteps.splice(idx, 1);
  const card = document.getElementById('stepcard-' + sid);
  if (card) card.remove();
  renumberSteps();
}

function moveStep(sid, dir) {
  const container = document.getElementById('steps-container');
  const cards = Array.from(container.querySelectorAll('.step-card'));
  const idx = cards.findIndex(c => c.id === 'stepcard-' + sid);
  const newIdx = idx + dir;
  if (newIdx < 0 || newIdx >= cards.length) return;
  if (dir === -1) container.insertBefore(cards[idx], cards[newIdx]);
  else            container.insertBefore(cards[newIdx], cards[idx]);
  renumberSteps();
}

function renumberSteps() {
  const cards = document.querySelectorAll('#steps-container .step-card');
  cards.forEach((card, i) => {
    const badge = card.querySelector('.step-num');
    if (badge) badge.textContent = 'STEP ' + (i + 1);
  });
}

function collectSteps() {
  const steps = [];
  document.querySelectorAll('#steps-container .step-card').forEach(card => {
    const sid = card.id.replace('stepcard-', '');
    const extractions = [];
    card.querySelectorAll('.extraction-row').forEach(row => {
      const inputs = row.querySelectorAll('input');
      const varName  = inputs[0]?.value.trim();
      const jsonPath = inputs[1]?.value.trim();
      if (varName && jsonPath) extractions.push({ varName, jsonPath });
    });
    const checkStatus = document.getElementById(sid + '-check-status')?.value.trim();
    const checkRt     = document.getElementById(sid + '-check-rt')?.value.trim();
    const checkBody   = document.getElementById(sid + '-check-body')?.value.trim();
    const checks = {};
    if (checkStatus) checks.statusCode       = Number(checkStatus);
    if (checkRt)     checks.maxResponseTime  = Number(checkRt);
    if (checkBody)   checks.bodyContains     = checkBody;

    steps.push({
      name:        card.querySelector('.step-name-input')?.value.trim() || '',
      method:      document.getElementById(sid + '-method')?.value || 'GET',
      path:        document.getElementById(sid + '-path')?.value.trim() || '/',
      headers:     document.getElementById(sid + '-headers')?.value.trim() || '',
      body:        document.getElementById(sid + '-body')?.value.trim() || '',
      queryParams: document.getElementById(sid + '-query')?.value.trim() || '',
      thinkTime:   document.getElementById(sid + '-thinktime')?.value.trim() ?? '1',
      checks,
      extractions,
    });
  });
  return steps;
}

async function saveScenario() {
  const id   = document.getElementById('editor-scenario-id').value;
  const name = document.getElementById('editor-name').value.trim();
  const desc = document.getElementById('editor-desc').value.trim();
  const steps = collectSteps();

  if (!name) { alert('Scenario name is required'); return; }

  const btn = document.getElementById('save-scenario-btn');
  btn.disabled = true;

  try {
    if (id) {
      await fetchJSON(api.scenarios + '/' + id, 'PUT', { name, description: desc, steps });
    } else {
      await fetchJSON(api.scenarios, 'POST', { name, description: desc, steps });
    }
    navigate('scenarios');
  } catch (e) {
    alert('Error: ' + e.message);
  } finally {
    btn.disabled = false;
  }
}

async function deleteScenario(id) {
  if (!confirm('Delete this scenario?')) return;
  await fetchJSON(api.scenarios + '/' + id, 'DELETE');
  loadScenarios();
}

// ── Test Runs ────────────────────────────────────────────────────────────────
async function loadRuns() {
  const params = new URLSearchParams();
  params.set('page', state.runsPage);
  params.set('limit', state.runsLimit);

  const from     = document.getElementById('filter-from')?.value;
  const to       = document.getElementById('filter-to')?.value;
  const scenario = document.getElementById('filter-scenario')?.value;
  const env      = document.getElementById('filter-env')?.value;

  if (from)     params.set('from', from);
  if (to)       params.set('to', to + 'T23:59:59');
  if (scenario) params.set('scenarioId', scenario);
  if (env)      params.set('environmentId', env);

  const data = await fetchJSON(api.runs + '?' + params.toString());
  const runs = data.items || [];
  state.runsTotal = data.total || 0;

  // Populate filter dropdowns
  populateRunFilters();

  const tbody = document.getElementById('runs-tbody');
  if (runs.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:24px">No runs found</td></tr>';
  } else {
    tbody.innerHTML = runs.map(r => `
      <tr onclick="navigate('run-detail',{id:'${r.id}'})" class="clickable">
        <td><span class="uid-badge">${r.id.slice(0,8)}</span></td>
        <td style="color:var(--text)">${esc(r.scenarioName)}</td>
        <td>${esc(r.environmentName)}</td>
        <td>${statusBadge(r.status)}</td>
        <td>${fmtDate(r.startedAt)}</td>
        <td>${r.status === 'completed' ? `<button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();navigate('run-detail',{id:'${r.id}'})">View →</button>` : '—'}</td>
      </tr>
    `).join('');
  }

  // Pagination
  const total = state.runsTotal;
  const page  = state.runsPage;
  const limit = state.runsLimit;
  const pages = Math.ceil(total / limit);
  document.getElementById('runs-pagination-info').textContent =
    `Page ${page} of ${Math.max(1,pages)} · ${total} total`;
  document.getElementById('runs-prev-btn').disabled = page <= 1;
  document.getElementById('runs-next-btn').disabled = page >= pages;
}

function runsChangePage(dir) {
  state.runsPage = Math.max(1, state.runsPage + dir);
  loadRuns();
}

function clearRunFilters() {
  document.getElementById('filter-from').value = '';
  document.getElementById('filter-to').value   = '';
  document.getElementById('filter-scenario').value = '';
  document.getElementById('filter-env').value  = '';
  state.runsPage = 1;
  loadRuns();
}

function populateRunFilters() {
  const scenSel = document.getElementById('filter-scenario');
  const envSel  = document.getElementById('filter-env');
  const curScen = scenSel.value;
  const curEnv  = envSel.value;

  scenSel.innerHTML = '<option value="">Any</option>' +
    state.scenarios.map(s => `<option value="${s.id}" ${s.id===curScen?'selected':''}>${esc(s.name)}</option>`).join('');
  envSel.innerHTML = '<option value="">Any</option>' +
    state.environments.map(e => `<option value="${e.id}" ${e.id===curEnv?'selected':''}>${esc(e.name)}</option>`).join('');
}

// ── Run Detail ───────────────────────────────────────────────────────────────
async function loadRunDetail(id) {
  const run = await fetchJSON(api.run(id));

  document.getElementById('run-detail-title').textContent = 'Test Run ' + run.id.slice(0,8);
  document.getElementById('run-detail-sub').textContent   = run.scenarioName + ' · ' + run.environmentName;
  document.getElementById('run-detail-status-badge').innerHTML = statusBadge(run.status);

  document.getElementById('rd-status').innerHTML   = statusBadge(run.status);
  document.getElementById('rd-env').textContent     = run.environmentName;
  document.getElementById('rd-host').textContent    = run.targetHost;
  document.getElementById('rd-vus').textContent     = run.loadModel === 'arrival-rate'
    ? (run.arrivalRate + ' users/sec')
    : (run.vus + ' VUs');
  document.getElementById('rd-duration').textContent = run.duration + 's';
  document.getElementById('rd-started').textContent  = fmtDate(run.startedAt);
  document.getElementById('rd-finished').textContent = run.finishedAt ? fmtDate(run.finishedAt) : '—';

  if (run.error) {
    document.getElementById('rd-error-block').style.display = 'block';
    document.getElementById('rd-error').textContent = run.error;
  }

  if (run.metrics) {
    document.getElementById('rd-metrics-block').style.display = 'block';
    const m = run.metrics;
    const lat = m.latency || {};
    const grid = document.getElementById('rd-metrics-grid');
    grid.innerHTML = [
      { val: m.totalRequests || 0, lbl: 'Total Requests', cls: '' },
      { val: m.totalRequests - Math.round((m.errorRate||0) * (m.totalRequests||0)), lbl: 'Success', cls: 'green' },
      { val: Math.round((m.errorRate||0) * (m.totalRequests||0)), lbl: 'Failed', cls: 'red' },
      { val: (m.rps||0).toFixed(1), lbl: 'Avg RPS', cls: '' },
      { val: fmtMs(lat.p50), lbl: 'P50', cls: 'purple' },
      { val: fmtMs(lat.p75), lbl: 'P75', cls: 'purple' },
      { val: fmtMs(lat.p95), lbl: 'P95', cls: 'purple' },
      { val: fmtMs(lat.p99), lbl: 'P99', cls: 'purple' },
      { val: fmtMs(lat.min), lbl: 'Min', cls: '' },
      { val: fmtMs(lat.max), lbl: 'Max', cls: '' },
      { val: fmtMs(lat.avg), lbl: 'Mean', cls: '' },
      { val: run.duration + 's', lbl: 'Duration', cls: '' },
    ].map(c => `<div class="metric-card"><div class="m-val ${c.cls}">${c.val}</div><div class="m-lbl">${c.lbl}</div></div>`).join('');
  }
}

// ── Environments ─────────────────────────────────────────────────────────────
async function loadEnvironments() {
  const envs = await fetchJSON(api.environments);
  state.environments = envs;

  const tbody = document.getElementById('envs-tbody');
  if (envs.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:24px">No environments yet</td></tr>';
    return;
  }
  tbody.innerHTML = envs.map(e => `
    <tr>
      <td style="color:var(--text);font-weight:600">${esc(e.name)}</td>
      <td style="color:var(--blue)">${esc(e.host)}</td>
      <td>${esc(e.description || '—')}</td>
      <td>${fmtDate(e.createdAt, true)}</td>
      <td>
        <div style="display:flex;gap:6px">
          <button class="btn btn-ghost btn-sm" onclick="showEnvModal('${e.id}')">Edit</button>
          <button class="btn btn-danger btn-sm" onclick="deleteEnv('${e.id}')">Delete</button>
        </div>
      </td>
    </tr>
  `).join('');
}

function showEnvModal(id) {
  const env = id ? state.environments.find(e => e.id === id) : null;
  document.getElementById('env-modal-id').value    = env ? env.id : '';
  document.getElementById('env-modal-name').value  = env ? env.name : '';
  document.getElementById('env-modal-host').value  = env ? env.host : '';
  document.getElementById('env-modal-desc').value  = env ? env.description : '';
  document.getElementById('env-modal-title').textContent = env ? 'Edit Environment' : 'New Environment';
  document.getElementById('env-modal').style.display = 'flex';
}

function closeEnvModal() {
  document.getElementById('env-modal').style.display = 'none';
}

async function saveEnv() {
  const id   = document.getElementById('env-modal-id').value;
  const name = document.getElementById('env-modal-name').value.trim();
  const host = document.getElementById('env-modal-host').value.trim();
  const desc = document.getElementById('env-modal-desc').value.trim();

  if (!name || !host) { alert('Name and Host are required'); return; }

  try {
    if (id) {
      await fetchJSON(api.environments + '/' + id, 'PUT', { name, host, description: desc });
    } else {
      await fetchJSON(api.environments, 'POST', { name, host, description: desc });
    }
    closeEnvModal();
    await loadEnvSelector();
    loadEnvironments();
  } catch (e) {
    alert('Error: ' + e.message);
  }
}

async function deleteEnv(id) {
  if (!confirm('Delete this environment?')) return;
  await fetchJSON(api.environments + '/' + id, 'DELETE');
  await loadEnvSelector();
  loadEnvironments();
}

// ── New Run Modal ─────────────────────────────────────────────────────────────
function showNewRunModal(preselectedScenarioId = null) {
  const scenSel = document.getElementById('run-modal-scenario');
  const envSel  = document.getElementById('run-modal-env');

  scenSel.innerHTML = state.scenarios.map(s =>
    `<option value="${s.id}" ${s.id === preselectedScenarioId ? 'selected' : ''}>${esc(s.name)}</option>`
  ).join('');
  envSel.innerHTML = state.environments.map(e =>
    `<option value="${e.id}" ${e.id === state.currentEnvId ? 'selected' : ''}>${esc(e.name)}</option>`
  ).join('');

  if (state.scenarios.length === 0) { alert('Create a scenario first'); return; }
  if (state.environments.length === 0) { alert('Create an environment first'); return; }

  document.getElementById('run-modal').style.display = 'flex';
}

function closeRunModal() {
  document.getElementById('run-modal').style.display = 'none';
}

function updateLoadModelUI() {
  const model = document.getElementById('run-modal-load-model').value;
  document.getElementById('run-modal-vus-section').style.display     = model === 'vus' ? 'block' : 'none';
  document.getElementById('run-modal-arrival-section').style.display = model === 'arrival-rate' ? 'block' : 'none';
}

async function startRun() {
  const scenarioId    = document.getElementById('run-modal-scenario').value;
  const environmentId = document.getElementById('run-modal-env').value;
  const loadModel     = document.getElementById('run-modal-load-model').value;

  if (!scenarioId || !environmentId) { alert('Select scenario and environment'); return; }

  let payload = { environmentId, loadModel };

  if (loadModel === 'arrival-rate') {
    payload.arrivalRate      = Number(document.getElementById('run-modal-rate').value) || 10;
    payload.duration         = Number(document.getElementById('run-modal-duration-ar').value) || 30;
    payload.rampUp           = Number(document.getElementById('run-modal-rampup-ar').value) || 0;
    payload.preAllocatedVUs  = Number(document.getElementById('run-modal-prealloc').value) || 50;
  } else {
    payload.vus      = Number(document.getElementById('run-modal-vus').value) || 10;
    payload.duration = Number(document.getElementById('run-modal-duration').value) || 30;
    payload.rampUp   = Number(document.getElementById('run-modal-rampup').value) || 0;
  }

  const btn = document.getElementById('run-modal-start-btn');
  btn.disabled = true;
  btn.textContent = 'Starting...';

  try {
    await fetchJSON(api.runScenario(scenarioId), 'POST', payload);
    closeRunModal();
    state.runsPage = 1;
    navigate('runs');
  } catch (e) {
    alert('Error starting run: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Run';
  }
}

// ── Performance History ──────────────────────────────────────────────────────
async function loadHistory(scenarioId) {
  state.histScenarioId = scenarioId;
  const scenario = state.scenarios.find(s => s.id === scenarioId);
  document.getElementById('hist-title').textContent = 'Performance History';
  document.getElementById('hist-sub').textContent   = scenario ? scenario.name : '';

  const data = await fetchJSON(api.runs + '?scenarioId=' + scenarioId + '&limit=50');
  state.histRuns = (data.items || []).filter(r => r.status === 'completed' && r.metrics).reverse();

  renderHistChart(state.histRuns, state.histMode);
  renderHistTable(state.histRuns);
}

function switchHistChart(mode) {
  state.histMode = mode;
  document.getElementById('hist-btn-latency').classList.toggle('active', mode === 'latency');
  document.getElementById('hist-btn-rps').classList.toggle('active', mode === 'rps');
  if (state.histRuns.length) renderHistChart(state.histRuns, mode);
}

function renderHistChart(runs, mode) {
  if (state.histChart) { state.histChart.destroy(); state.histChart = null; }

  const labels = runs.map(r => fmtDate(r.startedAt, true));
  let datasets;

  if (mode === 'latency') {
    datasets = [
      { label: 'p50', data: runs.map(r => r.metrics?.latency?.p50 || 0), borderColor: '#22c55e', backgroundColor: 'transparent', tension: 0.3 },
      { label: 'p95', data: runs.map(r => r.metrics?.latency?.p95 || 0), borderColor: '#3b82f6', backgroundColor: 'transparent', tension: 0.3 },
      { label: 'p99', data: runs.map(r => r.metrics?.latency?.p99 || 0), borderColor: '#ef4444', backgroundColor: 'transparent', tension: 0.3 },
    ];
  } else {
    datasets = [
      { label: 'RPS', data: runs.map(r => r.metrics?.rps || 0), borderColor: '#a78bfa', backgroundColor: 'rgba(124,58,237,0.15)', fill: true, tension: 0.3 },
    ];
  }

  state.histChart = new Chart(document.getElementById('hist-chart'), {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      scales: {
        y: { beginAtZero: true, ticks: { color: '#94a3b8' }, grid: { color: '#1e2a3a' } },
        x: { ticks: { color: '#94a3b8' }, grid: { color: '#1e2a3a' } },
      },
      plugins: { legend: { labels: { color: '#94a3b8', font: { family: 'JetBrains Mono' } } } },
    },
  });
}

function renderHistTable(runs) {
  const tbody = document.getElementById('hist-tbody');
  if (runs.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--muted);padding:24px">No completed runs</td></tr>';
    return;
  }
  tbody.innerHTML = [...runs].reverse().map(r => {
    const m = r.metrics || {};
    const lat = m.latency || {};
    const success = m.totalRequests ? Math.round((1 - (m.errorRate||0)) * 100) : 100;
    return `<tr onclick="navigate('run-detail',{id:'${r.id}'})" class="clickable">
      <td>${fmtDate(r.startedAt)}</td>
      <td>${m.totalRequests || '—'}</td>
      <td style="color:${(m.errorRate||0)>0?'var(--red)':'var(--green)'}">${Math.round((m.errorRate||0)*(m.totalRequests||0))}</td>
      <td>${fmtMs(lat.p50)}</td>
      <td>${fmtMs(lat.p95)}</td>
      <td>${fmtMs(lat.p99)}</td>
      <td>${(m.rps||0).toFixed(1)}</td>
      <td style="color:${success===100?'var(--green)':'var(--yellow)'}">${success.toFixed(1)}%</td>
    </tr>`;
  }).join('');
}

// ── Utilities ────────────────────────────────────────────────────────────────
async function fetchJSON(url, method = 'GET', body = null) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(err.error || 'Request failed');
  }
  if (method === 'DELETE') return {};
  return res.json();
}

function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtDate(iso, short = false) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (short) return d.toLocaleDateString();
  return d.toLocaleString();
}

function fmtMs(n) {
  if (n === undefined || n === null || isNaN(n)) return '—';
  if (n < 1000) return n.toFixed(1) + ' ms';
  return (n / 1000).toFixed(2) + 's';
}

function statusBadge(status) {
  const map = {
    completed: 'badge-green',
    running:   'badge-purple',
    failed:    'badge-red',
    pending:   'badge-yellow',
  };
  return `<span class="badge ${map[status] || 'badge-blue'}">${status || '—'}</span>`;
}

// ── Gatling status badge ──────────────────────────────────────────────────────
async function checkGatlingStatus() {
  const badge = document.getElementById('gatlingBadge');
  if (!badge) return;
  try {
    const data = await fetchJSON('/api/status');
    if (data.hasGatling) {
      const ver = (data.gatlingVersion || '').split('\n')[0].trim().slice(0, 30);
      badge.className = 'gatling-badge ready';
      badge.textContent = '⬡ Gatling ' + (ver || 'ready');
    } else {
      badge.className = 'gatling-badge checking';
      badge.textContent = '⬡ Gatling not found';
    }
  } catch {
    badge.className = 'gatling-badge checking';
    badge.textContent = '⬡ Gatling…';
  }
}

// Poll a running run and show live log in the runs table
let runPoller = null;
function startRunPoller(runId) {
  if (runPoller) clearInterval(runPoller);
  runPoller = setInterval(async () => {
    try {
      const run = await fetchJSON(`/api/runs/${runId}`);
      const logEl = document.getElementById('run-live-log-' + runId);
      if (logEl && run.log) {
        const isDownload = /download|fetch|install|progress/i.test(run.log);
        logEl.parentElement.className = 'gatling-badge ' + (isDownload ? 'download' : 'checking');
        logEl.textContent = run.log.length > 60 ? run.log.slice(0, 60) + '…' : run.log;
      }
      if (run.status !== 'running') {
        clearInterval(runPoller);
        runPoller = null;
        loadRuns();
      }
    } catch { clearInterval(runPoller); runPoller = null; }
  }, 1500);
}

// ── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  await loadEnvSelector();
  checkGatlingStatus();

  // Single listener for the global environment selector — added once here to
  // avoid duplicating listeners each time loadEnvSelector() is called.
  document.getElementById('globalEnvSelect').addEventListener('change', function () {
    state.currentEnvId = this.value;
    localStorage.setItem('fg_env', this.value);
    if (document.getElementById('page-dashboard').classList.contains('active')) loadDashboard();
  });

  navigate('dashboard'); // loadDashboard() populates state.scenarios
}

document.addEventListener('DOMContentLoaded', init);
