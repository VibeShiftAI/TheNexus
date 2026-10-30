/**
 * Prices and the free OpenRouter list come from the catalog Praxis writes;
 * these tests read the fixture catalog (setup-model-registry.js points
 * PRAXIS_OPENROUTER_CATALOG_PATH at fixtures/openrouter-catalog.json).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const { FIXTURE_EXECUTORS, useModelRegistryFixture } = require('./fixtures/model-registry');
const prices = require('../services/model-prices');

const CLAUDE_CODE = {
    executor: 'claude-code',
    source: 'fixture',
    models: [
        { id: 'claude-opus-5-5', label: 'Opus 5.5', efforts: ['low', 'medium', 'high'], listed: true, current: true },
        { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', efforts: ['low', 'medium', 'high'], listed: true, current: true },
        { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', efforts: [], listed: true, current: false },
        { id: 'claude-opus-5', label: 'Opus 5', efforts: [], listed: true, current: false },
    ],
};

describe('model prices from the OpenRouter catalog', () => {
    let cleanup;
    beforeEach(() => {
        cleanup = useModelRegistryFixture({ ...FIXTURE_EXECUTORS, 'claude-code': CLAUDE_CODE });
        prices.resetModelPricesCache();
    });
    afterEach(() => {
        cleanup();
        prices.resetModelPricesCache();
    });

    test.each([
        ['claude-opus-5-5', 'anthropic/claude-opus-5.5'],
        ['claude-opus-5', 'anthropic/claude-opus-5'],
        ['claude-haiku-4-5-20251001', 'anthropic/claude-haiku-4.5'],
        ['claude-sonnet-5-5[1m]', 'anthropic/claude-sonnet-5.5'],
        ['Claude-Opus-5-5', 'anthropic/claude-opus-5.5'],
        ['gpt-6-astra', 'openai/gpt-6-astra'],
        ['gpt-6.1-sol', 'openai/gpt-6.1-sol'],
        ['gemini-4-argon', 'google/gemini-4-argon'],
        ['gemini-4-argon-high', 'google/gemini-4-argon'],
        ['Gemini 4 Argon (High)', 'google/gemini-4-argon'],
        ['openai/gpt-4o', 'openai/gpt-4o'],
        ['codex/gpt-6-astra', 'openai/gpt-6-astra'],
        ['claude-code/claude-opus-5-5', 'anthropic/claude-opus-5.5'],
        ['opus', 'anthropic/claude-opus-5.5'],
        ['claude-sonnet', 'anthropic/claude-sonnet-5.5'],
    ])('%s maps to %s', (value, slug) => {
        expect(prices.openRouterSlugFor(value)).toBe(slug);
    });

    test.each(['codex', 'google/gemma-4-31b-qat', 'local-default', 'llama3.2', '', null])(
        '%s has no slug and no price', (value) => {
            expect(prices.openRouterSlugFor(value)).toBeNull();
            expect(prices.priceForModel(value)).toBeNull();
        });

    test('a bare family word with no current model of that line is unpriced', () => {
        expect(prices.openRouterSlugFor('haiku')).toBeNull();
    });

    test('prices carry the catalog rates, cache rates only when listed', () => {
        expect(prices.priceForModel('claude-opus-5-5')).toEqual({
            in: 4, out: 20, cacheRead: 0.2, cacheWrite: 5, slug: 'anthropic/claude-opus-5.5',
        });
        expect(prices.priceForModel('openai/gpt-4o')).toEqual({
            in: 2.5, out: 10, cacheRead: 1.25, slug: 'openai/gpt-4o',
        });
    });

    test('a slug the catalog does not price is unpriced', () => {
        expect(prices.openRouterSlugFor('gpt-9-unlisted')).toBe('openai/gpt-9-unlisted');
        expect(prices.priceForModel('gpt-9-unlisted')).toBeNull();
    });

    test('the free lane comes back in preference order', () => {
        expect(prices.freeLaneModels().map((m) => m.slug)).toEqual([
            'nvidia/nemotron-3-ultra-550b-a55b:free',
            'poolside/laguna-s-2.1:free',
            'cohere/north-mini-code:free',
            'openrouter/free',
        ]);
    });
});

describe('model prices without a usable catalog', () => {
    const original = process.env.PRAXIS_OPENROUTER_CATALOG_PATH;
    let dir;
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-model-prices-'));
        prices.resetModelPricesCache();
    });
    afterEach(() => {
        process.env.PRAXIS_OPENROUTER_CATALOG_PATH = original;
        prices.resetModelPricesCache();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('a missing file prices nothing and lists no free models', () => {
        process.env.PRAXIS_OPENROUTER_CATALOG_PATH = path.join(dir, 'absent.json');
        expect(prices.readOpenRouterCatalog()).toBeNull();
        expect(prices.priceForModel('claude-opus-5-5')).toBeNull();
        expect(prices.freeLaneModels()).toEqual([]);
        expect(prices.catalogSource()).toMatch(/no OpenRouter catalog yet/);
    });

    test('a catalog written before prices existed (verdicts only) prices nothing', () => {
        const file = path.join(dir, 'catalog.json');
        fs.writeFileSync(file, JSON.stringify({ fetchedAt: 1793242992632, verdicts: { 'openrouter/free': 'free' } }));
        process.env.PRAXIS_OPENROUTER_CATALOG_PATH = file;
        expect(prices.priceForModel('claude-opus-5-5')).toBeNull();
        expect(prices.freeLaneModels()).toEqual([]);
        expect(prices.catalogSource()).toMatch(/^OpenRouter catalog 2026-/);
    });
});

describe('CLI role assignments from the registry', () => {
    test('offers each CLI default, then every current model with its efforts', () => {
        const cleanup = useModelRegistryFixture({ ...FIXTURE_EXECUTORS, 'claude-code': CLAUDE_CODE });
        try {
            const options = require('../services/model-registry').cliAssignmentOptions();
            const values = options.map((o) => o.value);
            expect(values[0]).toBe('cli:claude-code');
            expect(values).toEqual(expect.arrayContaining([
                'cli:claude-code/claude-opus-5-5', 'cli:codex/gpt-6-astra', 'cli:antigravity/gemini-4-argon',
            ]));
            // Older models (current: false) and hidden ones are not offered.
            expect(values).not.toContain('cli:claude-code/claude-opus-5');
            expect(values).not.toContain('cli:codex/gpt-reserve');
            expect(options.find((o) => o.value === 'cli:codex/gpt-6-astra'))
                .toEqual({ value: 'cli:codex/gpt-6-astra', label: 'GPT-6 Astra (Codex)', backend: 'codex', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] });
        } finally {
            cleanup();
        }
    });
});
