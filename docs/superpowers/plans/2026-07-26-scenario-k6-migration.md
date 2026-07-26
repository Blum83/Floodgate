# Scenario-mode k6 Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Gatling with k6 for Scenario mode, merge the two Express servers into one, and fix the CORS/code-injection issues found in code review.

**Architecture:** One Express app on port 3847 serves landing + `/stress` + `/scenario` static assets and all APIs. Both Stress and Scenario spawn k6 through a single shared run-execution helper (spawn → SSE progress/log streaming → `parseK6Metrics`). Scenario runs are generated as k6 scripts (`generateK6ScenarioScript`) and persisted to `runs.json` as today, with live progress over a new SSE endpoint.

**Tech Stack:** Node.js, Express, k6 (spawned CLI), Electron, vanilla JS frontend, SSE.

## Global Constraints

- Node/Express server file is `server.js` (single file; the codebase keeps all server logic there — do not split it).
- No automated test framework exists in this repo. Each task is verified by running the app (`npm start`, then exercise via browser/curl) — verification steps are explicit per task.
- k6 metric shape returned by `parseK6Metrics()` is the canonical metrics contract: `{ totalRequests, rps, latency:{avg,p50,p75,p90,p95,p99,min,max}, successRate, errorRate, statusCodes, dataReceived, dataSent }`. Do not change this shape — the dashboard/history UI depends on it.
- Allowed HTTP methods whitelist (exact): `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`.
- Scenario data files (`data/scenarios.json`, `data/environments.json`, `data/runs.json`) keep their existing shape — no schema migration.
- k6 is spawned via `getK6Cmd()` (already exists); the packaged app auto-downloads k6 on first use.
- Commit after each task. End commit messages with `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`.

## File Structure

- `server.js` — Modify. Remove `cors`, merge `appGatling` routes into single app, add `generateK6ScenarioScript()`, `jsonPathValue` helper (mini-JSONPath, emitted into scripts as source text), shared `runK6()` helper, `/api/runs/:id/progress` SSE endpoint, whitelist validation in both script generators. Delete Gatling generator/parser and second `listen()`.
- `public/index.html` — Modify. Relative link to `/scenario/`.
- `public/stress/index.html` — Modify. Relative link to `/scenario/`.
- `public/scenario/index.html` — Modify. Relative links to `/` and `/stress/`; badge text.
- `public/scenario/app.js` — Modify. `checkGatlingStatus` → `checkK6Status`, run-detail live SSE subscription, badge text.
- `public/app2.js` — Delete (dead code).
- `package.json` — Modify. Drop `@gatling.io/*` + `cors` deps; drop `asarUnpack` gatling entry.
- `.gitignore` — Modify. Add `bin/`.

---

### Task 1: Remove CORS and merge servers into one port

**Files:**
- Modify: `server.js:31-44` (app setup), `server.js:95-197` (Gatling route registrations), `server.js:1063-1074` (listen calls)

**Interfaces:**
- Produces: single `app` Express instance; all routes registered on it. No `appGatling`, no `cors`.

- [ ] **Step 1: Remove the cors import and both `app.use(cors())` calls**

In `server.js` delete line 2 (`const cors = require('cors');`) and remove `appK6.use(cors());` (line 32) and `appGatling.use(cors());` (line 39).

- [ ] **Step 2: Collapse the two Express apps into one**

Replace the app-setup block (lines 31-44) with:

```js
// ── Single Express app (port 3847) ──────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/stress',   express.static(path.join(__dirname, 'public', 'stress')));
app.use('/scenario', express.static(path.join(__dirname, 'public', 'scenario')));
const appK6 = app;       // aliases so existing route registrations keep working
const appGatling = app;
```

Keeping the `appK6`/`appGatling` aliases means the ~15 existing `appGatling.get(...)` / `appK6.get(...)` registrations don't each need editing in this task.

- [ ] **Step 3: Replace the two `listen()` calls with one**

Replace lines 1063-1074 with:

```js
// ── Start server ────────────────────────────────────────────────────────────
const server = app.listen(3847, () => console.log('Floodgate → http://localhost:3847'));
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.log('Port 3847 already in use.');
  else console.error('Server error:', err);
});
```

- [ ] **Step 4: Resolve the duplicate `/api/status` route**

