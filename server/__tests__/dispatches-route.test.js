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
