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
                    models: [{ id: 'local-llama', provider: 'local', api_model_id: 'llama3.2', apiModelId: 'llama3.2' }],
                    aliases: [{ alias: 'local_default', target: 'model:local-llama' }],
                    projectAliases: [{ alias: 'coder', target: 'model:local-llama' }],
                    thinkingLevels: { 'claude-fable-5-1': 'low', 'claude-opus-5': 'xhigh' },
                    agentBackend: { backend: 'codex', fallbacks: ['claude-code', 'gemini'] },
                    chatBackend: 'claude-code',
                    chatConfig: {
                        backend: 'claude-code', claudeModel: '', codexModel: '', thinkingLevel: 'default',
                        // Tiers for the effective model (the Opus 5 default).
                        thinkingTiers: ['default', 'low', 'medium', 'high', 'xhigh', 'max']
                    },
                    claudeDefault: 'claude-opus-5',
                    codexDefault: '',
                    antigravityDefault: '',
                    codexModels: expect.any(Array),
                    localOnly: { enabled: false, reason: null },
                    policy: { enabled: false, reason: null },
                    projectPolicy: {
                        enabled: true,
                        requiredCapabilities: ['coding'],
                        fallbackChain: ['alias:local_default']
                    },
                    // Key-aware routing rides the options payload. Its contents
                    // are derived from live dispatch history (asserted in
                    // provider-credential-routing.test.js); here we only pin
                    // that every dispatch surface receives it.
                    credentials: expect.objectContaining({
                        executors: expect.any(Array),
                        providers: expect.any(Array)
                    })
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
                budget: {
                    dailyTokenLimit: 1000,
                    dailyCostLimit: 1.25,
                    autoLocalOnly: false,
                    providerLimits: {
                        anthropic: { dailyTokenLimit: 250, dailyCostLimit: 0.75 }
                    }
                }
            })
        })).resolves.toEqual({
            status: 200,
            body: {
                enabled: true,
                requiredCapabilities: ['coding'],
                fallbackChain: ['alias:local_default'],
                budget: {
                    dailyTokenLimit: 1000,
                    dailyCostLimit: 1.25,
                    autoLocalOnly: false,
                    providerLimits: {
                        anthropic: { dailyTokenLimit: 250, dailyCostLimit: 0.75 }
                    }
                }
            }
        });

        await expect(requestJson(`${handle.baseUrl}/api/model-control/projects/project-1/policy`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                enabled: true,
                requiredCapabilities: ['reasoning'],
                fallbackChain: ['family_latest:google/gemini-pro'],
                budget: { dailyTokenLimit: 500, dailyCostLimit: 0.5, autoLocalOnly: false, providerLimits: {} }
            })
        })).resolves.toEqual({
            status: 200,
            body: {
                enabled: true,
                requiredCapabilities: ['reasoning'],
                fallbackChain: ['family_latest:google/gemini-pro'],
                budget: { dailyTokenLimit: 500, dailyCostLimit: 0.5, autoLocalOnly: false, providerLimits: {} }
            }
        });
    });

    test('reads and updates the codex / antigravity default models', async () => {
        const settings = {};
        const db = {
            getModelControlSetting: jest.fn(async (key) => settings[key] ?? null),
            setModelControlSetting: jest.fn(async (key, value) => { settings[key] = value; return value; }),
        };
        const createModelControlRouter = require('../routes/model-control');
        const app = express();
        app.use(express.json());
        app.use('/api/model-control', createModelControlRouter({ db }));
        handle = await listen(app);

        // Unset → empty string means "the CLI's own default".
        await expect(requestJson(`${handle.baseUrl}/api/model-control/codex-default`))
            .resolves.toEqual({ status: 200, body: { model: '' } });

        await expect(requestJson(`${handle.baseUrl}/api/model-control/codex-default`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: 'gpt-5.5' })
        })).resolves.toEqual({ status: 200, body: { model: 'gpt-5.5' } });
        await expect(requestJson(`${handle.baseUrl}/api/model-control/codex-default`))
            .resolves.toEqual({ status: 200, body: { model: 'gpt-5.5' } });

        // Antigravity values are `agy models` display names.
        await expect(requestJson(`${handle.baseUrl}/api/model-control/antigravity-default`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: 'Gemini 3.1 Pro (High)' })
        })).resolves.toEqual({ status: 200, body: { model: 'Gemini 3.1 Pro (High)' } });

        // Empty clears back to the CLI default; non-strings are rejected.
        await expect(requestJson(`${handle.baseUrl}/api/model-control/antigravity-default`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: '' })
        })).resolves.toEqual({ status: 200, body: { model: '' } });
        const bad = await requestJson(`${handle.baseUrl}/api/model-control/codex-default`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: 42 })
        });
        expect(bad.status).toBe(400);
    });

    test('reads and updates per-model thinking levels', async () => {
        const settings = {};
        const db = {
            getModelControlSetting: jest.fn(async (key) => settings[key] ?? null),
            setModelControlSetting: jest.fn(async (key, value) => { settings[key] = value; return value; }),
        };
        const createModelControlRouter = require('../routes/model-control');
        const app = express();
        app.use(express.json());
        app.use('/api/model-control', createModelControlRouter({ db }));
        handle = await listen(app);

        // Seeded: Robert's two explicit picks are live before anything is stored.
        await expect(requestJson(`${handle.baseUrl}/api/model-control/thinking-levels`))
            .resolves.toEqual({
                status: 200,
                body: { levels: { 'claude-fable-5-1': 'low', 'claude-opus-5': 'xhigh' } }
            });

        // Single-model PUT.
        const set = await requestJson(`${handle.baseUrl}/api/model-control/thinking-levels`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: 'gpt-5.6-sol', level: 'high' })
        });
        expect(set.status).toBe(200);
        expect(set.body.levels['gpt-5.6-sol']).toBe('high');
        expect(set.body.levels['claude-opus-5']).toBe('xhigh');

        // An explicit empty level CLEARS a seeded default.
        const cleared = await requestJson(`${handle.baseUrl}/api/model-control/thinking-levels`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: 'claude-fable-5-1', level: '' })
        });
        expect(cleared.status).toBe(200);
        expect(cleared.body.levels['claude-fable-5-1']).toBeUndefined();

        // Whole-map PUT.
        const bulk = await requestJson(`${handle.baseUrl}/api/model-control/thinking-levels`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ levels: { 'claude-opus-5': 'max', 'claude-fable-5-1': 'low' } })
        });
        expect(bulk.status).toBe(200);
        expect(bulk.body.levels).toEqual({
            'claude-opus-5': 'max',
            'claude-fable-5-1': 'low',
            'gpt-5.6-sol': 'high',
        });

        // Validation: unknown level, and a level this model's backend rejects
        // (gpt-5.5 stops at xhigh — "max" would 400 the turn).
        const badLevel = await requestJson(`${handle.baseUrl}/api/model-control/thinking-levels`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: 'claude-opus-5', level: 'colossal' })
        });
        expect(badLevel.status).toBe(400);
        const tooHigh = await requestJson(`${handle.baseUrl}/api/model-control/thinking-levels`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: 'gpt-5.5', level: 'max' })
        });
        expect(tooHigh.status).toBe(400);
        const noModel = await requestJson(`${handle.baseUrl}/api/model-control/thinking-levels`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ level: 'high' })
        });
        expect(noModel.status).toBe(400);
    });

    test('reads and updates the Praxis chat backend', async () => {
        const settings = {};
        const db = {
            getModelControlSetting: jest.fn(async (key) => settings[key] ?? null),
            setModelControlSetting: jest.fn(async (key, value) => { settings[key] = value; return value; }),
        };
        const createModelControlRouter = require('../routes/model-control');
        const app = express();
        app.use(express.json());
        app.use('/api/model-control', createModelControlRouter({ db }));
        handle = await listen(app);

        // Unset → the permanent Claude session is the default.
        await expect(requestJson(`${handle.baseUrl}/api/model-control/chat-backend`))
            .resolves.toEqual({ status: 200, body: { backend: 'claude-code' } });

        await expect(requestJson(`${handle.baseUrl}/api/model-control/chat-backend`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ backend: 'codex' })
        })).resolves.toEqual({ status: 200, body: { backend: 'codex' } });
        await expect(requestJson(`${handle.baseUrl}/api/model-control/chat-backend`))
            .resolves.toEqual({ status: 200, body: { backend: 'codex' } });

        // "off" = legacy routed-LLM loop; anything else is rejected.
        await expect(requestJson(`${handle.baseUrl}/api/model-control/chat-backend`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ backend: 'off' })
        })).resolves.toEqual({ status: 200, body: { backend: 'off' } });
        const bad = await requestJson(`${handle.baseUrl}/api/model-control/chat-backend`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ backend: 'gemini' })
        });
        expect(bad.status).toBe(400);
    });

    test('reads and updates the chat config (backend + models + thinking level)', async () => {
        const settings = {};
        const db = {
            getModelControlSetting: jest.fn(async (key) => settings[key] ?? null),
            setModelControlSetting: jest.fn(async (key, value) => { settings[key] = value; return value; }),
        };
        const createModelControlRouter = require('../routes/model-control');
        const app = express();
        app.use(express.json());
        app.use('/api/model-control', createModelControlRouter({ db }));
        handle = await listen(app);

        // Unset → all defaults. Tiers are computed against the EFFECTIVE model
        // (empty override → the claude default, Opus 4.8), which supports the
        // extended reasoning set.
        const OPUS_TIERS = ['default', 'low', 'medium', 'high', 'xhigh', 'max'];
        await expect(requestJson(`${handle.baseUrl}/api/model-control/chat-config`))
            .resolves.toEqual({
                status: 200,
                body: {
                    backend: 'claude-code', claudeModel: '', codexModel: '',
                    thinkingLevel: 'default', thinkingTiers: OPUS_TIERS
                }
            });

        // Partial update: model + thinking level only — backend untouched.
        await expect(requestJson(`${handle.baseUrl}/api/model-control/chat-config`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ claudeModel: ' claude-fable-5 ', thinkingLevel: 'high' })
        })).resolves.toEqual({
            status: 200,
            body: {
                backend: 'claude-code', claudeModel: 'claude-fable-5', codexModel: '',
                thinkingLevel: 'high', thinkingTiers: OPUS_TIERS
            }
        });

        // Fable 5's deeper tiers round-trip without a 400 — the whole point of
        // the extended set.
        for (const level of ['xhigh', 'max']) {
            await expect(requestJson(`${handle.baseUrl}/api/model-control/chat-config`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ thinkingLevel: level })
            })).resolves.toMatchObject({ status: 200, body: { thinkingLevel: level } });
        }

        // Backend rides the SAME chat_backend key the /chat-backend route uses.
        await expect(requestJson(`${handle.baseUrl}/api/model-control/chat-config`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ backend: 'codex', codexModel: 'gpt-5.5' })
        })).resolves.toMatchObject({ status: 200, body: { backend: 'codex', codexModel: 'gpt-5.5' } });
        await expect(requestJson(`${handle.baseUrl}/api/model-control/chat-backend`))
            .resolves.toEqual({ status: 200, body: { backend: 'codex' } });

        // A bad field rejects WITHOUT applying any other field in the body.
        const bad = await requestJson(`${handle.baseUrl}/api/model-control/chat-config`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            // "ultra" used to be the invalid example here — it's a real codex
            // tier now (gpt-5.6-sol), so this needs a genuinely bogus value.
            body: JSON.stringify({ claudeModel: 'claude-opus-4-8', thinkingLevel: 'nonsense' })
        });
        expect(bad.status).toBe(400);
        // Backend is codex on gpt-5.5 now, which tops out at xhigh — so the
        // stored "max" (picked while on Fable 5) CLAMPS rather than being
        // forwarded. Sending it would 400 the codex turn at the OpenAI API.
        await expect(requestJson(`${handle.baseUrl}/api/model-control/chat-config`))
            .resolves.toMatchObject({
                status: 200,
                body: {
                    claudeModel: 'claude-fable-5',
                    thinkingLevel: 'default',
                    thinkingTiers: ['default', 'low', 'medium', 'high', 'xhigh']
                }
            });

        // Switching to a model that tops out at "high" CLAMPS the stored "max"
        // rather than handing Praxis a tier the backend would reject — codex
        // forwards this to the OpenAI API, which 400s an unsupported enum.
        await expect(requestJson(`${handle.baseUrl}/api/model-control/chat-config`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ backend: 'claude-code', claudeModel: 'claude-haiku-4-5-20251001' })
        })).resolves.toMatchObject({
            status: 200,
            body: { thinkingLevel: 'default', thinkingTiers: ['default', 'low', 'medium', 'high'] }
        });
    });

    test('an unnameable codex model falls back to the conservative tier floor', async () => {
        const settings = {};
        const db = {
            getModelControlSetting: jest.fn(async (key) => settings[key] ?? null),
            setModelControlSetting: jest.fn(async (key, value) => { settings[key] = value; return value; }),
        };
        const createModelControlRouter = require('../routes/model-control');
        const app = express();
        app.use(express.json());
        app.use('/api/model-control', createModelControlRouter({ db }));
        handle = await listen(app);

        // Codex with NO chat override and NO codex_default_model: the CLI picks
        // its own default, so we have no capability data for it. Praxis forwards
        // whatever we return verbatim, so offering the full union here could
        // send max/ultra to a model that 400s on it.
        const empty = await requestJson(`${handle.baseUrl}/api/model-control/chat-config`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ backend: 'codex', codexModel: '' })
        });
        expect(empty.status).toBe(200);
        expect(empty.body.thinkingTiers).toEqual(['default', 'low', 'medium', 'high']);
        for (const risky of ['xhigh', 'max', 'ultra']) {
            expect(empty.body.thinkingTiers).not.toContain(risky);
        }

        // Storing a deep tier while unnameable must CLAMP, not pass through.
        await expect(requestJson(`${handle.baseUrl}/api/model-control/chat-config`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ thinkingLevel: 'max' })
        })).resolves.toMatchObject({ status: 200, body: { thinkingLevel: 'default' } });

        // Naming the model re-opens its real tiers — the floor is a fallback,
        // not a cap.
        await expect(requestJson(`${handle.baseUrl}/api/model-control/chat-config`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ codexModel: 'gpt-5.6-sol', thinkingLevel: 'ultra' })
        })).resolves.toMatchObject({
            status: 200,
            body: {
                thinkingLevel: 'ultra',
                thinkingTiers: ['default', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']
            }
        });
    });

    test('serves the antigravity model roster', async () => {
        const createModelControlRouter = require('../routes/model-control');
        const app = express();
        app.use(express.json());
        app.use('/api/model-control', createModelControlRouter({ db: {} }));
        handle = await listen(app);

        // Point at a nonexistent binary so the fallback list is exercised
        // deterministically (no dependency on the local agy install in tests).
        const previousAgyBin = process.env.AGY_BIN;
        process.env.AGY_BIN = '/nonexistent/agy-for-tests';
        try {
            const res = await requestJson(`${handle.baseUrl}/api/model-control/antigravity-models`);
            expect(res.status).toBe(200);
            expect(Array.isArray(res.body.models)).toBe(true);
            expect(res.body.models.length).toBeGreaterThan(0);
            expect(res.body.models.every((m) => typeof m === 'string')).toBe(true);
        } finally {
            if (previousAgyBin === undefined) delete process.env.AGY_BIN;
            else process.env.AGY_BIN = previousAgyBin;
        }
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

    test('returns budget status from the existing usage ledger', async () => {
        const db = {
            getModelControlSetting: jest.fn(async () => ({
                enabled: true,
                budget: { dailyTokenLimit: 1000, providerLimits: { anthropic: { dailyTokenLimit: 200 } } }
            })),
            getProjectModelControlSetting: jest.fn(async () => null),
            getUsageStats: jest.fn(async () => [
                { model: 'claude-sonnet', input_tokens: 120, output_tokens: 90, total_tokens: 210 },
                { model: 'gemini-pro', input_tokens: 10, output_tokens: 5, total_tokens: 15 }
            ])
        };
        const createModelControlRouter = require('../routes/model-control');
        const app = express();
        app.use(express.json());
        app.use('/api/model-control', createModelControlRouter({ db }));
        handle = await listen(app);

        await expect(requestJson(`${handle.baseUrl}/api/model-control/budget-status`))
            .resolves.toEqual({
                status: 200,
                body: expect.objectContaining({
                    dailyTokensUsed: 225,
                    dailyTokenLimit: 1000,
                    exceeded: false,
                    byProvider: expect.objectContaining({
                        anthropic: expect.objectContaining({
                            dailyTokensUsed: 210,
                            dailyTokenLimit: 200,
                            exceeded: true
                        }),
                        google: expect.objectContaining({
                            dailyTokensUsed: 15,
                            exceeded: false
                        })
                    })
                })
            });
    });

    test('runs resolve-only and live model-control probes', async () => {
        const db = {
            getModelControlSetting: jest.fn(async () => null),
            getProjectModelControlSetting: jest.fn(async () => null),
            getModel: jest.fn(async () => ({
                id: 'local-llama',
                provider: 'local',
                api_model_id: 'llama3.2',
                name: 'Local Llama',
                capabilities: { chat: true, local: true },
                is_active: true,
                availability_status: 'available'
            })),
            getModels: jest.fn(async () => []),
            getModelAliases: jest.fn(async () => []),
            getProjectModelAliases: jest.fn(async () => []),
            getUsageStats: jest.fn(async () => []),
            createModelExecutionSnapshot: jest.fn(async (snapshot) => ({ id: 'snapshot-1', ...snapshot })),
        };
        const callAI = jest.fn(async () => ({
            text: 'probe ok',
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        }));
        const createModelControlRouter = require('../routes/model-control');
        const app = express();
        app.use(express.json());
        app.use('/api/model-control', createModelControlRouter({ db, callAI }));
        handle = await listen(app);

        await expect(requestJson(`${handle.baseUrl}/api/model-control/probe`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode: 'resolve', model_assignment: 'model:local-llama', projectId: 'project-1' })
        })).resolves.toEqual({
            status: 200,
            body: expect.objectContaining({
                mode: 'resolve',
                live: false,
                resolved: expect.objectContaining({
                    resolvedModelId: 'local-llama',
                    provider: 'local',
                    apiModelId: 'llama3.2'
                })
            })
        });
        expect(callAI).not.toHaveBeenCalled();
        expect(db.createModelExecutionSnapshot).not.toHaveBeenCalled();

        await expect(requestJson(`${handle.baseUrl}/api/model-control/probe`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode: 'live', model_assignment: 'model:local-llama', projectId: 'project-1', prompt: 'Say probe ok.' })
        })).resolves.toEqual({
            status: 200,
            body: expect.objectContaining({
                mode: 'live',
                live: true,
                response: 'probe ok',
                snapshot: expect.objectContaining({ id: 'snapshot-1', project_id: 'project-1' }),
                resolved: expect.objectContaining({
                    resolvedModelId: 'local-llama',
                    provider: 'local'
                })
            })
        });
        expect(callAI).toHaveBeenCalledWith(
            expect.objectContaining({ provider: 'local', apiModelId: 'llama3.2' }),
            'Say probe ok.',
            expect.any(String),
            [],
            { returnFullResult: true }
        );
        expect(db.createModelExecutionSnapshot).toHaveBeenCalledWith(expect.objectContaining({
            requested_assignment: 'model:local-llama',
            resolved_model_id: 'local-llama',
            provider: 'local',
            project_id: 'project-1',
            command_id: 'model-control-probe'
        }));
    });
});
