/**
 * Optimistic-lock health gauge.
 *
 * The cost ledger already says whether a tool call *failed*; it cannot say
 * whether the write lost a race, whether the retry loop recovered it, or
 * whether the row was already in the requested state. Without that split a
 * stale-state incident and a genuine conflict look identical, which is how the
 * 15% `nexus_task_update` stale rate sat in the ledger as an undifferentiated
 * error count.
 *
 * One row per contended-or-not write, in the same WAL sqlite the ledger uses
 * (~/.praxis-mind/cost_ledger.sqlite) so ephemeral MCP spawns share it. Every
 * function here is best-effort: a broken gauge must never fail a write.
 */
const { getDb } = require('./ledger');
const { log } = require('./log');

let _ready = false;

function db() {
  const handle = getDb();
  if (!_ready) {
    handle.exec(`
      CREATE TABLE IF NOT EXISTS optimistic_lock_events (
        id INTEGER PRIMARY KEY,
        ts TEXT NOT NULL,
        tool TEXT NOT NULL,
        caller TEXT,
        target TEXT,
        outcome TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 1,
        conflict_fields TEXT,
        blocking_fields TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_lock_events_tool_ts ON optimistic_lock_events(tool, ts);
    `);
    _ready = true;
  }
  return handle;
}

/** Outcomes that mean "the write landed, or did not need to". */
const RESOLVED = new Set(['committed', 'committed_after_retry', 'converged_noop']);
/** Outcomes that mean "a real conflict stopped the write". */
const UNRESOLVED = new Set(['conflict_unresolved', 'retries_exhausted']);

/**
 * Record one guarded write. `lock` is the trace returned (or attached to the
 * error) by executeOptimisticTransaction; absent, the write is logged as an
 * uncontended single attempt.
 */
function record({ tool, caller = null, target = null, outcome, lock = null }) {
  try {
    const conflictFields = new Set();
    for (const conflict of lock?.conflicts || []) {
      for (const field of conflict.fields || []) conflictFields.add(field);
    }
    db().prepare(
      `INSERT INTO optimistic_lock_events (ts, tool, caller, target, outcome, attempts, conflict_fields, blocking_fields)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      new Date().toISOString(),
      tool,
      caller,
      target,
      outcome,
      lock?.attempts ?? 1,
      conflictFields.size ? [...conflictFields].join(',') : null,
      lock?.blocking_fields?.length ? lock.blocking_fields.join(',') : null,
    );
  } catch (e) {
    log(`lockHealth.record failed: ${e.message}`);
  }
}

/**
 * Contention summary for one tool over a trailing window.
 *
 * `stale_errors` is read from the ledger's `calls` table rather than from the
 * event rows, so the gauge reports the pre-retry failure signal too — it is
 * meaningful on the first call, before any event rows exist, and it is the
 * number that has to fall for this machinery to have worked.
 */
function gauge(tool = 'nexus_task_update', hours = 24) {
  const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
  const summary = {
    tool,
    window_hours: hours,
    writes: 0,
    contended: 0,
    conflict_rate: 0,
    auto_resolved: 0,
    unresolved: 0,
    stale_errors: 0,
  };

  try {
    const rows = db().prepare(
      `SELECT outcome, attempts, conflict_fields, blocking_fields
       FROM optimistic_lock_events WHERE tool = ? AND ts >= ?`,
    ).all(tool, since);

    summary.writes = rows.length;
    const blocking = new Map();
    for (const row of rows) {
      const contended = Boolean(row.conflict_fields) || (row.attempts || 1) > 1;
      if (contended) summary.contended += 1;
      if (contended && RESOLVED.has(row.outcome)) summary.auto_resolved += 1;
      if (UNRESOLVED.has(row.outcome)) {
        summary.unresolved += 1;
        for (const field of (row.blocking_fields || '').split(',').filter(Boolean)) {
          blocking.set(field, (blocking.get(field) || 0) + 1);
        }
      }
    }
    if (summary.writes > 0) {
      summary.conflict_rate = round3(summary.contended / summary.writes);
    }
    if (blocking.size) {
      summary.blocked_on = [...blocking.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([field, n]) => `${field}×${n}`);
    }
  } catch (e) {
    log(`lockHealth.gauge event read failed: ${e.message}`);
    return null;
  }

  try {
    const row = db().prepare(
      `SELECT COUNT(*) AS n FROM calls
       WHERE tool = ? AND ts >= ? AND success = 0 AND error LIKE 'Stale expected state%'`,
    ).get(tool, since);
    summary.stale_errors = row?.n || 0;
  } catch (e) {
    log(`lockHealth.gauge stale-error read failed: ${e.message}`);
  }

  return summary;
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

/** One human-readable line, for the CLI and for logs. */
function formatGauge(summary) {
  if (!summary) return '(lock gauge unavailable)';
  if (summary.writes === 0) {
    return `${summary.tool}: no guarded writes in the last ${summary.window_hours}h`
      + (summary.stale_errors ? ` (${summary.stale_errors} stale-state error(s) recorded by the ledger)` : '');
  }
  const pct = Math.round(summary.conflict_rate * 100);
  const parts = [
    `${summary.tool}: ${summary.writes} write(s) in ${summary.window_hours}h`,
    `${summary.contended} contended (${pct}%)`,
    `${summary.auto_resolved} auto-resolved`,
    `${summary.unresolved} unresolved`,
  ];
  if (summary.blocked_on) parts.push(`blocked on ${summary.blocked_on.join(', ')}`);
  return parts.join(', ');
}

module.exports = { record, gauge, formatGauge, RESOLVED, UNRESOLVED };
