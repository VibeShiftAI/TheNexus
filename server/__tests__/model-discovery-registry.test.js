function jsonResponse(body) {
    return {
        ok: true,
        json: jest.fn(async () => body)
    };
}

describe('model discovery registry upsert', () => {
    const originalEnv = process.env;
    const originalFetch = global.fetch;

    beforeEach(() => {
        jest.resetModules();
        process.env = {
            ...originalEnv,
            GOOGLE_API_KEY: 'google-key',
            OPENAI_API_KEY: 'openai-key',
            ANTHROPIC_API_KEY: 'anthropic-key',
            XAI_API_KEY: 'xai-key'
        };
        global.fetch = jest.fn()
            .mockResolvedValueOnce(jsonResponse({ models: [{ name: 'models/gemini-3-pro' }, { name: 'models/gemini-2-pro' }] }))
            .mockResolvedValueOnce(jsonResponse({ data: [{ id: 'gpt-5' }, { id: 'gpt-4.1-mini' }] }))
            .mockResolvedValueOnce(jsonResponse({ data: [{ id: 'claude-sonnet-4-6' }] }))
            .mockResolvedValueOnce(jsonResponse({ data: [{ id: 'grok-4' }] }));
    });

    afterEach(() => {
        process.env = originalEnv;
        global.fetch = originalFetch;
    });

    test('upserts discovered models with durable registry fields', async () => {
        const db = {
            getModel: jest.fn(async () => null),
            upsertModel: jest.fn(async record => record)
        };
        const { discoverModels } = require('../services/model-discovery');

        const models = await discoverModels({ db });

        expect(models.length).toBeGreaterThan(0);
        expect(db.upsertModel).toHaveBeenCalledWith(expect.objectContaining({
            id: 'google-gemini-pro',
            provider: 'google',
            api_model_id: 'gemini-3-pro',
            display_name: 'Gemini 3 Pro',
            family: 'Gemini Pro',
            capabilities: expect.objectContaining({ chat: true }),
            default_parameters: expect.any(Object),
            availability_status: 'available',
            is_active: 1,
            discovered_at: expect.any(String),
            last_seen_at: expect.any(String)
        }));
    });
});
