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
    'agent.interactive': { role: 'agent.interactive', assignment: 'cli:claude-code/claude-sonnet-5@low', is_active: 1 },
    'brain.chat': { role: 'brain.chat', assignment: 'cli:claude-code/claude-opus-4-8@high', is_active: 1 },
    'agent.epistemic': { role: 'agent.epistemic', assignment: 'alias:gemini_default', is_active: 1 },
    'bad.cli': { role: 'bad.cli', assignment: 'cli:not-a-backend/whatever', is_active: 1 },
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

    // ── CLI subscription lane (task 0a62d8a6) ────────────────────────────
    test('cli: assignment resolves to the CLI lane with per-role model + thinking', async () => {
        const r = await resolveModelAssignment(makeDb(), { role: 'agent.interactive' });
        expect(r.provider).toBe('cli');
        expect(r.apiModelId).toBe('claude-sonnet-5');
        expect(r.cli).toEqual({ backend: 'claude-code', model: 'claude-sonnet-5', thinking: 'low' });
        expect(r.parameters.thinking_level).toBe('low');
        expect(r.label).toContain('claude-sonnet-5');
        expect(r.label).toContain('low thinking');
    });

    test('cli: assignment carries a different model/thinking per role', async () => {
        const r = await resolveModelAssignment(makeDb(), { role: 'brain.chat' });
        expect(r.provider).toBe('cli');
        expect(r.cli).toEqual({ backend: 'claude-code', model: 'claude-opus-4-8', thinking: 'high' });
    });

    test('retained sampler roles still resolve to the Gemini API, not the lane', async () => {
        const r = await resolveModelAssignment(makeDb(), { role: 'agent.epistemic' });
        expect(r.provider).toBe('google');
        expect(r.cli).toBeUndefined();
    });

    test('cli: assignment with an unknown backend falls back to local, not an error', async () => {
        const r = await resolveModelAssignment(makeDb(), { role: 'bad.cli' });
        expect(r.provider).toBe('local');
        expect(r.fallbackUsed).toBe(true);
    });

    test('local-only kill switch overrides the CLI lane too', async () => {
        const r = await resolveModelAssignment(makeDb({ enabled: true, reason: 'test' }), { role: 'agent.interactive' });
        expect(r.provider).toBe('local');
    });
});
