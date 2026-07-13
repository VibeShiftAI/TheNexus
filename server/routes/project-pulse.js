/**
 * Project pulse — batched per-project activity rollups powering the bridge's
 * project cards and the project brief screen.
 *
 * One request replaces the old N-cards × (git status) fan-out on every home
 * page load:
 *   GET /api/projects/pulse      → { generatedAt, pulses: { [projectId]: Pulse } }
 *   GET /api/projects/:id/pulse  → Pulse + 30-day commit series + merged ops log
 *
 * A Pulse folds three signals together per project:
 *   git   — branch/uncommitted/ahead-behind, last commit, daily commit counts
 *   tasks — rollups by status group (active / queued / attention / review)
 *   crew  — dispatch rollups (running lanes, last run, token burn)
 *
 * Mount BEFORE the main projects router: its GET /:id would swallow /pulse.
 * The injected db facade has no raw prepare/exec, so this module opens its
 * own WAL-mode connection (same pattern as routes/dispatches.js).
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const simpleGit = require('simple-git');

const DEFAULT_DB_PATH = process.env.NEXUS_DB_PATH || path.resolve(__dirname, '../../nexus.db');

const DAY_MS = 24 * 3600_000;
// Dispatch rows can be orphaned in "running" forever (117 observed) — only
// count a lane as live when it started recently enough to plausibly still run.
const RUNNING_WINDOW_MS = 4 * 3600_000;
const BATCH_CACHE_TTL_MS = 45_000;
const GIT_POOL_SIZE = 6;

const ACTIVE_STATUSES = new Set(['in_progress', 'dispatched']);
const QUEUED_STATUSES = new Set(['idea', 'planning', 'todo', 'scheduled']);
const ATTENTION_STATUSES = new Set(['needs_input', 'blocked', 'failed']);
const REVIEW_STATUSES = new Set(['ready_for_review', 'review']);

/** sqlite writes "YYYY-MM-DD HH:MM:SS" (UTC), app code writes ISO — accept both. */
function toMs(value) {
    if (!value) return null;
    const iso = typeof value === 'string' && !value.includes('T')
        ? value.replace(' ', 'T') + 'Z'
        : value;
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? ms : null;
}

/** Bucket a timestamp into `days` rolling 24h slots, oldest first. */
function bucketIndex(ms, nowMs, days) {
    const age = Math.floor((nowMs - ms) / DAY_MS);
    if (age < 0 || age >= days) return -1;
    return days - 1 - age;
}

