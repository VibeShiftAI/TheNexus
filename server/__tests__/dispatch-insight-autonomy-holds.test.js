/**
 * Tests for the two "why is work held" read surfaces on
 * server/routes/dispatch-insight.js:
 *
 *   GET /autonomy   — the EXPLICIT pause flag from Praxis composed with the
 *                     separate no-live-day-schedule probe, which Praxis exposes
 *                     only through the read-only `get_day_schedule` agent-tool.
 *   GET /qa-holds   — tasks whose LATEST operational event is
 *                     `qa_correction_withheld_paused`, i.e. still held.
 *
 * Temp SQLite + a fake Praxis; the live board and the real daemon are never
 * touched. The event bodies below are verbatim from real Nexus ag_events rows
 * so the reason/findings split is pinned against production text, not a
 * hand-shaped string.
 */
const express = require('express');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const createDispatchInsightRouter = require('../routes/dispatch-insight');

function listen(app) {
    const server = http.createServer(app);
    const sockets = new Set();
    server.on('connection', (socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            resolve({ server, sockets, baseUrl: `http://127.0.0.1:${server.address().port}` });
        });
    });
}

function close(handle) {
    if (!handle) return Promise.resolve();
    for (const socket of handle.sockets) socket.destroy();
    return new Promise((resolve) => handle.server.close(resolve));
}

async function getJson(url) {
    const res = await fetch(url);
    return { status: res.status, body: await res.json() };
}

/** Verbatim ag_events.message, row 13065 (task 1e7f4570, 2026-09-02 10:50:19). */
const NO_SCHEDULE_MESSAGE =
    'QA (codex) failed this round, but autonomy is paused (no live day schedule — autonomy is paused. ' +
    'Install a day plan (morning routine) or dispatch this task explicitly to resume it; ' +
    'PRAXIS_AUTONOMY_WHEN_PAUSED=1 overrides.) so the task was NOT re-dispatched. ' +
    'It is parked at `todo` with its findings; dispatch it to resume.\n\n' +
    'Q1: No — 7/10 criteria pass; the build/typecheck passed and the live header/picker worked, ' +
    'but failed-save behavior and the dashboard suite do not satisfy the task.\n' +
    'Q2: Criteria 3 and 7 fail in chat-settings-section.tsx.';

/** The explicit-pause variant, which also holds operator-started work. */
const EXPLICIT_MESSAGE =
    'QA (antigravity) failed this round, but autonomy is paused (an explicit pause is in effect ' +
    '(requested by Robert).) so the task was NOT re-dispatched. Robert started this task by hand; ' +
    'the explicit stop holds its correction too. It is parked at `todo`.\n\n' +
    'Q1: No. The route landed but its test does not run.';

function seed(dbPath) {
    const db = new Database(dbPath);
    db.exec(`
        CREATE TABLE tasks (
            id TEXT PRIMARY KEY, project_id TEXT, name TEXT, status TEXT,
            priority INTEGER DEFAULT 0, dependencies TEXT DEFAULT '[]',
            default_executor TEXT, metadata TEXT DEFAULT '{}', archived_at TEXT
        );
        CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, status TEXT);
        CREATE TABLE ag_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_type TEXT, severity TEXT, title TEXT, message TEXT,
            task_id TEXT, source TEXT, metadata TEXT,
            requires_action INTEGER DEFAULT 0, action_taken INTEGER DEFAULT 0,
            created_at TEXT
        );
    `);
    const task = db.prepare('INSERT INTO tasks (id, project_id, name, status) VALUES (?, ?, ?, ?)');
    task.run('task-held', 'proj-1', 'Held by no-schedule', 'todo');
    task.run('task-held-explicit', 'proj-1', 'Held by explicit stop', 'todo');
    task.run('task-released', 'proj-1', 'Was held, then re-dispatched', 'completed');

    const event = db.prepare(`
        INSERT INTO ag_events (event_type, severity, title, message, task_id, source, metadata, created_at)
        VALUES (@event_type, 'info', @title, @message, @task_id, 'praxis:qa-dispatch', @metadata, @created_at)
    `);
    const held = {
        event_type: 'qa_correction_withheld_paused',
        title: 'QA corrections held — autonomy paused',
        metadata: '{}',
    };

    // Still held: the hold is this task's newest event.
    event.run({ ...held, message: NO_SCHEDULE_MESSAGE, task_id: 'task-held', created_at: '2026-09-02 10:50:19' });

    // Still held, operator-initiated (metadata carries the provenance).
    event.run({
        ...held,
        message: EXPLICIT_MESSAGE,
        task_id: 'task-held-explicit',
        metadata: JSON.stringify({ operatorInitiated: true, persisted: 'persisted', explicit: true }),
        created_at: '2026-09-02 11:00:00',
    });

    // RELEASED: held once, but a later event means the hold is over. This is
    // the case that separates "is held" from "was ever held".
    event.run({ ...held, message: NO_SCHEDULE_MESSAGE, task_id: 'task-released', created_at: '2026-09-02 09:00:00' });
    event.run({
        event_type: 'task_qa_passed',
        title: 'QA passed',
        message: 'clean',
        task_id: 'task-released',
        metadata: '{}',
        created_at: '2026-09-02 12:00:48',
    });

    // A hold event with no task attached must not produce a phantom row.
    event.run({ ...held, message: NO_SCHEDULE_MESSAGE, task_id: null, created_at: '2026-09-02 08:00:00' });
    db.close();
}

