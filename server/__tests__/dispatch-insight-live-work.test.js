/**
 * Tests for GET /api/dispatch-insight/live-work — the read projection that
 * puts chat-dispatched (ad hoc) work on Today's Schedule: what is running,
 * what is queued behind the CLI slot and in which order, what has finished
 * implementation but still awaits QA, and which linked board tasks wait on
 * that live work. Temp SQLite + a fake Praxis; the live board and the real
 * daemon are never touched, and the fake records every request so the suite
 * can prove the projection is read-only.
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

// Board shaped like the live one on 2026-10-04 21:33 (ids shortened): a
// running task holding the slot, two queued behind it, each with a linked
// successor, a finished-but-unreviewed task, a stale in_progress row with no
// runtime run, and plain ideas that must never read as queued.
function seedBoard(dbPath, { successorColumn = true } = {}) {
    const db = new Database(dbPath);
    db.exec(`
        CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, status TEXT);
        CREATE TABLE tasks (
            id TEXT PRIMARY KEY, project_id TEXT, name TEXT, status TEXT,
            priority INTEGER DEFAULT 0, version INTEGER DEFAULT 7, dependencies TEXT DEFAULT '[]',
            ${successorColumn ? 'successor_id TEXT,' : ''}
            default_executor TEXT, metadata TEXT DEFAULT '{}', archived_at TEXT
        );
        CREATE TABLE calendar_events (id TEXT PRIMARY KEY, title TEXT, task_id TEXT, status TEXT, start_time TEXT, end_time TEXT, event_type TEXT);
    `);
    db.prepare('INSERT INTO projects (id, name, status) VALUES (?, ?, ?)').run('nexus', 'TheNexus', 'active');
    db.prepare('INSERT INTO projects (id, name, status) VALUES (?, ?, ?)').run('praxis', 'Praxis', 'active');
    const cols = ['id', 'project_id', 'name', 'status', 'dependencies', 'metadata', 'archived_at']
        .concat(successorColumn ? ['successor_id'] : []);
    const ins = db.prepare(`INSERT INTO tasks (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')})`);
    const row = (t) => ins.run({
        project_id: 'nexus', dependencies: '[]', metadata: '{}', archived_at: null,
        ...(successorColumn ? { successor_id: null } : {}),
        ...t,
    });
    row({ id: 'visibility', name: 'Show chat-dispatched work in Today’s Schedule', status: 'in_progress' });
    row({ id: 'approvals', name: 'Enable executor-recorded document approvals', status: 'todo',
        metadata: JSON.stringify({ status_message: 'QA failed — corrections required' }),
        ...(successorColumn ? { successor_id: 'vitality' } : {}) });
    row({ id: 'contract-fix', name: 'Honor Robert-originated task contract changes', status: 'todo',
        ...(successorColumn ? { successor_id: 'contract-successor' } : {}) });
    row({ id: 'contract-successor', project_id: 'praxis', name: 'Carry contract decisions through dispatch',
        status: 'idea', dependencies: '["contract-fix"]' });
    row({ id: 'vitality', name: 'Move vitality memo provenance to the bottom', status: 'todo',
        dependencies: '["approvals"]' });
    row({ id: 'grandchild', name: 'Publish the vitality memo', status: 'idea', dependencies: '["vitality"]' });
    row({ id: 'unreviewed', name: 'Latest document revision repair', status: 'in_progress' });
    row({ id: 'stale-board', name: 'Board says in_progress, runtime says nothing', status: 'in_progress' });
    row({ id: 'plain-idea', name: 'An unscheduled idea', status: 'idea' });
    row({ id: 'done-dep', name: 'Finished predecessor', status: 'completed' });
    row({ id: 'waits-on-done', name: 'Waits only on finished work', status: 'idea', dependencies: '["done-dep"]' });
    row({ id: 'archived', name: 'Archived successor', status: 'idea', dependencies: '["contract-fix"]', archived_at: '2026-01-01T00:00:00Z' });
    row({ id: 'cancelled-successor', name: 'Cancelled successor', status: 'cancelled', dependencies: '["contract-fix"]' });
    db.close();
}

/** Fake Praxis that serves a mutable dispatch-state and logs every request. */
function fakePraxis(state) {
    const app = express();
    app.use(express.json());
    const requests = [];
    app.use((req, _res, next) => { requests.push(`${req.method} ${req.path}`); next(); });
    app.get('/api/dispatch/state', (_req, res) => res.json(state.current));
    app.use((_req, res) => res.status(404).json({ error: 'not found' }));
    return { app, requests };
}

