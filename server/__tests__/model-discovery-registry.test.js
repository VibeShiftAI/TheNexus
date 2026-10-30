/**
 * Model rows come from the files Praxis writes (CLI registry and OpenRouter
 * catalog fixtures here); no vendor model-listing API is called.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

function fakeDb(rows) {
    const byId = new Map(rows.map(r => [r.id, { ...r }]));
    return {
        rows: byId,
        getModels: jest.fn(async () => [...byId.values()].map(r => ({ ...r }))),
        upsertModel: jest.fn(async record => {
            const merged = { ...(byId.get(record.id) || {}), ...record };
            byId.set(record.id, merged);
            return { ...merged };
        }),
    };
}

const STALE_AND_CURRENT_ROWS = [
    { id: 'openrouter-ox-alpha', name: 'Ox Alpha', provider: 'openrouter', api_model_id: 'stealth/ox-alpha', is_active: 1, created_at: '2026-08-25' },
    { id: 'openrouter-nemotron-ultra', name: 'Nemotron 3 Ultra', display_name: 'Nemotron 3 Ultra 550B (free)', provider: 'openrouter',
      api_model_id: 'nvidia/nemotron-3-ultra-550b-a55b:free', family: 'Nemotron', sort_order: 11, is_active: 1,
      capabilities: { reasoning: true, tools: true }, default_parameters: { max_tokens: 4096 }, discovered_at: '2026-08-25', created_at: '2026-08-25' },
    { id: 'openrouter-glm', name: 'GLM 5.2', provider: 'openrouter', api_model_id: 'z-ai/glm-5.2:free', is_active: 1 },
    { id: 'local-gemma-4-31b', name: 'Gemma 4 31B QAT', provider: 'local', api_model_id: 'google/gemma-4-31b-qat', is_active: 1 },
];

describe('model source sync', () => {
    const originalFetch = global.fetch;
    let cleanupRegistry;

    beforeEach(() => {
        jest.resetModules();
        global.fetch = jest.fn(async () => { throw new Error('no network in this test'); });
        cleanupRegistry = require('./fixtures/model-registry').useModelRegistryFixture();
    });

    afterEach(() => {
        cleanupRegistry();
        global.fetch = originalFetch;
    });

    test('upserts the free lane, marks withdrawn OpenRouter rows inactive, and calls no vendor API', async () => {
        const db = fakeDb(STALE_AND_CURRENT_ROWS);
        const { syncModelSources, getModels } = require('../services/model-discovery');

        const result = await syncModelSources({ db });

        expect(global.fetch).not.toHaveBeenCalled();
        expect(result.providers).toEqual(expect.arrayContaining([
            expect.objectContaining({ provider: 'cli registry', status: 'ok' }),
            expect.objectContaining({ provider: 'openrouter', status: 'ok', rawCount: 4, modelCount: 4 }),
        ]));
        expect(result.deactivated).toBe(2);

        // The existing row is reused by slug, keeping its tuning and display name.
        expect(db.rows.get('openrouter-nemotron-ultra')).toMatchObject({
            is_active: 1, name: 'Nemotron 3 Ultra', display_name: 'Nemotron 3 Ultra 550B (free)',
            default_parameters: { max_tokens: 4096 }, created_at: '2026-08-25',
        });
        // New free models get rows.
        expect(db.rows.get('openrouter-poolside-laguna-s-2-1')).toMatchObject({
            provider: 'openrouter', api_model_id: 'poolside/laguna-s-2.1:free', name: 'Laguna S 2.1', is_active: 1,
        });
        expect(db.rows.get('openrouter-openrouter-free')).toMatchObject({ api_model_id: 'openrouter/free', is_active: 1 });
        // Withdrawn slugs are kept but inactive; local rows are untouched.
        expect(db.rows.get('openrouter-ox-alpha')).toMatchObject({ is_active: 0, created_at: '2026-08-25' });
        expect(db.rows.get('openrouter-glm').is_active).toBe(0);
        expect(db.rows.get('local-gemma-4-31b').is_active).toBe(1);
        // GET /api/models serves what the sync produced.
        expect(getModels().map(m => m.apiModelId)).toEqual([
            'nvidia/nemotron-3-ultra-550b-a55b:free', 'poolside/laguna-s-2.1:free', 'cohere/north-mini-code:free', 'openrouter/free',
        ]);
    });

    test('a catalog without a free-lane list leaves the rows alone', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-sync-'));
        const file = path.join(dir, 'catalog.json');
        fs.writeFileSync(file, JSON.stringify({ fetchedAt: 1793242992632, verdicts: {} }));
        const previous = process.env.PRAXIS_OPENROUTER_CATALOG_PATH;
        process.env.PRAXIS_OPENROUTER_CATALOG_PATH = file;
        try {
            const db = fakeDb(STALE_AND_CURRENT_ROWS);
            const { syncModelSources } = require('../services/model-discovery');
            const result = await syncModelSources({ db });
            expect(db.upsertModel).not.toHaveBeenCalled();
            expect(result.providers.find(p => p.provider === 'openrouter')).toMatchObject({ status: 'skipped' });
            expect(result.deactivated).toBe(0);
        } finally {
            process.env.PRAXIS_OPENROUTER_CATALOG_PATH = previous;
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('maps free-text model slugs to the right tier set', () => {
        const { thinkingTiersForModelId, ALL_THINKING_TIERS } = require('../services/model-discovery');
        // Codex efforts come from the model registry Praxis builds from the CLI's own list.
        const cleanup = require('./fixtures/model-registry').useModelRegistryFixture();
        try {

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
        // 2026-09-06 roster: gpt-6-astra leads the codex roster and reports
        // every tier through "ultra". Without its exact row the /^gpt-/
        // guard below handed it the conservative three, so the strict codex
        // backend was offered a NARROWER set than the model really supports.
        expect(thinkingTiersForModelId('gpt-6-astra'))
            .toEqual(['default', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
        // gpt-5.4 left the roster the same day: a stale pin gets the
        // conservative set, never a tier set nobody can vouch for any more.
        expect(thinkingTiersForModelId('gpt-5.4')).toEqual(CONSERVATIVE);
        // Hidden / api-less roster entries keep exact rows for hand-typed slugs.
        expect(thinkingTiersForModelId('codex-auto-review'))
            .toEqual(['default', 'low', 'medium', 'high', 'xhigh', 'max']);
        expect(thinkingTiersForModelId('gpt-5.3-codex-spark'))
            .toEqual(['default', 'low', 'medium', 'high', 'xhigh']);
        // The validation whitelist is the CLIs' effort vocabulary.
        expect(ALL_THINKING_TIERS).toEqual(['default', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
        // No current model offers "minimal", despite the API enum allowing it.
        for (const slug of ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.5', 'gpt-5.4']) {
            expect(thinkingTiersForModelId(slug)).not.toContain('minimal');
        }
        // An unrecognised gpt-* must not inherit a sibling's tiers.
        expect(thinkingTiersForModelId('gpt-5-codex')).toEqual(CONSERVATIVE);
        expect(thinkingTiersForModelId('gpt-9-unreleased')).toEqual(CONSERVATIVE);

        // Empty = "the CLI's own default", which we can't name.
        expect(thinkingTiersForModelId('')).toBeNull();
        // Unknown slugs stay conservative — never offer a tier we can't vouch for.
        expect(thinkingTiersForModelId('some-unknown-model')).toEqual(CONSERVATIVE);
        } finally {
            cleanup();
        }
    });
});
