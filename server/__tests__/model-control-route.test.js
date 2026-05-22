const express = require('express');
const http = require('http');

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
    const res = await fetch(url, options);
    return {
        status: res.status,
        body: await res.json(),
    };
}

describe('model control route', () => {
    let handle;

    afterEach(async () => {
        if (handle) await close(handle);
        handle = null;
    });

    test('returns model-control options and updates local-only mode', async () => {
        const db = {
            getModels: jest.fn(async () => [{ id: 'local-llama', provider: 'local', api_model_id: 'llama3.2' }]),
            getModel: jest.fn(async () => ({ id: 'local-llama', provider: 'local', api_model_id: 'llama3.2', is_active: true })),
            getModelAliases: jest.fn(async () => [{ alias: 'local_default', target: 'model:local-llama' }]),
            getProjectModelAliases: jest.fn(async () => [{ alias: 'coder', target: 'model:local-llama' }]),
            getModelControlSetting: jest.fn(async () => ({ enabled: false, reason: null })),
            getProjectModelControlSetting: jest.fn(async () => ({
                enabled: true,
                requiredCapabilities: ['coding'],
                fallbackChain: ['alias:local_default']
            })),
            setModelControlSetting: jest.fn(async (_key, value) => value),
            setProjectModelControlSetting: jest.fn(async (_projectId, _key, value) => value),
            upsertModelAlias: jest.fn(async (record) => record),
            upsertProjectModelAlias: jest.fn(async (projectId, record) => ({ project_id: projectId, ...record })),
        };
        const createModelControlRouter = require('../routes/model-control');
        const app = express();
        app.use(express.json());
        app.use('/api/model-control', createModelControlRouter({ db }));
        handle = await listen(app);

        await expect(requestJson(`${handle.baseUrl}/api/model-control/options?projectId=project-1`))
            .resolves.toEqual({
                status: 200,
                body: {
                    models: [{ id: 'local-llama', provider: 'local', api_model_id: 'llama3.2' }],
                    aliases: [{ alias: 'local_default', target: 'model:local-llama' }],
                    projectAliases: [{ alias: 'coder', target: 'model:local-llama' }],
                    localOnly: { enabled: false, reason: null },
                    policy: { enabled: false, reason: null },
                    projectPolicy: {
                        enabled: true,
                        requiredCapabilities: ['coding'],
                        fallbackChain: ['alias:local_default']
                    }
                }
            });

        await expect(requestJson(`${handle.baseUrl}/api/model-control/local-only`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: true, reason: 'offline' })
        })).resolves.toEqual({
            status: 200,
            body: { enabled: true, reason: 'offline' }
        });

        await expect(requestJson(`${handle.baseUrl}/api/model-control/policy`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                enabled: true,
                requiredCapabilities: ['coding'],
                fallbackChain: ['alias:local_default'],
                budget: { dailyTokenLimit: 1000, dailyCostLimit: 1.25, autoLocalOnly: false }
            })
        })).resolves.toEqual({
            status: 200,
            body: {
                enabled: true,
                requiredCapabilities: ['coding'],
                fallbackChain: ['alias:local_default'],
                budget: { dailyTokenLimit: 1000, dailyCostLimit: 1.25, autoLocalOnly: false }
            }
        });

        await expect(requestJson(`${handle.baseUrl}/api/model-control/projects/project-1/policy`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                enabled: true,
                requiredCapabilities: ['reasoning'],
                fallbackChain: ['family_latest:google/gemini-pro'],
                budget: { dailyTokenLimit: 500, dailyCostLimit: 0.5, autoLocalOnly: false }
            })
        })).resolves.toEqual({
            status: 200,
            body: {
                enabled: true,
                requiredCapabilities: ['reasoning'],
                fallbackChain: ['family_latest:google/gemini-pro'],
                budget: { dailyTokenLimit: 500, dailyCostLimit: 0.5, autoLocalOnly: false }
            }
        });
    });

    test('updates global and project role aliases', async () => {
        const db = {
            upsertModelAlias: jest.fn(async (record) => ({ alias: record.alias, ...record })),
            upsertProjectModelAlias: jest.fn(async (projectId, record) => ({ project_id: projectId, alias: record.alias, ...record })),
        };
        const createModelControlRouter = require('../routes/model-control');
        const app = express();
        app.use(express.json());
        app.use('/api/model-control', createModelControlRouter({ db }));
        handle = await listen(app);

        await expect(requestJson(`${handle.baseUrl}/api/model-control/aliases/coder`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ target: 'model:anthropic-claude-sonnet', description: 'Default coding model' })
        })).resolves.toEqual({
            status: 200,
            body: {
                alias: 'coder',
                target: 'model:anthropic-claude-sonnet',
                description: 'Default coding model'
            }
        });

        await expect(requestJson(`${handle.baseUrl}/api/model-control/projects/project-1/aliases/coder`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ target: 'model:local-llama', description: 'Offline project coder' })
        })).resolves.toEqual({
            status: 200,
            body: {
                project_id: 'project-1',
                alias: 'coder',
                target: 'model:local-llama',
                description: 'Offline project coder'
            }
        });
    });

    test('returns recent model execution snapshots for the control center', async () => {
        const db = {
            getModelExecutionSnapshots: jest.fn(async (filters) => ({
                snapshots: [{
                    id: 'snapshot-1',
                    requested_assignment: 'alias:coder',
                    resolved_model_id: 'anthropic-claude-sonnet',
                    provider: 'anthropic',
                    api_model_id: 'claude-sonnet-4-6',
                    source: 'project_alias',
                    fallback_used: false,
                    local_only_active: false,
                    project_id: 'project-1',
                    task_id: 'task-1',
                    created_at: '2026-05-22T12:00:00.000Z'
                }],
                total: 1,
                limit: filters.limit,
                offset: filters.offset
            })),
        };
        const createModelControlRouter = require('../routes/model-control');
        const app = express();
        app.use(express.json());
        app.use('/api/model-control', createModelControlRouter({ db }));
        handle = await listen(app);

        await expect(requestJson(`${handle.baseUrl}/api/model-control/executions?projectId=project-1&limit=5&offset=0`))
            .resolves.toEqual({
                status: 200,
                body: {
                    snapshots: [{
                        id: 'snapshot-1',
                        requested_assignment: 'alias:coder',
                        resolved_model_id: 'anthropic-claude-sonnet',
                        provider: 'anthropic',
                        api_model_id: 'claude-sonnet-4-6',
                        source: 'project_alias',
                        fallback_used: false,
                        local_only_active: false,
                        project_id: 'project-1',
                        task_id: 'task-1',
                        created_at: '2026-05-22T12:00:00.000Z'
                    }],
                    total: 1,
                    limit: 5,
                    offset: 0
                }
            });
        expect(db.getModelExecutionSnapshots).toHaveBeenCalledWith({
            projectId: 'project-1',
            limit: 5,
            offset: 0
        });
    });

    test('runs manual model discovery for the control center', async () => {
        const db = {};
        const discoverModelRegistry = jest.fn(async ({ db: injectedDb }) => ({
            models: [{ id: 'anthropic-claude-sonnet', provider: 'Anthropic', apiModelId: 'claude-sonnet-4-6' }],
            providers: [
                { provider: 'anthropic', status: 'ok', rawCount: 1, modelCount: 1 },
                { provider: 'openai', status: 'skipped', rawCount: 0, modelCount: 0, message: 'no API key' }
            ],
            summary: {
                anthropic: '1 models (from 1 raw)',
                openai: 'SKIPPED (no key)'
            },
            elapsedMs: 12,
            discoveredAt: '2026-05-22T12:00:00.000Z',
            dbInjected: injectedDb === db
        }));
        const createModelControlRouter = require('../routes/model-control');
        const app = express();
        app.use(express.json());
        app.use('/api/model-control', createModelControlRouter({ db, discoverModelRegistry }));
        handle = await listen(app);

        await expect(requestJson(`${handle.baseUrl}/api/model-control/discover`, { method: 'POST' }))
            .resolves.toEqual({
                status: 200,
                body: {
                    models: [{ id: 'anthropic-claude-sonnet', provider: 'Anthropic', apiModelId: 'claude-sonnet-4-6' }],
                    providers: [
                        { provider: 'anthropic', status: 'ok', rawCount: 1, modelCount: 1 },
                        { provider: 'openai', status: 'skipped', rawCount: 0, modelCount: 0, message: 'no API key' }
                    ],
                    summary: {
                        anthropic: '1 models (from 1 raw)',
                        openai: 'SKIPPED (no key)'
                    },
                    elapsedMs: 12,
                    discoveredAt: '2026-05-22T12:00:00.000Z',
                    dbInjected: true
                }
            });
        expect(discoverModelRegistry).toHaveBeenCalledWith({ db });
    });
});
