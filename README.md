# Floodgate

A web-based load testing tool powered by k6, with Node.js/Express backend and vanilla JavaScript frontend.

## Features

- **Multiple concurrent tests**: Run up to 5 tests simultaneously, up to 5000 VUS each
- **Authorization support**: Bearer Token, Basic Auth, API Key — built into each test card
- **Real-time metrics**: RPS, latency percentiles, success/error rates, status code breakdown
- **Live progress**: Progress bar and metric cards update during test execution
- **Results visualization**: Latency distribution chart + status code pie chart
- **Dark theme UI**: Terminal-style interface with JetBrains Mono font
- **Flexible configuration**: HTTP methods (GET/POST/PUT/DELETE/PATCH), custom headers, request bodies, ramp-up

## Stack

- **Backend**: Node.js + Express
- **Frontend**: Vanilla JS + HTML + Chart.js
- **Load engine**: k6

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```
2. Install k6: https://grafana.com/docs/k6/latest/set-up/install-k6/
3. Start the server:
   ```bash
   node server.js
   ```
4. Open `http://localhost:3000`

## Usage

1. Click **+ Add Test** to add test cards (up to 5)
2. For each test card, configure:
   - **URL** and **HTTP method**
   - **Authorization** (optional): Bearer Token, Basic Auth, or API Key
   - **Headers**: custom key-value pairs
   - **Body**: request payload for POST/PUT/PATCH
   - **VUS**: virtual users, 1–5000
   - **Duration**: test length in seconds
   - **Ramp-up**: gradual VUS increase time (optional)
3. Click **Run This Test** on individual cards, or **Run All** to launch all at once
4. Monitor live progress, metrics, and raw k6 output
5. View final results: summary cards, latency chart, status code breakdown

## API

### POST /api/run-test

Start a load test.

```json
{
  "url": "https://example.com/api",
  "method": "GET",
  "headers": { "Authorization": "Bearer token" },
  "body": "{\"key\": \"value\"}",
  "vus": 100,
  "duration": 30,
  "rampUp": 5
}
```

Returns `{ "testId": "abc123" }`

### GET /api/progress/:testId

SSE endpoint. Event types: `progress`, `metrics`, `log`, `done`.

### GET /api/results/:testId

Final test results with parsed k6 metrics.

### GET /api/active-tests

List active tests, slot/VUS availability.

## Configuration (server.js)

| Constant | Default | Description |
|---|---|---|
| `MAX_CONCURRENT_TESTS` | 5 | Max simultaneous tests |
| `MAX_TOTAL_VUS` | 25000 | Max VUS across all tests |
| `TEST_EXPIRY_MS` | 5 min | Auto-cleanup completed tests |
| `MAX_OUTPUT_SIZE` | 5 MB | Per-test stdout/stderr buffer limit |

## Project Structure

```
floodgate/
├── server.js          # Express server + k6 process manager
├── public/
│   ├── index.html     # UI layout + styles
│   └── app2.js        # Frontend logic
├── temp/              # Generated k6 scripts & results (auto-created)
└── package.json
```

## Troubleshooting

- **k6 not found**: Run `k6 version` in terminal; ensure k6 is in system PATH
- **Progress stuck at 95%**: Test is still running; wait for k6 cooldown phase
- **Metrics empty**: Check `temp/` folder for `summary.json`; check server console
- **Port 3000 in use**: Kill the existing process or change the port in `server.js`

## License

ISC
