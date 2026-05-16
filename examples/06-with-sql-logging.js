// SqlLogger examples for three popular drivers.
// Pick one. Apply sql/schema.sql to your database first.

import { RequestForwarder, SqlLogger } from '../index.js';

// ---- Option A: PostgreSQL (npm install pg) ----
async function withPostgres() {
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const logger = new SqlLogger({
    execute: (sql, params) => pool.query(sql, params),
    placeholders: 'numeric',  // pg uses $1, $2, ...
  });
  return logger;
}

// ---- Option B: MySQL (npm install mysql2) ----
async function withMysql() {
  const mysql = await import('mysql2/promise');
  const pool = mysql.createPool({
    host: 'localhost', user: 'user', password: 'pass', database: 'mydb',
  });
  const logger = new SqlLogger({
    execute: (sql, params) => pool.execute(sql, params),
    placeholders: 'qmark',  // mysql2 uses ?
  });
  return logger;
}

// ---- Option C: SQLite (npm install better-sqlite3) ----
async function withSqlite() {
  const { default: Database } = await import('better-sqlite3');
  const db = new Database('./forwards.db');
  const logger = new SqlLogger({
    execute: async (sql, params) => db.prepare(sql).run(...params),
    placeholders: 'qmark',
  });
  return logger;
}

// Pick one:
const logger = await withSqlite();

const rf = new RequestForwarder(
  'https://httpbin.org/post',
  {
    method: 'POST',
    body: JSON.stringify({ event: 'ping' }),
    headers: { 'Content-Type': 'application/json' },
    sourceLabel: 'event_webhook',
  },
  logger
);

const resp = await rf.forward();
console.log(resp.toJSON());
