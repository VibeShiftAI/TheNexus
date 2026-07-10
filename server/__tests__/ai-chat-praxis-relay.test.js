/**
 * Pins the 2026-07-02 simplification of /api/ai/chat: the route is a thin
 * relay to Praxis. No mode branching (Cortex-direct and direct-LLM branches
 * are gone), no model-control resolution (Praxis ignored it), and attached
 * text files are inlined into the message instead of being silently dropped.
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

function createDb() {
    return {
        getActiveConversation: jest.fn(async () => ({ id: 'conversation-1' })),
        saveChatMessage: jest.fn(async message => ({ id: message.id || 'message-1', ...message })),
    };
}

describe('AI chat Praxis relay', () => {
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

    test('every mode relays to Praxis — including legacy "chat"', async () => {
        global.fetch = jest.fn(async () => ({
            ok: true,
            json: async () => ({ response: 'praxis response' }),
        }));
        await mount(createDb());

        const response = await post({ message: 'hello', mode: 'chat', history: [] });

        expect(response.status).toBe(200);
        expect(response.body.provider).toBe('Praxis');
        expect(global.fetch).toHaveBeenCalledWith(
            'http://127.0.0.1:54322/api/chat',
            expect.any(Object),
        );
    });

    test('does not forward model-assignment fields Praxis ignores', async () => {
        global.fetch = jest.fn(async () => ({
            ok: true,
            json: async () => ({ response: 'praxis response' }),
        }));
        await mount(createDb());

        await post({
            message: 'ship it',
            mode: 'praxis',
            model_assignment: 'model:anthropic-claude-sonnet',
            modelConfig: { id: 'x', provider: 'Anthropic' },
        });

        const praxisPayload = JSON.parse(global.fetch.mock.calls[0][1].body);
        expect(praxisPayload.modelAssignment).toBeUndefined();
        expect(praxisPayload.resolvedModel).toBeUndefined();
        expect(praxisPayload.modelOverride).toBeUndefined();
        expect(praxisPayload.message).toBe('ship it');
    });

    test('inlines attached text files into the Praxis message', async () => {
        global.fetch = jest.fn(async () => ({
            ok: true,
            json: async () => ({ response: 'read it' }),
        }));
        await mount(createDb());

        await post({
            message: 'summarize this',
            mode: 'praxis',
            files: [{ name: 'notes.txt', content: 'line one\nline two', type: 'text/plain' }],
        });

        const praxisPayload = JSON.parse(global.fetch.mock.calls[0][1].body);
        expect(praxisPayload.message).toContain('summarize this');
        expect(praxisPayload.message).toContain('[Attached file: notes.txt]');
        expect(praxisPayload.message).toContain('line one\nline two');
    });

    test('a retried send with the same clientMessageId joins the in-flight run (no double agent execution)', async () => {
        // The mobile client re-POSTs after its cellular connection dies
        // mid-wait; the join-map must attach the retry to the ORIGINAL
        // Praxis run instead of running the agent twice.
        let resolvePraxis;
        const praxisGate = new Promise((resolve) => { resolvePraxis = resolve; });
        global.fetch = jest.fn(async () => {
            await praxisGate;
            return { ok: true, json: async () => ({ response: 'one run, one reply' }) };
        });
        const db = createDb();
        await mount(db);

        const first = post({ message: 'from the gym', mode: 'praxis', clientMessageId: 'msg-retry-1' });
        // Let the first request reach the relay and register its run.
        await new Promise((resolve) => setTimeout(resolve, 100));
        const second = post({ message: 'from the gym', mode: 'praxis', clientMessageId: 'msg-retry-1' });
        await new Promise((resolve) => setTimeout(resolve, 50));
        resolvePraxis();

        const [a, b] = await Promise.all([first, second]);
        expect(a.status).toBe(200);
        expect(b.status).toBe(200);
        expect(a.body.response).toBe('one run, one reply');
        expect(b.body.response).toBe('one run, one reply');
        // The agent ran exactly once, and the messages persisted once each.
        expect(global.fetch).toHaveBeenCalledTimes(1);
        const savedRoles = db.saveChatMessage.mock.calls.map(([m]) => m.role);
        expect(savedRoles.filter((r) => r === 'user')).toHaveLength(1);
        expect(savedRoles.filter((r) => r === 'assistant')).toHaveLength(1);
    });

    test('a completed run stays joinable, and a failed run is not pinned', async () => {
        let praxisCalls = 0;
        global.fetch = jest.fn(async () => {
            praxisCalls += 1;
            if (praxisCalls === 1) throw new Error('praxis down');
            return { ok: true, json: async () => ({ response: 'second try worked' }) };
        });
        const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        try {
            await mount(createDb());

            // First run fails → 502, and the failure must NOT be cached.
            const failed = await post({ message: 'retry me', mode: 'praxis', clientMessageId: 'msg-retry-2' });
            expect(failed.status).toBe(502);

            // A later retry with the same id re-runs and succeeds…
            const retried = await post({ message: 'retry me', mode: 'praxis', clientMessageId: 'msg-retry-2' });
            expect(retried.status).toBe(200);
            expect(retried.body.response).toBe('second try worked');
            expect(global.fetch).toHaveBeenCalledTimes(2);

            // …and a straggler retry arriving after completion joins the
            // cached result instead of running the agent a third time.
            const straggler = await post({ message: 'retry me', mode: 'praxis', clientMessageId: 'msg-retry-2' });
            expect(straggler.status).toBe(200);
            expect(straggler.body.response).toBe('second try worked');
            expect(global.fetch).toHaveBeenCalledTimes(2);
        } finally {
            consoleErrorSpy.mockRestore();
        }
    });

    test('legacy agent mode still relays with the Cortex System-2 flag', async () => {
        global.fetch = jest.fn(async () => ({
            ok: true,
            json: async () => ({ response: 'brain output', artifacts: [] }),
        }));
        await mount(createDb());

        const response = await post({ message: 'plan the feature', mode: 'agent' });

        expect(response.status).toBe(200);
        const praxisPayload = JSON.parse(global.fetch.mock.calls[0][1].body);
        expect(praxisPayload.agentMode).toBe(true);
        expect(praxisPayload.stream).toBeUndefined();
    });
});
