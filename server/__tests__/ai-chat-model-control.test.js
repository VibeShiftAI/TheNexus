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

async function requestJson(url, options = {}) {
    const res = await nativeFetch(url, options);
    return {
        status: res.status,
        body: await res.json(),
    };
}

function createDb(overrides = {}) {
    const models = [
        { id: 'anthropic-claude-sonnet', provider: 'anthropic', api_model_id: 'claude-sonnet-4-6', name: 'Claude Sonnet', availability_status: 'available', is_active: true },
        { id: 'local-llama', provider: 'local', api_model_id: 'llama3.2', name: 'Local Llama', availability_status: 'available', is_active: true },
    ];
    return {
        getModelControlSetting: jest.fn(async () => null),
        getModel: jest.fn(async id => models.find(m => m.id === id) || null),
        getModels: jest.fn(async () => models),
        getModelAliases: jest.fn(async () => [{ alias: 'local_default', target: 'model:local-llama' }]),
        getProjectModelAliases: jest.fn(async () => []),
        createModelExecutionSnapshot: jest.fn(async snapshot => ({ id: 'snapshot-1', ...snapshot })),
        getActiveConversation: jest.fn(async () => ({ id: 'conversation-1' })),
        saveChatMessage: jest.fn(async message => ({ id: message.id || 'message-1', ...message })),
        ...overrides
    };
}

describe('AI chat model control integration', () => {
    const originalEnv = process.env;
    const originalFetch = global.fetch;
    let handle;

    beforeEach(() => {
        jest.resetModules();
        process.env = { ...originalEnv, ANTHROPIC_API_KEY: 'anthropic-key' };
    });

    afterEach(async () => {
        if (handle) await close(handle);
        handle = null;
        process.env = originalEnv;
        global.fetch = originalFetch;
    });

    async function mount(db, callAI) {
        const createAIChatRouter = require('../routes/ai-chat');
        const app = express();
        app.use(express.json());
        app.use('/api/ai/chat', createAIChatRouter({ db, callAI, io: { emit: jest.fn() } }));
        handle = await listen(app);
    }

    test('resolves model assignment and calls callAI with resolved provider config', async () => {
        const db = createDb();
        const callAI = jest.fn(async () => ({ text: 'hello from model', usage: { totalTokens: 3 } }));
        await mount(db, callAI);

        const response = await requestJson(`${handle.baseUrl}/api/ai/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                message: 'hello',
                mode: 'chat',
                model_assignment: 'model:anthropic-claude-sonnet',
                history: []
            })
        });

        expect(response.status).toBe(200);
        expect(callAI).toHaveBeenCalledWith(expect.objectContaining({
            provider: 'anthropic',
            apiModelId: 'claude-sonnet-4-6'
        }), 'hello', expect.any(String), [], { returnFullResult: true });
        expect(db.createModelExecutionSnapshot).toHaveBeenCalledWith(expect.objectContaining({
            requested_assignment: 'model:anthropic-claude-sonnet',
            provider: 'anthropic',
            api_model_id: 'claude-sonnet-4-6'
        }));
    });

    test('persists fallback/local-only system message when resolver redirects', async () => {
        const db = createDb({
            getModelControlSetting: jest.fn(async () => ({ enabled: true, reason: 'offline' }))
        });
        const callAI = jest.fn(async () => ({ text: 'local response', usage: { totalTokens: 1 } }));
        await mount(db, callAI);

        const response = await requestJson(`${handle.baseUrl}/api/ai/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                message: 'hello',
                mode: 'chat',
                model_assignment: 'model:anthropic-claude-sonnet'
            })
        });

        expect(response.status).toBe(200);
        expect(callAI).toHaveBeenCalledWith(expect.objectContaining({ provider: 'local', apiModelId: 'llama3.2' }), expect.any(String), expect.any(String), expect.any(Array), expect.any(Object));
        expect(db.saveChatMessage).toHaveBeenCalledWith(expect.objectContaining({
            conversation_id: 'conversation-1',
            role: 'system',
            mode: 'praxis',
            content: expect.stringMatching(/local-only|offline/i)
        }));
    });

    test('passes resolved model metadata to Praxis proxy payload', async () => {
        const db = createDb();
        global.fetch = jest.fn(async () => ({
            ok: true,
            json: async () => ({ response: 'praxis response' })
        }));
        await mount(db, jest.fn());

        const response = await requestJson(`${handle.baseUrl}/api/ai/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                message: 'ship it',
                mode: 'praxis',
                projectId: 'project-1',
                model_assignment: 'model:anthropic-claude-sonnet'
            })
        });

        expect(response.status).toBe(200);
        const praxisPayload = JSON.parse(global.fetch.mock.calls[0][1].body);
        expect(praxisPayload.modelAssignment).toBe('model:anthropic-claude-sonnet');
        expect(praxisPayload.modelOverride).toEqual(expect.objectContaining({
            provider: 'anthropic',
            apiModelId: 'claude-sonnet-4-6'
        }));
        expect(praxisPayload.resolvedModel).toEqual(expect.objectContaining({
            resolvedModelId: 'anthropic-claude-sonnet'
        }));
    });
});
