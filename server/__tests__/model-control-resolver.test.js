function createStubDb() {
    const models = [
        {
            id: 'anthropic-claude-sonnet',
            provider: 'anthropic',
            api_model_id: 'claude-sonnet-4-6',
            name: 'Claude Sonnet',
            family: 'claude-sonnet',
            version_sort: '2026-05-01',
            capabilities: { coding: true },
            parameters: { temperature: 0.2 },
            default_parameters: { max_tokens: 8192 },
            availability_status: 'available',
            is_active: true
        },
        {
            id: 'google-gemini-2-pro',
            provider: 'google',
            api_model_id: 'gemini-2-pro',
            name: 'Gemini 2 Pro',
            family: 'gemini-pro',
            version_sort: '2025-01-01',
            capabilities: { coding: true },
            availability_status: 'available',
            is_active: true
        },
        {
            id: 'google-gemini-3-pro',
            provider: 'google',
            api_model_id: 'gemini-3-pro',
            name: 'Gemini 3 Pro',
            family: 'gemini-pro',
            version_sort: '2026-01-01',
            capabilities: { coding: true },
            availability_status: 'available',
            is_active: true
        },
        {
            id: 'openai-stale',
            provider: 'openai',
            api_model_id: 'gpt-stale',
            name: 'Stale GPT',
            family: 'gpt',
            version_sort: '2024-01-01',
            capabilities: { coding: true },
            availability_status: 'unavailable',
            is_active: true
        },
        {
            id: 'local-llama',
            provider: 'local',
            api_model_id: 'llama3.2',
            name: 'Local Llama',
            family: 'local',
            version_sort: '2025-01-01',
            capabilities: { local: true, coding: true },
            availability_status: 'available',
            is_active: true
        }
    ];

    return {
        getModelControlSetting: jest.fn().mockResolvedValue(null),
        getModel: jest.fn(async (id) => models.find(m => m.id === id) || null),
        getModels: jest.fn(async () => models),
        getModelAliases: jest.fn(async () => [
            { alias: 'coder', target: 'model:google-gemini-2-pro', is_active: true },
            { alias: 'local_default', target: 'model:local-llama', is_active: true }
        ]),
        getProjectModelAliases: jest.fn(async () => [
            { alias: 'coder', target: 'model:anthropic-claude-sonnet' }
        ]),
        createModelExecutionSnapshot: jest.fn(async (snapshot) => ({ id: 'snapshot-1', ...snapshot }))
    };
}

describe('model control resolver', () => {
    const originalEnv = process.env;

    beforeEach(() => {
        jest.resetModules();
        process.env = {
            ...originalEnv,
            ANTHROPIC_API_KEY: 'test-anthropic',
            GOOGLE_API_KEY: 'test-google'
        };
    });

    afterEach(() => {
        process.env = originalEnv;
    });

    test('resolves item model assignment to provider call config', async () => {
        const { resolveModelAssignment } = require('../services/model-control');
        const resolved = await resolveModelAssignment(createStubDb(), {
            model_assignment: 'model:anthropic-claude-sonnet'
        });

        expect(resolved).toEqual(expect.objectContaining({
            requestedAssignment: 'model:anthropic-claude-sonnet',
            resolvedModelId: 'anthropic-claude-sonnet',
            provider: 'anthropic',
            apiModelId: 'claude-sonnet-4-6',
            source: 'item'
        }));
        expect(resolved.parameters).toEqual(expect.objectContaining({ temperature: 0.2, max_tokens: 8192 }));
    });

    test('uses project alias before global alias', async () => {
        const { resolveModelAssignment } = require('../services/model-control');
        const resolved = await resolveModelAssignment(createStubDb(), {
            project_id: 'project-1',
            model_assignment: 'alias:coder'
        });

        expect(resolved.resolvedModelId).toBe('anthropic-claude-sonnet');
        expect(resolved.source).toBe('project_alias');
    });

    test('uses family_latest newest active model by version_sort', async () => {
        const { resolveModelAssignment } = require('../services/model-control');
        const resolved = await resolveModelAssignment(createStubDb(), {
            model_assignment: 'family_latest:google/gemini-pro'
        });

        expect(resolved.resolvedModelId).toBe('google-gemini-3-pro');
        expect(resolved.apiModelId).toBe('gemini-3-pro');
    });

    test('global local-only mode forces local model and preserves requested assignment', async () => {
        const db = createStubDb();
        db.getModelControlSetting.mockResolvedValue({ enabled: true, reason: 'budget_limit' });
        const { resolveModelAssignment } = require('../services/model-control');

        const resolved = await resolveModelAssignment(db, {
            model_assignment: 'model:anthropic-claude-sonnet'
        });

        expect(resolved).toEqual(expect.objectContaining({
            requestedAssignment: 'model:anthropic-claude-sonnet',
            resolvedModelId: 'local-llama',
            provider: 'local',
            apiModelId: 'llama3.2',
            source: 'local_only',
            localOnlyActive: true,
            localOnlyReason: 'budget_limit'
        }));
    });

    test('unavailable target falls through fallback chain', async () => {
        const { resolveModelAssignment } = require('../services/model-control');
        const resolved = await resolveModelAssignment(createStubDb(), {
            model_assignment: 'fallback_chain:["model:openai-stale","model:anthropic-claude-sonnet"]'
        });

        expect(resolved.resolvedModelId).toBe('anthropic-claude-sonnet');
        expect(resolved.fallbackUsed).toBe(true);
        expect(resolved.fallbackReason).toMatch(/unavailable/i);
    });
});
