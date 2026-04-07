// Floodgate frontend for multiple concurrent k6 tests
const api = {
  status: '/api/status',
  run: '/api/run-test',
  progress: function(id){ return '/api/progress/' + id; },
  results: function(id){ return '/api/results/' + id; },
  activeTests: '/api/active-tests'
};

let latChart = null;
let statusChart = null;
let testSources = {}; // Map of testId -> EventSource

function addHeaderRow(testId, key, value) {
  key = key || '';
  value = value || '';
  const container = document.getElementById('headers-' + testId);
  if (!container) return;
  const row = document.createElement('div');
  row.className = 'header-row';

  const keyInput = document.createElement('input');
  keyInput.type = 'text';
  keyInput.placeholder = 'Name';
  keyInput.value = key;

  const valueInput = document.createElement('input');
  valueInput.type = 'text';
  valueInput.placeholder = 'Value';
  valueInput.value = value;

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'btn-sm';
  removeBtn.textContent = '✕';
  removeBtn.addEventListener('click', function(){ row.remove(); });

  row.appendChild(keyInput);
  row.appendChild(valueInput);
  row.appendChild(removeBtn);
  container.appendChild(row);
}

function collectHeaders(testId) {
  var headers = {};
  var container = document.getElementById('headers-' + testId);
  if (!container) return headers;
  var rows = container.querySelectorAll('.header-row');
  rows.forEach(function(row){
    var inputs = row.querySelectorAll('input');
    var key = inputs[0] ? inputs[0].value.trim() : '';
    var val = inputs[1] ? inputs[1].value.trim() : '';
    if (key) headers[key] = val;
  });
  return headers;
}

function createTestCard(testId, config) {
  const title = !config.url ? 'New Test' : config.url.length > 40 ? config.url.substring(0, 40) + '...' : config.url;

  const card = document.createElement('div');
  card.className = 'test-item';
  card.id = 'test-' + testId;
  card.innerHTML = `
    <div class="test-item-header">
      <div class="test-item-title">${title}</div>
      <div class="test-item-actions">
        <button type="button" class="remove-test-btn" data-testid="${testId}">✕ Remove</button>
      </div>
    </div>
    <form id="form-${testId}">
      <div class="url-row">
        <select id="method-${testId}">
          <option>GET</option><option>POST</option><option>PUT</option><option>DELETE</option><option>PATCH</option>
        </select>
        <input type="url" id="url-${testId}" value="${escapeAttr(config.url)}" placeholder="https://example.com/api">
      </div>
      <div class="field" style="margin-top:12px">
        <label>Authorization <span style="color:#334155;font-size:0.6rem">(optional)</span></label>
        <select id="authType-${testId}" class="auth-type-select" data-testid="${testId}" style="margin-bottom:8px">
          <option value="none">None</option>
          <option value="bearer">Bearer Token</option>
          <option value="basic">Basic Auth</option>
          <option value="apikey">API Key</option>
        </select>
        <div id="authFields-${testId}" style="display:none;flex-direction:column;gap:6px"></div>
      </div>
      <div class="field" style="margin-top:12px">
        <label>Headers</label>
        <div id="headers-${testId}" style="display:flex;flex-direction:column;gap:4px"></div>
        <button type="button" class="add-header-btn btn-sm" data-testid="${testId}" style="margin-top:4px">+ Add Header</button>
      </div>
      <div class="field" style="margin-top:12px">
        <label>Body <span style="color:#334155;font-size:0.6rem">(optional)</span></label>
        <textarea id="body-${testId}" rows="2" style="font-size:0.7rem"></textarea>
      </div>
      <div class="config-row spacer">
        <div class="field">
          <label>VUS <span style="color:#334155;font-size:0.6rem">(max 5000)</span></label>
          <input type="number" id="vus-${testId}" min="1" max="5000" value="${config.vus || 50}" required>
        </div>
        <div class="field">
          <label>Duration (s)</label>
          <input type="number" id="duration-${testId}" min="1" value="${config.duration || 30}" required>
        </div>
        <div class="field">
          <label>Ramp-up (s)</label>
          <input type="number" id="rampUp-${testId}" min="0" value="${config.rampUp || 0}">
        </div>
      </div>
      <div class="field spacer">
        <label>Proxies <span style="color:#334155;font-size:0.6rem">(optional — one per line, distributed across VUs)</span></label>
        <textarea id="proxies-${testId}" rows="2" placeholder="http://1.2.3.4:8080&#10;socks5://user:pass@5.6.7.8:1080" style="font-size:0.72rem;resize:vertical"></textarea>
      </div>
    </form>
    <div style="display:flex;gap:8px;margin-top:12px;padding-top:12px;border-top:1px solid #1e2a3a;">
      <button type="button" class="run-one-btn run-btn" data-testid="${testId}">▶ Run This Test</button>
      <button type="button" class="stop-one-btn btn-stop-one" data-testid="${testId}">⏹ Stop</button>
    </div>
  `;

  return card;
}

