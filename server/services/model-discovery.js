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
                isThinking,
                parameters: {},
                limits: null, // Provider APIs don't always return this; we leave it flexible
                family: familyDef.family,
                discoveredVersion: bestVersion,
            });
        }
    }

    return results;
}

/**
 * Main discovery function — call on server startup
 */
async function discoverModels() {
    console.log('[Model Discovery] Starting model discovery across all providers...');
    const startTime = Date.now();

    const providers = ['google', 'openai', 'anthropic', 'xai'];
    const results = await Promise.all(providers.map(queryProvider));

    const allModels = [];
    const summary = {};

    for (const result of results) {
        if (result.skipped) {
            summary[result.provider] = 'SKIPPED (no key)';
            continue;
        }
        if (result.error) {
            summary[result.provider] = `ERROR: ${result.error}`;
            continue;
        }

        // Log all raw models for visibility
        console.log(`[Model Discovery] ${result.provider} raw IDs:`, result.models.slice(0, 30).join(', '));

        const filtered = filterLatestPerFamily(result.provider, result.models);
        allModels.push(...filtered);
        summary[result.provider] = `${filtered.length} models (from ${result.models.length} raw)`;
    }

    const elapsed = Date.now() - startTime;
    console.log(`[Model Discovery] Complete in ${elapsed}ms. Summary:`, summary);
    console.log(`[Model Discovery] Final model list (${allModels.length} models):`);
    allModels.forEach(m => console.log(`  → ${m.name} (${m.provider}) [${m.apiModelId}]${m.isThinking ? ' ⚡ Thinking' : ''}`));

    discoveredModels = allModels;
    return allModels;
}

/**
 * Get the cached model list — returns empty array if discovery hasn't run yet
 */
function getModels() {
    return discoveredModels || [];
}

module.exports = {
    discoverModels,
    getModels,
};
