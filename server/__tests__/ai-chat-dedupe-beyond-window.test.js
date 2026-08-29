/**
 * Durable chat dedupe BEYOND the row window (round-3 hole).
 *
 * The first durable-dedupe fix looked the answered message up by scanning the
 * active conversation's last 200 rows. That closed the 10-minute TTL window but
 * left a second, quieter one: once 200+ messages have landed since the send, the
 * user row falls out of the scan, the lookup misses, and the route relays to
 * Praxis again — the exact duplicate-agent-run bug of 2026-08-28, just further
 * out. A busy conversation reaches 200 messages in ordinary use, and the mobile
 * retry timer that caused the incident thaws whenever the app is foregrounded.
 *
 * This suite drives the REAL db/index.js over a real (temp) SQLite file and a
 * real HTTP stub standing in for Praxis, and counts relays — a relay IS the
 * agent running. Against the pre-fix row-window implementation the headline
 * test fails with `Received: "AGENT RUN #2"` and relayCount 2; that is what
 * makes it a probe rather than a restatement of the implementation.
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
let prevDbPath;
let prevPraxisUrl;

function listen(server) {
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function startPraxisStub() {
    relayCount = 0;
    const server = http.createServer((req, res) => {
        relayCount += 1;
        const runNumber = relayCount;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ response: `AGENT RUN #${runNumber}` }));
    });
    await listen(server);
    return server;
}

/** A fresh mount is a process that has never seen this id in its join map —
 *  i.e. exactly TTL expiry, and exactly a server restart. jest.isolateModules
 *  is required: jest keeps its OWN module registry, so deleting require.cache
 *  does not reset the route module and the retry would be absorbed by a still-
 *  warm in-memory map, never exercising the durable path. */
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

/** Bury the answered exchange under `count` later messages.
 *  created_at is stamped explicitly and monotonically: saveChatMessage's own
 *  now() is millisecond-granular, so a tight insert loop can emit duplicate
 *  timestamps and make "the last 200 rows" ambiguous. Explicit stamps keep the
 *  window this test depends on deterministic. */
async function buryUnderLaterMessages(conversationId, count) {
    const base = Date.now() + 1000;
    for (let i = 0; i < count; i += 1) {
        await db.saveChatMessage({
            id: `filler-${i}`,
            conversation_id: conversationId,
            role: i % 2 === 0 ? 'user' : 'assistant',
            content: `filler message ${i}`,
            mode: 'praxis',
            created_at: new Date(base + i * 1000).toISOString(),
        });
    }
}

describe('AI chat durable dedupe — answered message beyond the 200-row window', () => {
    beforeAll(async () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-dedupe-window-'));
        praxisStub = await startPraxisStub();
        // Both are read at module-load time, so they must be set before requiring.
        // Jest workers share a process, so these are restored in afterAll.
        prevDbPath = process.env.NEXUS_DB_PATH;
        prevPraxisUrl = process.env.PRAXIS_URL;
        process.env.NEXUS_DB_PATH = path.join(tmpDir, 'window-probe.db');
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

    test('a late retry still returns the stored reply after 205 later messages, and does NOT relay', async () => {
        const clientMessageId = 'local-probe-beyond-window-0001';

        // 1. The original send: the agent runs once and both rows land in SQLite.
        let router = await mountFreshRouter();
        const first = await post(router.url, { message: 'why two notifications?', mode: 'praxis', clientMessageId });
        await router.close();

        expect(first.status).toBe(200);
        expect(first.body.response).toBe('AGENT RUN #1');
        expect(relayCount).toBe(1);

        const conversation = await db.getActiveConversation('praxis');

        // 2. The conversation carries on. 205 later messages push the answered
        //    exchange out of the last-200-row scan the old lookup relied on.
        await buryUnderLaterMessages(conversation.id, 205);

        const window = await db.getChatMessages(conversation.id, { limit: 200 });
        expect(window).toHaveLength(200);
        // Precondition of this test: the row-window scan can no longer see it.
        expect(window.find((m) => m.id === clientMessageId)).toBeUndefined();

        // 3. The backgrounded phone's retry timer finally thaws, long past the
        //    TTL and after a restart — a brand-new, empty join map.
        router = await mountFreshRouter();
        const late = await post(router.url, { message: 'why two notifications?', mode: 'praxis', clientMessageId });
        await router.close();

        expect(late.status).toBe(200);
        // The stored answer comes back — NOT a second "AGENT RUN #2".
        expect(late.body.response).toBe('AGENT RUN #1');
        expect(late.body.replayedFromStore).toBe(true);
        expect(late.body.conversationId).toBe(conversation.id);
        // The discriminating assertion: the agent did not run a second time.
        expect(relayCount).toBe(1);

        // And no duplicate rows were persisted (the incident produced a 2nd reply).
        const after = await db.getChatMessages(conversation.id, { limit: 500 });
        expect(after.filter((m) => m.id === clientMessageId)).toHaveLength(1);
        expect(after.filter((m) => m.role === 'assistant' && m.content.startsWith('AGENT RUN'))).toHaveLength(1);
    }, 30000);

    test('a late retry is found even after the conversation was switched away', async () => {
        const clientMessageId = 'local-probe-switched-conversation-0002';
        const relaysBefore = relayCount;

        let router = await mountFreshRouter();
        const first = await post(router.url, { message: 'sent before switching', mode: 'praxis', clientMessageId });
        await router.close();
        expect(relayCount).toBe(relaysBefore + 1);
        const answer = first.body.response;

        // Robert starts a new conversation; the answered message now lives in a
        // conversation that is no longer active, which the old active-only
        // lookup could not reach at all.
        const fresh = await db.createConversation('praxis', 'A new conversation');
        expect(fresh.id).toBeTruthy();

        router = await mountFreshRouter();
        const late = await post(router.url, { message: 'sent before switching', mode: 'praxis', clientMessageId });
        await router.close();

        expect(late.body.response).toBe(answer);
        expect(late.body.replayedFromStore).toBe(true);
        expect(relayCount).toBe(relaysBefore + 1);
    }, 30000);

    test('an unanswered message in the store still relays — the lookup needs a REPLY, not just the row', async () => {
        const conversation = await db.getActiveConversation('praxis');
        const clientMessageId = 'local-probe-unanswered-0003';
        const relaysBefore = relayCount;

        // A user row with no assistant reply after it: the previous run died
        // before answering, so the retry MUST reach the agent.
        await db.saveChatMessage({
            id: clientMessageId,
            conversation_id: conversation.id,
            role: 'user',
            content: 'never answered',
            mode: 'praxis',
        });

        const router = await mountFreshRouter();
        const retry = await post(router.url, { message: 'never answered', mode: 'praxis', clientMessageId });
        await router.close();

        expect(retry.body.replayedFromStore).toBeUndefined();
        expect(relayCount).toBe(relaysBefore + 1);
    }, 30000);
});
