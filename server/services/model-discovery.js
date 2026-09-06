/**
 * Model Discovery Service
 * 
 * Queries OpenAI, Google Gemini, Anthropic, and xAI model listing APIs on startup.
 * Normalizes results into a unified schema and filters to only the latest model per family.
 */

const MODEL_FAMILIES = {
    google: [
        { family: 'Gemini Pro', pattern: /^models\/gemini-(\d+(?:\.\d+)?)-pro/, display: (v) => `Gemini ${v} Pro` },
        { family: 'Gemini Flash', pattern: /^models\/gemini-(\d+(?:\.\d+)?)-flash(?!-thinking)/, display: (v) => `Gemini ${v} Flash` },
    ],
    openai: [
        // Only the main GPT model — exclude codex, mini, audio, realtime variants
        { family: 'GPT', pattern: /^gpt-(\d+(?:\.\d+)?)(?!.*(?:mini|codex|audio|realtime|transcribe))/, display: (v) => `GPT-${v}` },
    ],
    anthropic: [
        // Anthropic uses dash-separated versions: claude-opus-4-6 = version 4.6
        { family: 'Claude Opus', pattern: /^claude-opus-(\d+(?:[.-]\d+)?)/, display: (v) => `Claude Opus ${v}`, dashVersion: true },
        { family: 'Claude Sonnet', pattern: /^claude-sonnet-(\d+(?:[.-]\d+)?)/, display: (v) => `Claude Sonnet ${v}`, dashVersion: true },
        { family: 'Claude Haiku', pattern: /^claude-haiku-(\d+(?:[.-]\d+)?)/, display: (v) => `Claude Haiku ${v}`, dashVersion: true },
        { family: 'Claude Fable', pattern: /^claude-fable-(\d+(?:[.-]\d+)?)/, display: (v) => `Claude Fable ${v}`, dashVersion: true },
    ],
    xai: [
        // Only full Grok, no mini
        { family: 'Grok', pattern: /^grok-(\d+)(?!.*(?:mini|fast|vision|image))/, display: (v) => `Grok ${v}` },
    ],
};

// Known thinking models (reasoning-capable)
const THINKING_INDICATORS = [
    /thinking/i,
    /^o\d/,         // OpenAI o-series are reasoning models
    /-thinking/,
];

/**
 * Reasoning-effort tiers. Provider listing APIs don't expose these, so this map
 * is the registry's source of truth. Every value was verified against the real
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
 * EXACT per-slug OpenAI capability rules. Sourced from the codex CLI's own
 * model metadata (`~/.codex/models_cache.json` → supported_reasoning_levels),
 * which is what the backend actually validates against.
 *
 * Version-range guessing was wrong here in both directions and is deliberately
 * not used: gpt-5.5/5.4-mini stop at xhigh (offering them "max" gets the turn
 * rejected), 5.6-sol/terra and 6-astra go one PAST max to "ultra", and
 * "minimal"/"none" — though valid in the API's global enum — are offered by no
 * current model.
 *
 * To refresh: read supported_reasoning_levels out of models_cache.json.
 * Last refreshed 2026-09-06 (codex 0.153.4, cache fetched
 * 2026-09-06T23:19:19Z): gpt-6-astra arrived at priority 1 with the full six
 * tiers, and gpt-5.4 left the roster entirely — its row is gone, so a stale
 * "gpt-5.4" pin now gets the conservative set rather than a tier set nobody
 * can vouch for any more. Hidden entries (visibility=hide: gpt-reserve,
 * codex-auto-review) are never offered in the roster dropdown but keep exact
 * rows here so a slug typed by hand still gets the tiers its backend really
 * validates against.
 */
