/**
 * Model sources and reasoning-effort tiers.
 *
 * The Nexus no longer queries vendor model-listing APIs (2026-10-30). Which
 * models exist comes from two files Praxis writes: the CLI model registry
 * (./model-registry.js) and OpenRouter's catalog with Praxis's free roster
 * (./model-prices.js). syncModelSources() turns the free OpenRouter list into
 * `models` rows so roles can pick one; CLI models are `cli:` assignments, not
 * rows. The old listing calls sent the fleet Google key in a URL, found models
 * no Praxis provider could run, and could not see Gemini 4 Argon.
 */

const modelRegistry = require('./model-registry');
const modelPrices = require('./model-prices');
const { invalidateModelsCache } = require('../shared/models-cache');

// Claude family patterns, used only to pick reasoning-effort tiers for a slug.
const CLAUDE_FAMILIES = [
    { family: 'Claude Opus', pattern: /^claude-opus-(\d+(?:[.-]\d+)?)/ },
    { family: 'Claude Sonnet', pattern: /^claude-sonnet-(\d+(?:[.-]\d+)?)/ },
    { family: 'Claude Haiku', pattern: /^claude-haiku-(\d+(?:[.-]\d+)?)/ },
    { family: 'Claude Fable', pattern: /^claude-fable-(\d+(?:[.-]\d+)?)/ },
];

/**
 * Reasoning-effort tiers. Model lists don't expose every rule, so these sets
 * fill in where the registry cannot say. Every value was verified against the real
 * CLI/API, not inferred:
 *
 *   claude → `claude --effort <level>`; --help enumerates
 *            "low, medium, high, xhigh, max" (no "ultra", no "minimal"). An
 *            unknown value only warns and falls back, so claude is forgiving.
 *   codex  → `-c model_reasoning_effort="<level>"`, forwarded verbatim to the
 *            OpenAI API, which HARD-REJECTS an unsupported tier with a 400
 *            (confirmed live: bogus → invalid_enum_value, turn killed). Codex
 *            is the strict backend, so its sets must be exact.
 *
 * "default" is our own sentinel (pass no flag) and is prepended to every set
 * rather than stored here.
 */
const EXTENDED_EFFORT_TIERS = ['low', 'medium', 'high', 'xhigh', 'max'];
const BASIC_EFFORT_TIERS = ['low', 'medium', 'high'];

/**
 * Exact efforts for any model an executor CLI offers come from the model
 * registry (./model-registry.js), which Praxis builds from the CLIs' own
 * model lists, e.g. Codex's supported_reasoning_levels. This replaced a
 * hand-refreshed per-slug table (last refreshed 2026-09-06) that never learned
 * of gpt-6.1-sol or Sonnet 5.5. Codex hard-rejects an unsupported effort, so an
 * unknown gpt-* slug still gets only the conservative set.
 */
/**
 * Claude tiers still gate on family + version: the claude CLI takes the same
 * five levels for every model it accepts, so the only question is which
 * generations expose deep reasoning at all — and a version floor lets a future
 * Sonnet 6 inherit it without a code change. This is safe precisely because
 * claude DOWNGRADES an unsupported --effort instead of erroring; the codex
 * side above can't afford the same latitude.
 */
const THINKING_TIER_RULES = [
    { family: 'Claude Fable', minVersion: 0, tiers: EXTENDED_EFFORT_TIERS },
    { family: 'Claude Opus', minVersion: 4.8, tiers: EXTENDED_EFFORT_TIERS },
    { family: 'Claude Sonnet', minVersion: 5, tiers: EXTENDED_EFFORT_TIERS },
];

/**
 * The reasoning-effort tiers a model supports, always led by "default".
 * An exact OpenAI slug match wins over any family rule; anything we can't
 * identify falls back to the conservative low/medium/high set, which every
 * reasoning model on both backends accepts.
 */
function thinkingTiersFor(family, version, slug) {
    const exact = slug ? modelRegistry.registryEfforts(String(slug).trim(), ['codex', 'claude-code']) : null;
    if (exact) return ['default', ...exact];
    const numericVersion = typeof version === 'number' ? version : parseVersion(String(version || ''));
    const rule = THINKING_TIER_RULES.find(r => r.family === family && numericVersion >= r.minVersion);
    return ['default', ...(rule ? rule.tiers : BASIC_EFFORT_TIERS)];
}

