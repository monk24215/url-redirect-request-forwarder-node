import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { RequestForwarder, FileLogger, ForwarderError } from '../index.js';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Local test server — covers all the scenarios httpbin would, but offline.
let server;
let baseUrl;
const callsTo503 = { count: 0 };

before(async () => {
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');

    // /get — echo query
    if (url.pathname === '/get') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ args: Object.fromEntries(url.searchParams) }));
      return;
    }

    // /post — echo body + headers
    if (url.pathname === '/post') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = Buffer.concat(chunks).toString('utf8');
      let parsed = null;
      try { parsed = JSON.parse(body); } catch {}
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        method: req.method,
        body,
        json: parsed,
        headers: req.headers,
      }));
      return;
    }

    // /status/:code
    const m = url.pathname.match(/^\/status\/(\d+)$/);
    if (m) {
      const code = Number(m[1]);
      if (code === 503) callsTo503.count++;
      res.statusCode = code;
      res.end(`HTTP ${code}`);
      return;
    }

    // /slow — sleep 2s
    if (url.pathname === '/slow') {
      await new Promise(r => setTimeout(r, 2000));
      res.end('slow');
      return;
    }

    // /set-cookie — multiple Set-Cookie headers
    if (url.pathname === '/set-cookie') {
      res.setHeader('Set-Cookie', ['a=1', 'b=2']);
      res.end('cookies set');
      return;
    }

    res.statusCode = 404;
    res.end('not found');
  });

  await new Promise(r => server.listen(0, r));
  baseUrl = `http://localhost:${server.address().port}`;
});

after(async () => {
  await new Promise(r => server.close(r));
});

describe('RequestForwarder', () => {

  it('throws on invalid URL', () => {
    assert.throws(() => new RequestForwarder('not-a-url'), ForwarderError);
  });

  it('forwards a GET and returns ok=true on 200', async () => {
    const rf = new RequestForwarder(`${baseUrl}/get`);
    const resp = await rf.forward();
    assert.equal(resp.ok, true);
    assert.equal(resp.status, 200);
    assert.equal(resp.attempts, 1);
    assert.ok(resp.durationMs >= 0);
  });

  it('forwards a POST body', async () => {
    const rf = new RequestForwarder(`${baseUrl}/post`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ping: 'pong' }),
    });
    const resp = await rf.forward();
    assert.equal(resp.ok, true);
    const data = resp.json();
    assert.equal(data.json.ping, 'pong');
  });

  it('merges query string into the target URL', async () => {
    const rf = new RequestForwarder(`${baseUrl}/get?a=1`, {
      query: { b: '2' },
    });
    const resp = await rf.forward();
    const data = resp.json();
    assert.equal(data.args.a, '1');
    assert.equal(data.args.b, '2');
  });

  it('retries on 503 and exhausts attempts', async () => {
    callsTo503.count = 0;
    const rf = new RequestForwarder(`${baseUrl}/status/503`, {
      maxRetries: 3,
      retryDelayMs: 10,
    });
    const resp = await rf.forward();
    assert.equal(resp.ok, false);
    assert.equal(resp.attempts, 3);
    assert.equal(callsTo503.count, 3);
  });

  it('does NOT retry on 404', async () => {
    const rf = new RequestForwarder(`${baseUrl}/status/404`, {
      maxRetries: 3,
    });
    const resp = await rf.forward();
    assert.equal(resp.attempts, 1);
    assert.equal(resp.status, 404);
    assert.equal(resp.ok, false);
  });

  it('aborts on timeout', async () => {
    const rf = new RequestForwarder(`${baseUrl}/slow`, {
      timeout: 100,
      maxRetries: 1,
    });
    const resp = await rf.forward();
    assert.equal(resp.ok, false);
    assert.match(resp.error, /Timeout/i);
  });

  it('calls the logger with request + result', async () => {
    const calls = [];
    const logger = {
      log: async (request, result) => calls.push({ request, result }),
    };
    const rf = new RequestForwarder(`${baseUrl}/get`, { sourceLabel: 'test' }, logger);
    await rf.forward();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].request.sourceLabel, 'test');
    assert.equal(calls[0].result.ok, true);
  });

  it('captures multiple Set-Cookie headers correctly', async () => {
    const rf = new RequestForwarder(`${baseUrl}/set-cookie`);
    const resp = await rf.forward();
    const cookies = resp.headers['set-cookie'];
    assert.ok(Array.isArray(cookies), 'set-cookie should be an array');
    assert.equal(cookies.length, 2);
  });

  it('strips hop-by-hop headers before forwarding', async () => {
    const rf = new RequestForwarder(`${baseUrl}/post`, {
      method: 'POST',
      headers: {
        'Host': 'should-be-stripped',
        'Connection': 'close',
        'X-Keep': 'yes',
      },
      body: 'x',
    });
    const resp = await rf.forward();
    const data = resp.json();
    assert.equal(data.headers['x-keep'], 'yes');
    assert.notEqual(data.headers['host'], 'should-be-stripped');
  });

  it('sets a default User-Agent when not provided', async () => {
    const rf = new RequestForwarder(`${baseUrl}/post`, { method: 'POST', body: 'x' });
    const resp = await rf.forward();
    const data = resp.json();
    assert.ok(/url-redirect-request-forwarder-node/.test(data.headers['user-agent']));
  });

});

describe('FileLogger', () => {
  it('writes one JSON line per forward', async () => {
    const path = join(tmpdir(), `forwarder-test-${Date.now()}.jsonl`);
    const logger = new FileLogger(path);
    const rf = new RequestForwarder(`${baseUrl}/get`, { sourceLabel: 'file_test' }, logger);
    await rf.forward();
    await rf.forward();

    const content = await fs.readFile(path, 'utf8');
    const lines = content.trim().split('\n');
    assert.equal(lines.length, 2);
    const entry = JSON.parse(lines[0]);
    assert.equal(entry.source_label, 'file_test');
    assert.equal(entry.ok, true);

    await fs.unlink(path);
  });
});
