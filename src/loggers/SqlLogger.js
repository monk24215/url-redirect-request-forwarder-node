import { ForwarderError } from '../errors.js';

/**
 * Generic SQL logger. Database-driver agnostic — you supply an async `execute`
 * function that takes (sql, params) and runs it against your DB.
 *
 * Example with pg:
 *   const { Pool } = require('pg');
 *   const pool = new Pool({...});
 *   new SqlLogger({ execute: (sql, params) => pool.query(sql, params) });
 *
 * Example with mysql2/promise:
 *   const pool = mysql.createPool({...});
 *   new SqlLogger({
 *     execute: (sql, params) => pool.execute(sql, params),
 *     placeholders: 'qmark'  // mysql2 uses ? not $1
 *   });
 *
 * Example with better-sqlite3 (synchronous):
 *   const db = new Database('log.db');
 *   new SqlLogger({
 *     execute: async (sql, params) => db.prepare(sql).run(...params),
 *     placeholders: 'qmark'
 *   });
 */
export class SqlLogger {
  constructor({ execute, table = 'request_forward_log', bodyMax = 65535, placeholders = 'qmark' } = {}) {
    if (typeof execute !== 'function') {
      throw new ForwarderError('SqlLogger requires an `execute(sql, params)` function');
    }
    if (!['qmark', 'numeric'].includes(placeholders)) {
      throw new ForwarderError("SqlLogger placeholders must be 'qmark' or 'numeric'");
    }
    this.execute = execute;
    this.table = table;
    this.bodyMax = bodyMax;
    this.placeholders = placeholders;
  }

  _truncate(s) {
    if (s == null) return null;
    const str = typeof s === 'string' ? s : JSON.stringify(s);
    return str.length > this.bodyMax ? str.slice(0, this.bodyMax) + '...[truncated]' : str;
  }

  _placeholder(n) {
    return this.placeholders === 'numeric' ? `$${n}` : '?';
  }

  async log(request, result) {
    try {
      const cols = [
        'source_label', 'method', 'target_url', 'final_url',
        'request_headers', 'request_body',
        'response_status', 'response_headers', 'response_body',
        'attempts', 'duration_ms', 'ok', 'error_message', 'client_ip',
      ];
      const placeholders = cols.map((_, i) => this._placeholder(i + 1)).join(', ');
      const sql = `INSERT INTO ${this.table} (${cols.join(', ')}) VALUES (${placeholders})`;

      const params = [
        request.sourceLabel ?? null,
        request.method,
        request.targetUrl,
        result.finalUrl,
        this._truncate(request.requestHeaders),
        this._truncate(request.requestBody),
        result.status || null,
        this._truncate(result.headers),
        this._truncate(result.body),
        result.attempts,
        result.durationMs,
        result.ok ? 1 : 0,
        result.error,
        request.clientIp ?? null,
      ];

      await this.execute(sql, params);
    } catch (err) {
      // Logging must never break forwarding
      console.error('SqlLogger failed:', err.message);
    }
  }
}