There are now two `/api/status` handlers on the same app: the k6 one (was `appK6.get`, ~line 721) and the Gatling one (was `appGatling.get`, ~line 730). Delete the Gatling `/api/status` handler entirely — the k6 handler (`hasK6`/`version`) is the one both modes will use.

- [ ] **Step 5: Verify the app boots and both mode pages load same-origin**

Run: `npm start`
Then in a browser (or `curl`): `http://localhost:3847/` (landing), `http://localhost:3847/stress/`, `http://localhost:3847/scenario/` all return 200 HTML. `curl http://localhost:3847/api/status` returns `{"hasK6":...}`. Nothing listens on 3848.
Expected: all three pages load; no 3848.

- [ ] **Step 6: Commit**

```bash
git add server.js
git commit -m "Merge Stress/Scenario servers onto one port, remove CORS"
```

---

### Task 2: Fix injection in the k6 stress-script generator

**Files:**
- Modify: `server.js:742-839` (`/api/run-test` handler, script template)

**Interfaces:**
- Consumes: request body `{ url, method, vus, duration, rampUp, headers, body, proxies }`.
- Produces: a k6 script where `method` is validated against the whitelist and `url` is `JSON.stringify`'d.

- [ ] **Step 1: Add method whitelist validation before script generation**

After the required-fields check (`server.js:770`), add:

```js
const ALLOWED_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'];
const methodUpper = String(req.body.method || '').toUpperCase();
if (!ALLOWED_METHODS.includes(methodUpper)) {
  return res.status(400).json({ error: `Invalid method. Allowed: ${ALLOWED_METHODS.join(', ')}` });
}
```

Then change `const normalizedMethod = method.toLowerCase();` (line 798) to `const normalizedMethod = methodUpper.toLowerCase();`.

- [ ] **Step 2: Serialize the URL safely in the generated script**

In the script template (line 830), the request line is currently:

```js
const res = http.${normalizedMethod}('${url}', ${hasBody ? bodyLiteral : 'null'}, { headers: ${headersLiteral}${proxyParam} });
```

Change `'${url}'` to `${JSON.stringify(url)}`:

```js
const res = http.${normalizedMethod}(${JSON.stringify(url)}, ${hasBody ? bodyLiteral : 'null'}, { headers: ${headersLiteral}${proxyParam} });
```

- [ ] **Step 3: Verify a normal stress test still runs and a bad method is rejected**

Run: `npm start`. From the Stress UI, run a GET test against `https://example.com` — it completes with metrics. Then:
`curl -s -XPOST http://localhost:3847/api/run-test -H 'content-type: application/json' -d '{"url":"https://example.com","method":"get(); //","vus":1,"duration":1}'`
Expected: normal test succeeds; the malicious-method request returns HTTP 400 "Invalid method".

- [ ] **Step 4: Verify a URL with a quote does not break the script**