async function mapPool(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    async function worker() {
        while (next < items.length) {
            const i = next++;
            results[i] = await fn(items[i], i);
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}

const EMPTY_GIT = {
    hasGit: false, hasRemote: false, hasCommits: false, remoteUrl: null,
    branch: null, uncommitted: 0, ahead: 0, behind: 0,
    lastCommit: null, series: [], total: 0,
};

async function gitPulse(projectPath, days, nowMs) {
    if (!projectPath || !fs.existsSync(path.join(projectPath, '.git'))) {
        return { ...EMPTY_GIT, series: new Array(days).fill(0) };
    }
    const git = simpleGit(projectPath);
    const out = { ...EMPTY_GIT, hasGit: true, series: new Array(days).fill(0) };
    try {
        const status = await git.status();
        out.branch = status.current;
        out.uncommitted = status.files?.length || 0;
        out.ahead = status.ahead || 0;
        out.behind = status.behind || 0;
    } catch { /* fresh repo — leave defaults */ }
    try {
        const origin = (await git.getRemotes(true)).find(r => r.name === 'origin');
        if (origin?.refs?.push) {
            out.hasRemote = true;
            out.remoteUrl = origin.refs.push
                .replace('git@github.com:', 'https://github.com/')
                .replace(/\.git$/, '');
        }
    } catch { /* no remotes */ }
    try {
        const log = await git.log({ maxCount: 1 });
        if (log.latest) {
            out.hasCommits = true;
            out.lastCommit = {
                hash: log.latest.hash,
                message: log.latest.message,
                date: log.latest.date,
            };
        }
    } catch { /* unborn HEAD */ }
    if (out.hasCommits) {
        try {
            const raw = await git.raw(['log', `--since=${days}.days`, '--format=%ct']);
            for (const line of raw.split('\n')) {
                const sec = parseInt(line, 10);
                if (!Number.isFinite(sec)) continue;
                const idx = bucketIndex(sec * 1000, nowMs, days);
                if (idx >= 0) { out.series[idx]++; out.total++; }
            }
        } catch { /* histogram is best-effort */ }
    }
    return out;
}

function createProjectPulseRouter({ PROJECT_ROOT, getAllProjects, getProjectById, dbPath = DEFAULT_DB_PATH }) {
    const router = express.Router();

    let dbc;
    try {
        dbc = new Database(dbPath, { readonly: true });
        // WAL is set by the writers; a readonly handle just follows along.
    } catch (err) {
        console.error(`[Pulse] DB unavailable (${err.message}) — project pulse disabled`);
        router.use((_req, res) => res.status(503).json({ error: 'pulse storage unavailable' }));
        return router;
    }

    const taskStmt = dbc.prepare(`
        SELECT project_id, name, status, updated_at, last_activity_at
        FROM tasks
        WHERE archived_at IS NULL AND status NOT IN ('archived', 'cancelled')
    `);
    // project_id is often null on dispatch rows — attribute through the task.
    const dispatchStmt = dbc.prepare(`
        SELECT d.executor, d.model, d.tokens, d.outcome, d.started_at, d.completed_at,
               COALESCE(d.project_id, t.project_id) AS project_id,
               t.name AS task_name
        FROM task_dispatches d
        LEFT JOIN tasks t ON t.id = d.task_id
        ORDER BY d.started_at DESC
        LIMIT 800
    `);
    const doneTasksStmt = dbc.prepare(`
        SELECT name, status, updated_at
        FROM tasks
        WHERE project_id = ? AND status = 'completed'
        ORDER BY updated_at DESC
        LIMIT 10
    `);

    function emptyTasks() {
        return { active: 0, activeNames: [], queued: 0, attention: 0, review: 0, done7d: 0, total: 0, lastTouchMs: null };
    }
    function emptyCrew() {
        return { running: 0, last: null, tokens24h: 0, tokens7d: 0, dispatches7d: 0 };
    }

    /** Task + dispatch rollups for every project in one pass over the board. */
    function boardRollups(nowMs) {
        const tasks = new Map();
        for (const t of taskStmt.all()) {
            if (!t.project_id) continue;
            let r = tasks.get(t.project_id);
            if (!r) { r = emptyTasks(); tasks.set(t.project_id, r); }
            r.total++;
            const touched = toMs(t.last_activity_at) ?? toMs(t.updated_at);
            if (touched && (!r.lastTouchMs || touched > r.lastTouchMs)) r.lastTouchMs = touched;
            if (ACTIVE_STATUSES.has(t.status)) {
                r.active++;
                if (r.activeNames.length < 3) r.activeNames.push(t.name);
            } else if (QUEUED_STATUSES.has(t.status)) r.queued++;
            else if (ATTENTION_STATUSES.has(t.status)) r.attention++;
            else if (REVIEW_STATUSES.has(t.status)) r.review++;
            else if (t.status === 'completed' && touched && nowMs - touched <= 7 * DAY_MS) r.done7d++;
        }
        const crew = new Map();
        for (const d of dispatchStmt.all()) {
            if (!d.project_id) continue;
            let c = crew.get(d.project_id);
            if (!c) { c = emptyCrew(); crew.set(d.project_id, c); }
            const startedMs = toMs(d.started_at);
            if (!c.last) {
                c.last = {
                    executor: d.executor, model: d.model, outcome: d.outcome,
                    taskName: d.task_name, at: d.started_at, tokens: d.tokens,
                };
            }
            if (!startedMs) continue;
            if (d.outcome === 'running' && nowMs - startedMs <= RUNNING_WINDOW_MS) c.running++;
            if (nowMs - startedMs <= 7 * DAY_MS) {
                c.dispatches7d++;
                if (d.tokens) {
                    c.tokens7d += d.tokens;
                    if (nowMs - startedMs <= DAY_MS) c.tokens24h += d.tokens;
                }
            }
        }
        return { tasks, crew };
    }

    function assemblePulse(project, git, taskRoll, crewRoll) {
        const { lastTouchMs, ...tasks } = taskRoll ?? emptyTasks();
        const crew = crewRoll ?? emptyCrew();
        const candidates = [
            git.lastCommit ? toMs(git.lastCommit.date) : null,
            lastTouchMs,
            crew.last ? toMs(crew.last.at) : null,
        ].filter(Boolean);
        return {
            projectId: project.id,
            git,
            tasks,
            crew,
            lastActivityAt: candidates.length ? new Date(Math.max(...candidates)).toISOString() : null,
        };
    }

    let batchCache = null;
    let batchCacheAt = 0;
    let batchInFlight = null;

    async function buildBatch() {
        const nowMs = Date.now();
        const projects = (await getAllProjects(PROJECT_ROOT)).filter(p => p.status !== 'archived');
        const { tasks, crew } = boardRollups(nowMs);
        const gits = await mapPool(projects, GIT_POOL_SIZE, p => gitPulse(p.path, 14, nowMs));
        const pulses = {};
        projects.forEach((p, i) => {
            pulses[p.id] = assemblePulse(p, gits[i], tasks.get(p.id), crew.get(p.id));
        });
        return { generatedAt: new Date(nowMs).toISOString(), pulses };
    }

    router.get('/pulse', async (_req, res) => {
        try {
            if (batchCache && Date.now() - batchCacheAt < BATCH_CACHE_TTL_MS) {
                return res.json(batchCache);
            }
            if (!batchInFlight) {
                batchInFlight = buildBatch()
                    .then(payload => { batchCache = payload; batchCacheAt = Date.now(); return payload; })
                    .finally(() => { batchInFlight = null; });
            }
            res.json(await batchInFlight);
        } catch (err) {
            console.error('[Pulse] batch failed:', err.message);
            res.status(500).json({ error: 'Failed to build project pulse: ' + err.message });
        }
    });

    router.get('/:id/pulse', async (req, res) => {
        try {
            const project = await getProjectById(PROJECT_ROOT, req.params.id);
            if (!project) return res.status(404).json({ error: 'Project not found' });
            const nowMs = Date.now();
            const { tasks, crew } = boardRollups(nowMs);
            const git = await gitPulse(project.path, 30, nowMs);
            const pulse = assemblePulse(project, git, tasks.get(project.id), crew.get(project.id));

            // Ops log — commits, dispatches, and completions merged newest-first.
            const events = [];
            if (git.hasCommits) {
                try {
                    const log = await simpleGit(project.path).log({ maxCount: 30 });
                    for (const c of log.all) {
                        events.push({
                            type: 'commit', at: c.date, title: c.message,
                            meta: c.hash.substring(0, 7), by: c.author_name,
                        });
                    }
                } catch { /* ops log is best-effort */ }
            }
            for (const d of dispatchStmt.all()) {
                if (d.project_id !== project.id) continue;
                events.push({
                    type: 'dispatch', at: d.started_at,
                    title: d.task_name || 'Ad-hoc dispatch',
                    meta: [d.executor, d.model].filter(Boolean).join(' · '),
                    outcome: d.outcome, tokens: d.tokens,
                });
            }
            for (const t of doneTasksStmt.all(project.id)) {
                const ms = toMs(t.updated_at);
                events.push({
                    type: 'task', at: ms ? new Date(ms).toISOString() : t.updated_at,
                    title: t.name, outcome: 'completed',
                });
            }
            events.sort((a, b) => (toMs(b.at) ?? 0) - (toMs(a.at) ?? 0));

            res.json({ ...pulse, opsLog: events.slice(0, 40) });
        } catch (err) {
            console.error(`[Pulse] detail failed for ${req.params.id}:`, err.message);
            res.status(500).json({ error: 'Failed to build project pulse: ' + err.message });
        }
    });

    return router;
}

module.exports = createProjectPulseRouter;
