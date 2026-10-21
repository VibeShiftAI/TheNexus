const { createHash } = require('crypto');

function initializeActivityEvents(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS ag_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, event_type TEXT NOT NULL,
      severity TEXT DEFAULT 'info', title TEXT NOT NULL, message TEXT, task_id TEXT,
      source TEXT DEFAULT 'praxis', metadata TEXT DEFAULT '{}', requires_action INTEGER DEFAULT 0,
      action_taken INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS ag_event_receipts (
      idempotency_key TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, event_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS ag_question_resolutions (
        question_id TEXT NOT NULL, task_id TEXT NOT NULL DEFAULT '', resumed INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(question_id, task_id));`);
    // Backfill before retention can remove the answer. Repeatable and monotonic.
    const prior = db.prepare(`SELECT * FROM ag_events WHERE event_type IN ('hitl_resolved','task_resumed_with_answer')`).all();
    db.transaction(() => { for (const event of prior) rememberQuestionResolution(db, event); })();
}

function rememberQuestionResolution(db, event) {
    if (!['hitl_resolved','task_resumed_with_answer'].includes(event.event_type)) return;
    let metadata = event.metadata || {};
    if (typeof metadata === 'string') { try { metadata = JSON.parse(metadata) || {}; } catch { return; } }
    const resumed = event.event_type === 'task_resumed_with_answer';
    const id = resumed ? metadata.rootHitlId || metadata.resolvedHitlId : metadata.hitlId;
    if (typeof id !== 'string' || !id.trim() || (resumed && !event.task_id)) return;
    db.prepare(`INSERT INTO ag_question_resolutions (question_id,task_id,resumed) VALUES (?,?,?)
        ON CONFLICT(question_id,task_id) DO UPDATE SET resumed=max(resumed,excluded.resumed)`)
        .run(id.trim(), resumed ? event.task_id : '', resumed ? 1 : 0);
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
          (event_type, severity, title, message, task_id, source, metadata, requires_action, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`).run(...fields, event.created_at || null);
        const id = Number(result.lastInsertRowid);
        rememberQuestionResolution(db, event);
        if (key !== undefined) db.prepare('INSERT INTO ag_event_receipts (idempotency_key, payload_hash, event_id) VALUES (?, ?, ?)').run(key, hash, id);
        // Historical imports receive new IDs but must not evict newer activity.
        // Hidden chat receipts must remain retrievable after ordinary feed retention.
        if (retention !== null) db.prepare(`DELETE FROM ag_events WHERE id IN (SELECT id FROM ag_events
          WHERE json_extract(CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END, '$.chatMessageId') IS NULL
          ORDER BY datetime(created_at) DESC, id DESC LIMIT -1 OFFSET ?)`).run(retention);
        return { id, duplicate: false };
    })();
}


/** Project question lifecycle into the feed without rewriting its audit records.
 * Resolve before filtering/limiting so an answer outside the visible page still counts.
 */
function readActivityEvents(db, {limit = 50, since = null, severity = null} = {}) {
    const rows = db.prepare(`WITH normalized AS (
      SELECT *, CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END AS meta FROM ag_events
    ), linked AS (
      SELECT *, nullif(trim(json_extract(meta, '$.hitlId')), '') AS question_id,
        json_extract(meta, '$.chatMessageId') AS chat_id FROM normalized
    ), answers AS (
      SELECT question_id, nullif(task_id,'') AS task_id, resumed FROM ag_question_resolutions
    ), ranked AS (
      SELECT *, row_number() OVER (PARTITION BY
        CASE WHEN event_type='task_blocked' AND question_id IS NOT NULL THEN coalesce(task_id,'') || ':' || question_id ELSE 'event:' || id END
        ORDER BY (chat_id IS NOT NULL), id) AS question_rank FROM linked
    ), projected AS (
      SELECT *, CASE WHEN event_type='task_blocked' AND question_id IS NOT NULL THEN
        (SELECT max(resumed) FROM answers a WHERE a.question_id=ranked.question_id AND (a.task_id IS NULL OR a.task_id=ranked.task_id))
        ELSE NULL END AS answer_state FROM ranked WHERE question_rank=1
    ) SELECT * FROM projected
      WHERE (? IS NULL OR julianday(created_at)>julianday(?))
        AND (? IS NULL OR CASE WHEN answer_state IS NOT NULL THEN 'info' ELSE severity END = ?)
      ORDER BY datetime(created_at) DESC, id DESC LIMIT ?`).all(since,since,severity,severity,Math.min(Math.max(Number(limit)||50,1),500));
    return rows.map(({meta,question_id,chat_id,question_rank,answer_state,...row}) => {
        row.metadata = JSON.parse(meta);
        if (answer_state !== null) {
            row.metadata = {...row.metadata, originalEventType:row.event_type, originalTitle:row.title, questionState:answer_state ? 'resumed' : 'answered'};
            row.event_type='task_question_resolved';
            row.title=answer_state ? 'Question answered; task resumed' : 'Question answered';
            row.severity='info'; row.requires_action=0; row.action_taken=1;
            row.message=`This earlier request has been answered${answer_state ? ' and the task resumed' : ''}. No further answer is needed for this question.\n\nOriginal request:\n${row.message || ''}`;
        }
        return row;
    });
}
module.exports = { initializeActivityEvents, recordActivityEvent, readActivityEvents };
