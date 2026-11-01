// The activity table is a record: the QA-holds panel, per-task review counts
// and task progress read their state from it. It kept the newest 5,000 events
// until 2026-11-01, which could delete a hold that was still in effect.
const Database = require('better-sqlite3');
const { initializeActivityEvents, recordActivityEvent } = require('../../db/activity-events');

test('a hold stays readable after more than 5,000 later events, through the task index', () => {
    const db = new Database(':memory:');
    initializeActivityEvents(db);
    recordActivityEvent(db, { event_type: 'qa_correction_withheld_paused', title: 'Correction withheld', task_id: 'held-task', created_at: '2026-10-01T09:00:00Z' });
    const many = db.transaction(() => {
        for (let i = 0; i < 5001; i++) recordActivityEvent(db, { event_type: 'task_completed', title: `Done ${i}`, task_id: `other-${i}`, created_at: '2026-10-02T09:00:00Z' });
    });
    many();
    expect(db.prepare('SELECT COUNT(*) AS n FROM ag_events').get().n).toBe(5002);
    const newestForTask = 'SELECT id, event_type FROM ag_events WHERE task_id = ? ORDER BY created_at DESC, id DESC LIMIT 1';
    expect(db.prepare(newestForTask).get('held-task').event_type).toBe('qa_correction_withheld_paused');
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${newestForTask}`).all('held-task').map(row => row.detail).join(' ');
    expect(plan).toMatch(/idx_ag_events_task/);
    db.close();
});