`curl -s -XPOST http://localhost:3847/api/run-test -H 'content-type: application/json' -d '{"url":"https://example.com/?a='"'"'b","method":"GET","vus":1,"duration":1}'` returns a `testId` and the run does not fail with a script parse error (check the run's log/status via the UI or `/api/results/:testId`).
Expected: run starts and executes (no k6 syntax error from the URL).

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "Validate method and escape URL in k6 stress script generator"
```

---

### Task 3: Add the k6 Scenario script generator

**Files:**
- Modify: `server.js` — add `generateK6ScenarioScript()` and a `K6_JSONPATH_SRC` string constant near the other generators (replace `generateGatlingSimulation` at 325-450 in Task 6; for now add alongside).

**Interfaces:**
- Produces:
  - `K6_JSONPATH_SRC` — a string containing the source of a `function jsonPathValue(obj, path)` that resolves paths like `$.a.b[0].c` and returns the value or `undefined`. Emitted verbatim into each generated script.
  - `generateK6ScenarioScript({ scenario, env, vus, duration, rampUp, loadModel, arrivalRate, preAllocatedVUs, proxy }) => string` — returns a complete k6 script.

- [ ] **Step 1: Add the mini-JSONPath source constant**

Add near the top of the generator section:

```js
// Source of a tiny JSONPath resolver, emitted verbatim into generated k6 scripts.
// Supports $.a.b, a.b, and [n] index segments. Returns undefined if not found.
const K6_JSONPATH_SRC = `
function jsonPathValue(obj, path) {
  if (obj == null || !path) return undefined;
  var clean = String(path).replace(/^\\$\\.?/, '');
  var parts = clean.match(/[^.\\[\\]]+/g) || [];
  var cur = obj;
  for (var i = 0; i < parts.length; i++) {
    if (cur == null) return undefined;
    var key = /^\\d+$/.test(parts[i]) ? Number(parts[i]) : parts[i];
    cur = cur[key];
  }
  return cur;
}`;
```

- [ ] **Step 2: Add the scenario generator function**

Add `generateK6ScenarioScript`. It reuses the existing `escJSStr`/`toGatlingEL`-style templating but targets k6. Note: `{{var}}` placeholders must become `${vars.var}` inside a JS template literal in the generated script. Add a helper inside `server.js`:

```js
// Convert user text with {{var}} placeholders into a k6 template-literal body.
// Escapes backticks/${ and rewrites {{name}} -> ${vars.name}.
function toK6Template(str) {
  return String(str == null ? '' : str)
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$\{/g, '\\${')
    .replace(/\{\{(\w+)\}\}/g, '${vars.$1 == null ? "" : vars.$1}');
}
```

Then the generator:

```js
function generateK6ScenarioScript({ scenario, env, vus, duration, rampUp, loadModel, arrivalRate, preAllocatedVUs, proxy }) {
  const ALLOWED = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'];
  const baseUrl = env.host;
  const steps = scenario.steps || [];

  // ── Per-step code ──
  const stepCode = steps.map((step, i) => {
    const methodUpper = ALLOWED.includes(String(step.method || 'GET').toUpperCase())
      ? String(step.method).toUpperCase() : 'GET';
    const method = methodUpper.toLowerCase();
    const hasBody = ['post', 'put', 'patch'].includes(method);

    // URL = baseUrl + path, with {{var}} interpolation via template literal
    const pathTpl = toK6Template(step.path || '/');

    // Query params -> object built as template
    const queryPairs = [];
    if (step.queryParams && step.queryParams.trim()) {
      step.queryParams.trim().split('\n').map(l => l.trim()).filter(l => l.includes('=')).forEach(l => {
        const idx = l.indexOf('=');
        queryPairs.push(`${JSON.stringify(l.slice(0, idx).trim())}: \`${toK6Template(l.slice(idx + 1).trim())}\``);
      });
    }
    const queryStr = queryPairs.length
      ? ` + '?' + Object.entries({${queryPairs.join(', ')}}).map(function(kv){return encodeURIComponent(kv[0])+'='+encodeURIComponent(kv[1]);}).join('&')`
      : '';

    // Headers -> object
    const headerPairs = [];
    if (step.headers && step.headers.trim()) {
      step.headers.trim().split('\n').map(l => l.trim()).filter(l => l.includes(':')).forEach(l => {
        const ci = l.indexOf(':');
        headerPairs.push(`${JSON.stringify(l.slice(0, ci).trim())}: \`${toK6Template(l.slice(ci + 1).trim())}\``);
      });
    }
    const headersObj = `{${headerPairs.join(', ')}}`;

    // Body
    const bodyExpr = hasBody && step.body && step.body.trim()
      ? '`' + toK6Template(step.body.trim()) + '`'
      : 'null';

    // Checks
    const chk = step.checks || {};
    const checkEntries = [];
    if (chk.statusCode) checkEntries.push(`'status is ${Number(chk.statusCode)}': function(r){return r.status === ${Number(chk.statusCode)};}`);
    else checkEntries.push(`'status 2xx': function(r){return r.status >= 200 && r.status < 300;}`);
    if (chk.maxResponseTime) checkEntries.push(`'resp < ${Number(chk.maxResponseTime)}ms': function(r){return r.timings.duration <= ${Number(chk.maxResponseTime)};}`);
    if (chk.bodyContains) checkEntries.push(`'body contains': function(r){return String(r.body).indexOf(${JSON.stringify(chk.bodyContains)}) !== -1;}`);

    // Extractions
    const extractLines = (step.extractions || []).filter(ex => ex.varName && ex.jsonPath).map(ex => {
      return `  try { var __v = jsonPathValue(res.json(), ${JSON.stringify(ex.jsonPath)}); if (__v !== undefined) vars[${JSON.stringify(ex.varName)}] = __v; } catch (e) {}`;
    });

    // Think time -> sleep
    let sleepLine = '  sleep(1);';
    if (step.thinkTime !== undefined && step.thinkTime !== '') {
      const tt = String(step.thinkTime).trim();
      if (tt.includes('-')) {
        const [mn, mx] = tt.split('-').map(Number);
        if (!isNaN(mn) && !isNaN(mx) && mx > mn) sleepLine = `  sleep(${mn} + Math.random() * ${mx - mn});`;
      } else {
        const f = parseFloat(tt);
        if (isNaN(f) || f <= 0) sleepLine = '';
        else sleepLine = `  sleep(${f});`;
      }
    }

    return [
      `  {`,
      `    var url = \`${baseUrlLiteral(baseUrl)}${pathTpl}\`${queryStr};`,
      `    var params = { headers: ${headersObj}${'PROXY_PARAM'} };`,
      `    var res = http.${method}(url, ${bodyExpr}, params);`,
      `    recordStatus(res.status);`,
      `    check(res, {\n      ${checkEntries.join(',\n      ')}\n    });`,
      ...extractLines,
      ...(sleepLine ? [sleepLine] : []),
      `  }`,
    ].join('\n');
  }).join('\n');

  // ── Executor / scenarios ──
  let execBlock;
  if (loadModel === 'arrival-rate') {
    const rate = Number(arrivalRate) || 10;
    const prealloc = Number(preAllocatedVUs) || 50;
    execBlock = rampUp > 0
      ? `{ executor: 'ramping-arrival-rate', startRate: 0, timeUnit: '1s', preAllocatedVUs: ${prealloc}, stages: [ { target: ${rate}, duration: '${Number(rampUp)}s' }, { target: ${rate}, duration: '${Number(duration)}s' } ] }`
      : `{ executor: 'constant-arrival-rate', rate: ${rate}, timeUnit: '1s', duration: '${Number(duration)}s', preAllocatedVUs: ${prealloc} }`;
  } else {
    const v = Number(vus) || 10;
    execBlock = rampUp > 0
      ? `{ executor: 'ramping-vus', startVUs: 0, stages: [ { target: ${v}, duration: '${Number(rampUp)}s' }, { target: ${v}, duration: '${Number(duration)}s' } ] }`
      : `{ executor: 'constant-vus', vus: ${v}, duration: '${Number(duration)}s' }`;
  }

  // ── Proxy (per-VU round robin, mirrors stress generator) ──
  const parsed = proxy ? parseProxyUrl(proxy) : null;
  const proxyBlock = parsed ? `const __proxies = ${JSON.stringify([proxy])};\nconst __proxy = __proxies[(__VU - 1) % __proxies.length];` : '';
  const proxyParam = parsed ? ', proxy: __proxy' : '';

  return `import http from 'k6/http';
import { sleep, check } from 'k6';
import { Counter } from 'k6/metrics';
import { vu } from 'k6/execution';

const status_2xx = new Counter('status_2xx');
const status_3xx = new Counter('status_3xx');
const status_4xx = new Counter('status_4xx');
const status_5xx = new Counter('status_5xx');
const status_other = new Counter('status_other');
${proxyBlock}
${K6_JSONPATH_SRC}

function recordStatus(s) {
  if (s >= 200 && s < 300) status_2xx.add(1);
  else if (s >= 300 && s < 400) status_3xx.add(1);
  else if (s >= 400 && s < 500) status_4xx.add(1);
  else if (s >= 500 && s < 600) status_5xx.add(1);
  else status_other.add(1);
}

export const options = { scenarios: { main: ${execBlock} } };

export default function () {
  const vars = {};
${stepCode.replace(/PROXY_PARAM/g, proxyParam)}
}
`;
}

// Helper: base URL as a template-literal-safe prefix
function baseUrlLiteral(host) {
  return String(host == null ? '' : host)
    .replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
}
```

Note the `'PROXY_PARAM'` placeholder inside `params` is replaced by `.replace(/PROXY_PARAM/g, proxyParam)` at the end — this threads the optional proxy param into every step without per-step branching.

- [ ] **Step 3: Verify the generator produces a syntactically valid k6 script**

Add a throwaway check (do not commit it): in a Node REPL or temp script, require `server.js`'s function is not exported, so instead verify indirectly in Task 5. For now, sanity-check by eye that the emitted string has balanced braces and that `${vars.x}` appears where a step path used `{{x}}`.

Run: `node -e "new Function(require('fs').readFileSync('/tmp/sample.k6.js','utf8'))"` is NOT valid for k6 imports; skip automated syntax check here — Task 5 runs the real k6 binary which is the true verification.

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "Add k6 scenario script generator with mini-JSONPath extraction"
```

---

### Task 4: Add shared `runK6()` helper and refactor stress to use it

**Files:**
- Modify: `server.js` — extract the spawn/SSE/parse logic from `/api/run-test` (lines ~857-993) into a reusable `runK6()`.

**Interfaces:**
- Produces: `runK6({ scriptPath, resultsPath, summaryPath, totalDuration, testEntry, onDone }) => ChildProcess` where `testEntry` is the object stored in `tests` (has `clients`, `stdout`, `progress`, etc.), and `onDone(code, metrics)` is called after parsing. Handles: spawn via `getK6Cmd()`, progress interval, throttled log buffer, stdout live-metrics parse, buffer size limits, summary/raw metrics parse.

- [ ] **Step 1: Extract `runK6()`**

Move the body of `/api/run-test` that runs after `tests.set(...)` (the `spawn`, `progressInterval`, `queueLog`/`flushLogs`, `proc.stdout`/`proc.stderr`/`proc.on('close')` blocks) into a standalone `function runK6({ testId, scriptPath, resultsPath, summaryPath, totalDuration, onDone })`. It reads the test entry via `tests.get(testId)` exactly as the inline code does today. On close, after computing `t.metrics`, call `onDone && onDone(code, t.metrics)` before sending the SSE `done` event (so callers like Scenario can persist to `runs.json`).

- [ ] **Step 2: Call `runK6()` from `/api/run-test`**

Replace the extracted inline block with a single call:

```js
const totalDuration = (rampUp || 0) + duration + 10;
runK6({ testId, scriptPath, resultsPath, summaryPath, totalDuration });
return res.json({ testId });
```

- [ ] **Step 3: Verify stress mode is unchanged**

Run: `npm start`. Run a stress test from the UI. Confirm: live progress bar advances, live log lines appear, final metrics (RPS, latency percentiles, status pie) render exactly as before.
Expected: identical behavior to pre-refactor.

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "Extract shared runK6 helper from stress test handler"
```

---

### Task 5: Rewire the Scenario run endpoint to k6 + shared limits + SSE

**Files:**
- Modify: `server.js:200-308` (`/api/scenarios/:id/run`), add `/api/runs/:id/progress` SSE endpoint. Remove Gatling spawn.

**Interfaces:**
- Consumes: `generateK6ScenarioScript()` (Task 3), `runK6()` (Task 4), `parseK6Metrics()`, the shared `tests` Map and `MAX_CONCURRENT_TESTS`/`MAX_TOTAL_VUS`.
- Produces: `/api/scenarios/:id/run` starts a k6-backed run keyed by `runId`, registered in `tests` (for shared limits) AND persisted to `runs.json`. New `/api/runs/:id/progress` SSE endpoint streams `progress`/`metrics`/`log`/`done` for a running scenario.

- [ ] **Step 1: Apply the shared concurrency check to scenario runs**

At the start of `/api/scenarios/:id/run`, after loading scenario/env and validating steps, add the same guard used by `/api/run-test`:

```js
if (tests.size >= MAX_CONCURRENT_TESTS) {
  return res.status(429).json({ error: `Max concurrent tests limit reached (max ${MAX_CONCURRENT_TESTS})` });
}
let currentVus = 0;
for (const t of tests.values()) { if (!t.done) currentVus += (t.config?.vus || 0); }
const effVus = loadModel === 'arrival-rate' ? (Number(preAllocatedVUs) || 50) : (Number(vus) || 10);
if (currentVus + effVus > MAX_TOTAL_VUS) {
  return res.status(429).json({ error: `Max total VUS limit reached (max ${MAX_TOTAL_VUS})` });
}
```

- [ ] **Step 2: Generate a k6 script instead of a Gatling sim**

Replace the `simFolder`/`resultsFolder`/`generateGatlingSimulation`/`writeFileSync(...FloodgateSimulation.gatling.js...)` block with:

```js
const runId = makeId();
const scriptPath  = path.join(tempDir, `${runId}-scenario.js`);
const resultsPath = path.join(tempDir, `${runId}-results.json`);
const summaryPath = path.join(tempDir, `${runId}-summary.json`);
const script = generateK6ScenarioScript({ scenario, env, vus, duration, rampUp, loadModel, arrivalRate, preAllocatedVUs, proxy });
fs.writeFileSync(scriptPath, script, 'utf8');
```

- [ ] **Step 3: Register the run in `tests` and persist to runs.json**

Keep the existing `runs.json` push (the `run` object). Also register a `tests` entry so shared limits and SSE work, then start k6 via `runK6()`:

```js
tests.set(runId, {
  status: 'running', progress: 0, stdout: '', stderr: '', parsed: null,
  done: false, error: null, clients: new Set(),
  config: { vus: effVus, duration, rampUp }, startTime: Date.now(), endTime: null,
});

const totalDuration = (Number(rampUp) || 0) + Number(duration) + 10;
runK6({
  testId: runId, scriptPath, resultsPath, summaryPath, totalDuration,
  onDone: (code, metrics) => {
    const allRuns = readData('runs.json');
    const idx = allRuns.findIndex(r => r.id === runId);
    if (idx === -1) return;
    allRuns[idx].status     = code === 0 ? 'completed' : 'failed';
    allRuns[idx].finishedAt = new Date().toISOString();
    allRuns[idx].metrics    = metrics || null;
    if (code !== 0 && !metrics) allRuns[idx].error = `k6 exited with code ${code}`;
    writeData('runs.json', allRuns);
    try { fs.unlinkSync(scriptPath); } catch {}
    try { fs.unlinkSync(resultsPath); } catch {}
    try { fs.unlinkSync(summaryPath); } catch {}
  },
});

res.status(202).json({ runId, status: 'running' });
```

- [ ] **Step 4: Add the scenario progress SSE endpoint**

Add near `/api/progress/:testId`:

```js
app.get('/api/runs/:id/progress', (req, res) => {
  const t = tests.get(req.params.id);
  if (!t) {
    // Run may already be finished & only in runs.json — report terminal state.
    const runs = readData('runs.json');
    const run = runs.find(r => r.id === req.params.id);
    if (run) return res.json({ status: run.status, metrics: run.metrics || null, done: true });
    return res.status(404).json({ error: 'Run not found' });
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  t.clients.add(res);
  res.write(`data: ${JSON.stringify({ type: 'status', status: t.status, progress: t.progress })}\n\n`);
  req.on('close', () => t.clients.delete(res));
});
```

Note: the SSE endpoint returns JSON (not a stream) when the run is already terminal, so the frontend must check `Content-Type`/`done` — handled in Task 7.

- [ ] **Step 5: Verify a scenario run executes on k6 end-to-end**

Run: `npm start`. In the Scenario UI: create an environment (host `https://httpbin.org`), create a scenario with 2 steps — step 1 `GET /json`, step 2 `GET /get?x={{slideshow}}` with an extraction on step 1 (`slideshow ← $.slideshow.title`). Run it (closed model, 2 VUs, 5s).
Expected: run appears as `running`, then `completed`; run-detail shows Total Requests > 0 and latency percentiles. No Gatling/JVM download occurs.

- [ ] **Step 6: Verify the shared VUS limit blocks an over-limit scenario run**

With a stress test using near-max VUs active, `curl -s -XPOST http://localhost:3847/api/scenarios/<id>/run -H 'content-type: application/json' -d '{"environmentId":"<env>","vus":25000,"duration":5}'`.
Expected: HTTP 429 "Max total VUS limit reached".

- [ ] **Step 7: Commit**

```bash
git add server.js
git commit -m "Run Scenario mode on k6 via shared runK6, add run progress SSE"
```

---

### Task 6: Delete Gatling generator, parser, and unpacked-path usage

**Files:**
- Modify: `server.js` — remove `generateGatlingSimulation` (325-450), `parseGatlingSimLog` (543-602), `toGatlingEL`, and the Gatling-specific `unpackedPath` uses / `versions.js` require that only served Gatling.

**Interfaces:**
- Produces: no remaining references to Gatling.

- [ ] **Step 1: Remove dead Gatling functions**

Delete `generateGatlingSimulation`, `parseGatlingSimLog`, `parseProxyUrl` is STILL USED by the scenario generator (Task 3) — keep it. Delete `toGatlingEL` and `escJSStr` only if unused after Task 3 (grep first). Delete `runLogs` map and its uses (the old Gatling last-line log — the scenario now streams via SSE): grep `runLogs` and remove all references, including the `/api/runs/:id` handler's `const log = runLogs.get(...)` (leave the rest of that handler intact, just drop the `log` field).

- [ ] **Step 2: Grep for orphans**

Run: `grep -n -i "gatling\|runLogs\|generateGatlingSimulation\|parseGatlingSimLog\|toGatlingEL" server.js`
Expected: no matches except possibly comments you then remove. `parseProxyUrl` and `escJSStr`/`escJS` may remain if still referenced — confirm with grep before deleting.

- [ ] **Step 3: Verify the app still boots and both modes work**

Run: `npm start`. Repeat the stress test (Task 4 Step 3) and scenario run (Task 5 Step 5).
Expected: both work; no runtime error from a removed reference.

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "Remove dead Gatling generator, parser, and run-log map"
```

---

### Task 7: Frontend — relative links, k6 status badge, scenario live SSE

**Files:**
- Modify: `public/index.html:241`, `public/stress/index.html:524`, `public/scenario/index.html:606,619`
- Modify: `public/scenario/app.js` (`checkGatlingStatus` → `checkK6Status`, run-detail SSE)

- [ ] **Step 1: Make cross-mode links relative**

- `public/index.html:241`: `href="http://localhost:3848/"` → `href="/scenario/"`
- `public/stress/index.html:524`: `href="http://localhost:3848/"` → `href="/scenario/"`
- `public/scenario/index.html:606`: `href="http://localhost:3847/"` → `href="/"`
- `public/scenario/index.html:619`: `href="http://localhost:3847/stress/"` → `href="/stress/"`

- [ ] **Step 2: Replace the Gatling status badge with a k6 badge**

In `public/scenario/app.js` replace `checkGatlingStatus` (lines 761-779) with:

```js
async function checkK6Status() {
  const badge = document.getElementById('gatlingBadge');
  if (!badge) return;
  try {
    const data = await fetchJSON('/api/status');
    if (data.hasK6) {
      const ver = (data.version || '').split('\n')[0].trim().slice(0, 30);
      badge.className = 'gatling-badge ready';
      badge.textContent = '⬡ k6 ' + (ver || 'ready');
    } else {
      badge.className = 'gatling-badge checking';
      badge.textContent = '⬡ k6 not found';
    }
  } catch {
    badge.className = 'gatling-badge checking';
    badge.textContent = '⬡ k6…';
  }
}
```

Update the call site in `init()` (line 806) from `checkGatlingStatus();` to `checkK6Status();`.

- [ ] **Step 3: Subscribe run-detail to SSE for live progress**

In `public/scenario/app.js`, at the end of `loadRunDetail(id)` (after line 500), add live streaming when the run is still running:

```js
  if (run.status === 'running') {
    subscribeRunProgress(run.id);
  }
}

let runDetailSource = null;
function subscribeRunProgress(runId) {
  if (runDetailSource) { runDetailSource.close(); runDetailSource = null; }
  const src = new EventSource(`/api/runs/${runId}/progress`);
  runDetailSource = src;
  src.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'progress') {
      const badge = document.getElementById('run-detail-status-badge');
      if (badge) badge.innerHTML = statusBadge('running') + ` <span style="color:var(--muted);font-size:0.7rem">${msg.progress || 0}%</span>`;
    } else if (msg.type === 'done') {
      src.close(); runDetailSource = null;
      loadRunDetail(runId); // reload to render final metrics from runs.json
    }
  };
  src.onerror = () => { src.close(); runDetailSource = null; };
}
```

Note: the endpoint may respond with a plain JSON body (not a stream) if the run already finished; `EventSource` will error on a non-event-stream response, which we handle by closing quietly — the initial `loadRunDetail` fetch already rendered the terminal state in that case.

- [ ] **Step 4: Point the runs-list poller at the SSE-friendly path (optional cleanup)**

The existing `startRunPoller` (line 783) polls `/api/runs/:id` for `run.log`, which no longer exists (removed in Task 6). Simplify it to just poll status and refresh the list:

```js
let runPoller = null;
function startRunPoller(runId) {
  if (runPoller) clearInterval(runPoller);
  runPoller = setInterval(async () => {
    try {
      const run = await fetchJSON(`/api/runs/${runId}`);
      if (run.status !== 'running') { clearInterval(runPoller); runPoller = null; loadRuns(); }
    } catch { clearInterval(runPoller); runPoller = null; }
  }, 1500);
}
```

- [ ] **Step 5: Verify navigation and live progress in the browser**

Run: `npm start`. From landing, click Scenarios → lands on `/scenario/` same-origin. Badge shows "k6 …/ready". Start a run, open its detail while running → progress % updates live, then metrics appear on completion without a manual refresh. Click back to Stress → lands on `/stress/`.
Expected: all navigation same-origin (no 3848), badge shows k6, live progress works.

- [ ] **Step 6: Commit**

```bash
git add public/index.html public/stress/index.html public/scenario/index.html public/scenario/app.js
git commit -m "Frontend: relative mode links, k6 status badge, scenario live SSE"
```

---

### Task 8: Cleanup — dead file, package deps, gitignore, k6.exe

**Files:**
- Delete: `public/app2.js`
- Modify: `package.json`, `.gitignore`

- [ ] **Step 1: Delete the dead frontend duplicate**

Confirm unreferenced: `grep -rn "app2" public/*.html public/**/*.html` → no matches. Then `git rm public/app2.js`.

- [ ] **Step 2: Drop Gatling + cors from package.json**

Remove `"@gatling.io/cli"`, `"@gatling.io/core"`, `"@gatling.io/http"`, and `"cors"` from `dependencies`. Remove the `"node_modules/@gatling.io/**"` line from `build.asarUnpack` (keep `"data/**"`).

- [ ] **Step 3: Untrack k6.exe and ignore bin/**

```bash
git rm --cached bin/k6.exe
```

Add to `.gitignore` under the Dependencies or a new section:

```
# Downloaded k6 binary
bin/
```

- [ ] **Step 4: Reinstall to prune and verify boot**

Run: `npm install` (regenerates lockfile without gatling/cors), then `npm start`.
Expected: server boots on 3847; `curl http://localhost:3847/api/status` works; a stress test and a scenario run both complete. `git status` shows `bin/k6.exe` staged for deletion-from-index but the file still present on disk.