function renderAuthFields(testId) {
  const type = document.getElementById('authType-' + testId).value;
  const container = document.getElementById('authFields-' + testId);
  if (!container) return;

  if (type === 'none') {
    container.style.display = 'none';
    container.innerHTML = '';
    return;
  }

  container.style.display = 'flex';

  if (type === 'bearer') {
    container.innerHTML = '<label style="font-size:0.6rem;color:#64748b;margin-bottom:2px">TOKEN</label><input type="text" id="authToken-' + testId + '">';
  } else if (type === 'basic') {
    container.innerHTML =
      '<label style="font-size:0.6rem;color:#64748b;margin-bottom:2px">USERNAME</label><input type="text" id="authUser-' + testId + '">' +
      '<label style="font-size:0.6rem;color:#64748b;margin-bottom:2px;margin-top:4px">PASSWORD</label><input type="password" id="authPass-' + testId + '">';
  } else if (type === 'apikey') {
    container.innerHTML =
      '<label style="font-size:0.6rem;color:#64748b;margin-bottom:2px">HEADER NAME</label><input type="text" id="authKeyName-' + testId + '">' +
      '<label style="font-size:0.6rem;color:#64748b;margin-bottom:2px;margin-top:4px">KEY VALUE</label><input type="text" id="authKeyValue-' + testId + '">';
  }
}

function collectAuth(testId) {
  const typeEl = document.getElementById('authType-' + testId);
  if (!typeEl) return null;
  const type = typeEl.value;

  if (type === 'bearer') {
    const token = document.getElementById('authToken-' + testId);
    return token && token.value.trim() ? { type: 'bearer', token: token.value.trim() } : null;
  }
  if (type === 'basic') {
    const user = document.getElementById('authUser-' + testId);
    const pass = document.getElementById('authPass-' + testId);
    if (user && user.value.trim()) {
      return { type: 'basic', username: user.value.trim(), password: pass ? pass.value : '' };
    }
    return null;
  }
  if (type === 'apikey') {
    const name = document.getElementById('authKeyName-' + testId);
    const value = document.getElementById('authKeyValue-' + testId);
    if (name && name.value.trim() && value && value.value.trim()) {
      return { type: 'apikey', headerName: name.value.trim(), headerValue: value.value.trim() };
    }
    return null;
  }
  return null;
}

