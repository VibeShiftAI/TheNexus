/**
 * Tests for the task dispatch-history route (server/routes/dispatches.js):
 * open → close by id, close-open (the AG /callback path), listing, and
 * validation of outcomes/kinds. Uses a temp SQLite file so the live board DB
 * is never touched.
 */
const express = require('express');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const createDispatchesRouter = require('../routes/dispatches');

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
    for (const socket of handle.sockets) socket.destroy();
    return new Promise((resolve) => handle.server.close(resolve));
}

async function requestJson(url, options = {}) {
    const res = await fetch(url, {
        headers: { 'Content-Type': 'application/json' },
        ...options,
    });
    return { status: res.status, body: await res.json() };
}

describe('dispatches route', () => {
    let handle;
    let tmpDir;

    beforeEach(async () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-dispatches-'));
        const app = express();
        app.use(express.json());
        app.use('/api/dispatches', createDispatchesRouter({ dbPath: path.join(tmpDir, 'test.db') }));
        handle = await listen(app);
    });

    afterEach(async () => {
        if (handle) await close(handle);
        handle = null;
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('records a dispatch, closes it by id, and lists it', async () => {
        const created = await requestJson(`${handle.baseUrl}/api/dispatches`, {
            method: 'POST',
            body: JSON.stringify({
                task_id: 'task-1',
                executor: 'claude-code',
                model: 'claude-opus-4-8',
                prompt: '# Nexus Task task-1: do the thing',
                workspace: '/tmp/ws',
            }),
        });
        expect(created.status).toBe(201);
        const id = created.body.id;
        expect(id).toBeTruthy();

        const patched = await requestJson(`${handle.baseUrl}/api/dispatches/${id}`, {
            method: 'PATCH',
            body: JSON.stringify({
                outcome: 'success',
                output: 'Shipped it.',
                session_id: 'sess-abc',
            }),
        });
        expect(patched.status).toBe(200);

        const listed = await requestJson(`${handle.baseUrl}/api/dispatches?task_id=task-1`);
        expect(listed.status).toBe(200);
        expect(listed.body.dispatches).toHaveLength(1);
        const row = listed.body.dispatches[0];
        expect(row.outcome).toBe('success');
        expect(row.output).toBe('Shipped it.');
        expect(row.session_id).toBe('sess-abc');
        expect(row.completed_at).toBeTruthy();
        expect(row.kind).toBe('dispatch');
    });

    test('persists token counts on create and completion, and exposes them via listRecentDispatches', async () => {
        // tokens can arrive at dispatch start...
        const created = await requestJson(`${handle.baseUrl}/api/dispatches`, {
            method: 'POST',
            body: JSON.stringify({
                task_id: 'task-tok', project_id: 'proj-tok', executor: 'codex',
                model: 'gpt-5-codex', tokens: '12,000',
            }),
        });
        expect(created.status).toBe(201);

        // ...or be updated at completion (COALESCE keeps the larger final count).
        const patched = await requestJson(`${handle.baseUrl}/api/dispatches/${created.body.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ outcome: 'success', tokens: 34567 }),
        });
        expect(patched.status).toBe(200);

        const listed = await requestJson(`${handle.baseUrl}/api/dispatches?task_id=task-tok`);
        expect(listed.body.dispatches[0].tokens).toBe(34567);

        // The in-process reader used by the activity feed returns the row.
        const router = createDispatchesRouter({ dbPath: path.join(tmpDir, 'test.db') });
        const recent = router.listRecentDispatches(50);
        const row = recent.find((d) => d.project_id === 'proj-tok');
        expect(row).toBeTruthy();
        expect(row.model).toBe('gpt-5-codex');
        expect(row.tokens).toBe(34567);
        expect(row.tokens_estimated).toBe(0); // exact count → not flagged as estimated
    });

    test('listRecentDispatches resolves project_id from the owning task when the dispatch omits it', async () => {
        // Real Claude dispatch rows routinely ship without a project_id; the
        // reader must recover it from the task so the activity feed can still
        // bucket the row into the right project instead of dropping it.
        const seed = new Database(path.join(tmpDir, 'test.db'));
        seed.exec('CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, name TEXT, project_id TEXT)');
        seed.prepare('INSERT INTO tasks (id, name, project_id) VALUES (?, ?, ?)')
            .run('task-noproj', 'Do the thing', 'proj-from-task');
        seed.close();

        // Dispatch carries a task_id but NO project_id (the Claude-writer gap).
        const created = await requestJson(`${handle.baseUrl}/api/dispatches`, {
            method: 'POST',
            body: JSON.stringify({ task_id: 'task-noproj', executor: 'claude-code', model: 'claude-opus-4-8' }),
        });
        await requestJson(`${handle.baseUrl}/api/dispatches/${created.body.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ outcome: 'success', tokens: 1000 }),
        });

        const router = createDispatchesRouter({ dbPath: path.join(tmpDir, 'test.db') });
        const recent = router.listRecentDispatches(50);
        const row = recent.find((d) => d.task_id === 'task-noproj');
        expect(row).toBeTruthy();
        expect(row.project_id).toBe('proj-from-task'); // recovered from tasks, not the (null) dispatch column
        expect(row.model).toBe('claude-opus-4-8');
    });

    test('estimates a token count from text volume when the executor reports none', async () => {
        const created = await requestJson(`${handle.baseUrl}/api/dispatches`, {
            method: 'POST',
            body: JSON.stringify({
                task_id: 'task-est', project_id: 'proj-est', executor: 'antigravity',
                prompt: 'p'.repeat(400), // 400 chars
            }),
        });
        // Complete with an 800-char output and no tokens → estimate ~ (400+800)/4 = 300.
        await requestJson(`${handle.baseUrl}/api/dispatches/${created.body.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ outcome: 'success', output: 'o'.repeat(800) }),
        });
        const listed = await requestJson(`${handle.baseUrl}/api/dispatches?task_id=task-est`);
        const row = listed.body.dispatches[0];
        expect(row.tokens).toBe(300);
        expect(row.tokens_estimated).toBe(1);
    });

    test('close-open closes only the latest running row for the task/executor', async () => {
        // Two attempts: the first already closed, the second still running.
        const first = await requestJson(`${handle.baseUrl}/api/dispatches`, {
            method: 'POST',
            body: JSON.stringify({
                task_id: 'task-2', executor: 'antigravity', started_at: '2026-07-06T01:00:00.000Z',
            }),
        });
        await requestJson(`${handle.baseUrl}/api/dispatches/${first.body.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ outcome: 'failure', output: 'died' }),
        });
        const second = await requestJson(`${handle.baseUrl}/api/dispatches`, {
            method: 'POST',
            body: JSON.stringify({
                task_id: 'task-2', executor: 'antigravity', started_at: '2026-07-06T02:00:00.000Z',
            }),
        });

        const closed = await requestJson(`${handle.baseUrl}/api/dispatches/close-open`, {
            method: 'PATCH',
            body: JSON.stringify({
                task_id: 'task-2', executor: 'antigravity', outcome: 'success', output: 'done via callback',
            }),
        });
        expect(closed.status).toBe(200);
        expect(closed.body.closed).toBe(true);
        expect(closed.body.id).toBe(second.body.id);

        // No running rows left — a second close-open is a no-op, not an error.
        const again = await requestJson(`${handle.baseUrl}/api/dispatches/close-open`, {
            method: 'PATCH',
            body: JSON.stringify({ task_id: 'task-2', outcome: 'success' }),
        });
        expect(again.status).toBe(200);
        expect(again.body.closed).toBe(false);

        const listed = await requestJson(`${handle.baseUrl}/api/dispatches?task_id=task-2`);
        const outcomes = listed.body.dispatches.map((d) => d.outcome).sort();
        expect(outcomes).toEqual(['failure', 'success']);
    });

    test('records follow_up rows with parent linkage and session id', async () => {
        const parent = await requestJson(`${handle.baseUrl}/api/dispatches`, {
            method: 'POST',
            body: JSON.stringify({ task_id: 'task-3', executor: 'codex', session_id: 'sess-1' }),
        });
        const followUp = await requestJson(`${handle.baseUrl}/api/dispatches`, {
            method: 'POST',
            body: JSON.stringify({
                task_id: 'task-3',
                executor: 'codex',
                kind: 'follow_up',
                parent_id: parent.body.id,
                session_id: 'sess-1',
                prompt: 'why sqlite?',
            }),
        });
        expect(followUp.status).toBe(201);

        const listed = await requestJson(`${handle.baseUrl}/api/dispatches?task_id=task-3`);
        const fu = listed.body.dispatches.find((d) => d.kind === 'follow_up');
        expect(fu.parent_id).toBe(parent.body.id);
        expect(fu.session_id).toBe('sess-1');
    });

    test('/active returns only running rows, newest first, with task-correlated model and cumulative tokens', async () => {
        // Seed a tasks table so /active can resolve the human-readable title.
        const seed = new Database(path.join(tmpDir, 'test.db'));
        seed.exec("CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, name TEXT)");
        seed.prepare('INSERT INTO tasks (id, name) VALUES (?, ?)').run('task-live', 'Ship the Now strip');
        seed.close();

        // A completed earlier attempt on the same task (contributes 5k tokens)...
        const done = await requestJson(`${handle.baseUrl}/api/dispatches`, {
            method: 'POST',
            body: JSON.stringify({ task_id: 'task-live', executor: 'codex', model: 'gpt-5-codex' }),
        });
        await requestJson(`${handle.baseUrl}/api/dispatches/${done.body.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ outcome: 'success', tokens: 5000 }),
        });
        // ...and the currently-running dispatch (no token count yet).
        await requestJson(`${handle.baseUrl}/api/dispatches`, {
            method: 'POST',
            body: JSON.stringify({ task_id: 'task-live', executor: 'claude-code', model: 'claude-opus-4-8' }),
        });
        // An unrelated running dispatch on another task — must appear separately,
        // never fold its tokens/model into task-live.
        await requestJson(`${handle.baseUrl}/api/dispatches`, {
            method: 'POST',
            body: JSON.stringify({ task_id: 'task-other', executor: 'codex', model: 'gpt-5-codex' }),
        });

        const res = await requestJson(`${handle.baseUrl}/api/dispatches/active`);
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body.active)).toBe(true);
        // Both running dispatches surface; the completed one does not.
        expect(res.body.active).toHaveLength(2);

        const live = res.body.active.find((d) => d.taskId === 'task-live');
        expect(live).toBeTruthy();
        expect(live.title).toBe('Ship the Now strip');
        expect(live.model).toBe('claude-opus-4-8');     // the in-flight row's model, not the other task's
        expect(live.executor).toBe('claude-code');
        expect(live.tokens).toBe(5000);                 // cumulative for THIS task only
        expect(live.tokensEstimated).toBe(false);

        const other = res.body.active.find((d) => d.taskId === 'task-other');
        expect(other.tokens).toBeNull();                // nothing recorded yet → unavailable, not borrowed
        expect(other.model).toBe('gpt-5-codex');
    });

    test('/active hides stale running rows outside the window', async () => {
        // A running row that started 30h ago is a ghost — excluded by the 6h default.
        await requestJson(`${handle.baseUrl}/api/dispatches`, {
            method: 'POST',
            body: JSON.stringify({
                task_id: 'task-ghost', executor: 'antigravity',
                started_at: new Date(Date.now() - 30 * 3600_000).toISOString(),
            }),
        });
        const def = await requestJson(`${handle.baseUrl}/api/dispatches/active`);
        expect(def.body.active).toHaveLength(0);
        // A wide-enough window surfaces it again.
        const wide = await requestJson(`${handle.baseUrl}/api/dispatches/active?hours=48`);
        expect(wide.body.active.some((d) => d.taskId === 'task-ghost')).toBe(true);
    });

    test('validates required fields, outcomes, and kinds', async () => {
        const missing = await requestJson(`${handle.baseUrl}/api/dispatches`, {
            method: 'POST',
            body: JSON.stringify({ executor: 'codex' }),
        });
        expect(missing.status).toBe(400);

        const badKind = await requestJson(`${handle.baseUrl}/api/dispatches`, {
            method: 'POST',
            body: JSON.stringify({ task_id: 't', executor: 'codex', kind: 'nonsense' }),
        });
        expect(badKind.status).toBe(400);

        const created = await requestJson(`${handle.baseUrl}/api/dispatches`, {
            method: 'POST',
            body: JSON.stringify({ task_id: 't', executor: 'codex' }),
        });
        const badOutcome = await requestJson(`${handle.baseUrl}/api/dispatches/${created.body.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ outcome: 'exploded' }),
        });
        expect(badOutcome.status).toBe(400);

        const missingTask = await requestJson(`${handle.baseUrl}/api/dispatches?limit=5`);
        expect(missingTask.status).toBe(400);

        const unknownId = await requestJson(`${handle.baseUrl}/api/dispatches/nope`, {
            method: 'PATCH',
            body: JSON.stringify({ outcome: 'success' }),
        });
        expect(unknownId.status).toBe(404);
    });
});
