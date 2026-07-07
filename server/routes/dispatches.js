/**
 * Task dispatch history.
 *
 * Every CLI dispatch attempt (claude-code / codex / antigravity) gets a row:
 * the exact prompt sent, the executor + model that ran it, the final output,
 * the outcome, and — for claude-code/codex — the CLI session id so the run
 * can be resumed with a follow-up prompt from the task screen.
 *
 * Praxis writes rows from the executor seam (src/executors/dispatch-history.ts):
 *   POST   /api/dispatches             → record a dispatch start (outcome "running")
 *   PATCH  /api/dispatches/close-open  → close the latest running row for a task
 *                                        (antigravity's /callback path, which has
 *                                        no dispatch id in hand)
 *   PATCH  /api/dispatches/:id         → record completion (outcome/output/session)
 *   GET    /api/dispatches?task_id=x   → history for the task screen, newest first
 *
 * The injected db facade (db/index.js) has no raw prepare/exec, so this module
 * opens its own WAL-mode connection to the same SQLite file — same pattern as
 * routes/fleet.js.
 */
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const DEFAULT_DB_PATH = process.env.NEXUS_DB_PATH || path.resolve(__dirname, '../../nexus.db');

const OUTCOMES = new Set(['running', 'success', 'failure', 'timeout', 'needs_input', 'cancelled']);
const KINDS = new Set(['dispatch', 'follow_up']);

// Prompts embed full execution briefs and outputs can be whole walkthroughs —
// keep rows bounded so the board DB never bloats on a runaway transcript.
const MAX_TEXT_CHARS = 64_000;

function clampText(value) {
    if (typeof value !== 'string') return null;
    if (value.length <= MAX_TEXT_CHARS) return value;
    return `${value.slice(0, MAX_TEXT_CHARS)}\n… (truncated, ${value.length} chars total)`;
}