function escapeAttr(str) {
  if (!str) return str;
  return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function collectConfig(testId) {
  var headers = collectHeaders(testId);
  var auth = collectAuth(testId);

  if (auth) {
    if (auth.type === 'bearer') {
      headers['Authorization'] = 'Bearer ' + auth.token;
    } else if (auth.type === 'basic') {
      headers['Authorization'] = 'Basic ' + btoa(auth.username + ':' + auth.password);
    } else if (auth.type === 'apikey') {
      headers[auth.headerName] = auth.headerValue;
    }
  }

  return {
    url: document.getElementById(`url-${testId}`).value.trim(),
    method: document.getElementById(`method-${testId}`).value.trim(),
    headers: headers,
    body: document.getElementById(`body-${testId}`).value.trim(),
    vus: Number(document.getElementById(`vus-${testId}`).value),
    duration: Number(document.getElementById(`duration-${testId}`).value),
    rampUp: Number(document.getElementById(`rampUp-${testId}`).value) || 0,
    proxies: (document.getElementById(`proxies-${testId}`)?.value || '')
      .split('\n').map(s => s.trim()).filter(Boolean),
  };
}

function stopTest(testId) {
  const source = testSources[testId];
  if (source) {
    source.close();
    testSources[testId] = null;
  }

  fetch(api.run, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ testId, action: 'stop' })
  }).then(() => {
    updateActiveTests();
  }).catch(() => {});
}

function startTest(testId) {
  const config = collectConfig(testId);

  if (!config.url) {
    alert('Target URL is required');
    return;
  }

  const card = document.getElementById(`test-${testId}`);
  const runBtn = card ? card.querySelector('.run-one-btn') : null;
  const stopBtn = card ? card.querySelector('.stop-one-btn') : null;

  document.getElementById('rawLog').textContent = `Starting test #${testId}...\n`;
  document.getElementById('resultsPanel').style.display = 'block';

  if (runBtn) { runBtn.disabled = true; runBtn.textContent = 'RUNNING...'; }
  if (stopBtn) { stopBtn.disabled = false; }

  function resetButtons() {
    if (runBtn) { runBtn.disabled = false; runBtn.textContent = '▶ Run This Test'; }
    if (stopBtn) { stopBtn.disabled = true; }
  }

  fetch(api.run, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config)
  }).then(function(res){
    if (!res.ok) {
      return res.json().then(function(err){ throw new Error(err.error || 'Could not start test'); });
    }
    return res.json();
  }).then(function(body){
    var sseTestId = body.testId;

    const eventSource = new EventSource(api.progress(sseTestId));
    testSources[testId] = eventSource;

    eventSource.onmessage = function(evt){
      var data = JSON.parse(evt.data);
      if (data.type === 'progress') {
        updateProgress(data.progress);
      }
      if (data.type === 'log') {
        appendRawLog(data.text);
      }
      if (data.type === 'metrics') {
        updateProgress(data.progress);
        displayLiveMetrics(data.data);
      }
      if (data.type === 'done') {
        eventSource.close();
        testSources[testId] = null;
        resetButtons();
        updateProgress(100);
        document.getElementById('progStatus').textContent = data.error ? 'Test failed' : 'Test complete';

        if (data.error) {
          console.log('Test #' + sseTestId + ' failed: ' + data.error);
        } else if (data.metrics) {
          displayResults(data.metrics);
        } else {
          fetchAndShowResults(sseTestId);
        }
        updateActiveTests();
      }
    };

    eventSource.onerror = function(){
      appendRawLog('\n[SSE] Connection lost\n');
      eventSource.close();
      testSources[testId] = null;
      resetButtons();
      updateActiveTests();
    };
  }).catch(function(err){
    resetButtons();
    console.error('Test start failed:', err.message);
    appendRawLog('Error: ' + err.message + '\n');
  });
}

function updateActiveTests() {
  fetch(api.activeTests).then(res => res.json()).then(data => {
    document.getElementById('activeCount').textContent = data.count;
    document.getElementById('slotCount').textContent = data.availableSlots;
    document.getElementById('vusCount').textContent = data.availableVus;
    document.getElementById('availSlots').textContent = data.availableSlots;
  }).catch(() => {});
}

function updateProgress(progress) {
  document.getElementById('progressPanel').style.display = 'block';
  document.getElementById('progFill').style.width = progress + '%';
  document.getElementById('progPct').textContent = progress + '%';
  document.getElementById('progStatus').textContent = 'Running tests...';
}

