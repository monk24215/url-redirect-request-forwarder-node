/**
 * Immutable result object returned by RequestForwarder.forward().
 */
export class ForwardResult {
  constructor({ ok, status, headers, body, attempts, durationMs, finalUrl, error = null }) {
    this.ok = ok;
    this.status = status;
    this.headers = headers;
    this.body = body;
    this.attempts = attempts;
    this.durationMs = durationMs;
    this.finalUrl = finalUrl;
    this.error = error;
    Object.freeze(this);
  }

  toJSON() {
    return {
      ok: this.ok,
      status: this.status,
      headers: this.headers,
      body: this.body,
      attempts: this.attempts,
      duration_ms: this.durationMs,
      final_url: this.finalUrl,
      error: this.error,
    };
  }

  /** Convenience JSON decode of body. Returns null if not valid JSON. */
  json() {
    try { return JSON.parse(this.body); }
    catch { return null; }
  }
}
