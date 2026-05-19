/**
 * Cost ledger — sqlite in WAL mode (concurrent ephemeral writers).
 * Tracks every MCP tool call with caller, tool, tokens, cost, latency.
 */
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const { LEDGER_DB } = require('./config');
const { log } = require('./log');

let _db = null;
function getDb() {
  if (_db) return _db;
  fs.mkdirSync(path.dirname(LEDGER_DB), { recursive: true });
  _db = new Database(LEDGER_DB);
  _db.pragma('journal_mode = WAL');
  _db.pragma('synchronous = NORMAL');
  _db.pragma('busy_timeout = 5000');

  _db.exec(`
    CREATE TABLE IF NOT EXISTS calls (
      id INTEGER PRIMARY KEY,
      ts TEXT NOT NULL,
      caller TEXT NOT NULL,
      tool TEXT NOT NULL,
      upstream_provider TEXT,
      prompt_tokens INTEGER,
      completion_tokens INTEGER,
      estimated_cost_usd REAL,
      latency_ms INTEGER,
      success INTEGER NOT NULL,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_calls_caller_ts ON calls(caller, ts);
    CREATE INDEX IF NOT EXISTS idx_calls_tool_ts ON calls(tool, ts);

    CREATE TABLE IF NOT EXISTS rate_limits (
      caller TEXT NOT NULL,
      tool TEXT NOT NULL,
      hour_bucket TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (caller, tool, hour_bucket)
    );
  `);

  return _db;
}

/**
 * Record one call. Synchronous, fast.
 */
function record({
  caller,
  tool,
  upstream_provider = null,
  prompt_tokens = null,
  completion_tokens = null,
  estimated_cost_usd = null,
  latency_ms = null,
  success = true,
  error = null,
}) {
  try {
    const db = getDb();
    db.prepare(
      `INSERT INTO calls (ts, caller, tool, upstream_provider, prompt_tokens, completion_tokens, estimated_cost_usd, latency_ms, success, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      new Date().toISOString(),
      caller,
      tool,
      upstream_provider,
      prompt_tokens,
      completion_tokens,
      estimated_cost_usd,
      latency_ms,
      success ? 1 : 0,
      error,
    );
  } catch (e) {
    log(`ledger.record failed: ${e.message}`);
  }
}

/**
 * Sum cost for a caller over the trailing N hours.
 */
function costSince(caller, hours = 24) {
  try {
    const db = getDb();
    const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
    const row = db
      .prepare(`SELECT COALESCE(SUM(estimated_cost_usd), 0) AS sum FROM calls WHERE caller = ? AND ts >= ?`)
      .get(caller, since);
    return row ? row.sum : 0;
  } catch (e) {
    return 0;
  }
}

/**
 * Recent calls for a caller.
 */
function recent(caller, limit = 20) {
  try {
    const db = getDb();
    return db
      .prepare(`SELECT ts, tool, upstream_provider, estimated_cost_usd, latency_ms, success FROM calls WHERE caller = ? ORDER BY id DESC LIMIT ?`)
      .all(caller, limit);
  } catch (e) {
    return [];
  }
}

module.exports = { record, costSince, recent, getDb };
