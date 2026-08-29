/**
 * Durable dedupe fallback for /api/ai/chat (2026-08-28 incident).
 *
 * The in-memory retry join-map is process-local and TTL-bound (10 min), but
 * the mobile client's retry timers freeze while the app is backgrounded — a
 * re-POST arrived 46 minutes after the send, missed the map, and ran the
 * Praxis agent a second time. These tests pin the durable fallback: when the
 * map misses but the clientMessageId row is already persisted AND an
 * assistant reply follows it, the route returns THAT reply and never relays.
 *
 * Every test here mounts a fresh router via jest.resetModules, so the
 * in-memory map is deliberately empty — simulating both TTL expiry and a
 * server restart.
 */
const express = require('express');
const http = require('http');
const nativeFetch = global.fetch;

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

const CLIENT_MESSAGE_ID = 'local-1787942224009-31mvrlemsd7';

/**
 * A stub shaped like the real db/index.js. `storedMessages` is in insertion
 * order, so an array index stands in for SQLite's rowid — which is exactly how
 * getNextAssistantMessage breaks ties between rows sharing a created_at.
 * The id lookup is whole-table (not a window), mirroring the PRIMARY KEY query.
 */
function createDb(storedMessages) {
    return {
        getActiveConversation: jest.fn(async () => ({ id: 'conversation-1' })),
        getChatMessages: jest.fn(async () => storedMessages),
        getChatMessageById: jest.fn(async (messageId) => {
            const index = storedMessages.findIndex((m) => m.id === messageId);
            return index === -1 ? null : { ...storedMessages[index], rowid: index + 1 };
        }),
        getNextAssistantMessage: jest.fn(async (afterMessage) => storedMessages
            .slice(afterMessage?.rowid ?? 0)
            .find((m) => m.role === 'assistant' && m.conversation_id === afterMessage?.conversation_id) || null),
        saveChatMessage: jest.fn(async (message) => ({ id: message.id || 'message-1', ...message })),
    };
}

describe('AI chat durable dedupe fallback', () => {
    const originalFetch = global.fetch;
    let handle;

    afterEach(async () => {
        if (handle) await close(handle);
        handle = null;
        global.fetch = originalFetch;
        jest.resetModules();
    });

    async function mount(db) {
        const createAIChatRouter = require('../routes/ai-chat');
        const app = express();
        app.use(express.json());
        app.use('/api/ai/chat', createAIChatRouter({ db, io: { emit: jest.fn() } }));
        handle = await listen(app);
    }

    async function post(body) {
        const res = await nativeFetch(`${handle.baseUrl}/api/ai/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        return { status: res.status, body: await res.json() };
    }

    test('a late retry of an already-answered message returns the stored reply and does NOT relay to Praxis', async () => {
        // The join map is empty (fresh module) — the only defense is the store.
        global.fetch = jest.fn(async () => {
            throw new Error('relay must not be called');
        });
        const db = createDb([
            { id: 'older-1', conversation_id: 'conversation-1', role: 'assistant', content: 'an earlier answer' },
            { id: CLIENT_MESSAGE_ID, conversation_id: 'conversation-1', role: 'user', content: 'why two notifications?' },
            { id: 'system-1', conversation_id: 'conversation-1', role: 'system', content: '[PRAXIS EVENT] QA review dispatched' },
            {
                id: 'assistant-1',
                conversation_id: 'conversation-1',
                role: 'assistant',
                content: 'Both come from the same failure, two lines apart.',
                metadata: { voiceData: [{ audio: 'YWJj', mimeType: 'audio/mpeg' }] },
            },
        ]);
        await mount(db);

        const response = await post({ message: 'why two notifications?', mode: 'praxis', clientMessageId: CLIENT_MESSAGE_ID });

        expect(response.status).toBe(200);
        expect(response.body.response).toBe('Both come from the same failure, two lines apart.');
        expect(response.body.assistantMessageId).toBe('assistant-1');
        expect(response.body.replayedFromStore).toBe(true);
        // Stored voice metadata rides along so the replayed answer is complete.
        expect(response.body.voiceData).toEqual([{ audio: 'YWJj', mimeType: 'audio/mpeg' }]);
        // Zero relay calls: the agent must not run a second time.
        expect(global.fetch).not.toHaveBeenCalled();
        // And no duplicate user row is persisted.
        expect(db.saveChatMessage).not.toHaveBeenCalled();
    });

    test('a retry whose message is persisted but NOT yet answered still relays (the original run died with the server)', async () => {
        global.fetch = jest.fn(async () => ({
            ok: true,
            json: async () => ({ response: 'fresh run answer' }),
        }));
        const db = createDb([
            { id: 'older-1', conversation_id: 'conversation-1', role: 'assistant', content: 'answer to something older' },
            { id: CLIENT_MESSAGE_ID, conversation_id: 'conversation-1', role: 'user', content: 'still waiting' },
            { id: 'system-1', conversation_id: 'conversation-1', role: 'system', content: '[PRAXIS EVENT] unrelated card' },
        ]);
        await mount(db);

        const response = await post({ message: 'still waiting', mode: 'praxis', clientMessageId: CLIENT_MESSAGE_ID });

        expect(response.status).toBe(200);
        expect(response.body.response).toBe('fresh run answer');
        expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    test('an assistant message that PRECEDES the user row does not count as its answer', async () => {
        global.fetch = jest.fn(async () => ({
            ok: true,
            json: async () => ({ response: 'the real answer' }),
        }));
        const db = createDb([
            { id: 'assistant-0', conversation_id: 'conversation-1', role: 'assistant', content: 'reply to a previous send' },
            { id: CLIENT_MESSAGE_ID, conversation_id: 'conversation-1', role: 'user', content: 'new question' },
        ]);
        await mount(db);

        const response = await post({ message: 'new question', mode: 'praxis', clientMessageId: CLIENT_MESSAGE_ID });

        expect(response.status).toBe(200);
        expect(response.body.response).toBe('the real answer');
        expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    test('a fresh send (id not in the store) relays normally and a store lookup failure never blocks it', async () => {
        global.fetch = jest.fn(async () => ({
            ok: true,
            json: async () => ({ response: 'normal answer' }),
        }));
        const db = createDb([]);
        db.getChatMessageById.mockRejectedValue(new Error('sqlite locked'));
        const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        try {
            await mount(db);

            const response = await post({ message: 'hello', mode: 'praxis', clientMessageId: 'brand-new-id' });

            expect(response.status).toBe(200);
            expect(response.body.response).toBe('normal answer');
            expect(global.fetch).toHaveBeenCalledTimes(1);
        } finally {
            consoleErrorSpy.mockRestore();
        }
    });

    test('the request log counts uploaded attachments as well as inline files', async () => {
        global.fetch = jest.fn(async () => ({
            ok: true,
            json: async () => ({ response: 'saw the image' }),
        }));
        const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
        try {
            await mount(createDb([]));

            await post({
                message: 'look at this',
                mode: 'praxis',
                files: [{ name: 'notes.txt', content: 'inline text' }],
                attachments: [
                    { url: '/api/chat/files/img-1', mimeType: 'image/png', originalName: 'screen.png' },
                    { url: '/api/chat/files/img-2', mimeType: 'image/jpeg', originalName: 'photo.jpg' },
                ],
            });

            const fileLine = consoleLogSpy.mock.calls
                .map((args) => args.join(' '))
                .find((line) => line.includes('Files:'));
            expect(fileLine).toContain('Files: 3 attached (1 inline, 2 uploaded)');
        } finally {
            consoleLogSpy.mockRestore();
        }
    });
});
