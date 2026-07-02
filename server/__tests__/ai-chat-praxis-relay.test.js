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