function appendRawLog(text) {
  var raw = document.getElementById('rawLog');
  raw.textContent += text;
  raw.scrollTop = raw.scrollHeight;
}

function fmtMs(n) {
  if (n === undefined || n === null) return '—';
  if (n < 1000) return n.toFixed(1) + 'ms';
  return (n / 1000).toFixed(2) + 's';
}

function fmtPct(n) {
  return (n * 100).toFixed(1) + '%';
}

function showK6Modal() {
  document.getElementById('k6Modal').classList.add('open');
}

function hideK6Modal() {
  document.getElementById('k6Modal').classList.remove('open');
}

function startK6Install() {
  const btn     = document.getElementById('installK6Btn');
  const progress = document.getElementById('modalProgress');
  const fill    = document.getElementById('modalProgressFill');
  const msg     = document.getElementById('modalProgressMsg');

  btn.disabled = true;
  btn.textContent = 'Installing…';
  progress.classList.add('visible');

  const es = new EventSource('/api/install-k6');
  es.onmessage = (e) => {
    const data = JSON.parse(e.data);
    if (data.type === 'progress') {
      fill.style.width = data.percent + '%';
      msg.textContent = 'Downloading… ' + data.percent + '%';
    } else if (data.type === 'status') {
      msg.textContent = data.message;
    } else if (data.type === 'done') {
      fill.style.width = '100%';
      msg.textContent = data.message;
      btn.textContent = '✓ Done — reloading…';
      es.close();
      setTimeout(() => { hideK6Modal(); checkK6(); }, 1200);
    } else if (data.type === 'error') {
      msg.textContent = '✗ ' + data.message;
      msg.style.color = '#ef4444';
      btn.disabled = false;
      btn.textContent = '⬇ Retry';
      es.close();
    }
  };
  es.onerror = () => {
    msg.textContent = '✗ Connection error';
    msg.style.color = '#ef4444';
    btn.disabled = false;
    btn.textContent = '⬇ Retry';
    es.close();
  };
}

function checkK6() {
  fetch(api.status).then(res => res.json()).then(data => {
    if (!data.hasK6) {
      document.getElementById('k6Status').textContent = 'k6 not found';
      document.getElementById('k6Status').style.color = '#ef4444';
      document.getElementById('addTestBtn').disabled = true;
      document.getElementById('runAllBtn').disabled = true;
      showK6Modal();
    } else {
      document.getElementById('k6Status').textContent = 'k6 ' + data.version + ' is ready';
      document.getElementById('k6Status').style.color = '#a78bfa';
      document.getElementById('addTestBtn').disabled = false;
      document.getElementById('runAllBtn').disabled = false;
    }
  }).catch(err => {
    document.getElementById('k6Status').textContent = 'k6 status check failed: ' + err.message;
    document.getElementById('k6Status').style.color = '#ef4444';
    document.getElementById('addTestBtn').disabled = true;
    document.getElementById('runAllBtn').disabled = true;
  });
}

function addTestToUI(config) {
  const testId = Date.now().toString(36) + Math.random().toString(36).slice(2);
  const defaultConfig = config || { url: '', method: 'GET', vus: 50, duration: 30, rampUp: 0 };
  const card = createTestCard(testId, defaultConfig);
  document.getElementById('testList').appendChild(card);
  addHeaderRow(testId, 'Content-Type', 'application/json');
  return testId;
}

