/**
 * Tests for the dispatch eligibility + containment route
 * (server/routes/dispatch-insight.js): per-task "why not running" reasons,
 * per-run ceilings/cost/verdicts from a fixture spine, and the kill relay.
 * Uses temp SQLite files and a fake Praxis server — the live board DB and
 * the real Praxis daemon are never touched.
 */
const express = require('express');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const Database = require('better-sqlite3');

const createDispatchesRouter = require('../routes/dispatches');
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
            const { port } = server.address();
            resolve({ server, sockets, baseUrl: `http://127.0.0.1:${port}` });
        });
    });
}

function close(handle) {
    if (!handle) return Promise.resolve();
    for (const socket of handle.sockets) socket.destroy();
    return new Promise((resolve) => handle.server.close(resolve));
}

async function requestJson(url, options = {}) {
    const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...options });
    return { status: res.status, body: await res.json() };
}

const HOUR = 3600_000;

function seedBoard(dbPath) {
    const db = new Database(dbPath);
    db.exec(`
        CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT, status TEXT);
        CREATE TABLE IF NOT EXISTS tasks (
            id TEXT PRIMARY KEY, project_id TEXT, name TEXT, status TEXT,
            priority INTEGER DEFAULT 0, dependencies TEXT DEFAULT '[]',
            default_executor TEXT, metadata TEXT DEFAULT '{}', archived_at TEXT
        );
    `);
    const proj = db.prepare('INSERT INTO projects (id, name, status) VALUES (?, ?, ?)');
    proj.run('proj-1', 'Active Project', 'active');
    proj.run('proj-2', 'Parked Project', 'parked');
    const task = db.prepare(`
        INSERT INTO tasks (id, project_id, name, status, dependencies, default_executor, metadata, archived_at)
        VALUES (@id, @project_id, @name, @status, @dependencies, @default_executor, @metadata, @archived_at)
    `);
    const base = { project_id: 'proj-1', dependencies: '[]', default_executor: null, metadata: '{}', archived_at: null };
    task.run({ ...base, id: 'task-done', name: 'Done predecessor', status: 'completed' });
    task.run({ ...base, id: 'task-open', name: 'Open predecessor', status: 'idea' });
    task.run({ ...base, id: 'task-gated', name: 'Gated by predecessor', status: 'todo', dependencies: '["task-open","task-done"]' });
    task.run({ ...base, id: 'task-queued', name: 'Queued task', status: 'todo' });
    task.run({ ...base, id: 'task-codex', name: 'Codex task', status: 'todo', default_executor: 'codex' });
    task.run({ ...base, id: 'task-free', name: 'Free task', status: 'todo' });
    task.run({ ...base, id: 'task-parked', name: 'Parked-project task', status: 'todo', project_id: 'proj-2' });
    // Board metadata carries a decoy timeoutMs: Praxis never propagates it
    // into the execution request, so the insight route must ignore it.
    task.run({ ...base, id: 'task-running', name: 'Running task', status: 'in_progress', metadata: '{"timeoutMs": 999999999}' });
    task.run({ ...base, id: 'task-archived', name: 'Archived task', status: 'todo', archived_at: '2026-01-01T00:00:00Z' });
    db.close();
}

function seedSpine(spinePath, { taskId, startedIso, verdictIso }) {
    const db = new Database(spinePath);
    db.exec(`
        CREATE TABLE IF NOT EXISTS run_events (
            seq INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, task_id TEXT NOT NULL,
            executor TEXT, kind TEXT, type TEXT NOT NULL, phase TEXT, outcome TEXT,
            title TEXT, workspace TEXT, summary TEXT, data TEXT
        );
    `);
    const ins = db.prepare(`
        INSERT INTO run_events (ts, task_id, executor, type, phase, summary, data)
        VALUES (@ts, @task_id, @executor, @type, @phase, @summary, @data)
    `);
    ins.run({
        ts: startedIso, task_id: taskId, executor: 'claude-code', type: 'dispatched',
        phase: null, summary: null, data: '{"estimated_minutes": 45}',
    });
    ins.run({
        ts: verdictIso, task_id: taskId, executor: 'claude-code', type: 'verification',
        phase: 'verified', summary: 'self-verification declared; QA pass',
        data: JSON.stringify({
            verdict: 'verified',
            basis: ['self-verification declared', 'independent audit: QA pass by codex'],
            qa: { outcome: 'pass', reviewer: 'codex', author: 'claude-code' },
        }),
    });
    db.close();
}