const OPENAI_MODEL_EFFORT_TIERS = {
    'gpt-6-astra': ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    'gpt-reserve': ['low', 'medium', 'high', 'xhigh', 'max'],
    'gpt-5.6-sol': ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    'gpt-5.6-terra': ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    'gpt-5.6-luna': ['low', 'medium', 'high', 'xhigh', 'max'],
    'gpt-5.5': ['low', 'medium', 'high', 'xhigh'],
    'gpt-5.4-mini': ['low', 'medium', 'high', 'xhigh'],
    // supported_in_api=false in the cache: the ChatGPT-account codex lists it,
    // but an API-keyed run cannot reach it. The tiers are still its own.
    'gpt-5.3-codex-spark': ['low', 'medium', 'high', 'xhigh'],
    'codex-auto-review': ['low', 'medium', 'high', 'xhigh', 'max'],
};

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
    const exact = OPENAI_MODEL_EFFORT_TIERS[String(slug || '').trim()];
    if (exact) return ['default', ...exact];
    const numericVersion = typeof version === 'number' ? version : parseVersion(String(version || ''));
    const rule = THINKING_TIER_RULES.find(r => r.family === family && numericVersion >= r.minVersion);
    return ['default', ...(rule ? rule.tiers : BASIC_EFFORT_TIERS)];
}

/**
 * Tiers for a raw model slug typed into the dashboard (e.g. "claude-fable-5",
 * "gpt-5.5") rather than a discovered roster entry. Reuses the same family
 * patterns discovery matches on, so the two can't drift apart. An unmatched
 * slug gets the conservative set — a model we can't identify never gets
 * offered a tier its backend might reject.
 */
function thinkingTiersForModelId(modelId) {
    const slug = String(modelId || '').trim();
    if (!slug) return null;
    // Exact OpenAI capability rules first — the roster's GPT pattern skips
    // codex/mini variants, but those are exactly what the codex backend runs.
    if (OPENAI_MODEL_EFFORT_TIERS[slug]) return ['default', ...OPENAI_MODEL_EFFORT_TIERS[slug]];
    // An unrecognised gpt-* slug must NOT inherit a sibling's tiers — OpenAI
    // 400s an unsupported effort, so stay conservative rather than guess.
    if (/^gpt-/.test(slug)) return ['default', ...BASIC_EFFORT_TIERS];
    for (const families of Object.values(MODEL_FAMILIES)) {
        for (const familyDef of families) {
            const match = slug.match(familyDef.pattern);
            if (match) return thinkingTiersFor(familyDef.family, parseVersion(match[1]));
        }
    }
    return ['default', ...BASIC_EFFORT_TIERS];
}

/**
 * The floor every reasoning model on both backends accepts — every entry in
 * OPENAI_MODEL_EFFORT_TIERS includes low/medium/high, and so does claude
 * --effort. Use this whenever the effective model can't be NAMED (e.g. codex
 * with no --model flag, where the CLI picks its own default): offering the
 * full union there would hand Praxis a tier the API may 400 on.
 */
const CONSERVATIVE_THINKING_TIERS = ['default', ...BASIC_EFFORT_TIERS];

/**
 * Every tier any model could report — the validation whitelist. Derived from
 * the maps above so a capability edit can't leave validation behind.
 */
const ALL_THINKING_TIERS = [
    'default',
    ...new Set([
        ...EXTENDED_EFFORT_TIERS,
        ...BASIC_EFFORT_TIERS,
        ...Object.values(OPENAI_MODEL_EFFORT_TIERS).flat(),
    ]),
];

// Provider display names
const PROVIDER_DISPLAY = {
    google: 'Google',
    openai: 'OpenAI',
    anthropic: 'Anthropic',
    xai: 'xAI',
};

// Cached discovered models
let discoveredModels = null;

/**
 * Parse a version string into a comparable number
 * Handles both dot and dash separators: "4.5" -> 4.5, "4-6" -> 4.6, "3" -> 3
 */
function parseVersion(versionStr) {
    // Replace dash with dot for Anthropic-style versions (4-6 -> 4.6)
    const normalized = versionStr.replace('-', '.');
    return parseFloat(normalized) || 0;
}

/**
 * Query a single provider's model listing endpoint
 */
