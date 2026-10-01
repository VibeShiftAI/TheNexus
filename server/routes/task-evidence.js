/**
 * Completion evidence dossier routes (services/task-evidence.js).
 *
 *   GET /api/task-evidence/:taskId
 *       The full dossier for one task: walkthrough, verify gate, code-review
 *       gate and QA verdict, each with its timestamp and log reference or an
 *       explicit absent marker, plus the verified/unverified state.
 *   GET /api/task-evidence?task_ids=a,b,c
 *       The compact state per task, for board badges (max MAX_BATCH ids).
 *   GET /api/task-evidence/:taskId/log/:dispatchId
 *       A bounded tail of the transcript a piece links to. Only a log_path
 *       recorded on a dispatch row of THIS task (or its qa-- reviewer shadow)
 *       is served, and only when it resolves inside an allowed log root, so
 *       the endpoint cannot be pointed at an arbitrary file.
 *
 * Read-only throughout: the board DB and Praxis's spine are opened readonly,
 * and no gate, verdict or task status is written.
 */
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openRaw, resolveNexusDbPath } = require('../../db/raw');
const { buildEvidenceDossier, summarizeDossier, qaTaskId } = require('../services/task-evidence');

const DEFAULT_SPINE_PATH = process.env.PRAXIS_EXECUTION_LOG_DB
    || path.join(os.homedir(), '.praxis-mind', 'cost_ledger.sqlite');
const DEFAULT_LOG_ROOTS = [
    process.env.PRAXIS_DATA_DIR || '/Volumes/Projects/Praxis/data',
];
const MAX_BATCH = 200;
const DEFAULT_TAIL_BYTES = 64 * 1024;
const MAX_TAIL_BYTES = 512 * 1024;
const FIRST_CAPTURE_TTL_MS = 10 * 60_000;