function str(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function createDispatchesRouter({ dbPath = DEFAULT_DB_PATH } = {}) {
    const router = express.Router();

    let db;
    try {
        db = new Database(dbPath);
        db.pragma('journal_mode = WAL');
        db.exec(`
            CREATE TABLE IF NOT EXISTS task_dispatches (
                id TEXT PRIMARY KEY,
                task_id TEXT NOT NULL,
                project_id TEXT,
                kind TEXT NOT NULL DEFAULT 'dispatch',
                parent_id TEXT,
                executor TEXT NOT NULL,
                model TEXT,
                prompt TEXT,
                instructions TEXT,
                output TEXT,
                error TEXT,
                outcome TEXT NOT NULL DEFAULT 'running',
                session_id TEXT,
                workspace TEXT,
                log_path TEXT,
                started_at TEXT NOT NULL,
                completed_at TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_task_dispatches_task ON task_dispatches(task_id, started_at);
            CREATE INDEX IF NOT EXISTS idx_task_dispatches_outcome ON task_dispatches(outcome);
        `);
    } catch (err) {
        console.error(`[Dispatches] DB unavailable (${err.message}) — dispatch history disabled`);
        router.use((_req, res) => res.status(503).json({ error: 'dispatch history storage unavailable' }));
        return router;
    }

    const insertStmt = db.prepare(`
        INSERT INTO task_dispatches (
            id, task_id, project_id, kind, parent_id, executor, model,
            prompt, instructions, outcome, session_id, workspace, log_path, started_at
        ) VALUES (
            @id, @task_id, @project_id, @kind, @parent_id, @executor, @model,
            @prompt, @instructions, 'running', @session_id, @workspace, @log_path, @started_at
        )
    `);

    // ─── Record a dispatch start ─────────────────────────────────────────
    router.post('/', (req, res) => {
        const body = req.body || {};
        const taskId = str(body.task_id) || str(body.taskId);
        const executor = str(body.executor);
        if (!taskId || !executor) {
            return res.status(400).json({ error: 'task_id and executor are required' });
        }
        const kind = str(body.kind) || 'dispatch';
        if (!KINDS.has(kind)) {
            return res.status(400).json({ error: `Invalid kind "${kind}". Valid: ${[...KINDS].join(', ')}` });
        }
        const row = {
            id: str(body.id) || crypto.randomUUID(),
            task_id: taskId,
            project_id: str(body.project_id),
            kind,
            parent_id: str(body.parent_id),
            executor,
            model: str(body.model),
            prompt: clampText(body.prompt),
            instructions: clampText(body.instructions),
            session_id: str(body.session_id),
            workspace: str(body.workspace),
            log_path: str(body.log_path),
            started_at: str(body.started_at) || new Date().toISOString(),
        };
        try {
            insertStmt.run(row);
            res.status(201).json({ success: true, id: row.id });
        } catch (err) {
            console.error('[Dispatches] insert failed:', err.message);
            res.status(500).json({ error: 'Failed to record dispatch: ' + err.message });
        }
    });

    /** Shared completion-update builder for PATCH /:id and PATCH /close-open. */
    function buildCompletion(body) {
        const outcome = str(body.outcome);
        if (!outcome || !OUTCOMES.has(outcome)) {
            return { error: `Invalid outcome "${outcome}". Valid: ${[...OUTCOMES].join(', ')}` };
        }
        return {
            updates: {
                outcome,
                output: clampText(body.output),
                error: clampText(body.error),
                session_id: str(body.session_id),
                model: str(body.model),
                completed_at: str(body.completed_at) || new Date().toISOString(),
            },
        };
    }

    function applyCompletion(id, updates) {
        return db.prepare(`
            UPDATE task_dispatches SET
                outcome = @outcome,
                output = COALESCE(@output, output),
                error = COALESCE(@error, error),
                session_id = COALESCE(@session_id, session_id),
                model = COALESCE(@model, model),
                completed_at = @completed_at,
                updated_at = datetime('now')
            WHERE id = @id
        `).run({ id, ...updates });
    }

    // ─── Close the latest running row for a task ─────────────────────────
    // Antigravity completions arrive via Praxis /callback with no dispatch id;
    // registered before '/:id' so Express doesn't treat "close-open" as an id.
    router.patch('/close-open', (req, res) => {
        const body = req.body || {};
        const taskId = str(body.task_id) || str(body.taskId);
        if (!taskId) return res.status(400).json({ error: 'task_id is required' });
        const completion = buildCompletion(body);
        if (completion.error) return res.status(400).json({ error: completion.error });

        const executor = str(body.executor);
        try {
            const open = db.prepare(`
                SELECT id FROM task_dispatches
                WHERE task_id = ? AND outcome = 'running' ${executor ? 'AND executor = ?' : ''}
                ORDER BY started_at DESC LIMIT 1
            `).get(...(executor ? [taskId, executor] : [taskId]));
            if (!open) return res.json({ success: true, id: null, closed: false });
            applyCompletion(open.id, completion.updates);
            res.json({ success: true, id: open.id, closed: true });
        } catch (err) {
            console.error('[Dispatches] close-open failed:', err.message);
            res.status(500).json({ error: 'Failed to close dispatch: ' + err.message });
        }
    });

    // ─── Record a dispatch completion ────────────────────────────────────
    router.patch('/:id', (req, res) => {
        const completion = buildCompletion(req.body || {});
        if (completion.error) return res.status(400).json({ error: completion.error });
        try {
            const result = applyCompletion(req.params.id, completion.updates);
            if (result.changes === 0) return res.status(404).json({ error: 'Dispatch not found' });
            res.json({ success: true, id: req.params.id });
        } catch (err) {
            console.error('[Dispatches] update failed:', err.message);
            res.status(500).json({ error: 'Failed to update dispatch: ' + err.message });
        }
    });

    // ─── History for a task ──────────────────────────────────────────────
    router.get('/', (req, res) => {
        const taskId = str(req.query.task_id);
        if (!taskId) return res.status(400).json({ error: 'task_id query parameter is required' });
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
        try {
            const rows = db.prepare(`
                SELECT * FROM task_dispatches
                WHERE task_id = ?
                ORDER BY started_at DESC, created_at DESC
                LIMIT ?
            `).all(taskId, limit);
            res.json({ dispatches: rows });
        } catch (err) {
            console.error('[Dispatches] list failed:', err.message);
            res.status(500).json({ error: 'Failed to list dispatches: ' + err.message });
        }
    });

    return router;
}

module.exports = createDispatchesRouter;
