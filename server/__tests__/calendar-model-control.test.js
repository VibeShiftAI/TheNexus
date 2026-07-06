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
    return { status: res.status, body: res.status === 204 ? null : await res.json() };
}

function createDb(overrides = {}) {
    const event = {
        id: 'event-1',
        title: 'Scheduled Praxis Work',
        start_time: new Date(Date.now() + 1000).toISOString(),
        status: 'scheduled',
        event_type: 'praxis_task',
        project_id: 'project-1',
        model_assignment: 'model:anthropic-claude-sonnet'
    };
    const models = [
        { id: 'anthropic-claude-sonnet', provider: 'anthropic', api_model_id: 'claude-sonnet-4-6', name: 'Claude Sonnet', availability_status: 'available', is_active: true },
        { id: 'local-llama', provider: 'local', api_model_id: 'llama3.2', name: 'Local Llama', availability_status: 'available', is_active: true }
    ];
    return {
        createCalendarEvent: jest.fn(async input => ({ id: 'event-created', ...input })),
        updateCalendarEvent: jest.fn(async (id, updates) => ({ id, ...updates })),
        getCalendarEvents: jest.fn(async () => [event]),
        getModelControlSetting: jest.fn(async () => null),
        getModel: jest.fn(async id => models.find(model => model.id === id) || null),
        getModels: jest.fn(async () => models),
        getModelAliases: jest.fn(async () => [{ alias: 'local_default', target: 'model:local-llama' }]),
        getProjectModelAliases: jest.fn(async () => []),
        createModelExecutionSnapshot: jest.fn(async snapshot => ({ id: 'snapshot-1', ...snapshot })),
        getActiveConversation: jest.fn(async () => ({ id: 'conversation-1' })),
        saveChatMessage: jest.fn(async message => ({ id: 'message-1', ...message })),
        ...overrides
    };
}

describe('calendar model control integration', () => {
    const originalEnv = process.env;
    let handle;

    beforeEach(() => {
        jest.resetModules();
        process.env = { ...originalEnv, ANTHROPIC_API_KEY: 'anthropic-key' };
    });

    afterEach(async () => {
        if (handle) await close(handle);
        handle = null;
        process.env = originalEnv;
    });

    test('calendar create and update persist model_assignment', async () => {
        const db = createDb();
        const createCalendarRouter = require('../routes/calendar');
        const app = express();
        app.use(express.json());
        app.use('/api/calendar', createCalendarRouter({ db }));
        handle = await listen(app);

        await requestJson(`${handle.baseUrl}/api/calendar`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: 'Event', model_assignment: 'alias:planner' })
        });
        expect(db.createCalendarEvent).toHaveBeenCalledWith(expect.objectContaining({ model_assignment: 'alias:planner' }));

        await requestJson(`${handle.baseUrl}/api/calendar/event-1`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model_assignment: 'model:anthropic-claude-sonnet' })
        });
        expect(db.updateCalendarEvent).toHaveBeenCalledWith('event-1', expect.objectContaining({ model_assignment: 'model:anthropic-claude-sonnet' }));
    });

    // The firing loop lives in Praxis now (calendar-dispatch.ts poller,
    // 2026-07-06 consolidation). Its resolve calls hit this route with a
    // snapshot context and announceTitle so the DB/chat side effects that the
    // retired Nexus scheduler used to perform still happen server-side.

    test('resolve returns the assignment and records a snapshot when asked', async () => {
        const db = createDb();
        const createModelControlRouter = require('../routes/model-control');
        const app = express();
        app.use(express.json());
        app.use('/api/model-control', createModelControlRouter({ db, io: null }));
        handle = await listen(app);

        const { status, body } = await requestJson(`${handle.baseUrl}/api/model-control/resolve`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model_assignment: 'model:anthropic-claude-sonnet',
                requestedAssignment: 'model:anthropic-claude-sonnet',
                projectId: 'project-1',
                role: 'scheduled_activity',
                snapshot: { project_id: 'project-1', task_id: 'task-1', calendar_event_id: 'event-1' },
                announceTitle: 'Scheduled Praxis Work'
            })
        });

        expect(status).toBe(200);
        expect(body).toEqual(expect.objectContaining({ provider: 'anthropic', apiModelId: 'claude-sonnet-4-6' }));
        expect(db.createModelExecutionSnapshot).toHaveBeenCalledWith(expect.objectContaining({
            calendar_event_id: 'event-1',
            task_id: 'task-1'
        }));
        expect(db.saveChatMessage).not.toHaveBeenCalled();
    });

    test('resolve announces local-only redirects for scheduled events', async () => {
        const db = createDb({
            getModelControlSetting: jest.fn(async () => ({ enabled: true, reason: 'budget_limit' }))
        });
        const createModelControlRouter = require('../routes/model-control');
        const app = express();
        app.use(express.json());
        app.use('/api/model-control', createModelControlRouter({ db, io: null }));
        handle = await listen(app);

        const { status, body } = await requestJson(`${handle.baseUrl}/api/model-control/resolve`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model_assignment: 'model:anthropic-claude-sonnet',
                requestedAssignment: 'model:anthropic-claude-sonnet',
                projectId: 'project-1',
                role: 'scheduled_activity',
                snapshot: { project_id: 'project-1', task_id: 'task-1', calendar_event_id: 'event-1' },
                announceTitle: 'Scheduled Praxis Work'
            })
        });

        expect(status).toBe(200);
        expect(body).toEqual(expect.objectContaining({ provider: 'local', apiModelId: 'llama3.2' }));
        expect(db.saveChatMessage).toHaveBeenCalledWith(expect.objectContaining({
            role: 'system',
            content: expect.stringMatching(/local-only|budget_limit/i)
        }));
    });
});