const RUNNING = {
    taskId: 'visibility', executor: 'claude-code', title: 'Show chat-dispatched work in Today’s Schedule',
    kind: 'task', phase: 'testing', status: 'active', startedAt: '2026-10-04T21:32:34.763Z', updatedAt: '2026-10-04T21:32:46.801Z',
};
const FINISHED_UNREVIEWED = {
    taskId: 'unreviewed', executor: 'claude-code', title: 'Latest document revision repair',
    kind: 'task', phase: 'completed', status: 'completed', startedAt: '2026-10-04T19:46:08.600Z', updatedAt: '2026-10-04T19:50:06.180Z',
};
const QA_RUNNING_FOR_UNREVIEWED = {
    taskId: 'qa--unreviewed', executor: 'codex', title: 'QA review: Latest document revision repair',
    kind: 'qa', phase: 'reviewing', status: 'active', startedAt: '2026-10-04T19:50:07.995Z', updatedAt: '2026-10-04T19:50:07.995Z',
};
const OLD_FINISHED_RUN_FOR_RUNNING_TASK = {
    // An earlier attempt of the running task — the active run must win.
    taskId: 'visibility', executor: 'claude-code', title: 'Show chat-dispatched work in Today’s Schedule',
    kind: 'task', phase: 'completed', status: 'completed', startedAt: '2026-10-04T18:00:00.000Z', updatedAt: '2026-10-04T18:30:00.000Z',
};
const AGENT_RUN = {
    taskId: 'agent-eod-review-1791075600432', executor: 'codex', title: 'EOD review', kind: 'agent',
    phase: 'completed', status: 'completed', startedAt: '2026-10-04T01:00:00.432Z', updatedAt: '2026-10-04T01:02:15.964Z',
};

const STATE_NO_PLAN_WITH_QUEUE = {
    executors: {
        runs: [RUNNING, OLD_FINISHED_RUN_FOR_RUNNING_TASK, FINISHED_UNREVIEWED, QA_RUNNING_FOR_UNREVIEWED, AGENT_RUN],
        cliQueue: [
            { taskId: 'approvals', title: 'Enable executor-recorded document approvals', executor: 'claude-code',
                enqueuedAt: '2026-10-04T19:51:51.244Z', args: { task_id: 'approvals', continuation: true, repair_context: { attempt: 0 } } },
            { taskId: 'contract-fix', title: 'Honor Robert-originated task contract changes', executor: 'claude-code',
                enqueuedAt: '2026-10-04T21:32:27.506Z', args: { task_id: 'contract-fix' } },
        ],
        deferredQa: [],
        health: {},
        incidents: {},
    },
};