- [ ] **Step 5: Commit**

```bash
git add public package.json package-lock.json .gitignore
git commit -m "Remove dead app2.js, drop Gatling/cors deps, untrack bin/k6.exe"
```

---

### Task 9: Update README and design/status references

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update the docs to reflect a single k6 engine**

In `README.md`: change the Scenario Testing section from "(Gatling)" to "(k6)"; update "Auto Gatling install" bullet to k6; update Stack "dual servers on ports 3847 & 3848" → single server on 3847, and "Load engines: k6 (stress), Gatling JS DSL (scenarios)" → "Load engine: k6 (both modes)"; drop the "Gatling not ready" troubleshooting line and the 3848 mention in "Port in use".

- [ ] **Step 2: Verify no stale 3848 / Gatling references remain in shipped code or docs**

Run: `grep -rn -i "3848\|gatling" server.js main.js public README.md`
Expected: no matches (docs and code fully migrated). Design doc under `docs/superpowers/specs/` may still mention Gatling as history — that's fine, leave it.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "Update README for single k6 engine, single port"
```

---

## Self-Review Notes

- **Spec coverage:** single server (T1), CORS removed (T1), method whitelist + URL escape both generators (T2 stress, T3 scenario), k6 scenario generator + mini-JSONPath (T3), shared runK6 (T4), shared limits + scenario-on-k6 + SSE (T5), Gatling removal (T6), frontend relative links + k6 badge + live SSE (T7), dead code + deps + k6.exe + gitignore (T8), docs (T9). All spec sections mapped.
- **Data compatibility:** `parseK6Metrics` shape reused unchanged; `runs.json` fields preserved; scenario `statusCodes` now populated (documented as improvement, UI already handles it).
- **Type consistency:** `runK6({ testId, scriptPath, resultsPath, summaryPath, totalDuration, onDone })` signature is identical in T4 (definition), T5 (scenario call), and T4-step2 (stress call). `generateK6ScenarioScript` param list matches its call site in T5. `checkK6Status` reads `data.hasK6`/`data.version` matching the k6 `/api/status` handler kept in T1.
- **Known nuance:** `/api/runs/:id/progress` dual-responds (SSE stream while running, plain JSON when already terminal). T5-step4 and T7-step3 both call this out and handle it.