function initFloodgate() {
  checkK6();
  addTestToUI();

  document.getElementById('installK6Btn').addEventListener('click', startK6Install);
  document.getElementById('addTestBtn').addEventListener('click', function() { addTestToUI(); });
  document.getElementById('runAllBtn').addEventListener('click', runAllTests);
  document.getElementById('stopAllBtn').addEventListener('click', stopAllTests);
  document.getElementById('clearResultsBtn').addEventListener('click', clearResults);

  document.getElementById('testList').addEventListener('change', function(e) {
    if (e.target.classList.contains('auth-type-select') && e.target.dataset.testid) {
      renderAuthFields(e.target.dataset.testid);
    }
  });

  document.getElementById('testList').addEventListener('click', function(e) {
    const target = e.target;

    if (target.classList.contains('remove-test-btn') && target.dataset.testid) {
      const testId = target.dataset.testid;
      const card = target.closest('.test-item');
      if (card) card.remove();
      if (testSources[testId]) testSources[testId].close();
      delete testSources[testId];
      updateActiveTests();
      return;
    }

    if (target.classList.contains('add-header-btn') && target.dataset.testid) {
      addHeaderRow(target.dataset.testid, '', '');
      return;
    }

    if (target.classList.contains('run-one-btn') && target.dataset.testid) {
      const testId = target.dataset.testid;
      const url = document.getElementById('url-' + testId);
      if (url && url.value.trim()) startTest(testId);
      return;
    }

    if (target.classList.contains('stop-one-btn') && target.dataset.testid) {
      stopTest(target.dataset.testid);
      return;
    }
  });
}

function runAllTests() {
  const cards = document.querySelectorAll('.test-item');
  let running = 0;

  cards.forEach(card => {
    const testId = card.id.replace('test-', '');
    const urlInput = document.getElementById('url-' + testId);
    const runBtn = card.querySelector('.run-one-btn');
    if (urlInput && urlInput.value.trim() && runBtn && !runBtn.disabled) {
      startTest(testId);
      running++;
    }
  });

  if (running === 0) {
    alert('No tests are ready to run. Configure at least one test first.');
  }
}

function stopAllTests() {
  const cards = document.querySelectorAll('.test-item');
  cards.forEach(card => {
    const testId = card.id.replace('test-', '');
    stopTest(testId);
  });
}

function clearResults() {
  document.getElementById('resultsPanel').style.display = 'none';
  document.getElementById('summaryCards').innerHTML = '';
  document.getElementById('latCards').innerHTML = '';
  document.getElementById('logBody').innerHTML = '';
  document.getElementById('rawLog').textContent = 'Waiting for test runs...';
  if (latChart) { latChart.destroy(); latChart = null; }
  if (statusChart) { statusChart.destroy(); statusChart = null; }
}

function displayResults(r) {
  document.getElementById('resultsPanel').style.display = 'block';
  document.getElementById('summaryCards').innerHTML =
    '<div class="metric-card"><div class="lbl">VUs</div><div class="val purple">' + (r.vus || 'N/A') + '</div></div>' +
    '<div class="metric-card"><div class="lbl">RPS</div><div class="val purple">' + (r.rps || 0).toFixed(1) + '</div></div>' +
    '<div class="metric-card"><div class="lbl">P95 Latency</div><div class="val">' + fmtMs(r.latency.p95) + '</div></div>' +
    '<div class="metric-card"><div class="lbl">Error Rate</div><div class="val ' + (r.errorRate > 0.1 ? 'red' : r.errorRate > 0 ? 'yellow' : 'green') + '">' + fmtPct(r.errorRate || 0) + '</div></div>';

  document.getElementById('latCards').innerHTML =
    '<div class="lat-card"><div class="lbl">avg</div><div class="val">' + fmtMs(r.latency.avg) + '</div></div>' +
    '<div class="lat-card"><div class="lbl">p50</div><div class="val">' + fmtMs(r.latency.p50) + '</div></div>' +
    '<div class="lat-card"><div class="lbl">p90</div><div class="val">' + fmtMs(r.latency.p90) + '</div></div>' +
    '<div class="lat-card"><div class="lbl">p99</div><div class="val">' + fmtMs(r.latency.p99) + '</div></div>' +
    '<div class="lat-card"><div class="lbl">min</div><div class="val">' + fmtMs(r.latency.min) + '</div></div>' +
    '<div class="lat-card"><div class="lbl">max</div><div class="val">' + fmtMs(r.latency.max) + '</div></div>';

  renderLatencyChart(r);
  renderStatusChart(r.statusCodes || {});
}