describe('dispatch-insight live-work projection', () => {
    let tmpDir;
    let handle;
    let praxisHandle;
    let praxisState;
    let praxisRequests;
    let dbPath;

    async function boot({ state = STATE_NO_PLAN_WITH_QUEUE, praxisUp = true, successorColumn = true, approved = true, slateError = false, improvements = { available: true, items: [] } } = {}) {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-live-work-'));
        dbPath = path.join(tmpDir, 'board.db');
        seedBoard(dbPath, { successorColumn });
        const date = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
        const calendarDb = new Database(dbPath);
        for (const id of ['visibility', 'approvals', 'contract-fix']) {
            calendarDb.prepare("INSERT INTO calendar_events VALUES (?, ?, ?, 'scheduled', ?, NULL, 'praxis_task')").run(id, id, id, new Date().toISOString());
        }
        calendarDb.close();
        const slate = { available: true, date, stages: [{ stage: 'approved', reached: approved }],
            slots: ['visibility', 'approvals', 'contract-fix'].map(taskId => ({ taskId, withdrawn: false })) };

        let praxisUrl = 'http://127.0.0.1:9';
        praxisRequests = [];
        praxisState = { current: state };
        if (praxisUp) {
            const fake = fakePraxis(praxisState);
            praxisHandle = await listen(fake.app);
            praxisUrl = praxisHandle.baseUrl;
            praxisRequests = fake.requests;
        }

        const app = express();
        app.use(express.json());
        app.use('/api/dispatch-insight', createDispatchInsightRouter({
            dbPath,
            spineDbPath: path.join(tmpDir, 'missing-spine.db'),
            detachedRunsDir: path.join(tmpDir, 'detached-runs'),
            councilSessionsDir: path.join(tmpDir, 'council-sessions'),
            praxisUrl,
            readImprovements: () => improvements,
            readFollowupSlate: () => { if (slateError) throw Error('Schedule read failed'); return slate; },
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

    test('live route includes distinct improvement rows and exposes incomplete reads', async () => {
        const improvement = { taskId: 'visibility', title: 'QA improvements — Visibility', lane: 'waiting', improvement: {id:'r1',status:'waiting',reason:'Approved work runs first'} };
        await boot({improvements:{available:false,items:[improvement]}});
        const {body} = await getJson(`${handle.baseUrl}/api/dispatch-insight/live-work`);
        expect(body.items.filter(i=>i.taskId==='visibility')).toHaveLength(2);
        expect(body.items).toContainEqual(improvement);
        expect(body.followupError).toMatch(/QA improvement records are unavailable/);
    });

    function byId(body) {
        return Object.fromEntries(body.items.map((i) => [i.taskId, i]));
    }

    test('approved day plan + a queue: running, queued, QA-pending and related waiting rows', async () => {
        await boot();
        const { status, body } = await getJson(`${handle.baseUrl}/api/dispatch-insight/live-work`);
        expect(status).toBe(200);
        expect(body.praxis).toEqual({ reachable: true, error: null });
        expect(typeof body.at).toBe('string');

        const items = byId(body);

        // The slot holder: one row, the ACTIVE run, not the earlier finished attempt.
        expect(body.items.filter((i) => i.taskId === 'visibility')).toHaveLength(1);
        expect(items.visibility).toMatchObject({
            lane: 'running', executor: 'claude-code', phase: 'testing',
            startedAt: '2026-10-04T21:32:34.763Z', boardStatus: 'in_progress', taskVersion: 7,
            title: 'Show chat-dispatched work in Today’s Schedule', projectId: 'nexus', projectName: 'TheNexus',
        });

        // Queue order and length as Praxis reports them; the correction flag
        // comes from the queued args (continuation / repair_context).
        expect(items.approvals).toMatchObject({
            lane: 'queued', position: 1, queueLength: 2, enqueuedAt: '2026-10-04T19:51:51.244Z',
            executor: 'claude-code', correction: true, boardStatus: 'todo',
            statusMessage: 'QA failed — corrections required',
        });
        expect(items['contract-fix']).toMatchObject({ lane: 'queued', position: 2, queueLength: 2, correction: false });
        expect(body.items.findIndex((i) => i.taskId === 'approvals'))
            .toBeLessThan(body.items.findIndex((i) => i.taskId === 'contract-fix'));

        // Implementation finished, reviewer still running: a QA row, not a
        // completion claim.
        expect(items.unreviewed).toMatchObject({
            lane: 'qa', finishedAt: '2026-10-04T19:50:06.180Z', boardStatus: 'in_progress',
            qa: { executor: 'codex', startedAt: '2026-10-04T19:50:07.995Z', status: 'active' },
        });

        // Linked successors wait on their NAMED dependencies, with each
        // dependency's live lane; designated successors retain legacy automatic start. Later chain steps stay off the calendar.
        expect(items['contract-successor']).toMatchObject({
            lane: 'waiting', boardStatus: 'idea', autoStart: true, legacyAutoStart: true, projectName: 'Praxis',
            waitingOn: [{ taskId: 'contract-fix', title: 'Honor Robert-originated task contract changes', lane: 'queued', position: 2 }],
        });
        expect(items.vitality).toMatchObject({
            lane: 'waiting', autoStart: true, legacyAutoStart: true,
            waitingOn: [{ taskId: 'approvals', lane: 'queued', position: 1 }],
        });
        expect(items.grandchild).toBeUndefined();

        expect(items['waits-on-done']).toBeUndefined();
        expect(items.vitality.followsToday).toEqual([{ taskId: 'approvals', title: 'Enable executor-recorded document approvals' }]);

        // Never listed: unlinked ideas,
        // archived or cancelled successors, a board row with no runtime run,
        // and the agent run.
        for (const absent of ['plain-idea', 'archived', 'cancelled-successor', 'stale-board', 'done-dep', 'agent-eod-review-1791075600432']) {
            expect(items[absent]).toBeUndefined();
        }
        expect(body.items.every((i) => i.lane !== 'queued' || ['approvals', 'contract-fix'].includes(i.taskId))).toBe(true);
    });

    test('transitions: the queue head becomes the running task, QA pass turns the QA row into a finished-done row, and successors stay linked to running predecessors', async () => {
        await boot();
        // Slot freed: approvals dequeued and running; contract-fix now head of the queue.
        praxisState.current = {
            executors: {
                runs: [
                    { ...RUNNING, status: 'completed', phase: 'completed', updatedAt: '2026-10-04T22:00:00.000Z' },
                    { taskId: 'approvals', executor: 'claude-code', title: 'Enable executor-recorded document approvals',
                        kind: 'task', phase: 'executing', status: 'active', startedAt: '2026-10-04T22:00:05.000Z', updatedAt: '2026-10-04T22:00:05.000Z' },
                    FINISHED_UNREVIEWED,
                    { ...QA_RUNNING_FOR_UNREVIEWED, status: 'completed', phase: 'completed', updatedAt: '2026-10-04T19:52:44.271Z' },
                ],
                cliQueue: [
                    { taskId: 'contract-fix', title: 'Honor Robert-originated task contract changes', executor: 'claude-code', enqueuedAt: '2026-10-04T21:32:27.506Z', args: {} },
                ],
            },
        };
        const db = new Database(dbPath);
        db.prepare("UPDATE tasks SET status = 'completed' WHERE id = 'unreviewed'").run();
        db.prepare("UPDATE tasks SET status = 'in_progress' WHERE id = 'approvals'").run();
        db.close();

        // Fresh boot, first read: the router's 3s snapshot cache is empty.
        const { body } = await getJson(`${handle.baseUrl}/api/dispatch-insight/live-work`);
        const items = byId(body);
        expect(items.approvals).toMatchObject({ lane: 'running', startedAt: '2026-10-04T22:00:05.000Z' });
        expect(items['contract-fix']).toMatchObject({ lane: 'queued', position: 1, queueLength: 1 });
        // Implementation finished AND the board says completed: a finished row
        // that the client dedupes against the [Ad-hoc] calendar event.
        expect(items.unreviewed).toMatchObject({ lane: 'finished', boardStatus: 'completed', qa: null });
        // The visibility task finished but its board row is still in_progress
        // and no reviewer is running: finished, QA pending — never "done".
        expect(items.visibility).toMatchObject({ lane: 'finished', boardStatus: 'in_progress', finishedAt: '2026-10-04T22:00:00.000Z' });
        expect(items.vitality).toMatchObject({ lane: 'waiting', waitingOn: [{ taskId: 'approvals', lane: 'running' }] });
    });

    test('before approval only actual execution is visible, not prepared successors', async () => {
        await boot({ approved: false });
        const { body } = await getJson(`${handle.baseUrl}/api/dispatch-insight/live-work`);
        expect(body.items.filter(i => i.lane === 'waiting')).toEqual([]);
        expect(byId(body).visibility.lane).toBe('running');
        expect(byId(body).approvals.lane).toBe('queued');
    });

    test('schedule read failure hides suggestions but preserves running/queued work with an explicit error', async () => {
        await boot({ slateError: true });
        const { body } = await getJson(`${handle.baseUrl}/api/dispatch-insight/live-work`);
        expect(body.items.filter(i => i.lane === 'waiting')).toEqual([]);
        expect(byId(body).visibility.lane).toBe('running');
        expect(byId(body).approvals.lane).toBe('queued');
        expect(body.followupError).toMatch(/Schedule read failed/);
    });

    test('Praxis unreachable: explicit unavailable state, no rows invented from the board', async () => {
        await boot({ praxisUp: false });
        const { status, body } = await getJson(`${handle.baseUrl}/api/dispatch-insight/live-work`);
        expect(status).toBe(200);
        expect(body.praxis.reachable).toBe(false);
        expect(typeof body.praxis.error).toBe('string');
        expect(body.items).toEqual([]);
    });

    test('a board without the successor_id column still projects dependency-linked waiting rows', async () => {
        await boot({ successorColumn: false });
        const { status, body } = await getJson(`${handle.baseUrl}/api/dispatch-insight/live-work`);
        expect(status).toBe(200);
        const items = byId(body);
        expect(items['contract-successor']).toMatchObject({ lane: 'waiting', autoStart: false });
        expect(items.vitality).toMatchObject({ lane: 'waiting', autoStart: false });
    });

    test('display is read-only: Praxis sees only GET /api/dispatch/state and the board is not written', async () => {
        await boot();
        const before = new Database(dbPath, { readonly: true });
        const snapshot = () => ({
            tasks: before.prepare('SELECT id, status, dependencies FROM tasks ORDER BY id').all(),
            calendar: before.prepare('SELECT COUNT(*) AS n FROM calendar_events').get().n,
        });
        const initial = snapshot();
        await getJson(`${handle.baseUrl}/api/dispatch-insight/live-work`);
        await getJson(`${handle.baseUrl}/api/dispatch-insight/live-work`);
        expect(snapshot()).toEqual(initial);
        before.close();
        expect(praxisRequests.every((r) => r === 'GET /api/dispatch/state')).toBe(true);
        expect(praxisRequests.length).toBeGreaterThan(0);
    });
});

// QA round 1 (2026-10-04): dependency lists changed with board-row order and
// omitted an unfinished prerequisite that was not itself linked to live work.
// Membership (who waits) follows the chain from live work; the NAMED
// dependencies are every unfinished predecessor, whatever order rows arrive.
describe('projectLiveWork dependency resolution', () => {
    const { projectLiveWork } = createDispatchInsightRouter;
    const row = (id, status, extra = {}) => ({
        id, project_id: 'nexus', project_name: 'TheNexus', name: `Task ${id}`, status,
        dependencies: JSON.stringify(extra.deps || []), metadata: '{}', archived_at: null, successor_id: extra.successor || null,
    });
    const stateQueued = (taskId) => ({ executors: { runs: [], deferredQa: [], cliQueue: [
        { taskId, title: `Task ${taskId}`, executor: 'claude-code', args: { task_id: taskId }, enqueuedAt: '2026-10-04T20:00:00.000Z' },
    ] } });
    const waitingOnIds = (items, id) => (items.find((i) => i.taskId === id)?.waitingOn || []).map((d) => d.taskId).sort();

    test('a chained dependency list is complete whatever order the board rows arrive in', () => {
        const A = row('A', 'todo');
        const B = row('B', 'todo', { deps: ['A'] });
        const C = row('C', 'todo', { deps: ['A', 'B'] });
        const forward = projectLiveWork(stateQueued('A'), [A, B, C]);
        const reversed = projectLiveWork(stateQueued('A'), [A, C, B]);
        expect(waitingOnIds(forward, 'C')).toEqual(['A', 'B']);
        expect(waitingOnIds(reversed, 'C')).toEqual(['A', 'B']);
        expect(waitingOnIds(reversed, 'B')).toEqual(['A']);
        const cDeps = reversed.find((i) => i.taskId === 'C').waitingOn;
        expect(cDeps.find((d) => d.taskId === 'A').lane).toBe('queued');
        expect(cDeps.find((d) => d.taskId === 'B').lane).toBe('waiting');
    });

    test('a linked successor names its blocked prerequisite as well as the live predecessor', () => {
        const A = row('A', 'todo', { successor: 'C' });
        const B = row('B', 'todo');
        const C = row('C', 'idea', { deps: ['B'] });
        const items = projectLiveWork(stateQueued('A'), [A, B, C]);
        const c = items.find((i) => i.taskId === 'C');
        expect(c.lane).toBe('waiting');
        expect(c.autoStart).toBe(true);
        expect(c.legacyAutoStart).toBe(true);
        expect(waitingOnIds(items, 'C')).toEqual(['A', 'B']);
        const b = c.waitingOn.find((d) => d.taskId === 'B');
        expect(b.lane).toBeNull();
        expect(b.boardStatus).toBe('todo');
        // B is not linked to live work itself, so it is not a waiting row.
        expect(items.some((i) => i.taskId === 'B')).toBe(false);
        // A completed prerequisite is not named.
        const D = row('D', 'completed');
        const C2 = row('C', 'idea', { deps: ['B', 'D'] });
        expect(waitingOnIds(projectLiveWork(stateQueued('A'), [A, B, C2, D]), 'C')).toEqual(['A', 'B']);
    });
});


describe('projectLiveWork prepared follow-ups and automatic starts', () => {
    const { projectLiveWork } = createDispatchInsightRouter;
    const row = (id, status, deps = [], extra = {}) => ({
        id, name: id, status, version: 12, dependencies: JSON.stringify(deps), ...extra,
    });
    const project = (rows, executors = {}) => projectLiveWork({ executors: { runs: [], cliQueue: [], ...executors } }, rows);
    const request = (state, taskId = 'follow') => ({
        taskId, state, requestedAt: '2026-10-08T10:00:00Z', updatedAt: '2026-10-08T11:00:00Z',
        detail: 'Waiting for dependencies', dependencies: ['before'], taskVersion: 12, contractHash: 'hash',
    });

    test.each(['completed', 'done'])('keeps a prepared follow-up after predecessor is %s and run history is gone', (status) => {
        const rows = [row('before', status), row('follow', 'planning', ['before']), row('unlinked', 'idea')];
        expect(project(rows)).toEqual([expect.objectContaining({
            taskId: 'follow', lane: 'waiting', waitingOn: [], autoStart: false, taskVersion: 12,
        })]);
    });

    test('keeps cross-project successor links after completion with no unfinished dependency claim', () => {
        const rows = [row('before', 'completed', [], { successor_id: 'follow', project_id: 'one' }),
            row('follow', 'planning', [], { project_id: 'two' })];
        expect(project(rows)).toEqual([expect.objectContaining({ taskId: 'follow', lane: 'waiting', waitingOn: [], autoStart: true, legacyAutoStart: true })]);
    });

    test.each(['waiting', 'held', 'starting', 'uncertain'])('an explicit %s automatic-start request is visible without a CLI queue claim', (state) => {
        const automaticStart = request(state);
        const items = project([row('follow', 'planning')], { automaticStarts: [automaticStart] });
        expect(items).toEqual([expect.objectContaining({
            taskId: 'follow', lane: 'waiting', autoStart: true, automaticStart, taskVersion: 12,
        })]);
        expect(items[0].position).toBeUndefined();
        expect(items[0].startedAt).toBeUndefined();
    });

    test.each(['cancelled'])('%s registry history does not expose unrelated backlog or claim auto-start', (state) => {
        expect(project([row('follow', 'planning')], { automaticStarts: [request(state)] })).toEqual([]);
        const linked = project([row('before', 'completed'), row('follow', 'planning', ['before'])], {
            automaticStarts: [request(state)],
        });
        expect(linked[0]).toMatchObject({ lane: 'waiting', autoStart: false, automaticStart: null });
    });

    test('accepted ownership stays visible without inventing an active run until the board becomes terminal', () => {
        const automaticStart = request('accepted');
        expect(project([row('follow', 'planning')], { automaticStarts: [automaticStart] })).toEqual([
            expect.objectContaining({ lane: 'waiting', autoStart: true, automaticStart }),
        ]);
        for (const status of ['completed', 'done', 'cancelled']) {
            expect(project([row('follow', status)], { automaticStarts: [automaticStart] })).toEqual([]);
        }
    });

    test('legacy ownership survives a cancelled registry request and obeys legacy status rules', () => {
        const rows = [row('before', 'completed', [], { successor_id: 'follow' }), row('follow', 'planning')];
        expect(project(rows, { automaticStarts: [request('cancelled')] })[0]).toMatchObject({
            autoStart: true, legacyAutoStart: true, automaticStart: null,
        });
        rows[1].status = 'active';
        expect(project(rows)[0]).toMatchObject({ autoStart: false, legacyAutoStart: false });
    });

    test('missing and archived incomplete prerequisites remain explicit rather than appearing completed', () => {
        const items = project([
            row('before', 'completed'), row('archived', 'planning', [], { archived_at: '2026-10-08' }),
            row('follow', 'planning', ['before', 'missing', 'archived']),
        ]);
        expect(items[0]).toMatchObject({ taskId: 'follow', lane: 'waiting', waitingOn: [
            { taskId: 'missing', title: 'Missing predecessor (missing)', missing: true, unavailable: true, boardStatus: null },
            { taskId: 'archived', missing: false, unavailable: true, boardStatus: 'planning' },
        ] });
    });

    test('a held retry is prepared despite an older finished attempt, while active QA stays authoritative', () => {
        const rows = [row('follow', 'planning')];
        const executors = {
            automaticStarts: [request('held')],
            runs: [{ taskId: 'follow', kind: 'task', status: 'failed', updatedAt: '2026-10-07T10:00:00Z' }],
        };
        expect(project(rows, executors)[0]).toMatchObject({ lane: 'waiting', automaticStart: { state: 'held' } });
        executors.runs.push({ taskId: 'qa--follow', kind: 'qa', status: 'active' });
        expect(project(rows, executors)[0]).toMatchObject({ lane: 'qa' });
    });

    test('real queue and running lanes win over automatic-start waiting state', () => {
        const items = project([row('follow', 'planning'), row('running', 'active')], {
            automaticStarts: [request('waiting'), request('starting', 'running')],
            cliQueue: [{ taskId: 'follow' }, { taskId: 'running' }],
            runs: [{ taskId: 'running', kind: 'task', status: 'active', executor: 'codex' }],
        });
        expect(items.find(i => i.taskId === 'follow')).toMatchObject({ lane: 'queued', position: 1, autoStart: true });
        expect(items.find(i => i.taskId === 'running')).toMatchObject({ lane: 'running', autoStart: true });
    });

    test('completed, cancelled and archived follow-ups remain excluded even with automatic-start records', () => {
        const rows = [row('before', 'completed'), row('done', 'completed', ['before']),
            row('cancelled', 'cancelled', ['before']), row('archived', 'planning', ['before'], { archived_at: '2026-10-08' })];
        expect(project(rows, { automaticStarts: rows.slice(1).map(r => request('held', r.id)) })).toEqual([]);
    });
});

test('approved-plan retryable successor survives an old failed run while live QA retains precedence', () => {
    const rows = [{ id: 'retry', name: 'Retry follow-up', status: 'todo', dependencies: '["today"]' },
        { id: 'today', name: 'Today', status: 'completed', dependencies: '[]' }];
    const scope = new Map([['retry', [{ taskId: 'today', title: 'Today' }]]]);
    const state = { executors: { runs: [{ taskId: 'retry', kind: 'task', status: 'failed', updatedAt: '2026-10-08T12:00:00Z' }] } };
    const items = createDispatchInsightRouter.projectLiveWork(state, rows, scope);
    expect(items[0]).toMatchObject({ taskId: 'retry', lane: 'waiting', followsToday: [{ taskId: 'today', title: 'Today' }] });
    expect(items[0].finishedAt).toBeUndefined();
    state.executors.runs.push({ taskId: 'qa--retry', kind: 'qa', status: 'active' });
    expect(createDispatchInsightRouter.projectLiveWork(state, rows, scope)[0].lane).toBe('qa');
});

describe('background evidence holds', () => {
    const project = createDispatchInsightRouter.projectLiveWork;
    const run = { taskId: 'held', kind: 'task', status: 'active', phase: 'completing', attemptId: 'attempt-new', startedAt: '2026-10-10T18:53:00Z', updatedAt: '2026-10-10T19:44:40Z' };
    const hold = { taskId: 'held', executionId: 'execution-new', currentExecution: true, state: 'held', detail: 'Held for background evidence: Artifact is not fresh: /tmp/gr-browser-1.txt', updatedAt: '2026-10-10T19:45:00Z' };
    test('a current execution evidence hold replaces the completing run with waiting and its reason', () => {
        const [item] = project({ executors: { runs: [run], backgroundObligations: [hold] } }, [{ id: 'held', status: 'in_progress' }]);
        expect(item).toMatchObject({ lane: 'waiting', statusMessage: hold.detail, updatedAt: hold.updatedAt, backgroundObligation: { state: 'held', executionId: hold.executionId, detail: hold.detail } });
    });
    test.each([{ currentExecution: false }, { currentExecution: undefined }, { state: 'continued' }, { state: 'abandoned' }])('ignores stale or settled obligations: %j', (change) => {
        const [item] = project({ executors: { runs: [run], backgroundObligations: [{ ...hold, ...change }] } }, [{ id: 'held', status: 'in_progress' }]);
        expect(item.lane).toBe('running');
    });
    test('an obligation registered while the parent still executes does not hide its active work', () => {
        const [item] = project({ executors: { runs: [{ ...run, phase: 'executing' }], backgroundObligations: [{ ...hold, state: 'waiting' }] } }, [{ id: 'held', status: 'in_progress' }]);
        expect(item.lane).toBe('running');
    });
});
