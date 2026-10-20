const express = require('express');
const { readTaskImprovements } = require('../services/task-improvements');
const { openRaw, resolveNexusDbPath } = require('../../db/raw');
const { readProgressLog, publicText, activityTimestamp } = require('../services/task-progress');

/** Task-scoped history and explicitly authored commentary; no runtime mutations. */
module.exports = function createTaskProgressRouter({ dbPath = resolveNexusDbPath(), logRoots = [process.env.PRAXIS_DATA_DIR || '/Volumes/Projects/Praxis/data'], improvementsDataDir = process.env.PRAXIS_DATA_DIR || '/Volumes/Projects/Praxis/data' } = {}) {
    const router = express.Router();
    router.get('/:taskId', (req, res) => {
        let db;
        try {
            db = openRaw(dbPath, { readonly: true, fileMustExist: true, cache: false });
            const taskId = req.params.taskId;
            const rows = db.prepare('SELECT id, task_id, executor, outcome, kind, parent_id, started_at, completed_at, log_path FROM task_dispatches WHERE task_id = ? ORDER BY started_at DESC, id DESC LIMIT 51').all(taskId);
            const attempts = rows.slice(0, 50).map((row, i) => {
                const next = rows.slice(0, i).filter(r => r.log_path === row.log_path).at(-1);
                return { id: row.id, executor: row.executor, outcome: row.outcome, kind: row.kind, parentId: row.parent_id, startedAt: row.started_at, completedAt: row.completed_at,
                    // Limit transcript I/O to the current attempt. Historical detail stays in the console.
                    commentary: i === 0 ? readProgressLog({ ...row, nextStartedAt: next?.started_at }, logRoots) : { available: false, reason: 'Historical transcript is available in dispatch details.', messages: [], truncated: false } };
            });
            let events = []; let eventsAvailable = true; let eventsTruncated = false;
            try {
                const records = db.prepare('SELECT id, title, message, event_type, created_at FROM ag_events WHERE task_id = ? ORDER BY created_at DESC, id DESC LIMIT 201').all(taskId);
                eventsTruncated = records.length > 200;
                events = records.slice(0, 200).map(row => ({ id: String(row.id), title: publicText(row.title), text: publicText(row.message), type: row.event_type, at: activityTimestamp(row.created_at) }));
            } catch { eventsAvailable = false; }
            res.set('Cache-Control', 'no-store').json({ taskId, fetchedAt: new Date().toISOString(), attempts, attemptsTruncated: rows.length > 50, events, eventsAvailable, eventsTruncated, improvements: readTaskImprovements(taskId, { dataDir: improvementsDataDir }) });
        } catch { res.status(503).json({ error: 'Task progress records are unavailable.' }); }
        finally { db?.close(); }
    });
    return router;
};
