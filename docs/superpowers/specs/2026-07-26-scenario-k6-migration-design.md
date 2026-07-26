# Scenario mode migration: Gatling → k6, plus bug/security fixes

Date: 2026-07-26

## Background

A code review of Floodgate surfaced several issues:

1. **CORS wide open** (`cors()` with no options) on both Express servers (ports 3847/3848), with no auth on any endpoint — any website open in the user's browser can hit these local APIs cross-origin.
2. **Code injection via generated scripts**: `method` is spliced as a bare identifier into generated k6/Gatling JS (`http.${normalizedMethod}(...)`, `.${method}(...)`) with no whitelist, and `url` is interpolated into a single-quoted template literal without escaping (unlike `headers`/`body`, which already use `JSON.stringify`). Combined with #1, this is a code-injection / potential RCE path (the Gatling sim runs inside a full Node process via `ELECTRON_RUN_AS_NODE=1`).
3. **Dead code**: `public/app2.js` is an old duplicate of `public/stress/app.js`, referenced by no HTML file.
4. **`bin/k6.exe` (71MB) committed and tracked in git**, despite the app auto-downloading k6 on first use — bloats `.git` to 248MB across 9 commits.
5. **Architecture**: Scenario mode runs on Gatling/JVM while Stress mode runs on k6. Two engines means duplicated install flows, script generators, metric parsers, servers/ports, and no concurrency limit on Gatling runs (unlike k6's `MAX_CONCURRENT_TESTS`/`MAX_TOTAL_VUS`). k6 can express everything Scenario mode needs (multi-step requests, checks, variable extraction, think-time, both load models via `ramping-vus`/`constant-vus` and `ramping-arrival-rate`/`constant-arrival-rate` executors), so Gatling can be dropped entirely.

The user asked to fix all of the above, including the full engine migration.

## Decisions (confirmed with user)

- **Single server**: merge the two Express apps into one, listening on port 3847. `public/scenario/` is mounted as static at `/scenario` (mirroring the existing `/stress` mount). All hardcoded `http://localhost:3848/...` links become relative. CORS is removed entirely — there was never a legitimate cross-origin need (mode switches were full-page navigations, not fetches); it existed only as attack surface.
- **Shared run-execution core**: both Stress and Scenario spawn k6 through one shared function that handles process spawn, throttled stdout/stderr log buffering, SSE client management, progress-interval calculation, and final metrics parsing (reusing the existing `parseK6Metrics`). Stress keeps results in-memory only (as today); Scenario additionally persists the finished run to `runs.json` (as today) and exposes live progress over a new `/api/runs/:id/progress` SSE endpoint with the same event shape as `/api/progress/:testId`.
- **Shared concurrency pool**: `MAX_CONCURRENT_TESTS` / `MAX_TOTAL_VUS` are counted across all active k6 processes regardless of mode, since both modes now drive the same engine on the same machine.
- **Live SSE for Scenario runs**: added now (not deferred) — the scenario run-detail screen subscribes to SSE instead of polling `/api/runs/:id` until completion.
- **Variable extraction**: implement a small (~15-20 line) JSONPath subset supporting `$.a.b[0].c` inside the generated k6 script, preserving the existing UI syntax (`varName ← $.json.path`) and existing scenario data with no migration needed.
- **Variable templating**: `{{var}}` placeholders continue to work; instead of converting to Gatling EL (`#{var}`), the generated k6 script does plain JS string substitution against a `vars` object populated as extractions happen across sequential steps.

## Script generation

`generateGatlingSimulation()` is replaced by `generateK6ScenarioScript()`, which produces a k6 script that:

- Picks the k6 executor based on `loadModel`: `ramping-vus`/`constant-vus` for the closed (fixed VUs) model, `ramping-arrival-rate`/`constant-arrival-rate` for the open (arrival-rate) model — matching the current Gatling `injectClosed`/`injectOpen` behavior.
- Runs scenario steps sequentially inside one default function: `http.<method>()` per step (query params, headers, JSON/raw body), `check()` for status/max response time/body-contains, `sleep()` for think-time (fixed or random range, matching current parsing of the `thinkTime` field).
- Applies proxy support using the same per-VU round-robin pattern already used by the Stress script generator.
- Defines the same `status_2xx`/`status_3xx`/`status_4xx`/`status_5xx`/`status_other` `Counter` metrics as the Stress script, so `parseK6Metrics()` populates `statusCodes` for Scenario runs too (currently always `{}` under Gatling — a strict improvement, not a regression, and the dashboard already renders this correctly for Stress).

Both the Stress and Scenario script generators get the same fix for the injection bug found in review:
- `method` is validated against a fixed whitelist (`GET/POST/PUT/PATCH/DELETE/HEAD`) before being used to build the script, instead of being spliced in unchecked.
- `url` / step `path` are always serialized via `JSON.stringify`, never hand-interpolated into a template literal.

## Data compatibility

No migration needed. `scenarios.json` / `environments.json` keep their existing shape. `runs.json` keeps its existing shape — `parseK6Metrics()` already returns the same metrics shape (`latency.{avg,p50,p75,p90,p95,p99,min,max}`, `successRate`, `errorRate`, `statusCodes`) that `parseGatlingSimLog()` used to produce, so the dashboard/history UI needs no changes to read it.

## Frontend changes

- `public/index.html`, `public/stress/index.html`, `public/scenario/index.html`: replace `http://localhost:3848/...` links with relative paths (`/scenario/`, `/`, `/stress/`).
- `public/scenario/index.html` / `app.js`: "Gatling ready" status badge becomes "k6 ready", backed by the same `/api/status` endpoint Stress already uses.
- `public/scenario/app.js`: run-detail view subscribes to the new `/api/runs/:id/progress` SSE stream for live progress/metrics instead of polling `/api/runs/:id` until `completed`/`failed`.

## Package / build

- Remove `@gatling.io/cli`, `@gatling.io/core`, `@gatling.io/http`, and `cors` from `package.json` dependencies.
- Remove the `node_modules/@gatling.io/**` entry from `asarUnpack` in the `build` config.

## Cleanup (bundled into this pass)

- Delete `public/app2.js` (dead code, unreferenced duplicate of `public/stress/app.js`).
- `git rm --cached bin/k6.exe`, add `bin/` to `.gitignore`. (Rewriting git history to shrink `.git` is a separate, more disruptive discussion — out of scope here.)

## Out of scope

- Rewriting git history to remove the large blob from past commits.
- Any change to the `scenarios.json` / `environments.json` schema.
- Per-step (rather than whole-run) latency breakdowns in the dashboard.