function createTaskEvidenceRouter({
    dbPath = resolveNexusDbPath(),
    spineDbPath = DEFAULT_SPINE_PATH,
    logRoots = DEFAULT_LOG_ROOTS,
    openDb = (p, opts) => openRaw(p, opts),
} = {}) {
    const router = express.Router();

    function board() {
        return openDb(dbPath, { readonly: true, fileMustExist: true });
    }

    // Fail-soft spine handle, same shape as dispatch-insight's: a missing or
    // locked file answers "unavailable" with a reason, never "no evidence".
    function openSpine() {
        try {
            if (!fs.existsSync(spineDbPath)) return { db: null, reason: 'Praxis run-events spine not found' };
            return { db: openDb(spineDbPath, { readonly: true, fileMustExist: true }), reason: null };
        } catch (err) {
            return { db: null, reason: err.message };
        }
    }

    let firstCapture = { at: null, readAt: 0 };
    function firstVerificationAt(spineDb) {
        if (Date.now() - firstCapture.readAt < FIRST_CAPTURE_TTL_MS) return firstCapture.at;
        try {
            const row = spineDb.prepare("SELECT MIN(ts) AS ts FROM run_events WHERE type = 'verification'").get();
            firstCapture = { at: row?.ts || null, readAt: Date.now() };
        } catch (_err) {
            firstCapture = { at: null, readAt: Date.now() };
        }
        return firstCapture.at;
    }

    function spineFor(taskId, spineHandle) {
        if (!spineHandle.db) return { available: false, reason: spineHandle.reason, path: spineDbPath };
        try {
            const record = spineHandle.db.prepare(`
                SELECT seq, ts, phase, data FROM run_events
                WHERE task_id = ? AND type = 'verification'
                ORDER BY seq DESC LIMIT 1
            `).get(taskId) || null;
            return {
                available: true,
                path: spineDbPath,
                record,
                firstVerificationAt: firstVerificationAt(spineHandle.db),
            };
        } catch (err) {
            return { available: false, reason: err.message, path: spineDbPath };
        }
    }

    function loadDossier(db, taskId, spineHandle) {
        const task = db.prepare('SELECT id, status, walkthrough, updated_at FROM tasks WHERE id = ?').get(taskId);
        if (!task) return null;
        const runStmt = db.prepare(`
            SELECT id, task_id, kind, executor, model, outcome, output, log_path, started_at, completed_at
            FROM task_dispatches WHERE task_id = ?
        `);
        let runs = [];
        let qaRuns = [];
        try {
            runs = runStmt.all(taskId);
            qaRuns = runStmt.all(qaTaskId(taskId));
        } catch (err) {
            // An isolated DB without task_dispatches still yields a dossier;
            // every piece that needed a run reports it absent.
            if (!/no such table/i.test(err.message)) throw err;
        }
        return buildEvidenceDossier({ task, runs, qaRuns, spine: spineFor(taskId, spineHandle) });
    }

    router.get('/', (req, res) => {
        const ids = [...new Set(String(req.query.task_ids || '')
            .split(',').map((s) => s.trim()).filter(Boolean))];
        if (ids.length === 0) return res.status(400).json({ error: 'task_ids query parameter is required' });
        if (ids.length > MAX_BATCH) return res.status(400).json({ error: `At most ${MAX_BATCH} task ids per request` });
        try {
            const db = board();
            const spineHandle = openSpine();
            const tasks = {};
            for (const id of ids) {
                const dossier = loadDossier(db, id, spineHandle);
                if (dossier) tasks[id] = summarizeDossier(dossier);
            }
            res.json({ at: new Date().toISOString(), spineAvailable: Boolean(spineHandle.db), tasks });
        } catch (err) {
            console.error('[TaskEvidence] batch read failed:', err.message);
            res.status(500).json({ error: 'Failed to read task evidence: ' + err.message });
        }
    });

    router.get('/:taskId', (req, res) => {
        try {
            const dossier = loadDossier(board(), req.params.taskId, openSpine());
            if (!dossier) return res.status(404).json({ error: 'Task not found' });
            res.json(dossier);
        } catch (err) {
            console.error('[TaskEvidence] dossier read failed:', err.message);
            res.status(500).json({ error: 'Failed to read task evidence: ' + err.message });
        }
    });

    function insideRoots(realFile) {
        return logRoots.some((root) => {
            let realRoot;
            try { realRoot = fs.realpathSync(root); } catch (_err) { return false; }
            const rel = path.relative(realRoot, realFile);
            return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
        });
    }

    router.get('/:taskId/log/:dispatchId', (req, res) => {
        const { taskId, dispatchId } = req.params;
        const requested = parseInt(req.query.bytes, 10);
        const tailBytes = Math.min(Math.max(Number.isFinite(requested) ? requested : DEFAULT_TAIL_BYTES, 1024), MAX_TAIL_BYTES);
        let row;
        try {
            row = board().prepare(`
                SELECT id, task_id, log_path FROM task_dispatches
                WHERE id = ? AND task_id IN (?, ?)
            `).get(dispatchId, taskId, qaTaskId(taskId));
        } catch (err) {
            return res.status(500).json({ error: 'Failed to read dispatch: ' + err.message });
        }
        if (!row) return res.status(404).json({ error: 'No such dispatch for this task' });
        if (!row.log_path) return res.status(404).json({ error: 'This run recorded no log path' });

        let realFile;
        try {
            realFile = fs.realpathSync(row.log_path);
        } catch (_err) {
            return res.status(404).json({ error: 'The recorded log file no longer exists', path: row.log_path });
        }
        if (!insideRoots(realFile)) {
            return res.status(403).json({ error: 'The recorded log path is outside the allowed log roots', path: row.log_path });
        }
        try {
            const stat = fs.statSync(realFile);
            if (!stat.isFile()) return res.status(404).json({ error: 'The recorded log path is not a file', path: row.log_path });
            const start = Math.max(0, stat.size - tailBytes);
            const length = stat.size - start;
            const buf = Buffer.alloc(length);
            const fd = fs.openSync(realFile, 'r');
            try { fs.readSync(fd, buf, 0, length, start); } finally { fs.closeSync(fd); }
            res.json({
                dispatchId: row.id,
                taskId: row.task_id,
                path: row.log_path,
                size: stat.size,
                modifiedAt: stat.mtime.toISOString(),
                truncated: start > 0,
                text: buf.toString('utf8'),
            });
        } catch (err) {
            res.status(500).json({ error: 'Failed to read log: ' + err.message });
        }
    });

    return router;
}

module.exports = createTaskEvidenceRouter;
