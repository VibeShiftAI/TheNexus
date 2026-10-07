const { createHash } = require('crypto');

function initializeActivityEvents(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS ag_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, event_type TEXT NOT NULL,
      severity TEXT DEFAULT 'info', title TEXT NOT NULL, message TEXT, task_id TEXT,
      source TEXT DEFAULT 'praxis', metadata TEXT DEFAULT '{}', requires_action INTEGER DEFAULT 0,
      action_taken INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS ag_event_receipts (
      idempotency_key TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, event_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
}

function ordered(value) {
    if (Array.isArray(value)) return value.map(ordered);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])]));
    return value;
}

/** Receipt and event share one transaction. Receipts deliberately outlive feed retention. */
function recordActivityEvent(db, event = {}, retention = 5000) {
    const title = typeof event.title === 'string' ? event.title.trim() : '';
    const eventType = typeof event.event_type === 'string' ? event.event_type.trim() : '';
    if (!title || !eventType) return null;
    const key = event.idempotency_key;
    if (key !== undefined && (typeof key !== 'string' || !key.trim() || key.length > 200 || key !== key.trim())) {
        throw Object.assign(new Error('idempotency_key must be a nonempty string of at most 200 characters without surrounding whitespace'), { status: 400 });
    }
    const fields = [eventType, event.severity || 'info', title, event.message || null,
        event.task_id || null, event.source || 'praxis', JSON.stringify(ordered(event.metadata || {})), event.requires_action ? 1 : 0];
    const hash = createHash('sha256').update(JSON.stringify(fields)).digest('hex');
    return db.transaction(() => {
        if (key !== undefined) {
            const receipt = db.prepare('SELECT * FROM ag_event_receipts WHERE idempotency_key = ?').get(key);
            if (receipt) {
                if (receipt.payload_hash !== hash) throw Object.assign(new Error('idempotency_key was already used for a different event'), { status: 409 });
                return { id: receipt.event_id, duplicate: true };
            }
        }
        const result = db.prepare(`INSERT INTO ag_events
          (event_type, severity, title, message, task_id, source, metadata, requires_action)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(...fields);
        const id = Number(result.lastInsertRowid);
        if (key !== undefined) db.prepare('INSERT INTO ag_event_receipts (idempotency_key, payload_hash, event_id) VALUES (?, ?, ?)').run(key, hash, id);
        db.prepare('DELETE FROM ag_events WHERE id <= (SELECT MAX(id) FROM ag_events) - ?').run(retention);
        return { id, duplicate: false };
    })();
}

module.exports = { initializeActivityEvents, recordActivityEvent };
