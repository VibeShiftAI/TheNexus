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
 * takes a raw WAL-mode connection to the same SQLite file from db/raw.js.
 */
const express = require('express');
const crypto = require('crypto');
const { openRaw, resolveNexusDbPath } = require('../../db/raw');

const DEFAULT_DB_PATH = resolveNexusDbPath();

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

// Coerce a token count from a number or numeric string; null when absent/invalid.
function num(value) {
    if (value == null || value === '') return null;
    const n = typeof value === 'number' ? value : parseInt(String(value).replace(/[,_\s]/g, ''), 10);
    return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

function createDispatchesRouter({ dbPath = DEFAULT_DB_PATH } = {}) {
    const router = express.Router();

    let db;
    try {
        db = openRaw(dbPath);
        db.exec(`
            CREATE TABLE IF NOT EXISTS task_dispatches (
                id TEXT PRIMARY KEY,
                task_id TEXT NOT NULL,
                project_id TEXT,
                kind TEXT NOT NULL DEFAULT 'dispatch',
                parent_id TEXT,
                executor TEXT NOT NULL,
                model TEXT,
                tokens INTEGER,
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
        // Migration: the tokens columns were added after the table shipped, so
        // back-fill them on pre-existing databases. ALTER throws if a column
        // already exists — harmless, so swallow that specific case.
        for (const ddl of [
            'ALTER TABLE task_dispatches ADD COLUMN tokens INTEGER',
            'ALTER TABLE task_dispatches ADD COLUMN tokens_estimated INTEGER DEFAULT 0',
        ]) {
            try { db.exec(ddl); }
            catch (e) { if (!/duplicate column name/i.test(e.message)) throw e; }
        }
    } catch (err) {
        console.error(`[Dispatches] DB unavailable (${err.message}) — dispatch history disabled`);
        router.use((_req, res) => res.status(503).json({ error: 'dispatch history storage unavailable' }));
        return router;
    }

    const insertStmt = db.prepare(`
        INSERT INTO task_dispatches (
            id, task_id, project_id, kind, parent_id, executor, model, tokens,
            prompt, instructions, outcome, session_id, workspace, log_path, started_at
        ) VALUES (
            @id, @task_id, @project_id, @kind, @parent_id, @executor, @model, @tokens,
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
            tokens: num(body.tokens),
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
                tokens: num(body.tokens),
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
                tokens = COALESCE(@tokens, tokens),
                completed_at = @completed_at,
                updated_at = datetime('now')
            WHERE id = @id
        `).run({ id, ...updates });
    }

    // When an executor doesn't report an exact token count, approximate one from
    // the real text volume of the run (prompt + instructions + output + error).
    // The rule of thumb is ~1 token per 4 characters. Flagged tokens_estimated=1
    // so the UI can render it as an approximation (e.g. "~12k") rather than an
    // exact figure. No-op once an exact count is present.
    const estimateSelectStmt = db.prepare(`
        SELECT prompt, instructions, output, error, tokens FROM task_dispatches WHERE id = ?
    `);
    const estimateUpdateStmt = db.prepare(`
        UPDATE task_dispatches SET tokens = ?, tokens_estimated = 1, updated_at = datetime('now') WHERE id = ?
    `);
    function backfillEstimatedTokens(id) {
        try {
            const row = estimateSelectStmt.get(id);
            if (!row || row.tokens != null) return; // exact count already recorded
            const chars = (row.prompt || '').length + (row.instructions || '').length
                + (row.output || '').length + (row.error || '').length;
            if (chars <= 0) return;
            estimateUpdateStmt.run(Math.ceil(chars / 4), id);
        } catch (err) {
            console.warn('[Dispatches] token estimate failed:', err.message);
        }
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
            backfillEstimatedTokens(open.id);
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
            backfillEstimatedTokens(req.params.id);
            res.json({ success: true, id: req.params.id });
        } catch (err) {
            console.error('[Dispatches] update failed:', err.message);
            res.status(500).json({ error: 'Failed to update dispatch: ' + err.message });
        }
    });

    // ─── Currently-executing dispatches (for the Now strip) ──────────────
    // Task-correlated "what is running right now": every row still in the
    // 'running' outcome, joined to its task name, newest first. The Now strip
    // reads the freshest row for the active model / task / token figures — so
    // model & tokens always belong to the in-flight task, never a global feed.
    //
    // A `since` window bounds ghost rows (a dispatch that crashed before its
    // completion callback would otherwise sit at 'running' forever). Tokens are
    // reported cumulatively across the task's dispatch rows so the counter grows
    // as attempts/follow-ups complete; it stays null until a real count exists
    // (the running row's own tokens are only written at completion), so the UI
    // shows "unavailable" rather than a borrowed number.
    const activeStmt = db.prepare(`
        SELECT id, task_id, project_id, executor, model, kind, started_at
        FROM task_dispatches
        WHERE outcome = 'running' AND started_at >= ?
        ORDER BY started_at DESC, created_at DESC
        LIMIT ?
    `);
    const taskTokenStmt = db.prepare(`
        SELECT COALESCE(SUM(tokens), 0) AS total,
               COUNT(tokens) AS counted,
               MAX(COALESCE(tokens_estimated, 0)) AS estimated
        FROM task_dispatches WHERE task_id = ?
    `);
    // The tasks table lives in the same DB but isn't owned by this router (and
    // may not exist in isolated tests), so resolve the human-readable title via
    // a lazily-prepared, failure-tolerant lookup rather than an eager JOIN that
    // would throw at router-construction time when tasks is absent.
    let taskTitleStmt;
    function titleFor(taskId) {
        try {
            if (!taskTitleStmt) taskTitleStmt = db.prepare('SELECT name FROM tasks WHERE id = ?');
            return taskTitleStmt.get(taskId)?.name ?? null;
        } catch {
            return null;
        }
    }
    router.get('/active', (req, res) => {
        const windowHours = Math.min(Math.max(parseInt(req.query.hours, 10) || 6, 1), 48);
        const since = new Date(Date.now() - windowHours * 3600_000).toISOString();
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 50);
        try {
            const active = activeStmt.all(since, limit).map((r) => {
                const tok = taskTokenStmt.get(r.task_id) || {};
                const counted = tok.counted || 0;
                return {
                    id: r.id,
                    taskId: r.task_id,
                    projectId: r.project_id,
                    executor: r.executor,
                    kind: r.kind,
                    // model belongs to THIS task's in-flight dispatch (null until known)
                    model: r.model || null,
                    // cumulative tokens for THIS task; null when nothing recorded yet
                    tokens: counted > 0 ? tok.total : null,
                    tokensEstimated: counted > 0 ? Boolean(tok.estimated) : false,
                    title: titleFor(r.task_id),
                    startedAt: r.started_at,
                };
            });
            res.json({ active });
        } catch (err) {
            console.error('[Dispatches] active failed:', err.message);
            res.status(500).json({ error: 'Failed to list active dispatches: ' + err.message });
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

    // ─── Recent-dispatch reader (for the activity feed) ──────────────────
    // The Recent Activity Feed correlates git commits to the dispatch that
    // produced them so it can show the *real* executor/model + token count,
    // not a guess parsed from commit trailers. Exposed on the router object
    // (not an HTTP route) so the projects router can read it in-process.
    //
    // Reliability note (task 1212d226): in production the dispatch writers are
    // inconsistent — Claude rows omit project_id, Codex/Antigravity rows omit
    // model — so a naive "WHERE project_id IS NOT NULL" reader drops most rows
    // and attributes nothing. We resolve project_id server-side instead: every
    // dispatch carries a task_id, so we recover the owning project from the task
    // (task_dispatches.task_id → tasks.project_id) whenever the row shipped
    // without its own project_id. (Model is left as-is here — the attribution
    // layer in projects.js falls back to an executor-derived label so a row is
    // never blank just because the writer skipped the model column.)
    const recentDispatchesNoJoinStmt = db.prepare(`
        SELECT id, task_id, project_id, executor, model, tokens, tokens_estimated, outcome, started_at, completed_at
        FROM task_dispatches
        WHERE project_id IS NOT NULL
        ORDER BY started_at DESC
        LIMIT ?
    `);
    let recentDispatchesJoinStmt = null;
    function tasksTableExists() {
        try {
            return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tasks'").get();
        } catch {
            return false;
        }
    }
    router.listRecentDispatches = (limit = 300) => {
        const n = Math.min(Math.max(parseInt(limit, 10) || 300, 1), 1000);
        try {
            // Prefer the task-join reader so dispatches missing an explicit
            // project_id still resolve one from their owning task. The tasks
            // table is created by the main db module; in isolated dispatch-only
            // test DBs it's absent, so fall back to the plain project_id reader.
            if (tasksTableExists()) {
                if (!recentDispatchesJoinStmt) {
                    recentDispatchesJoinStmt = db.prepare(`
                        SELECT d.id, d.task_id,
                               COALESCE(d.project_id, t.project_id) AS project_id,
                               d.executor, d.model, d.tokens, d.tokens_estimated,
                               d.outcome, d.started_at, d.completed_at
                        FROM task_dispatches d
                        LEFT JOIN tasks t ON t.id = d.task_id
                        WHERE COALESCE(d.project_id, t.project_id) IS NOT NULL
                        ORDER BY d.started_at DESC
                        LIMIT ?
                    `);
                }
                return recentDispatchesJoinStmt.all(n);
            }
            return recentDispatchesNoJoinStmt.all(n);
        } catch (err) {
            console.error('[Dispatches] listRecentDispatches failed:', err.message);
            return [];
        }
    };

    return router;
}

module.exports = createDispatchesRouter;
