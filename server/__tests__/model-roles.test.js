const { resolveModelAssignment } = require('../services/model-control');

// Hermetic mock db covering only what the resolver path touches.
const MODELS = {
    'local-gemma-4-31b': { id: 'local-gemma-4-31b', provider: 'local', api_model_id: 'google/gemma-4-31b', is_active: 1 },
    'google-gemini-pro': { id: 'google-gemini-pro', provider: 'google', api_model_id: 'gemini-3.1-pro-preview', is_active: 1 },
};
const ALIASES = [
    { alias: 'local_default', target: 'model:local-gemma-4-31b', is_active: 1 },
    { alias: 'gemini_default', target: 'model:google-gemini-pro', is_active: 1 },
];
const ROLES = {
    'ingestion.extract': { role: 'ingestion.extract', assignment: 'alias:local_default', is_active: 1 },
    'ingestion.summary': { role: 'ingestion.summary', assignment: 'alias:gemini_default', is_active: 1 },
    'inactive.role': { role: 'inactive.role', assignment: 'alias:gemini_default', is_active: 0 },
};

function makeDb(localOnly = { enabled: false }) {
    return {
        getModelControlSetting: async (k) => (k === 'local_only' ? localOnly : null),
        getProjectModelControlSetting: async () => null,
        getModelRole: async (r) => ROLES[r] || null,
        getModelAliases: async () => ALIASES,
        getProjectModelAliases: async () => [],
        getModel: async (id) => MODELS[id] || null,
        getModels: async () => Object.values(MODELS),
    };
}

describe('model-control role resolution', () => {
    beforeAll(() => { process.env.GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || 'test-key'; });

    test('local-first role resolves to local', async () => {
        const r = await resolveModelAssignment(makeDb(), { role: 'ingestion.extract' });
        expect(r.provider).toBe('local');
    });

    test('Gemini-allowlist role resolves to google', async () => {
        const r = await resolveModelAssignment(makeDb(), { role: 'ingestion.summary' });
        expect(r.provider).toBe('google');
        expect(r.apiModelId).toBe('gemini-3.1-pro-preview');
    });

    test('unknown role falls back to local-first default', async () => {
        const r = await resolveModelAssignment(makeDb(), { role: 'does.not.exist' });
        expect(r.provider).toBe('local');
    });

    test('inactive role falls back to local-first default', async () => {
        const r = await resolveModelAssignment(makeDb(), { role: 'inactive.role' });
        expect(r.provider).toBe('local');
    });

    test('explicit assignment overrides the role', async () => {
        const r = await resolveModelAssignment(makeDb(), { role: 'ingestion.extract', model_assignment: 'alias:gemini_default' });
        expect(r.provider).toBe('google');
    });

    test('local-only kill switch forces a Gemini role to local', async () => {
        const r = await resolveModelAssignment(makeDb({ enabled: true, reason: 'test' }), { role: 'ingestion.summary' });
        expect(r.provider).toBe('local');
    });
});
