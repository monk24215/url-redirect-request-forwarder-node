import { ForwardResult } from './ForwardResult.js';
import { ForwarderError } from './errors.js';
import { NullLogger } from './loggers/NullLogger.js';

/** Hop-by-hop and proxy-sensitive headers that should not be forwarded. */
const DEFAULT_STRIP_HEADERS = new Set([
  'host', 'content-length', 'connection', 'expect',
  'accept-encoding', 'proxy-connection', 'transfer-encoding',
  'keep-alive', 'te', 'trailer', 'upgrade',
]);

const DEFAULT_OPTS = {
  method: 'GET',
  query: {},
  body: null,
  headers: {},
  cookies: {},
  timeout: 30_000,
  maxRetries: 3,
  retryDelayMs: 250,
  followRedirects: true,
  maxRedirects: 5,
  verifySsl: true,
  stripHeaders: [...DEFAULT_STRIP_HEADERS],
  sourceLabel: null,
  userAgent: 'url-redirect-request-forwarder-node/1.0',
  fetchImpl: null, // override for testing or custom dispatcher
};

/**
 * Forwards HTTP requests with full passthrough, retries, and pluggable logging.
 *
 * - Faithfully forwards method, query string, body, headers, and cookies
 * - Retries on transient failures (5xx, network errors) with exponential backoff
 * - Does NOT retry 4xx — those are client-side conditions that won't change
 * - Strips hop-by-hop headers automatically
 */
export class RequestForwarder {
  constructor(targetUrl, opts = {}, logger = null) {
    if (typeof targetUrl !== 'string' || !targetUrl) {
      throw new ForwarderError(`Invalid target URL: ${targetUrl}`);
    }
    try { new URL(targetUrl); }
    catch { throw new ForwarderError(`Invalid target URL: ${targetUrl}`); }

    this.targetUrl = targetUrl;
    this.opts = { ...DEFAULT_OPTS, ...opts };
    this.logger = logger || new NullLogger();

    if (typeof fetch !== 'function' && !this.opts.fetchImpl) {
      throw new ForwarderError(
        'No global fetch found. Requires Node 18+ or pass `fetchImpl` in opts.'
      );
    }
  }

  /**
   * Create a forwarder pre-populated from an incoming Node http.IncomingMessage
   * (works with raw http, Express, Fastify, etc).
   *
   * For Express: pass `req` after body-parsing middleware has populated `req.body`,
   * or pass a pre-buffered body string/Buffer in opts.body.
   * For raw http: you must buffer the body yourself before calling this.
   */
  static fromIncomingRequest(targetUrl, req, opts = {}, logger = null) {
    const headers = { ...(req.headers || {}) };
    const url = new URL(req.url || '/', 'http://placeholder.local');
    const query = Object.fromEntries(url.searchParams);

    let body = opts.body ?? null;
    if (body == null && req.body != null) {
      // Express-style: body may be object (parsed) or string/Buffer (raw)
      if (typeof req.body === 'string' || Buffer.isBuffer(req.body)) {
        body = req.body;
      } else if (typeof req.body === 'object') {
        const ct = (headers['content-type'] || '').toLowerCase();
        if (ct.includes('application/json')) {
          body = JSON.stringify(req.body);
        } else if (ct.includes('application/x-www-form-urlencoded')) {
          body = new URLSearchParams(req.body).toString();
        } else {
          body = JSON.stringify(req.body);
        }
      }
    }

    const merged = {
      method: req.method || 'GET',
      headers,
      query: { ...query, ...(opts.query || {}) },
      body,
      ...opts,
    };
    // user's opts win over auto-detected:
    if (opts.method) merged.method = opts.method;
    if (opts.headers) merged.headers = { ...headers, ...opts.headers };

    return new RequestForwarder(targetUrl, merged, logger);
  }

