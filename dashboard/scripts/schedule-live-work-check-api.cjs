#!/usr/bin/env node
/**
 * Throwaway API + fake Praxis for the Today's Schedule live-work browser
 * check (task "Show chat-dispatched work and its queue in Today's Schedule",
 * 2026-10-04). Nothing here touches the live Nexus API (:4000), the live
 * nexus.db, or the live Praxis (:54322).
 *
 *   - A fresh SQLite board in a temp dir, seeded with the shapes the real
 *     snapshot had: one task running, two queued (the first a QA correction),
 *     an approved successor linked to the second, a plain idea, a completed
 *     task with its [Ad-hoc] completion event, and a day-plan slot event for
 *     one of the queued tasks (the dedupe case). No real task ids.
 *   - The REAL server routes mounted on it: server/routes/dispatch-insight.js
 *     (the new /live-work projection) and server/routes/calendar.js over the
 *     db facade (NEXUS_DB_PATH points at the temp file before it loads).
 *   - A fake Praxis on CHECK_PRAXIS_PORT that serves /api/dispatch/state from
 *     a named scenario. POST /__scenario/<name> switches it (so the browser
 *     check can walk queue → running → QA → unreachable). Scenarios:
 *       queue        running A; queue [B #1 correction, C #2]; D waits on C
 *       slot-freed   B running; queue [C #1]
 *       qa           B finished, QA run active for B; queue [C #1]
 *       unreachable  the fake Praxis answers 503 (Nexus reports reachable:false)
 *       empty        nothing running or queued
 *
 *   node dashboard/scripts/schedule-live-work-check-api.cjs
 *     prints CHECK_DIR=<temp dir>, CHECK_API=..., CHECK_PRAXIS=... and the
 *     seeded ids, then serves until SIGTERM/SIGINT.
 *
 * Env: CHECK_API_PORT (4299), CHECK_PRAXIS_PORT (4300), CHECK_DIR (fresh temp
 * dir by default).
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');

const ROOT = path.resolve(__dirname, '..', '..');
const API_PORT = Number(process.env.CHECK_API_PORT || 4299);
const PRAXIS_PORT = Number(process.env.CHECK_PRAXIS_PORT || 4300);
const DIR = process.env.CHECK_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-live-work-check-'));
fs.mkdirSync(DIR, { recursive: true });
const DB_PATH = path.join(DIR, 'nexus-check.db');
process.env.NEXUS_DB_PATH = DB_PATH;
process.env.PRAXIS_URL = `http://127.0.0.1:${PRAXIS_PORT}`;

const express = require(path.join(ROOT, 'node_modules', 'express'));
const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
const db = require(path.join(ROOT, 'db'));
const createCalendarRouter = require(path.join(ROOT, 'server', 'routes', 'calendar.js'));
const createDispatchInsightRouter = require(path.join(ROOT, 'server', 'routes', 'dispatch-insight.js'));

// ── Seed ────────────────────────────────────────────────────────────────────
const ids = {
    project: 'proj-check-nexus',
    running: 'task-check-running-0001',
    queuedCorrection: 'task-check-queued-correction-0002',
    queuedSlot: 'task-check-queued-slot-0003',
    successor: 'task-check-successor-0004',
    idea: 'task-check-idea-0005',
    done: 'task-check-done-0006',
    slotEvent: 'evt-check-slot-0003',
    adhocEvent: 'evt-check-adhoc-0006',
    llmEvent: 'evt-check-llm',
};
const titles = {
    [ids.running]: 'Synthetic: show chat-dispatched work in Today’s Schedule',
    [ids.queuedCorrection]: 'Synthetic: executor-recorded document approvals',
    [ids.queuedSlot]: 'Synthetic: honor operator-originated contract changes',
    [ids.successor]: 'Synthetic: carry contract decisions through dispatch',
    [ids.idea]: 'Synthetic: an unscheduled board idea',
    [ids.done]: 'Synthetic: open the latest document revision',
};
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
{
    const raw = new Database(DB_PATH);
    raw.pragma('journal_mode = WAL');
    const cols = raw.prepare('PRAGMA table_info(tasks)').all().map((c) => c.name);
    if (!cols.includes('successor_id')) raw.exec('ALTER TABLE tasks ADD COLUMN successor_id TEXT');
    raw.prepare(`INSERT INTO projects (id, name, path, description) VALUES (?, ?, ?, ?)`)
        .run(ids.project, 'TheNexus (check)', DIR, 'synthetic project for the live-work browser check');
    const insertTask = raw.prepare(`INSERT INTO tasks (id, project_id, name, status, priority, dependencies, successor_id, metadata, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'medium', ?, ?, ?, ?, ?)`);
    const t = (id, status, deps = [], successor = null, metadata = {}) =>
        insertTask.run(id, ids.project, titles[id], status, JSON.stringify(deps), successor, JSON.stringify(metadata), iso(now - 3 * 3600_000), iso(now - 600_000));
    t(ids.running, 'in_progress');
    t(ids.queuedCorrection, 'todo', [], null, { status_message: 'QA failed: corrections required' });
    t(ids.queuedSlot, 'todo', [], ids.successor);
    t(ids.successor, 'idea', [ids.queuedSlot]);
    t(ids.idea, 'idea');
    t(ids.done, 'completed');
    const insertEvent = raw.prepare(`INSERT INTO calendar_events (id, title, description, start_time, end_time, status, event_type, project_id, task_id, result, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    // A day-plan slot for the second queued task, an hour from now.
    insertEvent.run(ids.slotEvent, `Slot: ${titles[ids.queuedSlot]}`, 'day-plan slot', iso(now + 3600_000), iso(now + 2 * 3600_000), 'scheduled', 'praxis_task', ids.project, ids.queuedSlot, null, iso(now - 3600_000), iso(now - 3600_000));
    // The reconciler's [Ad-hoc] completion for the finished task.
    insertEvent.run(ids.adhocEvent, `[Ad-hoc] ${titles[ids.done]}`, 'completed via chat dispatch', iso(now - 2.5 * 3600_000), iso(now - 2 * 3600_000), 'completed', 'praxis_task', ids.project, ids.done, 'implementation complete', iso(now - 2 * 3600_000), iso(now - 2 * 3600_000));
    // A non-task event, as the real calendar has.
    insertEvent.run(ids.llmEvent, 'Local LLM Nightly Synthesis', null, iso(now - 4 * 3600_000), iso(now - 3.5 * 3600_000), 'scheduled', 'local_llm:synthesis', null, null, null, iso(now - 5 * 3600_000), iso(now - 5 * 3600_000));
    raw.close();
}

// ── Fake Praxis ─────────────────────────────────────────────────────────────
const run = (taskId, extra = {}) => ({
    id: taskId, taskId, title: titles[taskId], executor: 'claude-code', kind: 'task', phase: 'executing', status: 'active',
    startedAt: iso(now - 5 * 60_000), updatedAt: iso(now - 30_000), attemptId: `attempt-${taskId}`, schedule: null, ...extra,
});
const queued = (taskId, extra = {}) => ({ taskId, title: titles[taskId], executor: 'claude-code', args: { task_id: taskId }, enqueuedAt: iso(now - 2 * 3600_000), ...extra });
const base = () => ({ at: new Date().toISOString(), health: { ok: true }, incidents: [], executors: { cliConcurrency: { limit: 1 }, deferredQa: [], sessions: [] } });
const scenarios = {
    queue: () => ({ ...base(), executors: { ...base().executors, runs: [run(ids.running, { phase: 'testing' })],
        cliQueue: [queued(ids.queuedCorrection, { args: { task_id: ids.queuedCorrection, continuation: true, repair_context: 'QA round 1' } }), queued(ids.queuedSlot, { enqueuedAt: iso(now - 6 * 60_000) })] } }),
    'slot-freed': () => ({ ...base(), executors: { ...base().executors, runs: [
        run(ids.running, { status: 'completed', updatedAt: iso(now - 20_000) }),
        run(ids.queuedCorrection, { startedAt: iso(now - 10_000), updatedAt: iso(now - 5_000) }),
    ], cliQueue: [queued(ids.queuedSlot, { enqueuedAt: iso(now - 6 * 60_000) })] } }),
    qa: () => ({ ...base(), executors: { ...base().executors, runs: [
        run(ids.running, { status: 'completed', updatedAt: iso(now - 20_000) }),
        run(ids.queuedCorrection, { status: 'completed', startedAt: iso(now - 10 * 60_000), updatedAt: iso(now - 60_000) }),
        { ...run(ids.queuedCorrection, { startedAt: iso(now - 50_000), updatedAt: iso(now - 5_000) }), id: `qa--${ids.queuedCorrection}`, kind: 'qa', executor: 'codex' },
    ], cliQueue: [queued(ids.queuedSlot, { enqueuedAt: iso(now - 6 * 60_000) })] } }),
    empty: () => ({ ...base(), executors: { ...base().executors, runs: [], cliQueue: [] } }),
    unreachable: null,
};
let scenario = 'queue';
const praxisLog = [];
const praxis = express();
praxis.use(express.json());
praxis.use((req, _res, next) => { praxisLog.push(`${req.method} ${req.path}`); next(); });
praxis.post('/__scenario/:name', (req, res) => {
    if (!(req.params.name in scenarios)) return res.status(404).json({ error: 'unknown scenario' });
    scenario = req.params.name;
    res.json({ scenario });
});
praxis.get('/__log', (_req, res) => res.json({ scenario, log: praxisLog }));
praxis.get('/api/dispatch/state', (_req, res) => {
    const make = scenarios[scenario];
    if (!make) return res.status(503).json({ error: 'praxis down (scenario)' });
    res.json(make());
});
praxis.use((_req, res) => res.status(404).json({ error: 'not found' }));

// ── Throwaway Nexus API ─────────────────────────────────────────────────────
const api = express();
api.use(express.json());
const apiLog = [];
api.use((req, _res, next) => { apiLog.push(`${req.method} ${req.path}`); next(); });
api.get('/__log', (_req, res) => res.json({ log: apiLog }));
api.use('/api/calendar', createCalendarRouter({ db }));
api.use('/api/dispatch-insight', createDispatchInsightRouter({ dbPath: DB_PATH, praxisUrl: `http://127.0.0.1:${PRAXIS_PORT}` }));
// Everything else the home page asks for: a quiet 404 (the panel under test
// does not depend on it, and the request log still shows what was asked).
api.use((_req, res) => res.status(404).json({ error: 'not part of the check' }));

const servers = [
    http.createServer(praxis).listen(PRAXIS_PORT, '127.0.0.1'),
    http.createServer(api).listen(API_PORT, '127.0.0.1'),
];
Promise.all(servers.map((s) => new Promise((r) => s.once('listening', r)))).then(() => {
    fs.writeFileSync(path.join(DIR, 'ids.json'), JSON.stringify({ ids, titles }, null, 2));
    console.log(`CHECK_DIR=${DIR}`);
    console.log(`CHECK_API=http://127.0.0.1:${API_PORT}`);
    console.log(`CHECK_PRAXIS=http://127.0.0.1:${PRAXIS_PORT}`);
    console.log(`CHECK_IDS=${JSON.stringify(ids)}`);
    console.log('READY');
});
const stop = () => { servers.forEach((s) => s.close()); setTimeout(() => process.exit(0), 100); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