function displayLiveMetrics(r) {
  if (!r) return;
  document.getElementById('resultsPanel').style.display = 'block';

  document.getElementById('summaryCards').innerHTML =
    '<div class="metric-card"><div class="lbl">VUs</div><div class="val purple">' + (r.vus || 'N/A') + '</div></div>' +
    '<div class="metric-card"><div class="lbl">RPS</div><div class="val purple">' + (r.rps || 0).toFixed(2) + '</div></div>' +
    '<div class="metric-card"><div class="lbl">Avg Lat</div><div class="val">' + fmtMs(r.latency?.avg || 0) + '</div></div>' +
    '<div class="metric-card"><div class="lbl">Error %</div><div class="val ' + (r.errorRate > 0.1 ? 'red' : r.errorRate > 0 ? 'yellow' : 'green') + '">' + fmtPct(r.errorRate || 0) + '</div></div>';

  document.getElementById('latCards').innerHTML =
    '<div class="lat-card"><div class="lbl">p50</div><div class="val">' + fmtMs(r.latency?.p50 || 0) + '</div></div>' +
    '<div class="lat-card"><div class="lbl">p90</div><div class="val">' + fmtMs(r.latency?.p90 || 0) + '</div></div>' +
    '<div class="lat-card"><div class="lbl">p95</div><div class="val">' + fmtMs(r.latency?.p95 || 0) + '</div></div>' +
    '<div class="lat-card"><div class="lbl">p99</div><div class="val">' + fmtMs(r.latency?.p99 || 0) + '</div></div>' +
    '<div class="lat-card"><div class="lbl">Reqs</div><div class="val">' + (r.totalRequests || 0) + '</div></div>' +
    '<div class="lat-card"><div class="lbl">Data</div><div class="val">' + (r.dataReceived ? (r.dataReceived / 1024 / 1024).toFixed(1) + 'MB' : '0MB') + '</div></div>';
}

function renderLatencyChart(r) {
  if (latChart) { latChart.destroy(); latChart = null; }
  latChart = new Chart(document.getElementById('latencyChart'), {
    type: 'line',
    data: {
      labels: ['p50', 'p90', 'p95', 'p99', 'max'],
      datasets: [{
        label: 'Latency (ms)',
        data: [r.latency.p50, r.latency.p90, r.latency.p95, r.latency.p99, r.latency.max],
        borderColor: '#7c3aed',
        backgroundColor: 'rgba(124,58,237,0.35)',
        tension: 0.25
      }]
    },
    options: {
      scales: {
        y: { beginAtZero: true, ticks: { color: '#94a3b8' } },
        x: { ticks: { color: '#94a3b8' } }
      },
      plugins: { legend: { display: false } }
    }
  });
}

function renderStatusChart(statusCodes) {
  if (statusChart) { statusChart.destroy(); statusChart = null; }
  var labels = Object.keys(statusCodes);
  var data = labels.map(function(k){ return statusCodes[k]; });
  var colors = ['#7c3aed', '#22c55e', '#3b82f6', '#f59e0b', '#ef4444', '#a78bfa'];
  statusChart = new Chart(document.getElementById('statusChart'), {
    type: 'pie',
    data: { labels: labels, datasets: [{ data: data, backgroundColor: colors.slice(0, labels.length) }] },
    options: { plugins: { legend: { labels: { color: '#94a3b8' } } } }
  });
}

function fetchAndShowResults(testId) {
  fetch(api.results(testId)).then(res => res.json()).then(data => {
    if (data.status !== 'done') return;
    if (data.error) return;
    if (!data.metrics || Object.keys(data.metrics).length === 0) return;
    displayResults(data.metrics);
  }).catch(() => {});
}

document.addEventListener('DOMContentLoaded', initFloodgate);
