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
    return new Promise(resolve => handle.server.close(resolve));
}

async function requestJson(url, options = {}) {
    const res = await nativeFetch(url, options);
    return { status: res.status, body: await res.json() };
}

function createDb(overrides = {}) {
    const task = {
        id: 'task-1',
        project_id: 'project-1',
        name: 'Task One',
        description: 'Do the work',
        status: 'idea',
        model_assignment: 'model:anthropic-claude-sonnet'
    };
    const models = [
        { id: 'anthropic-claude-sonnet', provider: 'anthropic', api_model_id: 'claude-sonnet-4-6', name: 'Claude Sonnet', availability_status: 'available', is_active: true },
        { id: 'local-llama', provider: 'local', api_model_id: 'llama3.2', name: 'Local Llama', availability_status: 'available', is_active: true }
    ];
    return {
        createTask: jest.fn(async input => ({ id: 'task-created', ...input, created_at: 'now' })),
        updateTask: jest.fn(async (_id, updates) => ({ ...task, ...updates })),
        getTask: jest.fn(async () => task),
        getModelControlSetting: jest.fn(async () => null),
        getModel: jest.fn(async id => models.find(model => model.id === id) || null),
        getModels: jest.fn(async () => models),
        getModelAliases: jest.fn(async () => [{ alias: 'local_default', target: 'model:local-llama' }]),
        getProjectModelAliases: jest.fn(async () => []),
        createModelExecutionSnapshot: jest.fn(async snapshot => ({ id: 'snapshot-1', ...snapshot })),
        ...overrides
    };
}

async function mount(db) {
    const createTasksRouter = require('../routes/tasks');
    const app = express();
    app.use(express.json());
    app.use('/api/tasks', createTasksRouter({
        db,
        PROJECT_ROOT: '/Volumes/Projects',
        getProjectById: jest.fn(async () => ({ id: 'project-1', path: '/Volumes/Projects/ProjectOne' })),
        validateInitiativeRequest: jest.fn(async () => ({})),
        pushService: { notifyTaskUpdate: jest.fn(async () => {}) }
    }));
    return listen(app);
}