/**
 * Tiers for a raw model slug typed into the dashboard (e.g. "claude-fable-5",
 * "gpt-5.5"). An unmatched slug gets the conservative set: a model we can't
 * identify never gets offered a tier its backend might reject.
 */
function thinkingTiersForModelId(modelId) {
    const slug = String(modelId || '').trim();
    if (!slug) return null;
    // The CLI's own efforts first: the registry covers every model the codex and
    // claude CLIs offer, including the codex/mini variants the GPT pattern skips.
    const exact = modelRegistry.registryEfforts(slug, ['codex', 'claude-code']);
    if (exact) return ['default', ...exact];
    // An unrecognised gpt-* slug must NOT inherit a sibling's tiers — OpenAI
    // 400s an unsupported effort, so stay conservative rather than guess.
    if (/^gpt-/.test(slug)) return ['default', ...BASIC_EFFORT_TIERS];
    for (const familyDef of CLAUDE_FAMILIES) {
        const match = slug.match(familyDef.pattern);
        if (match) return thinkingTiersFor(familyDef.family, parseVersion(match[1]));
    }
    return ['default', ...BASIC_EFFORT_TIERS];
}

/**
 * The floor every reasoning model on both backends accepts: every codex model
 * in the registry lists low/medium/high, and so does claude --effort. Use this whenever the effective model can't be NAMED (e.g. codex
 * with no --model flag, where the CLI picks its own default): offering the
 * full union there would hand Praxis a tier the API may 400 on.
 */
const CONSERVATIVE_THINKING_TIERS = ['default', ...BASIC_EFFORT_TIERS];

/**
 * Every tier name the CLIs use: the validation whitelist for stored levels.
 * It is the effort vocabulary, not a model list; "ultra" is codex's tier above
 * max (gpt-6-astra, gpt-6.1-sol). Per-model narrowing comes from the registry.
 */
const ALL_THINKING_TIERS = ['default', ...new Set([...EXTENDED_EFFORT_TIERS, ...BASIC_EFFORT_TIERS, 'ultra'])];

/**
 * Parse a version string into a comparable number
 * Handles both dot and dash separators: "4.5" -> 4.5, "4-6" -> 4.6, "3" -> 3
 */
function parseVersion(versionStr) {
    // Replace dash with dot for Anthropic-style versions (4-6 -> 4.6)
    const normalized = versionStr.replace('-', '.');
    return parseFloat(normalized) || 0;
}

// The rows the last sync produced, in the camelCase shape GET /api/models serves.
let syncedModels = null;

const CLI_EXECUTORS = ['claude-code', 'codex', 'antigravity'];