/**
 * Fake Praxis: configurable dispatch-state, plus an agent-tool recorder that
 * exists purely to PROVE the kill path never invokes Praxis tools — the real
 * antigravity_abort performs global presence/extension cleanup and must not
 * be used as a kill substitute.
 */
function fakePraxis(state) {
    const app = express();
    app.use(express.json());
    const agentToolCalls = [];
    app.get('/api/dispatch/state', (_req, res) => res.json(state.current));
    app.post('/agent-tool', (req, res) => {
        agentToolCalls.push(req.body);
        res.json({ ok: true, result: 'should never be called by dispatch-insight' });
    });
    return { app, agentToolCalls };
}

const DISPATCH_STATE_BUSY = {
    executors: {
        runs: [{
            taskId: 'task-running', executor: 'claude-code', title: 'Running task',
            kind: 'task', phase: 'executing', status: 'active', startedAt: '2026-07-27T10:00:00.000Z',
        }],
        cliQueue: [{ taskId: 'task-queued', title: 'Queued task', executor: 'claude-code', enqueuedAt: '2026-07-27T10:05:00.000Z' }],
        health: {
            codex: { strikes: 3, suspendedUntil: new Date(Date.now() + 2 * HOUR).toISOString(), lastStrikeReason: 'usage limit' },
            'claude-code': { strikes: 0 },
        },
        incidents: {
            codex: [{ at: '2026-07-27T09:00:00.000Z', label: 'silent-token-exhaustion', source: 'executor-health', reason: 'usage limit hit' }],
        },
    },
};

