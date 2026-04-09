# Floodgate

A desktop load testing tool with two modes: **Stress Testing** (powered by k6) and **Scenario Testing** (powered by Gatling). Built as an Electron app with a Node.js/Express backend and vanilla JavaScript frontend.

## Features

### Stress Testing (k6)
- **Multiple concurrent tests**: Up to 5 simultaneous tests, up to 5000 VUs each (25,000 VUs total)
- **Authorization support**: Bearer Token, Basic Auth, API Key — per test card
- **Custom headers & body**: Key-value header pairs, request body for POST/PUT/PATCH
- **Proxy support**: HTTP/SOCKS5 proxies per test with round-robin distribution across VUs
- **Ramp-up**: Gradual VU increase over configurable time
- **Real-time metrics via SSE**: RPS, latency percentiles (p50/p75/p90/p95/p99), success/error rates, status code breakdown
- **Results visualization**: Latency distribution chart + status code pie chart (Chart.js)
- **Auto k6 install**: Downloads and installs k6 automatically on first use (Windows/macOS)

### Scenario Testing (Gatling)
- **Multi-step user journeys**: Build workflows with ordered HTTP steps
- **Variable templating**: Extract values from responses using JSONPath (`varName ← $.json.path`) and reuse them in subsequent steps via `{{variable}}`
- **Response checks**: Validate HTTP status, max response time, body contains assertions
- **Think time**: Fixed or random range delays between steps
- **Two load models**: Closed (fixed VUs) or Open (arrival rate)
- **Environment management**: Define named environments (dev/staging/prod) with base URLs
- **Run history & analytics**: Paginated run history with filters (date, scenario, environment)
- **Metrics dashboard**: Total requests, RPS, latency percentiles, success/failure counts
- **Historical trends**: Chart view of latency and status across runs
- **Auto Gatling install**: JVM and Gatling CLI downloaded automatically on first use

### General
- **Electron desktop app**: Single-instance, native title bar, system browser for external links
- **Keyboard zoom**: Ctrl/Cmd +/- to zoom UI (0.5x–3.0x), reset with 0
- **Dark terminal theme**: JetBrains Mono font, #080c10 background
- **Data persistence**: Scenarios, environments, and run history stored in `~/.floodgate/`
- **Resource limits**: Memory monitoring, output buffer limits, auto-cleanup of completed tests

## Stack

- **Desktop**: Electron 33
- **Backend**: Node.js + Express (dual servers on ports 3847 & 3848)
- **Frontend**: Vanilla JS + HTML + Chart.js
- **Load engines**: k6 (stress), Gatling JS DSL (scenarios)

## Installation

Download the latest release for your platform from the [Releases](https://github.com/Blum83/Floodgate/releases) page.

- **Windows**: Run `Floodgate Setup 1.0.0.exe` (installer) or extract `Floodgate-1.0.0-win.zip` (portable)
- **macOS**: Open `Floodgate-1.0.0.dmg` and drag to Applications

k6 and Gatling are installed automatically on first use — no manual setup required.

## Development

```bash
npm install
npm run electron       # run in dev mode
npm run dist:win       # build Windows installer + zip
npm run dist:mac       # build macOS DMG
npm run dist           # build all platforms
```

## Project Structure

```
floodgate/
├── main.js              # Electron entry, zoom control, single-instance lock
├── server.js            # Dual Express servers, all APIs, k6 & Gatling process management
├── public/
│   ├── index.html       # Landing page (mode selector)
│   ├── stress/
│   │   ├── index.html   # Stress test UI
│   │   └── app.js       # Stress test frontend logic
│   └── scenario/
│       ├── index.html   # Scenario UI (editor, runs, dashboard, history)
│       └── app.js       # Scenario frontend logic
├── data/                # Default JSON data (scenarios, environments, runs)
├── temp/                # Generated k6 scripts & Gatling sims (auto-created)
├── build/               # App icons
└── scripts/
    └── generate-icons.js
```

## Server Configuration

| Constant | Default | Description |
|---|---|---|
| `MAX_CONCURRENT_TESTS` | 5 | Max simultaneous stress tests |
| `MAX_TOTAL_VUS` | 25,000 | Max VUs across all tests |
| `TEST_EXPIRY_MS` | 5 min | Auto-cleanup completed tests |
| `MAX_OUTPUT_SIZE` | 5 MB | Per-test stdout/stderr buffer limit |

## API (Stress — port 3847)

### `POST /api/run-test`
Start a stress test.
```json
{
  "url": "https://example.com/api",
  "method": "GET",
  "headers": { "Authorization": "Bearer token" },
  "body": "{\"key\": \"value\"}",
  "vus": 100,
  "duration": 30,
  "rampUp": 5,
  "proxies": ["http://proxy:8080"]
}
```
Returns `{ "testId": "abc123" }`

### `GET /api/progress/:testId`
SSE stream. Event types: `progress`, `metrics`, `log`, `done`.

### `GET /api/results/:testId`
Final parsed k6 metrics.

### `GET /api/active-tests`
List active tests, slot/VUS availability.

## Troubleshooting

- **k6 not found**: Click the status badge in the UI to trigger auto-install
- **Gatling not ready**: Wait for the readiness badge to turn green on first launch (JVM download)
- **Progress stuck at 95%**: Test is still in cooldown phase; wait for k6 to finish
- **Port in use**: Ensure nothing else is running on ports 3847 or 3848

## License

ISC