/** Row id for a free OpenRouter slug ("poolside/laguna-s-2.1:free" -> "openrouter-poolside-laguna-s-2-1"). */
function openRouterRowId(slug) {
    return `openrouter-${String(slug).replace(/:free$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
}

/** A record with no undefined values: the db upsert would write them as NULL. */
function defined(record) {
    return Object.fromEntries(Object.entries(record).filter(([, v]) => v !== undefined));
}

function toApiShape(row) {
    return {
        id: row.id,
        apiModelId: row.api_model_id,
        name: row.display_name || row.name,
        provider: 'OpenRouter',
        providerId: 'openrouter',
        family: row.family || null,
        isThinking: !!row.capabilities?.reasoning,
        parameters: {},
    };
}

/**
 * Bring the `models` rows in line with the current sources. Free OpenRouter
 * models from Praxis's catalog are upserted active; an OpenRouter row the free
 * list no longer names is marked inactive (reversible), but only when the list
 * is present, so a missing catalog never empties the lane. CLI models are
 * reported, not stored: roles reach them as `cli:` assignments.
 *
 * Reads two local files and the db; it calls no vendor API.
 */
async function syncModelSources(options = {}) {
    const startTime = Date.now();
    const registryDb = options.db;
    const providers = [];
    const summary = {};

    const registry = modelRegistry.readModelRegistry();
    const cliCurrent = CLI_EXECUTORS.reduce((n, e) => n + modelRegistry.registryModels(e, { currentOnly: true }).length, 0);
    const cliListed = CLI_EXECUTORS.reduce((n, e) => n + modelRegistry.registryModels(e).length, 0);
    providers.push({
        provider: 'cli registry',
        status: registry ? 'ok' : 'missing',
        rawCount: cliListed,
        modelCount: cliCurrent,
        message: modelRegistry.registrySource('claude-code'),
    });
    summary['cli registry'] = registry ? `${cliCurrent} current CLI models` : 'MISSING';

    const lane = modelPrices.freeLaneModels();
    const catalog = modelPrices.readOpenRouterCatalog();
    const synced = [];
    let deactivated = 0;
    if (!lane.length) {
        providers.push({
            provider: 'openrouter',
            status: catalog ? 'skipped' : 'missing',
            rawCount: 0,
            modelCount: 0,
            message: catalog ? 'the catalog has no free-lane list yet; rows left as they are' : modelPrices.catalogSource(),
        });
        summary.openrouter = catalog ? 'SKIPPED (no free-lane list)' : 'MISSING';
    } else if (registryDb?.upsertModel && registryDb?.getModels) {
        const now = new Date().toISOString();
        const rows = (await registryDb.getModels(false)) || [];
        const openRouterRows = rows.filter((r) => String(r.provider).toLowerCase() === 'openrouter');
        const keep = new Set(lane.map((m) => m.slug));

        for (const [index, entry] of lane.entries()) {
            const existing = openRouterRows.find((r) => r.api_model_id === entry.slug)
                || rows.find((r) => r.id === openRouterRowId(entry.slug));
            const saved = await registryDb.upsertModel(defined({
                id: existing?.id || openRouterRowId(entry.slug),
                provider: 'openrouter',
                api_model_id: entry.slug,
                name: entry.label,
                display_name: existing?.display_name || `${entry.label} (free)`,
                family: existing?.family || entry.label.split(' ')[0],
                version_sort: existing?.version_sort,
                sort_order: existing?.sort_order ?? 10 + index,
                capabilities: existing?.capabilities && Object.keys(existing.capabilities).length ? existing.capabilities : { chat: true, tools: true },
                default_parameters: existing?.default_parameters && Object.keys(existing.default_parameters).length
                    ? existing.default_parameters
                    : { max_tokens: 4096 },
                availability_status: 'available',
                is_active: 1,
                discovered_at: existing?.discovered_at || now,
                last_seen_at: now,
                created_at: existing?.created_at,
            }));
            synced.push(saved || { id: existing?.id || openRouterRowId(entry.slug), api_model_id: entry.slug, name: entry.label });
        }

        for (const row of openRouterRows) {
            if (keep.has(row.api_model_id) || !(row.is_active === 1 || row.is_active === true)) continue;
            await registryDb.upsertModel(defined({ id: row.id, name: row.name, provider: row.provider, is_active: 0, created_at: row.created_at }));
            deactivated += 1;
        }
        invalidateModelsCache();
        providers.push({
            provider: 'openrouter',
            status: 'ok',
            rawCount: lane.length,
            modelCount: synced.length,
            message: `free lane from the ${modelPrices.catalogSource()}${deactivated ? `; ${deactivated} withdrawn row(s) marked inactive` : ''}`,
        });
        summary.openrouter = `${synced.length} free models${deactivated ? `, ${deactivated} marked inactive` : ''}`;
    } else {
        providers.push({ provider: 'openrouter', status: 'skipped', rawCount: lane.length, modelCount: 0, message: 'no database' });
        summary.openrouter = 'SKIPPED (no database)';
    }

    const elapsed = Date.now() - startTime;
    console.log('[Model Sources] Synced:', summary);
    syncedModels = synced.map(toApiShape);
    return {
        models: syncedModels,
        providers,
        summary,
        deactivated,
        elapsedMs: elapsed,
        discoveredAt: new Date().toISOString()
    };
}

/** The rows the last sync produced; empty before the first sync. */
function getModels() {
    return syncedModels || [];
}

module.exports = {
    syncModelSources,
    getModels,
    openRouterRowId,
    thinkingTiersFor,
    thinkingTiersForModelId,
    ALL_THINKING_TIERS,
    CONSERVATIVE_THINKING_TIERS,
};