describe('dispatch-insight route', () => {
    let tmpDir;
    let praxisHandle;
    let handle;
    let agentToolCalls;
    let dbPath;
    let praxisState;
    let scratchPids = [];

    async function boot({
        state = DISPATCH_STATE_BUSY,
        praxisUp = true,
        spine = true,
        detachedRecord = null,
    } = {}) {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-insight-'));
        dbPath = path.join(tmpDir, 'test.db');
        seedBoard(dbPath);

        const detachedRunsDir = path.join(tmpDir, 'detached-runs');
        fs.mkdirSync(detachedRunsDir);
        if (detachedRecord) {
            fs.writeFileSync(
                path.join(detachedRunsDir, `${detachedRecord.taskId}.json`),
                JSON.stringify(detachedRecord, null, 2),
            );
        }

        // All spine timestamps are relative to now so run/verdict ordering is
        // stable no matter when the suite runs: dispatched 4h ago, verdict
        // 2.5h ago — i.e. the verdict follows the completed run seeded in the
        // insight test (started 4h ago) and predates the running one (2h ago).
        const spinePath = path.join(tmpDir, 'spine.db');
        if (spine) {
            seedSpine(spinePath, {
                taskId: 'task-running',
                startedIso: new Date(Date.now() - 4 * HOUR).toISOString(),
                verdictIso: new Date(Date.now() - 2.5 * HOUR).toISOString(),
            });
        }

        let praxisUrl = 'http://127.0.0.1:9'; // unroutable → unreachable
        agentToolCalls = [];
        praxisState = { current: state };
        if (praxisUp) {
            const fake = fakePraxis(praxisState);
            praxisHandle = await listen(fake.app);
            praxisUrl = praxisHandle.baseUrl;
            agentToolCalls = fake.agentToolCalls;
        }

        const app = express();
        app.use(express.json());
        // The dispatches router owns the task_dispatches schema — construct it
        // first so the insight router reads the real table shape.
        app.use('/api/dispatches', createDispatchesRouter({ dbPath }));
        app.use('/api/dispatch-insight', createDispatchInsightRouter({
            dbPath,
            spineDbPath: spinePath,
            detachedRunsDir,
            praxisUrl,
            killWait: { graceMs: 500, pollMs: 25 },
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
        // Reap any scratch process a test left alive (refusal-path fixtures).
        for (const pid of scratchPids) {
            try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
            try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
        }
        scratchPids = [];
    });

    test('eligibility explains each waiting task with the first blocking gate', async () => {
        await boot();
        const { status, body } = await requestJson(`${handle.baseUrl}/api/dispatch-insight/eligibility`);
        expect(status).toBe(200);
        expect(body.praxis.reachable).toBe(true);

        const byId = Object.fromEntries(body.tasks.map((t) => [t.taskId, t]));
        expect(byId['task-gated'].reason.code).toBe('predecessors_incomplete');
        expect(byId['task-gated'].reason.detail).toContain('Open predecessor');
        expect(byId['task-gated'].reason.detail).not.toContain('Done predecessor');
        expect(byId['task-queued'].reason.code).toBe('queued');
        // codex suspended but claude-code available → Praxis reroutes, so the
        // suspension is a note, not the blocker; the slot is what blocks.
        expect(byId['task-codex'].reason.code).toBe('cli_slot_busy');
        expect(byId['task-codex'].note).toContain('reroutes this dispatch to claude-code');
        expect(byId['task-free'].reason.code).toBe('cli_slot_busy');
        expect(byId['task-free'].reason.detail).toContain('Running task');
        expect(byId['task-parked'].reason.code).toBe('project_dormant');
        // In-flight, done, and archived tasks are not "waiting" and never listed.
        expect(byId['task-running']).toBeUndefined();
        expect(byId['task-done']).toBeUndefined();
        expect(byId['task-archived']).toBeUndefined();

        expect(body.containment.cliSlot.busy).toBe(true);
        expect(body.containment.cliSlot.holder.taskId).toBe('task-running');
        expect(body.containment.queue[0]).toMatchObject({ taskId: 'task-queued', position: 1 });
        expect(body.containment.incidents[0].label).toBe('silent-token-exhaustion');
    });

    test('eligibility marks tasks eligible when no gate blocks them', async () => {
        const idleState = { executors: { runs: [], cliQueue: [], health: {}, incidents: {} } };
        await boot({ state: idleState });
        const { body } = await requestJson(`${handle.baseUrl}/api/dispatch-insight/eligibility`);
        const byId = Object.fromEntries(body.tasks.map((t) => [t.taskId, t]));
        expect(byId['task-free'].eligible).toBe(true);
        expect(byId['task-free'].reason).toBeNull();
        // Board-derived gates still apply without containment pressure.
        expect(byId['task-gated'].reason.code).toBe('predecessors_incomplete');
        expect(byId['task-parked'].reason.code).toBe('project_dormant');
    });

    test('a suspended preferred executor reroutes instead of blocking (planSuspendedDispatch mirror)', async () => {
        await boot({
            state: {
                executors: {
                    runs: [], cliQueue: [], incidents: {},
                    health: { codex: { strikes: 3, suspendedUntil: new Date(Date.now() + HOUR).toISOString() } },
                },
            },
        });
        const { body } = await requestJson(`${handle.baseUrl}/api/dispatch-insight/eligibility`);
        const byId = Object.fromEntries(body.tasks.map((t) => [t.taskId, t]));
        expect(byId['task-codex'].eligible).toBe(true);
        expect(byId['task-codex'].reason).toBeNull();
        expect(byId['task-codex'].note).toContain('reroutes this dispatch to claude-code');
    });

    test('executor_suspended blocks only when every worker circuit is open', async () => {
        const until = new Date(Date.now() + HOUR).toISOString();
        await boot({
            state: {
                executors: {
                    runs: [], cliQueue: [], incidents: {},
                    health: {
                        'claude-code': { strikes: 3, suspendedUntil: until },
                        codex: { strikes: 3, suspendedUntil: until, lastStrikeReason: 'usage limit' },
                        antigravity: { strikes: 3, suspendedUntil: until },
                    },
                },
            },
        });
        const { body } = await requestJson(`${handle.baseUrl}/api/dispatch-insight/eligibility`);
        const byId = Object.fromEntries(body.tasks.map((t) => [t.taskId, t]));
        expect(byId['task-codex'].reason.code).toBe('executor_suspended');
        expect(byId['task-codex'].reason.detail).toContain('Every worker');
        expect(byId['task-free'].reason.code).toBe('executor_suspended');
    });

    test('eligibility reports unknown (never eligible) when Praxis is down', async () => {
        await boot({ praxisUp: false });
        const { status, body } = await requestJson(`${handle.baseUrl}/api/dispatch-insight/eligibility`);
        expect(status).toBe(200);
        expect(body.praxis.reachable).toBe(false);
        expect(body.containment).toBeNull();
        const byId = Object.fromEntries(body.tasks.map((t) => [t.taskId, t]));
        // Board-derived reasons survive; containment-dependent tasks read unknown.
        expect(byId['task-gated'].reason.code).toBe('predecessors_incomplete');
        expect(byId['task-free'].reason.code).toBe('praxis_unreachable');
        expect(byId['task-free'].eligible).toBe(false);
    });

    test('task insight reports ceiling, cost, verdict, guardrails, and kill state', async () => {
        // The live detached-run record carries the enforcer's REAL 60s
        // ceiling; the board row's decoy metadata (999999999) must be ignored.
        await boot({
            detachedRecord: {
                taskId: 'task-running',
                executor: 'claude-code',
                startedAt: new Date(Date.now() - 2 * HOUR).toISOString(),
                timeoutMs: 60_000,
            },
        });
        // A running row (old enough to be overdue vs the record's 60s
        // ceiling) and a completed row with real token telemetry. Timestamps
        // align with the spine fixture: disp-old (4h → 3h ago) precedes the
        // verdict (2.5h ago), disp-running (2h ago) postdates it.
        await requestJson(`${handle.baseUrl}/api/dispatches`, {
            method: 'POST',
            body: JSON.stringify({
                id: 'disp-running', task_id: 'task-running', executor: 'claude-code',
                model: 'claude-opus-5', started_at: new Date(Date.now() - 2 * HOUR).toISOString(),
            }),
        });
        await requestJson(`${handle.baseUrl}/api/dispatches`, {
            method: 'POST',
            body: JSON.stringify({
                id: 'disp-old', task_id: 'task-running', executor: 'claude-code',
                model: 'claude-opus-5', started_at: new Date(Date.now() - 4 * HOUR).toISOString(),
            }),
        });
        await requestJson(`${handle.baseUrl}/api/dispatches/disp-old`, {
            method: 'PATCH',
            body: JSON.stringify({
                outcome: 'success', tokens: 1_000_000, completed_at: new Date(Date.now() - 3 * HOUR).toISOString(),
            }),
        });

        const { status, body } = await requestJson(`${handle.baseUrl}/api/dispatch-insight/task/task-running`);
        expect(status).toBe(200);
        // Task-level ceiling = the live run's real ceiling (governance strip).
        expect(body.ceiling).toEqual({ ms: 60_000, source: 'praxis_run_record' });
        expect(body.scheduleEstimateMinutes).toBe(45);
        expect(body.spineAvailable).toBe(true);
        expect(body.latestVerification.verdict).toBe('verified');
        expect(body.latestVerification.qa).toMatchObject({ outcome: 'pass', reviewer: 'codex' });

        const byId = Object.fromEntries(body.runs.map((r) => [r.dispatchId, r]));
        expect(byId['disp-running'].canKill).toBe(true);
        expect(byId['disp-running'].overdue).toBe(true); // 2h elapsed > the record's 60s ceiling
        // Per-run attribution: the record's real ceiling belongs ONLY to the
        // live run it describes; the historical run's true ceiling was never
        // persisted, so it reads as the assumed default — never the record's.
        expect(byId['disp-running'].ceiling).toEqual({ ms: 60_000, source: 'praxis_run_record' });
        expect(byId['disp-old'].ceiling).toEqual({ ms: 3 * HOUR, source: 'default_assumed' });
        expect(byId['disp-old'].canKill).toBe(false);
        expect(byId['disp-old'].overdue).toBe(false);
        // 1M tokens of opus-5 at the cache-aware blended notional rate:
        // 5 × 0.205 + 25 × 0.05 = $2.275, flagged as an estimate.
        expect(byId['disp-old'].cost).toEqual({ usd: 2.275, estimated: true });
        expect(byId['disp-running'].cost).toBeNull(); // no tokens yet
        // The verification record (2.5h ago) lands on the run it followed:
        // disp-old started before it, and disp-running started after it.
        expect(byId['disp-old'].verification?.verdict).toBe('verified');
        expect(byId['disp-running'].verification).toBeNull();
    });

    test('task insight falls back to the assumed default ceiling without a run record', async () => {
        await boot();
        // task-running has a running row AND decoy board metadata, but no
        // detached-run record in this boot — the only honest answer is the
        // assumed default, never the board metadata.
        await requestJson(`${handle.baseUrl}/api/dispatches`, {
            method: 'POST',
            body: JSON.stringify({ id: 'disp-run2', task_id: 'task-running', executor: 'claude-code' }),
        });
        const { body } = await requestJson(`${handle.baseUrl}/api/dispatch-insight/task/task-running`);
        expect(body.ceiling).toEqual({ ms: 3 * HOUR, source: 'default_assumed' });
        expect(body.runs[0].ceiling).toEqual({ ms: 3 * HOUR, source: 'default_assumed' });
        expect(body.runs[0].overdue).toBe(false);
    });

    // A real disposable process group, faithful to a detached run's shape: a
    // /bin/sh wrapper leading its own group, running a MULTI-line script
    // (like buildWrapperScript's "cmd; echo $? > done") so the shell cannot
    // exec-replace itself and its command line keeps the /bin/sh prefix that
    // the route's identity check verifies. Tracked for afterEach cleanup.
    function spawnScratchRun() {
        const child = spawn('/bin/sh', ['-c', 'sleep 30\nsleep 1'], { detached: true, stdio: 'ignore' });
        child.unref();
        scratchPids.push(child.pid);
        return child.pid;
    }

    function pidAlive(pid) {
        try { process.kill(pid, 0); return true; } catch { return false; }
    }

    function groupAlive(pgid) {
        try { process.kill(-pgid, 0); return true; } catch { return false; }
    }

    // The failure mode QA flagged: a group whose LEADER dies on SIGTERM while
    // a TERM-resistant child survives. The backgrounded subshell ignores TERM
    // and its exec'd sleep inherits the SIG_IGN disposition, so a group
    // SIGTERM kills the /bin/sh leader and the foreground sleep but leaves
    // the subshell chain alive in the same group.
    function spawnTermResistantRun() {
        const child = spawn(
            '/bin/sh',
            ['-c', '( trap "" TERM; sleep 30 ) &\nsleep 30\nsleep 1'],
            { detached: true, stdio: 'ignore' },
        );
        child.unref();
        scratchPids.push(child.pid);
        return child.pid;
    }

    test('kill signals the recorded process group and closes rows only after confirmed death', async () => {
        const pid = spawnScratchRun();
        await boot({
            detachedRecord: {
                taskId: 'task-running', executor: 'claude-code', pid, bin: '/bin/sh',
                startedAt: new Date().toISOString(), timeoutMs: 60_000,
            },
        });
        await requestJson(`${handle.baseUrl}/api/dispatches`, {
            method: 'POST',
            body: JSON.stringify({ id: 'disp-kill', task_id: 'task-running', executor: 'claude-code' }),
        });

        const { status, body } = await requestJson(`${handle.baseUrl}/api/dispatch-insight/kill`, {
            method: 'POST',
            body: JSON.stringify({ taskId: 'task-running' }),
        });
        expect(status).toBe(200);
        expect(body.ok).toBe(true);
        expect(body.cancelled).toBe(true);
        expect(['sigterm', 'sigkill']).toContain(body.method);
        expect(body.closedDispatches).toBe(1);
        expect(pidAlive(pid)).toBe(false); // the process is genuinely dead
        expect(agentToolCalls).toEqual([]); // antigravity_abort is never invoked

        const list = await requestJson(`${handle.baseUrl}/api/dispatches?task_id=task-running`);
        expect(list.body.dispatches[0].outcome).toBe('cancelled');
        expect(list.body.dispatches[0].error).toContain('death confirmed');
    });

    test('kill confirms GROUP death: a TERM-resistant child forces SIGKILL escalation before rows close', async () => {
        const pid = spawnTermResistantRun();
        await boot({
            detachedRecord: {
                taskId: 'task-running', executor: 'claude-code', pid, bin: '/bin/sh',
                startedAt: new Date().toISOString(), timeoutMs: 60_000,
            },
        });
        await requestJson(`${handle.baseUrl}/api/dispatches`, {
            method: 'POST',
            body: JSON.stringify({ id: 'disp-resist', task_id: 'task-running', executor: 'claude-code' }),
        });

        const { status, body } = await requestJson(`${handle.baseUrl}/api/dispatch-insight/kill`, {
            method: 'POST',
            body: JSON.stringify({ taskId: 'task-running' }),
        });
        expect(status).toBe(200);
        expect(body.cancelled).toBe(true);
        // SIGTERM killed the leader but not the resistant child, so the route
        // must have seen the group still alive and escalated — a leader-only
        // death check would have returned 'sigterm' with a survivor running.
        expect(body.method).toBe('sigkill');
        expect(body.closedDispatches).toBe(1);
        expect(groupAlive(pid)).toBe(false); // the WHOLE group is dead

        const list = await requestJson(`${handle.baseUrl}/api/dispatches?task_id=task-running`);
        expect(list.body.dispatches[0].outcome).toBe('cancelled');
        expect(list.body.dispatches[0].error).toContain('full group death confirmed');
    });

    test('kill refuses when the live process no longer matches the run record (pid reuse guard)', async () => {
        const pid = spawnScratchRun();
        await boot({
            detachedRecord: {
                taskId: 'task-running', executor: 'claude-code', pid,
                bin: '/definitely/not/this/binary',
                startedAt: new Date().toISOString(), timeoutMs: 60_000,
            },
        });
        await requestJson(`${handle.baseUrl}/api/dispatches`, {
            method: 'POST',
            body: JSON.stringify({ id: 'disp-mismatch', task_id: 'task-running', executor: 'claude-code' }),
        });

        const { status, body } = await requestJson(`${handle.baseUrl}/api/dispatch-insight/kill`, {
            method: 'POST',
            body: JSON.stringify({ taskId: 'task-running' }),
        });
        expect(status).toBe(409);
        expect(body.cancelled).toBe(false);
        expect(body.error).toContain('recycled');
        expect(pidAlive(pid)).toBe(true); // never signalled

        const list = await requestJson(`${handle.baseUrl}/api/dispatches?task_id=task-running`);
        expect(list.body.dispatches[0].outcome).toBe('running');
    });

    test('kill refuses an active run it has no record to target', async () => {
        // Praxis's registry shows the run active but no detached-run record
        // exists — there is nothing safe to signal, and no broad-brush tool
        // (antigravity_abort) may be substituted.
        await boot();
        await requestJson(`${handle.baseUrl}/api/dispatches`, {
            method: 'POST',
            body: JSON.stringify({ id: 'disp-notarget', task_id: 'task-running', executor: 'claude-code' }),
        });

        const { status, body } = await requestJson(`${handle.baseUrl}/api/dispatch-insight/kill`, {
            method: 'POST',
            body: JSON.stringify({ taskId: 'task-running' }),
        });
        expect(status).toBe(409);
        expect(body.cancelled).toBe(false);
        expect(body.error).toContain('no detached-run record');
        expect(agentToolCalls).toEqual([]);

        const list = await requestJson(`${handle.baseUrl}/api/dispatches?task_id=task-running`);
        expect(list.body.dispatches[0].outcome).toBe('running');
    });

    test('kill cleans up a ghost row without touching Praxis tools', async () => {
        // A dispatch row stuck at 'running' after an executor crash: no
        // process, no record, no active registry run — closing the row is
        // honest bookkeeping, and still no antigravity_abort.
        await boot({ state: { executors: { runs: [], cliQueue: [], health: {}, incidents: {} } } });
        await requestJson(`${handle.baseUrl}/api/dispatches`, {
            method: 'POST',
            body: JSON.stringify({ id: 'disp-ghost', task_id: 'task-free', executor: 'claude-code' }),
        });

        const { status, body } = await requestJson(`${handle.baseUrl}/api/dispatch-insight/kill`, {
            method: 'POST',
            body: JSON.stringify({ taskId: 'task-free' }),
        });
        expect(status).toBe(200);
        expect(body.cancelled).toBe(true);
        expect(body.method).toBe('ghost_cleanup');
        expect(body.closedDispatches).toBe(1);
        expect(agentToolCalls).toEqual([]);
    });

    test('kill leaves rows open and returns 502 when Praxis is unreachable', async () => {
        await boot({ praxisUp: false });
        await requestJson(`${handle.baseUrl}/api/dispatches`, {
            method: 'POST',
            body: JSON.stringify({ id: 'disp-stay', task_id: 'task-running', executor: 'claude-code' }),
        });

        const { status } = await requestJson(`${handle.baseUrl}/api/dispatch-insight/kill`, {
            method: 'POST',
            body: JSON.stringify({ taskId: 'task-running' }),
        });
        expect(status).toBe(502);

        const list = await requestJson(`${handle.baseUrl}/api/dispatches?task_id=task-running`);
        expect(list.body.dispatches[0].outcome).toBe('running');
    });

    test('kill validates the task id', async () => {
        await boot();
        const { status } = await requestJson(`${handle.baseUrl}/api/dispatch-insight/kill`, {
            method: 'POST',
            body: JSON.stringify({}),
        });
        expect(status).toBe(400);
    });
});
