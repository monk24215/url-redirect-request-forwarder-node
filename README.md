# url-redirect-request-forwarder-node

A small, framework-agnostic Node.js library for forwarding HTTP requests with faithful passthrough, automatic retry, and pluggable logging.

[![Tests](https://github.com/monk242/url-redirect-request-forwarder-node/actions/workflows/tests.yml/badge.svg)](https://github.com/monk242/url-redirect-request-forwarder-node/actions/workflows/tests.yml)
[![Node Version](https://img.shields.io/badge/node-%3E%3D18-green)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> Node.js sibling of [url-redirect-request-forwarder-php](https://github.com/monk242/url-redirect-request-forwarder-php). Same surface, same semantics, idiomatic Node.

## What it does

- Forwards method, query string, body, headers, and cookies verbatim to any target URL
- Retries on transient failures (5xx, network errors) with exponential backoff
- Does **not** retry 4xx — those are client-side conditions that won't change
- Strips hop-by-hop headers (`Host`, `Content-Length`, `Connection`, etc.) automatically
- Returns a structured `ForwardResult` object (status, body, headers, attempts, duration, error)
- Optional transparent proxy mode (echoes upstream response back to a Node http.ServerResponse)
- Pluggable logging — ships with file (JSONL), SQL (driver-agnostic), null, or bring your own
- **Zero runtime dependencies** — uses built-in `fetch`, `AbortController`, and `node:test`

## What it does NOT do

- **It cannot guarantee 100% delivery.** Networks fail, targets go down, certificates expire. What this library guarantees is faithful passthrough, sensible retry behavior, and structured error reporting so your caller can make informed decisions.
- It is not a streaming proxy — request and response bodies are buffered in memory. For multi-gigabyte payloads use a different tool.
- It does not handle authentication for you — pass any auth headers via the `headers` option.

## Installation

```bash
npm install url-redirect-request-forwarder-node
```

Requires Node 18+ (recommended: 20.x or 22.x LTS).

## Quick start

### Basic forward

```js
import { RequestForwarder } from 'url-redirect-request-forwarder-node';

const rf = new RequestForwarder('https://api.example.com/webhook', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ event: 'order.created' }),
});

const resp = await rf.forward();

if (resp.ok) {
  console.log(`Forwarded successfully in ${resp.durationMs}ms`);
} else {
  console.error(`Forward failed after ${resp.attempts} attempts: ${resp.error}`);
}
```

### Transparent proxy with raw `node:http` (no dependencies)

```js
import http from 'node:http';
import { RequestForwarder } from 'url-redirect-request-forwarder-node';

http.createServer(async (req, res) => {
  // Buffer the request body
  const chunks = [];
  for await (const c of req) chunks.push(c);
  req.body = Buffer.concat(chunks);

  const rf = RequestForwarder.fromIncomingRequest(
    'https://upstream.example.com' + req.url,
    req
  );
  await rf.proxy(res);
}).listen(3000);
```

### Transparent proxy with Express

```js
import express from 'express';
import { RequestForwarder } from 'url-redirect-request-forwarder-node';

const app = express();
app.use(express.raw({ type: '*/*', limit: '10mb' }));

app.all('*', async (req, res) => {
  const rf = RequestForwarder.fromIncomingRequest(
    'https://upstream.example.com' + req.path,
    req
  );
  await rf.proxy(res);
});

app.listen(3000);
```

### With file logging

```js
import { RequestForwarder, FileLogger } from 'url-redirect-request-forwarder-node';

const logger = new FileLogger('./logs/forwards.jsonl');
const rf = new RequestForwarder('https://api.example.com', {}, logger);
await rf.forward();
```

Each forward appends one JSON line to the file with full request/response details.

### With SQL logging (Postgres / MySQL / SQLite)

Apply `sql/schema.sql` to your database, then pass a query function to `SqlLogger`:

```js
import { RequestForwarder, SqlLogger } from 'url-redirect-request-forwarder-node';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const logger = new SqlLogger({
  execute: (sql, params) => pool.query(sql, params),
  placeholders: 'numeric',  // 'numeric' for pg ($1, $2…), 'qmark' for mysql2/sqlite (?)
});

const rf = new RequestForwarder('https://api.example.com', {}, logger);
```

See `examples/06-with-sql-logging.js` for MySQL and SQLite variants.

### Custom logger

```js
class MyLogger {
  async log(request, result) {
    // ship to pino / winston / Sentry / Datadog / wherever
  }
}

const rf = new RequestForwarder('https://api.example.com', {}, new MyLogger());
```

## Configuration

All options passed via the second constructor argument:

| Option | Default | Description |
|---|---|---|
| `method` | `'GET'` | HTTP method |
| `query` | `{}` | Query params (merged into target URL) |
| `body` | `null` | Request body (string, Buffer, or stream) |
| `headers` | `{}` | Request headers |
| `cookies` | `{}` | Cookies (merged into `Cookie` header) |
| `timeout` | `30000` | Total timeout (milliseconds) |
| `maxRetries` | `3` | Max attempts on 5xx/network errors |
| `retryDelayMs` | `250` | Base delay (exponential backoff) |
| `followRedirects` | `true` | Follow 3xx |
| `maxRedirects` | `5` | Redirect cap (note: `fetch` enforces this internally) |
| `verifySsl` | `true` | (Reserved; disabling requires a custom dispatcher — see security notes) |
| `stripHeaders` | hop-by-hop list | Headers to strip before forwarding |
| `sourceLabel` | `null` | Tag for log entries |
| `userAgent` | `'url-redirect-request-forwarder-node/1.0'` | Sent if no User-Agent provided |
| `fetchImpl` | `null` | Override fetch (useful for tests or `undici` dispatchers) |

## ForwardResult

```js
resp.ok         // boolean — true if 2xx/3xx and no transport error
resp.status     // number — HTTP status (0 if request never completed)
resp.headers    // object — response headers (repeated headers become arrays)
resp.body       // string — response body
resp.attempts   // number — how many tries it took
resp.durationMs // number — total wall-clock time in ms
resp.finalUrl   // string — URL actually requested (with merged query)
resp.error      // string|null — error message if !ok
resp.json()     // any — convenience JSON decode of body (null if invalid)
resp.toJSON()   // object — full result as plain object
```

## Retry semantics

- **5xx and network errors are retried** up to `maxRetries` times with exponential backoff (`retryDelayMs * 2^(attempt-1)`)
- **4xx is NOT retried** — these indicate a client-side condition (bad request, auth, not found) that won't change
- **2xx/3xx returns immediately**
- A failure after all retries still returns a `ForwardResult` (not a thrown error) with `ok: false` and `error` set

## Security notes

- **SSL verification is on by default** via Node's built-in fetch. Disabling it requires passing a custom `undici` dispatcher to `fetchImpl` — there's no quick flag for this on purpose.
- Be careful when using `fromIncomingRequest()` on a public endpoint — you become a proxy. Restrict which targets are allowed, rate-limit, and authenticate callers.
- Request and response bodies may contain sensitive data. Configure your logger's `bodyMax` accordingly, or implement a redacting logger.

## Testing

```bash
npm install
npm test
```

Tests spin up a local HTTP server — no external network needed, no httpbin dependency.

## Contributing

Pull requests welcome. Please:
1. Open an issue first for non-trivial changes
2. Add tests for new behavior
3. Keep zero runtime dependencies (dev dependencies for tooling are fine)

## License

MIT — see [LICENSE](LICENSE).
