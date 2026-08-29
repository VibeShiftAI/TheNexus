/**
 * RUNTIME activation probe for the durable chat-dedupe fallback.
 *
 * The sibling suite (ai-chat-durable-dedupe.test.js) mocks `db`, so it pins the
 * route's logic but can never prove the fallback works against the REAL
 * persistence layer. This suite drives the real db/index.js over a real (temp)
 * SQLite file and a real HTTP stub standing in for Praxis, and counts relays:
 * a relay == the Praxis agent running. The 2026-08-28 incident was a second
 * relay for one message, so "relays" is the discriminating measurement.
 *
 * Run against the pre-fix route (QA baseline 52d5fb20e80b) these expectations
 * fail with 2 relays instead of 1 — that is what makes this a probe and not a
 * restatement of the implementation.
 */
const express = require('express');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const nativeFetch = global.fetch;

let tmpDir;
let db;
let praxisStub;
let relayCount;
let holdPraxis = null;
let prevDbPath;
let prevPraxisUrl;

function listen(server) {
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function startPraxisStub() {
    relayCount = 0;
    const server = http.createServer(async (req, res) => {
        relayCount += 1;
        const runNumber = relayCount;
        if (holdPraxis) await holdPraxis;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ response: `AGENT RUN #${runNumber}` }));
    });
    await listen(server);
    return server;
}

/** A fresh mount is a process that has never seen this id in its join map —
 *  i.e. exactly TTL expiry, and exactly a server restart.
 *  jest.isolateModules is required here: jest keeps its OWN module registry, so
 *  `delete require.cache[...]` does NOT reset the route module. Without this the
 *  "restart" retry is silently absorbed by the still-warm in-memory map and the
 *  durable fallback is never exercised — a false green this suite must not have. */
async function mountFreshRouter() {
    let createAIChatRouter;
    jest.isolateModules(() => {
        createAIChatRouter = require('../routes/ai-chat');
    });
    const app = express();
    app.use(express.json());
    app.use('/api/ai/chat', createAIChatRouter({ db, io: { emit: () => {} } }));
    const server = await listen(http.createServer(app));
    return {
        url: `http://127.0.0.1:${server.address().port}/api/ai/chat`,
        close: () => new Promise((resolve) => server.close(resolve)),
    };
}

function post(url, body) {
    return nativeFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    }).then(async (res) => ({ status: res.status, body: await res.json() }));
}

describe('AI chat durable dedupe — real SQLite + real HTTP relay', () => {
    beforeAll(async () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-dedupe-probe-'));
        praxisStub = await startPraxisStub();
        // Both are read at module-load time, so they must be set before requiring.
        // Jest workers share a process, so these are restored in afterAll —
        // otherwise a later suite would silently pick up this throwaway DB.
        prevDbPath = process.env.NEXUS_DB_PATH;
        prevPraxisUrl = process.env.PRAXIS_URL;
        process.env.NEXUS_DB_PATH = path.join(tmpDir, 'probe.db');
        process.env.PRAXIS_URL = `http://127.0.0.1:${praxisStub.address().port}`;
        db = require('../../db'); // real persistence layer, auto-creates the schema
    });

    afterAll(async () => {
        if (praxisStub) await new Promise((resolve) => praxisStub.close(resolve));
        fs.rmSync(tmpDir, { recursive: true, force: true });
        if (prevDbPath === undefined) delete process.env.NEXUS_DB_PATH;
        else process.env.NEXUS_DB_PATH = prevDbPath;
        if (prevPraxisUrl === undefined) delete process.env.PRAXIS_URL;
        else process.env.PRAXIS_URL = prevPraxisUrl;
    });

    test('a late retry after a RESTART returns the persisted reply and runs the agent exactly once', async () => {
        const clientMessageId = 'local-probe-restart-0001';

        // 1. The original send: the agent runs and both rows land in real SQLite.
        let router = await mountFreshRouter();
        const first = await post(router.url, { message: 'why two notifications?', mode: 'praxis', clientMessageId });
        await router.close();

        expect(first.status).toBe(200);
        expect(first.body.response).toBe('AGENT RUN #1');
        expect(relayCount).toBe(1);

        const conversation = await db.getActiveConversation('praxis');
        const afterFirst = await db.getChatMessages(conversation.id, { limit: 50 });
        expect(afterFirst.find((m) => m.id === clientMessageId)).toBeTruthy();
        expect(afterFirst.filter((m) => m.role === 'assistant')).toHaveLength(1);

        // 2. The phone was backgrounded; its retry timer thaws long after the TTL
        //    and the server has restarted meanwhile — a brand-new empty join map.
        router = await mountFreshRouter();
        const late = await post(router.url, { message: 'why two notifications?', mode: 'praxis', clientMessageId });
        await router.close();

        expect(late.status).toBe(200);
        // The stored answer comes back — NOT a second "AGENT RUN #2".
        expect(late.body.response).toBe('AGENT RUN #1');
        expect(late.body.replayedFromStore).toBe(true);
        // The discriminating assertion: the agent did not run again.
        expect(relayCount).toBe(1);

        // And no duplicate rows were persisted (the incident produced a 2nd reply).
        const afterLate = await db.getChatMessages(conversation.id, { limit: 50 });
        expect(afterLate).toHaveLength(afterFirst.length);
        expect(afterLate.filter((m) => m.role === 'assistant')).toHaveLength(1);
    });

    test('a genuinely new message still relays — the fallback never swallows a real send', async () => {
        const relaysBefore = relayCount;
        const router = await mountFreshRouter();
        const fresh = await post(router.url, { message: 'a brand new question', mode: 'praxis', clientMessageId: 'local-probe-fresh-0002' });
        await router.close();

        expect(fresh.status).toBe(200);
        expect(relayCount).toBe(relaysBefore + 1);
        expect(fresh.body.replayedFromStore).toBeUndefined();
    });

    test('the in-memory join still absorbs a retry during a genuinely in-flight run', async () => {
        let release;
        holdPraxis = new Promise((resolve) => { release = resolve; });
        const relaysBefore = relayCount;
        const clientMessageId = 'local-probe-inflight-0003';

        try {
            const router = await mountFreshRouter();
            const body = { message: 'sent from the gym', mode: 'praxis', clientMessageId };
            const first = post(router.url, body);
            await new Promise((resolve) => setTimeout(resolve, 150)); // let run #1 register
            const retry = post(router.url, body);
            await new Promise((resolve) => setTimeout(resolve, 100));
            release();

            const [a, b] = await Promise.all([first, retry]);
            await router.close();

            expect(a.body.response).toBe(b.body.response);
            // One agent run served both connections.
            expect(relayCount).toBe(relaysBefore + 1);
        } finally {
            holdPraxis = null;
        }
    });
});
