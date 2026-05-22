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
    return new Promise(resolve => {
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            resolve({ server, sockets, baseUrl: `http://127.0.0.1:${port}` });
        });
    });
}

function close(handle) {
    for (const socket of handle.sockets) socket.destroy();
    return new Promise(resolve => handle.server.close(resolve));
}

async function requestJson(url, options = {}) {
    const res = await nativeFetch(url, options);
    return { status: res.status, body: await res.json() };
}

function createDb() {
    const models = [
        { id: 'anthropic-claude-sonnet', provider: 'anthropic', api_model_id: 'claude-sonnet-4-6', name: 'Claude Sonnet', availability_status: 'available', is_active: true },
        { id: 'local-llama', provider: 'local', api_model_id: 'llama3.2', name: 'Local Llama', availability_status: 'available', is_active: true }
    ];
    return {
        getModelControlSetting: jest.fn(async () => null),
        getModel: jest.fn(async id => models.find(model => model.id === id) || null),
        getModels: jest.fn(async () => models),
        getModelAliases: jest.fn(async () => [{ alias: 'local_default', target: 'model:local-llama' }]),
        getProjectModelAliases: jest.fn(async () => []),
        createModelExecutionSnapshot: jest.fn(async snapshot => ({ id: 'snapshot-1', ...snapshot })),
    };
}

describe('workflow model control integration', () => {
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

    test('LangGraph run payload includes per-node resolved model configs', async () => {
        const db = createDb();
        let forwardedPayload = null;
        jest.doMock('../services/langgraph-supervisor', () => ({
            proxyToLangGraph: jest.fn(async (_path, options) => {
                forwardedPayload = JSON.parse(options.body);
                return { success: true, run_id: 'run-1' };
            })
        }));
        const createLangGraphRouter = require('../routes/langgraph');
        const app = express();
        app.use(express.json());
        app.use('/api/langgraph', createLangGraphRouter({
            db,
            PROJECT_ROOT: '/Volumes/Projects',
            getProjectById: jest.fn(),
            contextSync: {},
            runAgent: jest.fn()
        }));
        handle = await listen(app);

        const graphConfig = {
            nodes: [{
                id: 'planner-1',
                type: 'planner',
                data: {
                    label: 'Planner',
                    config: { model_assignment: 'model:anthropic-claude-sonnet' }
                }
            }],
            edges: []
        };

        const response = await requestJson(`${handle.baseUrl}/api/langgraph/run`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ project_id: 'project-1', graph_config: graphConfig })
        });

        expect(response.status).toBe(200);
        expect(forwardedPayload.graph_config.nodes[0].data.config.resolved_model).toEqual(expect.objectContaining({
            provider: 'anthropic',
            api_model_id: 'claude-sonnet-4-6',
            local_only_active: false
        }));
        expect(forwardedPayload.graph_config.nodes[0].data.model).toBe('Claude Sonnet');
        expect(db.createModelExecutionSnapshot).toHaveBeenCalledWith(expect.objectContaining({
            project_id: 'project-1',
            node_id: 'planner-1'
        }));
    });
});
