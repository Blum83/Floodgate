const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const exec = require('child_process').exec;

// ── Packaged-app path helpers ────────────────────────────────────────────────
// When running inside app.asar, __dirname is a virtual read-only path.
// Writable files go to ~/.floodgate/; packaged resources come from app.asar.unpacked/.
const isPackaged = __dirname.includes('app.asar');

// Writable base: ~/.floodgate in production, project root in dev
const writableBase = isPackaged
  ? path.join(os.homedir(), '.floodgate')
  : __dirname;

// Path to a resource that lives in app.asar.unpacked (e.g. data/, node_modules/)
function unpackedPath(...parts) {
  if (isPackaged && process.resourcesPath) {
    return path.join(process.resourcesPath, 'app.asar.unpacked', ...parts);
  }
  return path.join(__dirname, ...parts);
}

// Ensure writable base exists
if (!fs.existsSync(writableBase)) fs.mkdirSync(writableBase, { recursive: true });

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Serve /stress/ and /scenario/ as SPA directories
app.use('/stress', express.static(path.join(__dirname, 'public', 'stress')));
app.use('/scenario', express.static(path.join(__dirname, 'public', 'scenario')));

// ── Data layer ──────────────────────────────────────────────────────────────
// data/ is in asarUnpack so it's always writable via unpackedPath
const dataDir = unpackedPath('data');

function readData(file) {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir, file), 'utf8')); }
  catch { return []; }
}

function writeData(file, data) {
  fs.writeFileSync(path.join(dataDir, file), JSON.stringify(data, null, 2), 'utf8');
}

function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
}

// Escape a string for safe embedding inside a JS template literal (`...`)
function escJS(str) {
  return String(str == null ? '' : str)
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$\{/g, '\\${');
}

// Escape a string for safe embedding inside a JS single-quoted string ('...')
function escJSSingle(str) {
  return String(str == null ? '' : str)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'");
}

