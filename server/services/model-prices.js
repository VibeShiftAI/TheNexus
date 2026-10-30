/**
 * Model prices and the free OpenRouter list, read from the catalog Praxis keeps.
 *
 * Praxis is the single producer: src/llm/openrouter-free.ts fetches
 * OpenRouter's public model list (`GET /api/v1/models`) for its free-model
 * price guard and writes data/openrouter-catalog.json, refreshed each morning
 * and whenever the free lane runs. Besides the free/paid verdicts it records
 * each model's $/MTok (`prices`) and Praxis's free roster filtered to slugs
 * the catalog lists as free (`freeLane`). The Nexus reads that file instead of
 * keeping its own price tables (2026-10-30: two hand tables had drifted, so
 * Opus 5.5, Sonnet 5.5 and GPT-6.x had no price and Sonnet 5 was overstated).
 *
 * A model the catalog does not price is unpriced (null), never given an
 * invented default rate. Prices are notional for subscription CLI runs: the
 * API-equivalent value of the work, not a bill.
 *
 * PRAXIS_OPENROUTER_CATALOG_PATH overrides the location (tests point it at a fixture).
 */
const fs = require('fs');

const modelRegistry = require('./model-registry');

const DEFAULT_CATALOG_PATH = '/Volumes/Projects/Praxis/data/openrouter-catalog.json';

function catalogPath() {
    const fromEnv = process.env.PRAXIS_OPENROUTER_CATALOG_PATH;
    return typeof fromEnv === 'string' && fromEnv.trim() ? fromEnv.trim() : DEFAULT_CATALOG_PATH;
}

let cached = null; // { file, mtimeMs, catalog }

/** The catalog, re-read only when the file changes; null when Praxis has not written one. */
function readOpenRouterCatalog() {
    const file = catalogPath();
    let mtimeMs;
    try { mtimeMs = fs.statSync(file).mtimeMs; } catch { return null; }
    if (cached && cached.file === file && cached.mtimeMs === mtimeMs) return cached.catalog;
    let catalog = null;
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
        if (parsed && typeof parsed === 'object' && typeof parsed.fetchedAt === 'number') catalog = parsed;
    } catch (error) {
        console.warn('[ModelPrices] unreadable catalog file:', error.message);
    }
    cached = { file, mtimeMs, catalog };
    return catalog;
}

const CLAUDE_ID = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/;
const CLAUDE_FAMILIES = ['opus', 'sonnet', 'haiku', 'fable'];
// Praxis records CLI-lane calls as "<backend>/<model>" (e.g. "codex/gpt-6-astra").
const CLI_BACKEND_PREFIX = /^(claude-code|codex|antigravity)\//;

function claudeVersion(id) {
    const m = String(id).match(CLAUDE_ID);
    return m ? { line: m[1], version: [Number(m[2]), Number(m[3] || 0)], dated: /-\d{8}$/.test(id) } : null;
}

/** Newest current Claude Code model of a line ("opus"), from the registry. */
function newestClaudeOfLine(line) {
    let best = null;
    for (const m of modelRegistry.registryModels('claude-code', { currentOnly: true })) {
        const v = claudeVersion(m.id);
        if (!v || v.line !== line) continue;
        const cmp = best ? (v.version[0] - best.v.version[0]) || (v.version[1] - best.v.version[1]) : 1;
        if (cmp > 0 || (cmp === 0 && best.v.dated && !v.dated)) best = { id: m.id, v };
    }
    return best ? best.id : null;
}

/** OpenRouter slug for a registry-style model id, or null when no rule applies. */
function slugForId(id) {
    const claude = id.match(CLAUDE_ID);
    if (claude) return `anthropic/claude-${claude[1]}-${claude[2]}${claude[3] ? `.${Number(claude[3])}` : ''}`;
    if (/^gpt-/.test(id)) return `openai/${id}`;
    if (/^gemini-/.test(id)) return `google/${id.replace(/-(low|medium|high)$/, '')}`;
    return null;
}

/**
 * The OpenRouter slug a recorded model value names, or null (unpriced).
 * Handles slugs, Claude ids (dated or not), GPT and Gemini ids, agy display
 * names and tier-suffixed agy ids, "<cli backend>/<model>" ledger values and
 * bare Claude family words ("opus" means the newest current Opus).
 */
function openRouterSlugFor(value, catalog = readOpenRouterCatalog()) {
    const raw = String(value || '').trim().replace(/\s*\[[^\]]*\]$/, '');
    if (!raw) return null;
    const lower = raw.toLowerCase();
    const prices = catalog?.prices || {};
    if (lower.includes('/') && Object.prototype.hasOwnProperty.call(prices, lower)) return lower;

    const unprefixed = lower.replace(CLI_BACKEND_PREFIX, '');
    // agy names ("Gemini 4 Argon (High)", "gemini-4-argon-high") resolve to their registry id first.
    const agy = modelRegistry.findRegistryModel(raw.replace(CLI_BACKEND_PREFIX, ''), ['antigravity'])
        || modelRegistry.findRegistryModel(unprefixed, ['antigravity']);
    const id = agy ? String(agy.model.id).toLowerCase() : unprefixed;

    const direct = slugForId(id);
    if (direct) return direct;

    const family = CLAUDE_FAMILIES.find((word) => id.includes(word));
    if (family) {
        const newest = newestClaudeOfLine(family);
        return newest ? slugForId(newest) : null;
    }
    return null;
}

/** $/MTok for a recorded model value: { in, out, cacheRead?, cacheWrite?, slug }, or null when unpriced. */
function priceForModel(value) {
    const catalog = readOpenRouterCatalog();
    const slug = openRouterSlugFor(value, catalog);
    const row = slug ? catalog?.prices?.[slug] : null;
    if (!row || !Number.isFinite(row.in) || !Number.isFinite(row.out)) return null;
    return {
        in: row.in,
        out: row.out,
        ...(Number.isFinite(row.cacheRead) ? { cacheRead: row.cacheRead } : {}),
        ...(Number.isFinite(row.cacheWrite) ? { cacheWrite: row.cacheWrite } : {}),
        slug,
    };
}

/** Praxis's free OpenRouter models in preference order ([] when the catalog has none). */
function freeLaneModels() {
    const lane = readOpenRouterCatalog()?.freeLane;
    if (!Array.isArray(lane)) return [];
    return lane.filter((m) => m && typeof m.slug === 'string' && m.slug)
        .map((m) => ({ slug: m.slug, label: m.label || m.slug, vendor: m.vendor || m.slug.split('/')[0] }));
}

/** Where the prices came from, for route responses and diagnostics. */
function catalogSource() {
    const catalog = readOpenRouterCatalog();
    if (!catalog) return 'no OpenRouter catalog yet (Praxis writes it each morning and when the free lane runs)';
    return `OpenRouter catalog ${new Date(catalog.fetchedAt).toISOString()}`;
}

function resetModelPricesCache() { cached = null; }

module.exports = {
    DEFAULT_CATALOG_PATH,
    readOpenRouterCatalog,
    openRouterSlugFor,
    priceForModel,
    freeLaneModels,
    catalogSource,
    resetModelPricesCache,
};