  /** Execute the forward and return a structured ForwardResult. */
  async forward() {
    this._stripHopHeaders();
    this._mergeCookiesIntoHeaders();
    this._ensureUserAgent();

    const finalUrl = this._buildFinalUrl();
    const fetchFn = this.opts.fetchImpl || fetch;

    const started = Date.now();
    let attempt = 0;
    let lastError = null;
    let status = 0;
    let body = '';
    let respHeaders = {};

    while (attempt < this.opts.maxRetries) {
      attempt++;
      respHeaders = {};

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.opts.timeout);

      try {
        const method = this.opts.method.toUpperCase();
        const init = {
          method,
          headers: this.opts.headers,
          signal: controller.signal,
          redirect: this.opts.followRedirects ? 'follow' : 'manual',
        };
        if (!['GET', 'HEAD'].includes(method) && this.opts.body != null && this.opts.body !== '') {
          init.body = this.opts.body;
        }

        const response = await fetchFn(finalUrl, init);
        clearTimeout(timer);

        status = response.status;
        respHeaders = this._extractHeaders(response.headers);
        body = await response.text();

        // Success or non-retryable (2xx/3xx/4xx) — done
        if (status > 0 && status < 500) {
          const result = this._buildResult({
            ok: status >= 200 && status < 400,
            status, respHeaders, body, attempt,
            duration: Date.now() - started, finalUrl, error: null,
          });
          await this._doLog(result);
          return result;
        }

        lastError = `HTTP ${status}`;
      } catch (err) {
        clearTimeout(timer);
        if (err.name === 'AbortError') {
          lastError = `Timeout after ${this.opts.timeout}ms`;
        } else {
          lastError = `${err.name || 'Error'}: ${err.message}`;
        }
      }

      if (attempt < this.opts.maxRetries) {
        const delay = this.opts.retryDelayMs * Math.pow(2, attempt - 1);
        await new Promise(r => setTimeout(r, delay));
      }
    }

    const result = this._buildResult({
      ok: false, status, respHeaders, body, attempt,
      duration: Date.now() - started, finalUrl, error: lastError,
    });
    await this._doLog(result);
    return result;
  }

  /**
   * Forward and write the upstream response back to an http.ServerResponse.
   * Works with raw http, Express, and Fastify (use reply.raw).
   */
  async proxy(res) {
    if (!res || typeof res.setHeader !== 'function') {
      throw new ForwarderError('proxy() requires a Node http.ServerResponse object');
    }
    const resp = await this.forward();
    const skip = new Set(['transfer-encoding', 'content-encoding', 'content-length']);

    res.statusCode = resp.status || 502;
    for (const [k, v] of Object.entries(resp.headers)) {
      if (skip.has(k.toLowerCase())) continue;
      try { res.setHeader(k, v); }
      catch { /* ignore invalid header names from upstream */ }
    }
    res.end(resp.body);
    return resp;
  }

  // ---------- internals ----------

  _stripHopHeaders() {
    const strip = new Set(this.opts.stripHeaders.map(h => h.toLowerCase()));
    for (const k of Object.keys(this.opts.headers)) {
      if (strip.has(k.toLowerCase())) delete this.opts.headers[k];
    }
  }

  _mergeCookiesIntoHeaders() {
    const cookies = this.opts.cookies;
    if (!cookies || Object.keys(cookies).length === 0) return;
    const parts = Object.entries(cookies).map(
      ([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`
    );
    this.opts.headers['Cookie'] = parts.join('; ');
  }

  _ensureUserAgent() {
    const hasUa = Object.keys(this.opts.headers).some(k => k.toLowerCase() === 'user-agent');
    if (!hasUa && this.opts.userAgent) {
      this.opts.headers['User-Agent'] = this.opts.userAgent;
    }
  }

  _buildFinalUrl() {
    const url = new URL(this.targetUrl);
    for (const [k, v] of Object.entries(this.opts.query || {})) {
      url.searchParams.set(k, v);
    }
    return url.toString();
  }

  _extractHeaders(headers) {
    const out = {};
    headers.forEach((v, k) => {
      const existing = out[k];
      if (existing !== undefined) {
        out[k] = Array.isArray(existing) ? [...existing, v] : [existing, v];
      } else {
        out[k] = v;
      }
    });
    // Set-Cookie is special — Headers.forEach concatenates with ", " which is wrong.
    if (typeof headers.getSetCookie === 'function') {
      const cookies = headers.getSetCookie();
      if (cookies && cookies.length) out['set-cookie'] = cookies;
    }
    return out;
  }

  _buildResult({ ok, status, respHeaders, body, attempt, duration, finalUrl, error }) {
    return new ForwardResult({
      ok, status,
      headers: respHeaders,
      body,
      attempts: attempt,
      durationMs: duration,
      finalUrl,
      error,
    });
  }

  async _doLog(result) {
    try {
      await this.logger.log({
        sourceLabel: this.opts.sourceLabel,
        method: this.opts.method.toUpperCase(),
        targetUrl: this.targetUrl,
        requestHeaders: this.opts.headers,
        requestBody: typeof this.opts.body === 'string'
          ? this.opts.body
          : (this.opts.body == null ? '' : String(this.opts.body)),
        clientIp: this.opts.clientIp ?? null,
      }, result);
    } catch (err) {
      console.error('RequestForwarder logger threw:', err.message);
    }
  }
}