async function queryProvider(provider) {
    const configs = {
        google: {
            key: process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY,
            url: () => `https://generativelanguage.googleapis.com/v1beta/models?key=${configs.google.key}`,
            headers: () => ({ 'Content-Type': 'application/json' }),
            extract: (data) => (data.models || []).map(m => m.name), // "models/gemini-3-pro" format
        },
        openai: {
            key: process.env.OPENAI_API_KEY,
            url: () => 'https://api.openai.com/v1/models',
            headers: () => ({
                'Authorization': `Bearer ${configs.openai.key}`,
                'Content-Type': 'application/json',
            }),
            extract: (data) => (data.data || []).map(m => m.id),
        },
        anthropic: {
            key: process.env.ANTHROPIC_API_KEY,
            url: () => 'https://api.anthropic.com/v1/models',
            headers: () => ({
                'x-api-key': configs.anthropic.key,
                'anthropic-version': '2023-06-01',
                'Content-Type': 'application/json',
            }),
            extract: (data) => (data.data || []).map(m => m.id),
        },
        xai: {
            key: process.env.XAI_API_KEY,
            url: () => 'https://api.x.ai/v1/models',
            headers: () => ({
                'Authorization': `Bearer ${configs.xai.key}`,
                'Content-Type': 'application/json',
            }),
            extract: (data) => (data.data || []).map(m => m.id),
        },
    };

    const config = configs[provider];
    if (!config || !config.key) {
        console.log(`[Model Discovery] Skipping ${provider}: no API key`);
        return { provider, models: [], skipped: true };
    }

    try {
        console.log(`[Model Discovery] Querying ${provider}...`);
        const response = await fetch(config.url(), {
            method: 'GET',
            headers: config.headers(),
        });

        if (!response.ok) {
            const err = await response.text().catch(() => '');
            throw new Error(`HTTP ${response.status}: ${err.substring(0, 200)}`);
        }

        const data = await response.json();
        const modelIds = config.extract(data);
        console.log(`[Model Discovery] ${provider}: found ${modelIds.length} raw models`);

        return { provider, models: modelIds, skipped: false };
    } catch (error) {
        console.error(`[Model Discovery] ${provider} failed:`, error.message);
        return { provider, models: [], error: error.message };
    }
}

/**
 * For each model family, find the latest version from the raw model IDs
 */