/**
 * Fake Praxis. `autonomy` is the /api/autonomy body; `schedule` is what the
 * `get_day_schedule` agent-tool answers — Praxis returns a fixed sentence
 * beginning "No active day schedule" when getDaySchedule() is null, which is
 * the exact probe autonomyPauseState() itself performs.
 */
function fakePraxis(config) {
    const app = express();
    app.use(express.json());
    const toolCalls = [];
    app.get('/api/autonomy', (_req, res) => {
        if (config.autonomyStatus && config.autonomyStatus !== 200) {
            return res.status(config.autonomyStatus).json({ error: 'boom' });
        }
        res.json(config.autonomy);
    });
    app.post('/agent-tool', (req, res) => {
        toolCalls.push(req.body);
        res.json({ ok: true, result: config.schedule });
    });
    return { app, toolCalls };
}

describe('dispatch-insight: autonomy + QA holds', () => {
    let tmpDir;
    let dbPath;
    let handle;
    let praxisHandle;
    let toolCalls;

    async function boot({ praxisUp = true, ...config } = {}) {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-holds-'));
        dbPath = path.join(tmpDir, 'nexus.db');
        seed(dbPath);

        let praxisUrl = 'http://127.0.0.1:9'; // unroutable → unreachable
        toolCalls = [];
        if (praxisUp) {
            const fake = fakePraxis(config);
            praxisHandle = await listen(fake.app);
            praxisUrl = praxisHandle.baseUrl;
            toolCalls = fake.toolCalls;
        }

        const app = express();
        app.use(express.json());
        app.use('/api/dispatch-insight', createDispatchInsightRouter({
            dbPath,
            spineDbPath: path.join(tmpDir, 'missing-spine.sqlite'),
            detachedRunsDir: path.join(tmpDir, 'runs'),
            praxisUrl,
        }));
        handle = await listen(app);
    }

    afterEach(async () => {
        await close(handle);
        await close(praxisHandle);
        handle = null;
        praxisHandle = null;
        if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
        tmpDir = null;
    });

    // ── GET /autonomy ────────────────────────────────────────────────────

    it('reports running when the flag is clear and a day schedule is live', async () => {
        await boot({
            autonomy: {
                paused: false,
                flag: { paused: false, since: '2026-09-03T01:13:37.288Z', requestedBy: 'Robert' },
                inFlight: [{ taskId: 'a', executor: 'claude-code' }],
            },
            schedule: '📅 **Day Schedule** (12 tasks):\n\n| # | Task |\n|---|---|\n| 1 | thing |',
        });

        const { status, body } = await getJson(`${handle.baseUrl}/api/dispatch-insight/autonomy`);
        expect(status).toBe(200);
        expect(body.praxis).toEqual({ reachable: true, error: null });
        expect(body.paused).toBe(false);
        expect(body.scheduleLive).toBe(true);
        expect(body.scheduleDetail).toBe('📅 **Day Schedule** (12 tasks):');
        expect(body.inFlight).toHaveLength(1);
        expect(toolCalls).toEqual([{ name: 'get_day_schedule', args: {} }]);
    });

    it('reports no-live-schedule from Praxis\'s own probe sentence', async () => {
        await boot({
            autonomy: { paused: false, flag: { paused: false }, inFlight: [] },
            schedule: 'No active day schedule. Use `schedule_day` during the morning standup to create one.',
        });

        const { body } = await getJson(`${handle.baseUrl}/api/dispatch-insight/autonomy`);
        expect(body.paused).toBe(false);
        expect(body.scheduleLive).toBe(false);
        expect(body.scheduleDetail).toMatch(/^No active day schedule/);
    });

    it('carries who asked for an explicit pause and since when, and skips the probe', async () => {
        await boot({
            autonomy: {
                paused: true,
                flag: {
                    paused: true,
                    since: '2026-09-02T21:13:00.000Z',
                    requestedBy: 'Robert',
                    reason: 'pause everything',
                },
                inFlight: [{ taskId: 'a' }, { taskId: 'b' }],
            },
            schedule: 'No active day schedule.',
        });

        const { body } = await getJson(`${handle.baseUrl}/api/dispatch-insight/autonomy`);
        expect(body.paused).toBe(true);
        expect(body.flag.requestedBy).toBe('Robert');
        expect(body.flag.since).toBe('2026-09-02T21:13:00.000Z');
        expect(body.inFlight).toHaveLength(2);
        // The explicit flag outranks the schedule, so the bridge round-trip is
        // not spent — and scheduleLive stays null rather than claiming a state.
        expect(body.scheduleLive).toBeNull();
        expect(toolCalls).toEqual([]);
    });

    it('reports unreachable rather than running when Praxis is down', async () => {
        await boot({ praxisUp: false });

        const { status, body } = await getJson(`${handle.baseUrl}/api/dispatch-insight/autonomy`);
        expect(status).toBe(200);
        expect(body.praxis.reachable).toBe(false);
        expect(body.praxis.error).toBeTruthy();
        expect(body.paused).toBe(false);
        // Unknown, not "running": scheduleLive must not read true here.
        expect(body.scheduleLive).toBeNull();
    });

    it('reports the schedule as unknown when the probe itself fails', async () => {
        await boot({
            autonomy: { paused: false, flag: { paused: false }, inFlight: [] },
            schedule: null, // tool answered with no result string
        });

        const { body } = await getJson(`${handle.baseUrl}/api/dispatch-insight/autonomy`);
        expect(body.praxis.reachable).toBe(true);
        expect(body.scheduleLive).toBeNull();
        expect(body.scheduleDetail).toMatch(/no schedule answer/);
    });

    it('reports unreachable when Praxis answers autonomy with an error status', async () => {
        await boot({ autonomy: {}, autonomyStatus: 503, schedule: 'x' });

        const { body } = await getJson(`${handle.baseUrl}/api/dispatch-insight/autonomy`);
        expect(body.praxis.reachable).toBe(false);
        expect(body.praxis.error).toMatch(/503/);
    });

    // ── GET /qa-holds ────────────────────────────────────────────────────

    it('lists only tasks whose LATEST event is the hold', async () => {
        await boot({ autonomy: { paused: false, flag: {}, inFlight: [] }, schedule: 'x' });

        const { status, body } = await getJson(`${handle.baseUrl}/api/dispatch-insight/qa-holds`);
        expect(status).toBe(200);
        expect(body.holds.map((h) => h.taskId).sort()).toEqual(['task-held', 'task-held-explicit']);
        // A task that was held and then re-dispatched is NOT still held.
        expect(body.holds.map((h) => h.taskId)).not.toContain('task-released');
    });

    it('splits the real event body into its pause reason and reviewer findings', async () => {
        await boot({ autonomy: { paused: false, flag: {}, inFlight: [] }, schedule: 'x' });

        const { body } = await getJson(`${handle.baseUrl}/api/dispatch-insight/qa-holds`);
        const hold = body.holds.find((h) => h.taskId === 'task-held');

        // The reason contains its own parentheses — the parser must match the
        // closing one before the fixed tail, not the first one it sees.
        expect(hold.reason).toBe(
            'no live day schedule — autonomy is paused. Install a day plan (morning routine) ' +
            'or dispatch this task explicitly to resume it; PRAXIS_AUTONOMY_WHEN_PAUSED=1 overrides.',
        );
        expect(hold.findings).toMatch(/^Q1: No — 7\/10 criteria pass/);
        expect(hold.findings).toMatch(/Q2: Criteria 3 and 7 fail/);
        expect(hold.title).toBe('Held by no-schedule');
        expect(hold.status).toBe('todo');
        expect(hold.projectId).toBe('proj-1');
        expect(hold.heldAt).toBe('2026-09-02 10:50:19');
        expect(hold.operatorInitiated).toBe(false);
    });

    it('flags an operator-initiated hold from the event metadata', async () => {
        await boot({ autonomy: { paused: false, flag: {}, inFlight: [] }, schedule: 'x' });

        const { body } = await getJson(`${handle.baseUrl}/api/dispatch-insight/qa-holds`);
        const hold = body.holds.find((h) => h.taskId === 'task-held-explicit');

        expect(hold.operatorInitiated).toBe(true);
        expect(hold.reason).toBe('an explicit pause is in effect (requested by Robert).');
    });

    it('returns newest holds first and ignores events with no task', async () => {
        await boot({ autonomy: { paused: false, flag: {}, inFlight: [] }, schedule: 'x' });

        const { body } = await getJson(`${handle.baseUrl}/api/dispatch-insight/qa-holds`);
        expect(body.holds).toHaveLength(2);
        expect(body.holds[0].taskId).toBe('task-held-explicit'); // 11:00 > 10:50
        expect(body.holds.every((h) => h.taskId)).toBe(true);
    });

    it('does not need Praxis to answer — holds are board-local', async () => {
        await boot({ praxisUp: false });

        const { status, body } = await getJson(`${handle.baseUrl}/api/dispatch-insight/qa-holds`);
        expect(status).toBe(200);
        expect(body.holds).toHaveLength(2);
    });
});
