import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { ForwarderError } from '../errors.js';

/**
 * Appends one JSON line per forward to the given path.
 * Truncates request/response bodies to bodyMax to keep files manageable.
 */
export class FileLogger {
  constructor(path, { bodyMax = 8192 } = {}) {
    if (!path || typeof path !== 'string') {
      throw new ForwarderError('FileLogger requires a path string');
    }
    this.path = path;
    this.bodyMax = bodyMax;
    this._initPromise = this._ensureDir();
  }

  async _ensureDir() {
    try {
      await fs.mkdir(dirname(this.path), { recursive: true });
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }

  _truncate(s) {
    if (typeof s !== 'string') return s;
    return s.length > this.bodyMax ? s.slice(0, this.bodyMax) + '...[truncated]' : s;
  }

  async log(request, result) {
    try {
      await this._initPromise;
      const entry = {
        ts: new Date().toISOString(),
        source_label: request.sourceLabel ?? null,
        method: request.method,
        target_url: request.targetUrl,
        final_url: result.finalUrl,
        request_headers: request.requestHeaders,
        request_body: this._truncate(request.requestBody),
        response_status: result.status,
        response_headers: result.headers,
        response_body: this._truncate(result.body),
        attempts: result.attempts,
        duration_ms: result.durationMs,
        ok: result.ok,
        error: result.error,
        client_ip: request.clientIp ?? null,
      };
      await fs.appendFile(this.path, JSON.stringify(entry) + '\n', 'utf8');
    } catch (err) {
      // Logging must never break forwarding
      console.error('FileLogger failed:', err.message);
    }
  }
}
