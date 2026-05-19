/**
 * Per-caller, per-tool, per-hour rate limits.
 * Counter persisted in the same sqlite as the ledger (WAL mode).
 */
const { getDb } = require('./ledger');

function hourBucket(d = new Date()) {
  return d.toISOString().slice(0, 13); // YYYY-MM-DDTHH
}

/**
 * Increment the counter and return { allowed, count, limit } for the caller/tool.
 * Atomic via SQLite upsert.
 */
function checkAndIncrement(caller, tool, limit) {
  if (!limit) return { allowed: true, count: 0, limit: Infinity };

  const db = getDb();
  const bucket = hourBucket();

  // Upsert + read current count
  const txn = db.transaction(() => {
    db.prepare(
      `INSERT INTO rate_limits (caller, tool, hour_bucket, count)
       VALUES (?, ?, ?, 1)
       ON CONFLICT(caller, tool, hour_bucket) DO UPDATE SET count = count + 1`,
    ).run(caller, tool, bucket);
    return db
      .prepare(`SELECT count FROM rate_limits WHERE caller = ? AND tool = ? AND hour_bucket = ?`)
      .get(caller, tool, bucket).count;
  });

  const count = txn();
  return { allowed: count <= limit, count, limit };
}

module.exports = { checkAndIncrement };