describe('tasks model control integration', () => {
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

    test('task create and update persist model_assignment', async () => {
        const db = createDb();
        handle = await mount(db);

        await requestJson(`${handle.baseUrl}/api/tasks`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ project_id: 'project-1', title: 'New task', model_assignment: 'alias:coder' })
        });
        expect(db.createTask).toHaveBeenCalledWith(expect.objectContaining({ model_assignment: 'alias:coder' }));

        await requestJson(`${handle.baseUrl}/api/tasks/task-1`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model_assignment: 'model:anthropic-claude-sonnet' })
        });
        expect(db.updateTask).toHaveBeenCalledWith('task-1', expect.objectContaining({ model_assignment: 'model:anthropic-claude-sonnet' }));
    });

    test('resume redispatch includes resolved model override', async () => {
        const db = createDb({
            getTask: jest.fn(async () => ({
                id: 'task-1',
                project_id: 'project-1',
                name: 'Suspended',
                status: 'suspended',
                model_assignment: 'model:anthropic-claude-sonnet',
                metadata: {
                    suspension: {
                        context: { workspace: '/Volumes/Projects/ProjectOne' },
                        resume_action: { type: 'redispatch' }
                    }
                }
            }))
        });
        global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ success: true }) }));
        handle = await mount(db);

        const response = await requestJson(`${handle.baseUrl}/api/tasks/project-1/tasks/task-1/resume`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ humanInput: 'continue' })
        });

        expect(response.status).toBe(200);
        const payload = JSON.parse(global.fetch.mock.calls[0][1].body);
        expect(payload.modelOverride).toEqual(expect.objectContaining({ provider: 'anthropic', apiModelId: 'claude-sonnet-4-6' }));
    });

    test('suspend PATCH persists metadata.suspension alongside status_message', async () => {
        const db = createDb();
        handle = await mount(db);

        const response = await requestJson(`${handle.baseUrl}/api/tasks/task-1`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                status: 'suspended',
                status_message: 'Waiting on Robert',
                suspended_at: '2026-09-03T10:00:00.000Z',
                suspended_reason: 'Need API design clarification',
                suspended_context: { question: 'REST or GraphQL?', partialResult: 'scaffolded routes', workspace: '/Volumes/Projects/ProjectOne' },
                resume_action: { type: 'redispatch' }
            })
        });

        expect(response.status).toBe(200);
        const updates = db.updateTask.mock.calls[0][1];
        expect(updates.status).toBe('suspended');
        expect(updates).not.toHaveProperty('suspended_at');
        expect(updates).not.toHaveProperty('suspended_reason');
        expect(updates).not.toHaveProperty('suspended_context');
        expect(updates).not.toHaveProperty('resume_action');
        expect(updates.metadata).toEqual({
            status_message: 'Waiting on Robert',
            suspension: {
                suspended_at: '2026-09-03T10:00:00.000Z',
                reason: 'Need API design clarification',
                context: { question: 'REST or GraphQL?', partialResult: 'scaffolded routes', workspace: '/Volumes/Projects/ProjectOne' },
                resume_action: { type: 'redispatch' }
            }
        });
    });

    test('leaving suspended via PATCH keeps metadata.suspension as history', async () => {
        const db = createDb({
            getTask: jest.fn(async () => ({
                id: 'task-1', project_id: 'project-1', name: 'Parked', status: 'suspended',
                metadata: { suspension: { suspended_at: 't0', reason: 'why' } }
            }))
        });
        handle = await mount(db);

        await requestJson(`${handle.baseUrl}/api/tasks/task-1`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'in_progress', status_message: 'back on it' })
        });
        const updates = db.updateTask.mock.calls[0][1];
        expect(updates.metadata).toEqual({ suspension: { suspended_at: 't0', reason: 'why' }, status_message: 'back on it' });

        // Explicit nulls clear the block.
        await requestJson(`${handle.baseUrl}/api/tasks/task-1`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ suspended_at: null, suspended_reason: null, suspended_context: null, resume_action: null })
        });
        expect(db.updateTask.mock.calls[1][1].metadata).toEqual({});
    });

    test('resume rebuilds instructions from metadata.suspension and stamps resumed_at', async () => {
        const db = createDb({
            getTask: jest.fn(async () => ({
                id: 'task-1', project_id: 'project-1', name: 'Parked', status: 'suspended',
                model_assignment: 'model:anthropic-claude-sonnet',
                metadata: {
                    status_message: 'note',
                    suspension: {
                        suspended_at: 't0',
                        reason: 'Need API design clarification',
                        context: { question: 'REST or GraphQL?', partialResult: 'scaffolded routes', workspace: '/Volumes/Projects/ProjectOne' },
                        resume_action: { type: 'redispatch' }
                    }
                }
            }))
        });
        global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ success: true }) }));
        handle = await mount(db);

        const response = await requestJson(`${handle.baseUrl}/api/tasks/project-1/tasks/task-1/resume`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ humanInput: 'GraphQL' })
        });
        expect(response.status).toBe(200);

        const updates = db.updateTask.mock.calls[0][1];
        expect(updates.status).toBe('in_progress');
        expect(updates).not.toHaveProperty('suspended_context');
        expect(updates.metadata.status_message).toBe('note');
        expect(updates.metadata.suspension).toEqual(expect.objectContaining({
            suspended_at: 't0',
            reason: 'Need API design clarification',
            resumed_at: expect.any(String)
        }));

        const payload = JSON.parse(global.fetch.mock.calls[0][1].body);
        expect(payload.workspace).toBe('/Volumes/Projects/ProjectOne');
        expect(payload.instructions).toContain('Previous context: scaffolded routes');
        expect(payload.instructions).toContain('Question asked: REST or GraphQL?');
        expect(payload.instructions).toContain('Human answer: GraphQL');
    });

    test('cancel from suspension sets cancelled status and stamps cancelled_at', async () => {
        const db = createDb({
            getTask: jest.fn(async () => ({
                id: 'task-1', project_id: 'project-1', name: 'Parked', status: 'suspended',
                metadata: { suspension: { suspended_at: 't0', reason: 'why', context: 'plain string context' } }
            }))
        });
        global.fetch = jest.fn();
        handle = await mount(db);

        const response = await requestJson(`${handle.baseUrl}/api/tasks/project-1/tasks/task-1/resume`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'cancel' })
        });
        expect(response.status).toBe(200);
        expect(response.body).toEqual({ success: true, action: 'cancelled' });
        expect(global.fetch).not.toHaveBeenCalled();

        const updates = db.updateTask.mock.calls[0][1];
        expect(updates.status).toBe('cancelled');
        expect(Object.keys(updates).sort()).toEqual(['metadata', 'status', 'updated_at']);
        expect(updates.metadata.suspension).toEqual({
            suspended_at: 't0', reason: 'why', context: 'plain string context', cancelled_at: expect.any(String)
        });
    });
});