// Escape a string for embedding inside a JS double-quoted string literal.
// Does NOT touch # or { so Gatling EL expressions (#{variable}) pass through intact.
function escJSStr(str) {
  return String(str == null ? '' : str)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

// Convert {{variable}} placeholders to Gatling EL #{variable}, then JS-escape.
function toGatlingEL(str) {
  return escJSStr(String(str == null ? '' : str).replace(/\{\{(\w+)\}\}/g, '#{$1}'));
}

// ── Environments API ─────────────────────────────────────────────────────────
app.get('/api/environments', (req, res) => {
  res.json(readData('environments.json'));
});

app.post('/api/environments', (req, res) => {
  const { name, host, description } = req.body;
  if (!name || !host) return res.status(400).json({ error: 'name and host are required' });
  const envs = readData('environments.json');
  const env = { id: makeId(), name, host: host.replace(/\/$/, ''), description: description || '', createdAt: new Date().toISOString() };
  envs.push(env);
  writeData('environments.json', envs);
  res.status(201).json(env);
});

app.put('/api/environments/:id', (req, res) => {
  const envs = readData('environments.json');
  const idx = envs.findIndex(e => e.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const { name, host, description } = req.body;
  if (!name || !host) return res.status(400).json({ error: 'name and host are required' });
  envs[idx] = { ...envs[idx], name, host: host.replace(/\/$/, ''), description: description || '' };
  writeData('environments.json', envs);
  res.json(envs[idx]);
});

app.delete('/api/environments/:id', (req, res) => {
  const envs = readData('environments.json');
  const filtered = envs.filter(e => e.id !== req.params.id);
  if (filtered.length === envs.length) return res.status(404).json({ error: 'Not found' });
  writeData('environments.json', filtered);
  res.json({ ok: true });
});

// ── Scenarios API ────────────────────────────────────────────────────────────
app.get('/api/scenarios', (req, res) => {
  res.json(readData('scenarios.json'));
});

app.get('/api/scenarios/:id', (req, res) => {
  const scenarios = readData('scenarios.json');
  const s = scenarios.find(s => s.id === req.params.id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  res.json(s);
});

app.post('/api/scenarios', (req, res) => {
  const { name, description, steps } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const scenarios = readData('scenarios.json');
  const scenario = {
    id: makeId(),
    name,
    description: description || '',
    steps: steps || [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  scenarios.push(scenario);
  writeData('scenarios.json', scenarios);
  res.status(201).json(scenario);
});

app.put('/api/scenarios/:id', (req, res) => {
  const scenarios = readData('scenarios.json');
  const idx = scenarios.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const { name, description, steps } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  scenarios[idx] = { ...scenarios[idx], name, description: description || '', steps: steps || [], updatedAt: new Date().toISOString() };
  writeData('scenarios.json', scenarios);
  res.json(scenarios[idx]);
});

app.delete('/api/scenarios/:id', (req, res) => {
  const scenarios = readData('scenarios.json');
  const filtered = scenarios.filter(s => s.id !== req.params.id);
  if (filtered.length === scenarios.length) return res.status(404).json({ error: 'Not found' });
  writeData('scenarios.json', filtered);
  res.json({ ok: true });
});

// ── Runs API ─────────────────────────────────────────────────────────────────
app.get('/api/runs', (req, res) => {
  let runs = readData('runs.json');
  const { scenarioId, environmentId, from, to, page = 1, limit = 20 } = req.query;
  if (scenarioId) runs = runs.filter(r => r.scenarioId === scenarioId);
  if (environmentId) runs = runs.filter(r => r.environmentId === environmentId);
  if (from) runs = runs.filter(r => new Date(r.startedAt) >= new Date(from));
  if (to)   runs = runs.filter(r => new Date(r.startedAt) <= new Date(to));
  runs = runs.sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
  const total = runs.length;
  const offset = (Number(page) - 1) * Number(limit);
  const items = runs.slice(offset, offset + Number(limit));
  res.json({ items, total, page: Number(page), limit: Number(limit) });
});

app.get('/api/runs/:id', (req, res) => {
  const runs = readData('runs.json');
  const run = runs.find(r => r.id === req.params.id);
  if (!run) return res.status(404).json({ error: 'Not found' });
  res.json(run);
});

// ── Run Scenario API ─────────────────────────────────────────────────────────
app.post('/api/scenarios/:id/run', (req, res) => {
  const scenarios = readData('scenarios.json');
  const scenario = scenarios.find(s => s.id === req.params.id);
  if (!scenario) return res.status(404).json({ error: 'Scenario not found' });

  const {
    environmentId,
    vus = 10, duration = 30, rampUp = 0,
    loadModel = 'vus',
    arrivalRate = 10,
    preAllocatedVUs = 50,
  } = req.body;
  const envs = readData('environments.json');
  const env = envs.find(e => e.id === environmentId);
  if (!env) return res.status(400).json({ error: 'Environment not found' });

  if (!scenario.steps || scenario.steps.length === 0) {
    return res.status(400).json({ error: 'Scenario has no steps' });
  }

  const runId = makeId();
  const simFolder     = path.join(writableBase, 'temp', `${runId}-sim`);
  const resultsFolder = path.join(writableBase, 'temp', `${runId}-results`);

  fs.mkdirSync(simFolder,     { recursive: true });
  fs.mkdirSync(resultsFolder, { recursive: true });

  const simContent = generateGatlingSimulation({ scenario, env, vus, duration, rampUp, loadModel, arrivalRate, preAllocatedVUs });
  fs.writeFileSync(path.join(simFolder, 'FloodgateSimulation.gatling.js'), simContent, 'utf8');

  const runs = readData('runs.json');
  const run = {
    id: runId,
    scenarioId: scenario.id,
    scenarioName: scenario.name,
    environmentId: env.id,
    environmentName: env.name,
    targetHost: env.host,
    loadModel,
    vus: loadModel === 'arrival-rate' ? (preAllocatedVUs || 50) : vus,
    arrivalRate: loadModel === 'arrival-rate' ? arrivalRate : null,
    duration,
    rampUp,
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    metrics: null,
    error: null,
  };
  runs.push(run);
  writeData('runs.json', runs);

  const gatlingCli = unpackedPath('node_modules', '@gatling.io', 'cli', 'target', 'index.js');
  const proc = spawn(process.execPath, [
    gatlingCli,
    'run',
    '--sources-folder',  simFolder,
    '--bundle-file',     path.join(resultsFolder, 'bundle.js'),
    '--results-folder',  resultsFolder,
    '--non-interactive',
  ], { cwd: writableBase });

  proc.stdout.on('data', () => {});
  proc.stderr.on('data', () => {});

  proc.on('close', (code) => {
    const allRuns = readData('runs.json');
    const idx = allRuns.findIndex(r => r.id === runId);
    if (idx === -1) return;

    allRuns[idx].status    = code === 0 ? 'completed' : 'failed';
    allRuns[idx].finishedAt = new Date().toISOString();
    if (code !== 0) allRuns[idx].error = `Gatling exited with code ${code}`;

    // Parse simulation.log — search any subdir of resultsFolder
    try {
      const entries = fs.readdirSync(resultsFolder);
      for (const entry of entries) {
        const logPath = path.join(resultsFolder, entry, 'simulation.log');
        if (fs.existsSync(logPath)) {
          allRuns[idx].metrics = parseGatlingSimLog(logPath);
          break;
        }
      }
    } catch (_) {}

    // Cleanup
    try { fs.rmSync(simFolder,     { recursive: true, force: true }); } catch {}
    try { fs.rmSync(resultsFolder, { recursive: true, force: true }); } catch {}

    writeData('runs.json', allRuns);
  });

  res.status(202).json({ runId, status: 'running' });
});

// ── Gatling Simulation Generator ────────────────────────────────────────────
function generateGatlingSimulation({ scenario, env, vus, duration, rampUp, loadModel, arrivalRate, preAllocatedVUs }) {
  const steps = scenario.steps;
  const baseUrl = escJSStr(env.host);

  // ── Per-step exec() chain ──
  const stepCode = steps.map((step, i) => {
    const stepName = escJSStr(step.name || `step${i + 1}`);
    const method   = (step.method || 'GET').toLowerCase();
    const hasBody  = ['post', 'put', 'patch'].includes(method);
    const stepPath = toGatlingEL(step.path || '/');

    // Query params → .queryParam("k", "v")
    const queryLines = [];
    if (step.queryParams && step.queryParams.trim()) {
      step.queryParams.trim().split('\n').map(l => l.trim()).filter(l => l.includes('=')).forEach(l => {
        const idx = l.indexOf('=');
        queryLines.push(`        .queryParam("${escJSStr(l.slice(0, idx).trim())}", "${toGatlingEL(l.slice(idx + 1).trim())}")`);
      });
    }

    // Headers → .header("k", "v")
    const headerLines = [];
    if (step.headers && step.headers.trim()) {
      step.headers.trim().split('\n').map(l => l.trim()).filter(l => l.includes(':')).forEach(l => {
        const ci = l.indexOf(':');
        headerLines.push(`        .header("${escJSStr(l.slice(0, ci).trim())}", "${toGatlingEL(l.slice(ci + 1).trim())}")`);
      });
    }

    // Body
    const bodyTrimmed = hasBody && step.body && step.body.trim();
    const isJson = bodyTrimmed && (bodyTrimmed.startsWith('{') || bodyTrimmed.startsWith('['));
    const bodyLines = bodyTrimmed
      ? [`        .body(StringBody("${toGatlingEL(bodyTrimmed)}"))${isJson ? '.asJson()' : ''}`]
      : [];

    // Checks + extractions
    const checkParts = [];
    const chk = step.checks || {};
    if (chk.statusCode)      checkParts.push(`status().is(${chk.statusCode})`);
    else                     checkParts.push(`status().in(200, 201, 202, 203, 204)`);
    if (chk.maxResponseTime) checkParts.push(`responseTimeInMillis().lte(${chk.maxResponseTime})`);
    if (chk.bodyContains)    checkParts.push(`bodyString().contains("${escJSStr(chk.bodyContains)}")`);
    (step.extractions || []).filter(ex => ex.varName && ex.jsonPath).forEach(ex => {
      checkParts.push(`jsonPath("${escJSStr(ex.jsonPath)}").saveAs("${escJSStr(ex.varName)}")`);
    });
    const checkLine = `        .check(\n          ${checkParts.join(',\n          ')}\n        )`;

    // Think time → .pause()
    let pauseLine = '      .pause(1)';
    if (step.thinkTime !== undefined && step.thinkTime !== '') {
      const tt = String(step.thinkTime).trim();
      if (tt.includes('-')) {
        const [mn, mx] = tt.split('-').map(Number);
        if (!isNaN(mn) && !isNaN(mx) && mx > mn) pauseLine = `      .pause(${mn}, ${mx})`;
      } else {
        const f = parseFloat(tt);
        if (isNaN(f) || f <= 0) pauseLine = '';
        else pauseLine = `      .pause(${f})`;
      }
    }

    return [
      `      .exec(`,
      `        http("${stepName}")`,
      `          .${method}("${stepPath}")`,
      ...queryLines,
      ...headerLines,
      ...bodyLines,
      checkLine,
      `      )`,
      ...(pauseLine ? [pauseLine] : []),
    ].join('\n');
  }).join('\n');

  // ── Injection profile ──
  let injectMethod, injectSteps;
  if (loadModel === 'arrival-rate') {
    const rate = arrivalRate || 10;
    injectMethod = 'injectOpen';
    injectSteps = rampUp > 0
      ? `rampUsersPerSec(0).to(${rate}).during(${rampUp}),\n      constantUsersPerSec(${rate}).during(${duration})`
      : `constantUsersPerSec(${rate}).during(${duration})`;
  } else {
    injectMethod = 'injectClosed';
    injectSteps = rampUp > 0
      ? `rampConcurrentUsers(0).to(${vus}).during(${rampUp}),\n      constantConcurrentUsers(${vus}).during(${duration})`
      : `constantConcurrentUsers(${vus}).during(${duration})`;
  }

  return `import {
  simulation, scenario,
  jsonPath, bodyString, responseTimeInMillis, StringBody,
  constantConcurrentUsers, rampConcurrentUsers,
  constantUsersPerSec, rampUsersPerSec,
} from "@gatling.io/core";
import { http, status } from "@gatling.io/http";

export default simulation((setUp) => {
  const httpProtocol = http
    .baseUrl("${baseUrl}")
    .acceptHeader("application/json, */*")
    .acceptEncodingHeader("gzip, deflate")
    .userAgentHeader("Floodgate/1.0");

  const scn = scenario("${escJSStr(scenario.name)}")
${stepCode};

  setUp(
    scn.${injectMethod}(
      ${injectSteps}
    )
  ).protocols(httpProtocol);
});
`;
}

const tempDir = path.join(writableBase, 'temp');
if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

// === CONFIGURATION ===
const MAX_CONCURRENT_TESTS = 5;        // Max concurrent tests allowed
const MAX_TOTAL_VUS = 25000;           // Max total VUS across all tests (5000 per test × 5 tests)
const TEST_EXPIRY_MS = 5 * 60 * 1000;  // Keep tests 5 minutes after completion
const MAX_OUTPUT_SIZE = 5 * 1024 * 1024; // 5MB buffer limit

// === MEMORY MONITORING ===
function checkMemoryUsage() {
  const usage = process.memoryUsage();
  const heapUsed = (usage.heapUsed / 1024 / 1024).toFixed(1);
  const heapTotal = (usage.heapTotal / 1024 / 1024).toFixed(1);
  
  if (heapUsed > 700) {
    console.warn(`⚠️  Heap usage high: ${heapUsed}MB / ${heapTotal}MB`);
  }
  
  if (heapUsed > 800) {
    console.error(`❌ MEMORY CRITICAL: ${heapUsed}MB - consider stopping tests`);
  }
}

const tests = new Map();

function makeTestId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`;
}

function checkAndCleanupTests() {
  // Remove completed tests older than expiry limit
  const now = Date.now();
  for (const [id, test] of tests.entries()) {
    if (test.done && (now - test.endTime > TEST_EXPIRY_MS)) {
      tests.delete(id);
    }
  }
  
  // Remove oldest tests when max concurrent limit reached
  while (tests.size > MAX_CONCURRENT_TESTS) {
    const first = tests.keys().next().value;
    const t = tests.get(first);
    if (t && t.done) {
      tests.delete(first);
    } else {
      break;
    }
  }
}

function parseK6Metrics(parsed) {
  if (!parsed || !parsed.metrics) return null;
  const m = parsed.metrics;

  const statusCodes = {};
  if (m.status_2xx && m.status_2xx.count > 0) statusCodes['2xx'] = m.status_2xx.count;
  if (m.status_3xx && m.status_3xx.count > 0) statusCodes['3xx'] = m.status_3xx.count;
  if (m.status_4xx && m.status_4xx.count > 0) statusCodes['4xx'] = m.status_4xx.count;
  if (m.status_5xx && m.status_5xx.count > 0) statusCodes['5xx'] = m.status_5xx.count;
  if (m.status_other && m.status_other.count > 0) statusCodes['other'] = m.status_other.count;

  const httpReqs = m.http_reqs || {};
  const reqDur = m.http_req_duration || {};
  const failed = m.http_req_failed || { rate: 0 };

  return {
    totalRequests: httpReqs.count || 0,
    rps: httpReqs.rate || 0,
    latency: {
      avg: reqDur.avg || 0,
      p50: reqDur['p(50)'] || 0,
      p75: reqDur['p(75)'] || 0,
      p90: reqDur['p(90)'] || 0,
      p95: reqDur['p(95)'] || 0,
      p99: reqDur['p(99)'] || 0,
      max: reqDur.max || 0,
      min: reqDur.min || 0,
    },
    successRate: 1 - (failed.rate || 0),
    errorRate: failed.rate || 0,
    statusCodes,
    dataReceived: m.data_received ? m.data_received.count : 0,
    dataSent: m.data_sent ? m.data_sent.count : 0,
    rawMetrics: m,
  };
}

// ── Gatling simulation.log parser ───────────────────────────────────────────
// Parses Gatling's tab-separated simulation.log to extract latency percentiles
// and request counts without needing the HTML report (--no-reports flag).
function parseGatlingSimLog(logPath) {
  let content;
  try { content = fs.readFileSync(logPath, 'utf8'); } catch { return null; }

  const responseTimes = [];
  let okCount = 0;
  let koCount = 0;
  let minTs = Infinity;
  let maxTs = -Infinity;

  for (const line of content.split('\n')) {
    if (!line.startsWith('REQUEST\t')) continue;
    const parts = line.split('\t');
    if (parts.length < 7) continue;
    const start  = parseInt(parts[4], 10);
    const end    = parseInt(parts[5], 10);
    const status = parts[6];
    if (isNaN(start) || isNaN(end)) continue;

    const rt = end - start;
    responseTimes.push(rt);
    if (status === 'OK') okCount++; else koCount++;
    if (start < minTs) minTs = start;
    if (end   > maxTs) maxTs = end;
  }

  if (responseTimes.length === 0) return null;

  responseTimes.sort((a, b) => a - b);

  const pct = (p) => {
    const idx = Math.min(Math.ceil((p / 100) * responseTimes.length) - 1, responseTimes.length - 1);
    return responseTimes[Math.max(0, idx)];
  };

  const total      = okCount + koCount;
  const durationMs = (maxTs !== -Infinity && minTs !== Infinity) ? Math.max(maxTs - minTs, 1) : 1000;
  const sum        = responseTimes.reduce((s, v) => s + v, 0);

  return {
    totalRequests: total,
    rps:           total / (durationMs / 1000),
    latency: {
      avg: sum / responseTimes.length,
      p50: pct(50),
      p75: pct(75),
      p90: pct(90),
      p95: pct(95),
      p99: pct(99),
      min: responseTimes[0],
      max: responseTimes[responseTimes.length - 1],
    },
    successRate: total > 0 ? okCount / total : 1,
    errorRate:   total > 0 ? koCount / total : 0,
    statusCodes: {},
  };
}

app.get('/api/status', (req, res) => {
  const result = {};
  let pending = 2;
  const done = () => { if (--pending === 0) res.json(result); };

  exec('k6 version', (err, stdout) => {
    result.hasK6    = !err;
    result.version  = err ? null : stdout.trim();  // kept for stress-test page compat
    done();
  });

  const gatlingCliStatus = unpackedPath('node_modules', '@gatling.io', 'cli', 'target', 'index.js');
  exec(`"${process.execPath}" "${gatlingCliStatus}" --version`, { timeout: 10000 }, (err, stdout) => {
    const out = (stdout || '').trim();
    result.hasGatling     = !err;
    result.gatlingVersion = result.hasGatling
      ? (out.match(/(\d+\.\d+\.\d+)/)?.[1] ?? out.slice(0, 60))
      : null;
    done();
  });
});

app.post('/api/run-test', (req, res) => {
  const { action, testId: stopTestId, url, method, vus, duration, rampUp, headers, body } = req.body;

  // Handle stop action first
  if (action === 'stop' && stopTestId) {
    const t = tests.get(stopTestId);
    if (!t) return res.status(404).json({ error: 'Test not found' });
    
    // Signal k6 to stop by writing to stderr
    t.stdout += '\nEOF\n';
    if (t.clients.size > 0) {
      t.clients.forEach((sse) => {
        sse.write(`data: ${JSON.stringify({ type: 'log', stream: 'stdout', text: 'Stopping test...' })}\n\n`);
      });
    }
    
    // Remove from active tests immediately
    t.done = true;
    t.status = 'stopped';
    checkAndCleanupTests();
    
    t.clients.forEach((sse) => {
      sse.write(`data: ${JSON.stringify({ type: 'done', status: t.status, error: null, metrics: null })}\n\n`);
    });
    return res.json({ stopped: true });
  }

  // Validate required fields for starting tests
  if (!req.body.url || !req.body.method || !req.body.vus || !req.body.duration) {
    return res.status(400).json({ error: 'Missing required fields: url, method, vus, duration' });
  }

  // Check concurrent tests limit
  if (tests.size >= MAX_CONCURRENT_TESTS) {
    return res.status(429).json({ 
      error: `Max concurrent tests limit reached (max ${MAX_CONCURRENT_TESTS})`,
      waitingFor: `${MAX_CONCURRENT_TESTS - tests.size} test(s) to complete` 
    });
  }

  let currentVus = 0;
  for (const t of tests.values()) { if (!t.done) currentVus += (t.config?.vus || 0); }
  const totalVus = currentVus + (vus || 0);
  if (totalVus > MAX_TOTAL_VUS) {
    return res.status(429).json({ 
      error: `Max total VUS limit reached (max ${MAX_TOTAL_VUS})`,
      currentVus: totalVus,
      availableVus: MAX_TOTAL_VUS - totalVus
    });
  }

  const testId = makeTestId();
  const scriptPath = path.join(tempDir, `${testId}-script.js`);
  const resultsPath = path.join(tempDir, `${testId}-results.json`);
  const summaryPath = path.join(tempDir, `${testId}-summary.json`);

  const normalizedMethod = method.toLowerCase();
  const hasBody = ['post', 'put', 'patch', 'delete'].includes(normalizedMethod) && body;

  const headersLiteral = JSON.stringify(headers || {});
  const bodyLiteral = hasBody ? JSON.stringify(body) : 'null';

  const script = `import http from 'k6/http';
import { sleep } from 'k6';
import { Counter } from 'k6/metrics';

const status_2xx = new Counter('status_2xx');
const status_3xx = new Counter('status_3xx');
const status_4xx = new Counter('status_4xx');
const status_5xx = new Counter('status_5xx');
const status_other = new Counter('status_other');

export const options = {
  stages: [
    { duration: '${rampUp}s', target: ${vus} },
    { duration: '${duration}s', target: ${vus} },
    { duration: '10s', target: 0 },
  ],
};

export default function () {
  const res = http.${normalizedMethod}('${url}', ${hasBody ? bodyLiteral : 'null'}, { headers: ${headersLiteral} });
  const s = res.status;
  if (s >= 200 && s < 300) status_2xx.add(1);
  else if (s >= 300 && s < 400) status_3xx.add(1);
  else if (s >= 400 && s < 500) status_4xx.add(1);
  else if (s >= 500 && s < 600) status_5xx.add(1);
  else status_other.add(1);
  sleep(1);
};
`;

  fs.writeFileSync(scriptPath, script, 'utf8');

  tests.set(testId, {
    status: 'running',
    progress: 0,
    stdout: '',
    stderr: '',
    parsed: null,
    done: false,
    error: null,
    clients: new Set(),
    config: { vus, duration, rampUp },
    startTime: Date.now(),
    endTime: null,
  });

  const totalDuration = (rampUp || 0) + duration + 10; // ramp + main + cooldown
  const proc = spawn('k6', ['run', '--out', `json=${resultsPath}`, '--summary-export', summaryPath, scriptPath]);

  // Send progress updates every 2s
  const progressInterval = setInterval(() => {
    const t = tests.get(testId);
    if (!t || t.done) {
      clearInterval(progressInterval);
      return;
    }
    const elapsed = (Date.now() - t.startTime) / 1000;
    const progress = Math.min(Math.round((elapsed / totalDuration) * 100), 95);
    t.progress = progress;
    if (t.clients.size > 0) {
      t.clients.forEach((sse) => {
        sse.write(`data: ${JSON.stringify({ type: 'progress', progress })}\n\n`);
      });
    }
  }, 2000);

  // Throttled log buffer — flush to SSE clients max every 2s
  let logBuffer = '';
  let logFlushTimer = null;
  function flushLogs() {
    const t = tests.get(testId);
    if (!t || !logBuffer || t.clients.size === 0) { logBuffer = ''; return; }
    // Send only last 2KB to avoid huge payloads
    const toSend = logBuffer.length > 2048 ? '...\n' + logBuffer.slice(-2048) : logBuffer;
    t.clients.forEach((sse) => {
      sse.write(`data: ${JSON.stringify({ type: 'log', text: toSend })}\n\n`);
    });
    logBuffer = '';
  }
  function queueLog(txt) {
    logBuffer += txt;
    if (!logFlushTimer) {
      logFlushTimer = setTimeout(() => { logFlushTimer = null; flushLogs(); }, 2000);
    }
  }

  proc.stdout.on('data', (chunk) => {
    const txt = chunk.toString();
    const t = tests.get(testId);
    if (!t) return;

    // Limit stdout buffer
    if (t.stdout.length + txt.length > MAX_OUTPUT_SIZE) {
      t.stdout = t.stdout.slice(-MAX_OUTPUT_SIZE / 2) + txt;
    } else {
      t.stdout += txt;
    }

    // Try to parse JSON for live metrics (only summary lines)
    const lines = txt.split('\n').filter(Boolean);
    lines.forEach((line) => {
      try {
        const json = JSON.parse(line);
        if (json.metrics) {
          const liveMetrics = parseK6Metrics(json);
          if (liveMetrics && t.clients.size > 0) {
            t.clients.forEach((sse) => {
              sse.write(`data: ${JSON.stringify({ type: 'metrics', data: liveMetrics, progress: t.progress })}\n\n`);
            });
          }
        }
      } catch (e) { /* not JSON */ }
    });

    queueLog(txt);
  });

  proc.stderr.on('data', (chunk) => {
    const txt = chunk.toString();
    const t = tests.get(testId);
    if (!t) return;

    // Limit stderr buffer
    if (t.stderr.length + txt.length > MAX_OUTPUT_SIZE) {
      t.stderr = t.stderr.slice(-MAX_OUTPUT_SIZE / 2) + txt;
    } else {
      t.stderr += txt;
    }

    // Only buffer stderr, don't spam SSE
    queueLog(txt);
  });

  proc.on('close', (code) => {
    clearInterval(progressInterval);
    if (logFlushTimer) { clearTimeout(logFlushTimer); logFlushTimer = null; }
    flushLogs();
    const t = tests.get(testId);
    if (!t) return;
    t.done = true;
    t.status = code === 0 ? 'done' : 'failed';
    t.endTime = Date.now();  // Record completion time

    if (code !== 0) {
      t.error = `k6 exited with code ${code}`;
    }

    checkMemoryUsage(); // Check memory usage after test completion
    checkAndCleanupTests(); // Auto cleanup

    try {
      const summaryRaw = fs.readFileSync(summaryPath, 'utf8');
      const summaryParsed = JSON.parse(summaryRaw);
      t.parsed = summaryParsed;
      t.metrics = parseK6Metrics(summaryParsed);
    } catch (err) {
      // fallback to raw json output path if summary-export fails
      try {
        const raw = fs.readFileSync(resultsPath, 'utf8');
        const lines = raw.trim().split(/\r?\n/).filter(Boolean);
        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            const candidate = JSON.parse(lines[i]);
            const candidateMetrics = parseK6Metrics(candidate);
            if (candidateMetrics) {
              t.parsed = candidate;
              t.metrics = candidateMetrics;
              break;
            }
          } catch (e) {
            // ignore malformed line
          }
        }
      } catch (err2) {
        t.error = t.error ? `${t.error}; ${err2.message}` : err2.message;
        t.metrics = null;
      }
    }

    t.clients.forEach((sse) => {
      sse.write(`data: ${JSON.stringify({ type: 'done', status: t.status, error: t.error || null, metrics: t.metrics })}\n\n`);
    });
  });

  return res.json({ testId });
});

app.get('/api/progress/:testId', (req, res) => {
  const testId = req.params.testId;
  const t = tests.get(testId);
  if (!t) return res.status(404).json({ error: 'Test not found' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  t.clients.add(res);
  res.write(`data: ${JSON.stringify({ type: 'status', status: t.status, progress: t.progress })}\n\n`);

  req.on('close', () => {
    t.clients.delete(res);
  });
});

app.get('/api/results/:testId', (req, res) => {
  const testId = req.params.testId;
  const t = tests.get(testId);
  if (!t) return res.status(404).json({ error: 'Test not found' });

  if (!t.done) return res.status(202).json({ status: t.status });

  let metrics = t.metrics || {};
  if (!metrics || Object.keys(metrics).length === 0) {
    metrics = parseK6Metrics(t.parsed) || {};
  }

  if (t.config && t.config.vus) {
    metrics.vus = metrics.vus || t.config.vus;
  }

  return res.json({ status: t.status, error: t.error, metrics });
});

app.get('/api/active-tests', (req, res) => {
  const activeTests = Array.from(tests.entries())
    .map(([id, test]) => ({
      id,
      status: test.status,
      progress: test.progress,
      vus: test.config?.vus,
      duration: test.config?.duration,
      startTime: test.startTime,
      endTime: test.endTime,
      vusInUse: test.done ? 0 : test.config?.vus || 0,
    }))
    .sort((a, b) => a.startTime - b.startTime);
  
  const totalVus = activeTests.reduce((sum, t) => sum + (t.vusInUse || 0), 0);
  
  res.json({
    activeTests,
    count: activeTests.length,
    totalVus,
    maxConcurrent: MAX_CONCURRENT_TESTS,
    maxTotalVus: MAX_TOTAL_VUS,
    availableSlots: Math.max(0, MAX_CONCURRENT_TESTS - activeTests.length),
    availableVus: Math.max(0, MAX_TOTAL_VUS - totalVus),
  });
});

const server = app.listen(3000, () => console.log('Floodgate running on http://localhost:3000'));
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log('Port 3000 already in use — another instance may be running.');
  } else {
    console.error('Server error:', err);
  }
});