function filterLatestPerFamily(provider, rawModelIds) {
    const families = MODEL_FAMILIES[provider] || [];
    const results = [];

    for (const familyDef of families) {
        let bestVersion = -1;
        let bestModelId = null;

        for (const modelId of rawModelIds) {
            const match = modelId.match(familyDef.pattern);
            if (match) {
                const version = parseVersion(match[1]);
                if (version > bestVersion) {
                    bestVersion = version;
                    bestModelId = modelId;
                }
            }
        }

        if (bestModelId && bestVersion > 0) {
            // For Google, strip the "models/" prefix for the API model ID
            const apiModelId = provider === 'google'
                ? bestModelId.replace(/^models\//, '')
                : bestModelId;

            const isThinking = THINKING_INDICATORS.some(re => re.test(bestModelId));

            results.push({
                id: `${provider}-${familyDef.family.toLowerCase().replace(/\s+/g, '-')}`,
                apiModelId,
                name: familyDef.display(bestVersion.toString()),
                provider: PROVIDER_DISPLAY[provider],
                providerId: provider,
                isThinking,
                thinkingTiers: thinkingTiersFor(familyDef.family, bestVersion, apiModelId),
                parameters: {},
                limits: null, // Provider APIs don't always return this; we leave it flexible
                family: familyDef.family,
                versionSort: bestVersion.toString(),
                discoveredVersion: bestVersion,
            });
        }
    }

    return results;
}

function inferCapabilities(model) {
    return {
        chat: true,
        reasoning: !!model.isThinking,
        local: model.providerId === 'local',
        // Durable so consumers reading the registry db (rather than the live
        // discovery result) still see which effort tiers this model accepts.
        thinkingTiers: model.thinkingTiers || thinkingTiersFor(model.family, model.discoveredVersion, model.apiModelId)
    };
}

function inferDefaultParameters(model) {
    if (model.providerId === 'anthropic') return { max_tokens: 8192 };
    if (model.providerId === 'google' && model.isThinking) return { thinking_budget: 8_000 };
    return {};
}

async function upsertDiscoveredModels(registryDb, models) {
    if (!registryDb?.upsertModel) return;
    const now = new Date().toISOString();

    for (const model of models) {
        const existing = registryDb.getModel
            ? await registryDb.getModel(model.id).catch(() => null)
            : null;
        await registryDb.upsertModel({
            id: model.id,
            provider: model.providerId || String(model.provider || '').toLowerCase(),
            api_model_id: model.apiModelId,
            name: model.name,
            display_name: model.name,
            family: model.family,
            version_sort: model.versionSort || String(model.discoveredVersion || ''),
            capabilities: inferCapabilities(model),
            parameters: model.parameters || {},
            default_parameters: inferDefaultParameters(model),
            availability_status: 'available',
            is_active: 1,
            discovered_at: existing?.discovered_at || now,
            last_seen_at: now
        });
    }
}

/**
 * Main discovery function — call on server startup
 */
async function discoverModelRegistry(options = {}) {
    console.log('[Model Discovery] Starting model discovery across all providers...');
    const startTime = Date.now();

    const providers = ['google', 'openai', 'anthropic', 'xai'];
    const results = await Promise.all(providers.map(queryProvider));

    const allModels = [];
    const summary = {};
    const providerStatuses = [];

    for (const result of results) {
        if (result.skipped) {
            summary[result.provider] = 'SKIPPED (no key)';
            providerStatuses.push({
                provider: result.provider,
                status: 'skipped',
                rawCount: 0,
                modelCount: 0,
                message: 'no API key'
            });
            continue;
        }
        if (result.error) {
            summary[result.provider] = `ERROR: ${result.error}`;
            providerStatuses.push({
                provider: result.provider,
                status: 'error',
                rawCount: 0,
                modelCount: 0,
                message: result.error
            });
            continue;
        }

        // Log all raw models for visibility
        console.log(`[Model Discovery] ${result.provider} raw IDs:`, result.models.slice(0, 30).join(', '));

        const filtered = filterLatestPerFamily(result.provider, result.models);
        allModels.push(...filtered);
        summary[result.provider] = `${filtered.length} models (from ${result.models.length} raw)`;
        providerStatuses.push({
            provider: result.provider,
            status: 'ok',
            rawCount: result.models.length,
            modelCount: filtered.length
        });
    }

    const elapsed = Date.now() - startTime;
    console.log(`[Model Discovery] Complete in ${elapsed}ms. Summary:`, summary);
    console.log(`[Model Discovery] Final model list (${allModels.length} models):`);
    allModels.forEach(m => console.log(`  → ${m.name} (${m.provider}) [${m.apiModelId}]${m.isThinking ? ' ⚡ Thinking' : ''}`));

    await upsertDiscoveredModels(options.db, allModels);

    discoveredModels = allModels;
    return {
        models: allModels,
        providers: providerStatuses,
        summary,
        elapsedMs: elapsed,
        discoveredAt: new Date().toISOString()
    };
}

async function discoverModels(options = {}) {
    const result = await discoverModelRegistry(options);
    return result.models;
}

/**
 * Get the cached model list — returns empty array if discovery hasn't run yet
 */
function getModels() {
    return discoveredModels || [];
}

module.exports = {
    discoverModels,
    discoverModelRegistry,
    getModels,
    filterLatestPerFamily,
    thinkingTiersFor,
    thinkingTiersForModelId,
    ALL_THINKING_TIERS,
    CONSERVATIVE_THINKING_TIERS,
};
