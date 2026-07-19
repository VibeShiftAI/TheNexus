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
        const { discoverModels, discoverModelRegistry } = require('../services/model-discovery');

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

        global.fetch = jest.fn()
            .mockResolvedValueOnce(jsonResponse({ models: [{ name: 'models/gemini-3-pro' }] }))
            .mockResolvedValueOnce(jsonResponse({ data: [{ id: 'gpt-5' }] }))
            .mockResolvedValueOnce(jsonResponse({ data: [{ id: 'claude-sonnet-4-6' }] }))
            .mockResolvedValueOnce(jsonResponse({ data: [{ id: 'grok-4' }] }));

        const result = await discoverModelRegistry({ db });

        expect(result.models.length).toBeGreaterThan(0);
        expect(result.providers).toEqual(expect.arrayContaining([
            expect.objectContaining({ provider: 'google', status: 'ok', rawCount: 1, modelCount: 1 }),
            expect.objectContaining({ provider: 'openai', status: 'ok', rawCount: 1, modelCount: 1 }),
            expect.objectContaining({ provider: 'anthropic', status: 'ok', rawCount: 1, modelCount: 1 }),
            expect.objectContaining({ provider: 'xai', status: 'ok', rawCount: 1, modelCount: 1 }),
        ]));
        expect(result.summary.google).toBe('1 models (from 1 raw)');
        expect(result.elapsedMs).toEqual(expect.any(Number));
        expect(result.discoveredAt).toEqual(expect.any(String));
    });

    test('attaches per-model reasoning-effort tiers to every roster entry', async () => {
        const db = { getModel: jest.fn(async () => null), upsertModel: jest.fn(async r => r) };
        const { discoverModels } = require('../services/model-discovery');

        const models = await discoverModels({ db });

        // Every entry carries tiers, always led by the "no flag" sentinel.
        expect(models.length).toBeGreaterThan(0);
        for (const model of models) {
            expect(Array.isArray(model.thinkingTiers)).toBe(true);
            expect(model.thinkingTiers[0]).toBe('default');
        }

        // Sonnet 4.6 predates the extended tiers. "gpt-5" is not a slug codex
        // can run at all, so it gets the conservative set rather than a
        // sibling's — offering an unsupported effort 400s the turn.
        const sonnet = models.find(m => m.family === 'Claude Sonnet');
        expect(sonnet.thinkingTiers).toEqual(['default', 'low', 'medium', 'high']);
        const gpt = models.find(m => m.family === 'GPT');
        expect(gpt.thinkingTiers).toEqual(['default', 'low', 'medium', 'high']);

        // Tiers persist into the registry so db readers see them too.
        expect(db.upsertModel).toHaveBeenCalledWith(expect.objectContaining({
            capabilities: expect.objectContaining({ thinkingTiers: expect.any(Array) })
        }));
    });

    test('maps free-text model slugs to the right tier set', () => {
        const { thinkingTiersForModelId } = require('../services/model-discovery');

        const CLAUDE_EXTENDED = ['default', 'low', 'medium', 'high', 'xhigh', 'max'];
        const CONSERVATIVE = ['default', 'low', 'medium', 'high'];

        // Claude: the CLI takes the same five levels everywhere, so only the
        // generation floor varies. Fable is extended at every version.
        expect(thinkingTiersForModelId('claude-fable-5')).toEqual(CLAUDE_EXTENDED);
        expect(thinkingTiersForModelId('claude-opus-4-8')).toEqual(CLAUDE_EXTENDED);
        expect(thinkingTiersForModelId('claude-opus-4-6')).toEqual(CONSERVATIVE);
        expect(thinkingTiersForModelId('claude-haiku-4-5-20251001')).toEqual(CONSERVATIVE);

        // OpenAI: EXACT per-slug sets, straight from codex's own model
        // metadata. Version ranges are wrong here in both directions —
        // 5.5 stops at xhigh while 5.6-sol goes one past max to "ultra" — and
        // offering a tier the model lacks gets the codex turn 400'd.
        expect(thinkingTiersForModelId('gpt-5.6-sol'))
            .toEqual(['default', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
        expect(thinkingTiersForModelId('gpt-5.6-luna'))
            .toEqual(['default', 'low', 'medium', 'high', 'xhigh', 'max']);
        expect(thinkingTiersForModelId('gpt-5.5')).toEqual(['default', 'low', 'medium', 'high', 'xhigh']);
        expect(thinkingTiersForModelId('gpt-5.4-mini')).toEqual(['default', 'low', 'medium', 'high', 'xhigh']);
        // No current model offers "minimal", despite the API enum allowing it.
        for (const slug of ['gpt-5.6-sol', 'gpt-5.5', 'gpt-5.4']) {
            expect(thinkingTiersForModelId(slug)).not.toContain('minimal');
        }
        // An unrecognised gpt-* must not inherit a sibling's tiers.
        expect(thinkingTiersForModelId('gpt-5-codex')).toEqual(CONSERVATIVE);
        expect(thinkingTiersForModelId('gpt-9-unreleased')).toEqual(CONSERVATIVE);

        // Empty = "the CLI's own default", which we can't name.
        expect(thinkingTiersForModelId('')).toBeNull();
        // Unknown slugs stay conservative — never offer a tier we can't vouch for.
        expect(thinkingTiersForModelId('some-unknown-model')).toEqual(CONSERVATIVE);
    });
});
