/**
 * Which models each executor CLI offers, read from the registry Praxis builds.
 *
 * Praxis is the single producer: src/models/registry.ts writes
 * data/model-registry.json after the morning CLI check and on boot, from each
 * CLI's own model list (the Claude Code catalog cache, ~/.codex/models_cache.json
 * and `agy models`). The Nexus reads that file instead of keeping its own model
 * lists or shelling the CLIs itself (2026-10-30: its fallback lists had gone
 * stale, so new models such as Sonnet 5.5 and GPT-6.1 Sol never reached a picker).
 *
 * PRAXIS_MODEL_REGISTRY_PATH overrides the location (tests point it at a fixture).
 */
const fs = require('fs');

const DEFAULT_REGISTRY_PATH = '/Volumes/Projects/Praxis/data/model-registry.json';
const EXECUTORS = ['claude-code', 'codex', 'antigravity'];

function registryPath() {
    const fromEnv = process.env.PRAXIS_MODEL_REGISTRY_PATH;
    return typeof fromEnv === 'string' && fromEnv.trim() ? fromEnv.trim() : DEFAULT_REGISTRY_PATH;
}

let cached = null; // { file, mtimeMs, registry }

/** The registry, re-read only when the file changes; null when Praxis has not written one. */
function readModelRegistry() {
    const file = registryPath();
    let mtimeMs;
    try { mtimeMs = fs.statSync(file).mtimeMs; } catch { return null; }
    if (cached && cached.file === file && cached.mtimeMs === mtimeMs) return cached.registry;
    let registry = null;
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
        if (parsed && parsed.schemaVersion === 1 && parsed.executors) registry = parsed;
    } catch (error) {
        console.warn('[ModelRegistry] unreadable registry file:', error.message);
    }
    cached = { file, mtimeMs, registry };
    return registry;
}

/** Listed models for one CLI, its current picker first; [] without a registry. */
function registryModels(executor, { currentOnly = false } = {}) {
    const models = readModelRegistry()?.executors?.[executor]?.models || [];
    const visible = models.filter((m) => m && m.listed !== false && (!currentOnly || m.current !== false));
    return [...visible.filter((m) => m.current !== false), ...visible.filter((m) => m.current === false)];
}

/** Claude ids name a version line; a dated id ("claude-haiku-4-5-20251001") is the same model. */
function claudeVersionKey(id) {
    const m = String(id).match(/^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/);
    return m ? `${m[1]}:${Number(m[2])}.${Number(m[3] || 0)}` : null;
}

/**
 * The registry entry a configured value names, for any CLI: an exact id, a
 * dated Claude alias, an agy display name ("Gemini 4 Argon (High)") or an agy
 * tier-suffixed id ("gemini-4-argon-high"). Returns { executor, model } or null.
 */
function findRegistryModel(value, executors = EXECUTORS) {
    const text = String(value || '').trim();
    if (!text) return null;
    const registry = readModelRegistry();
    if (!registry) return null;
    for (const executor of executors) {
        const models = registry.executors?.[executor]?.models || [];
        const exact = models.find((m) => m.id === text);
        if (exact) return { executor, model: exact };
        if (executor === 'claude-code') {
            const key = claudeVersionKey(text);
            const alias = key && models.find((m) => claudeVersionKey(m.id) === key);
            if (alias) return { executor, model: alias };
        }
        if (executor === 'antigravity') {
            const byDisplay = models.find((m) => Object.values(m.displayByEffort || {}).includes(text));
            if (byDisplay) return { executor, model: byDisplay };
            const tier = text.match(/-(low|medium|high)$/i);
            const base = tier && models.find((m) => m.id === text.slice(0, -tier[0].length));
            if (base) return { executor, model: base };
        }
    }
    return null;
}

/** Efforts the CLI reports for a model, or null when the registry cannot say. */
function registryEfforts(value, executors) {
    const hit = findRegistryModel(value, executors);
    return hit && Array.isArray(hit.model.efforts) && hit.model.efforts.length ? hit.model.efforts : null;
}

/** Codex picker entries in the shape /codex-models has always served. */
function codexPickerModels() {
    return registryModels('codex').map((m) => ({
        id: m.id,
        label: m.label || m.id,
        defaultEffort: m.defaultEffort || null,
        efforts: Array.isArray(m.efforts) ? m.efforts : [],
        current: m.current !== false,
        ...(m.upgradeTo ? { deprecated: true, upgradeTo: m.upgradeTo } : {}),
    }));
}

/** Every agy display name ("Gemini 4 Argon (High)"), the format agy pins and The Nexus stores. */
function antigravityDisplayNames() {
    return registryModels('antigravity').flatMap((m) => {
        const names = Object.values(m.displayByEffort || {});
        return names.length ? names : [m.label || m.id];
    });
}

const CLI_LABELS = { 'claude-code': 'Claude Code', codex: 'Codex', antigravity: 'Antigravity' };

/**
 * Role assignments for every current CLI model, as the role picker offers
 * them: the bare `cli:<backend>` (the CLI's own default) first, then
 * `cli:<backend>/<id>`. `efforts` lets the picker keep a role's `@thinking`.
 */
function cliAssignmentOptions() {
    return EXECUTORS.flatMap((backend) => [
        { value: `cli:${backend}`, label: `${CLI_LABELS[backend]} (CLI default)`, backend, efforts: [] },
        ...registryModels(backend, { currentOnly: true }).map((m) => ({
            value: `cli:${backend}/${m.id}`,
            label: `${m.label || m.id} (${CLI_LABELS[backend]})`,
            backend,
            efforts: Array.isArray(m.efforts) ? m.efforts : [],
        })),
    ]);
}

/** Where the registry came from, for route responses and diagnostics. */
function registrySource(executor) {
    const registry = readModelRegistry();
    if (!registry) return 'no model registry yet (Praxis builds it on boot and each morning)';
    const entry = registry.executors?.[executor];
    if (!entry) return `model registry ${registry.generatedAt} (no ${executor} entry)`;
    return `model registry ${registry.generatedAt}${entry.stale ? `; ${executor} list stale: ${entry.stale}` : ''}`;
}

function resetModelRegistryCache() { cached = null; }

module.exports = {
    DEFAULT_REGISTRY_PATH,
    readModelRegistry,
    registryModels,
    findRegistryModel,
    registryEfforts,
    codexPickerModels,
    antigravityDisplayNames,
    cliAssignmentOptions,
    registrySource,
    resetModelRegistryCache,
};
