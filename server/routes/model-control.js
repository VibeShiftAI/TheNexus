const express = require('express');
const modelRegistry = require('../services/model-registry');
const {
    resolveModelAssignment,
    mergePolicies,
    getBudgetStatus,
    recordModelExecutionSnapshot,
    writeModelSystemMessage
} = require('../services/model-control');
const {
    thinkingTiersForModelId,
    ALL_THINKING_TIERS,
    CONSERVATIVE_THINKING_TIERS
} = require('../services/model-discovery');
const { getRoutingState } = require('../services/provider-credentials');

function normalizePolicyInput(body = {}) {
    const budget = body.budget && typeof body.budget === 'object' ? body.budget : {};
    const providerLimits = budget.providerLimits && typeof budget.providerLimits === 'object'
        ? Object.fromEntries(Object.entries(budget.providerLimits).map(([provider, limits]) => {
            const value = limits && typeof limits === 'object' ? limits : {};
            return [String(provider).toLowerCase(), {
                dailyTokenLimit: Number(value.dailyTokenLimit) > 0 ? Number(value.dailyTokenLimit) : null,
                dailyCostLimit: Number(value.dailyCostLimit) > 0 ? Number(value.dailyCostLimit) : null
            }];
        }))
        : {};
    return {
        enabled: !!body.enabled,
        requiredCapabilities: Array.isArray(body.requiredCapabilities) ? body.requiredCapabilities : [],
        fallbackChain: Array.isArray(body.fallbackChain) ? body.fallbackChain : [],
        budget: {
            dailyTokenLimit: Number(budget.dailyTokenLimit) > 0 ? Number(budget.dailyTokenLimit) : null,
            dailyCostLimit: Number(budget.dailyCostLimit) > 0 ? Number(budget.dailyCostLimit) : null,
            autoLocalOnly: !!budget.autoLocalOnly,
            providerLimits
        }
    };
}

function toModelOverride(resolved) {
    return {
        provider: resolved.provider,
        apiModelId: resolved.apiModelId,
        parameters: resolved.parameters || {}
    };
}

/**
 * The model Praxis's claude-code executor uses when a dispatch carries no
 * explicit override. Stored in model_control_settings; defaults to Opus 4.8.
 */
const CLAUDE_DEFAULT_FALLBACK = 'claude-opus-5-5';
async function getClaudeDefaultModel(db) {
    const setting = await db.getModelControlSetting('claude_default_model');
    const model = setting && typeof setting.model === 'string' ? setting.model.trim() : '';
    return model || CLAUDE_DEFAULT_FALLBACK;
}

/**
 * Default models for Praxis's codex / antigravity CLI dispatches. Unlike the
 * claude default there is no hardcoded fallback: empty means "no --model
 * flag", i.e. the CLI's own default. Antigravity values are `agy models`
 * DISPLAY names ("Gemini 3.1 Pro (High)") — slug ids silently fail to pin.
 */
async function getCliDefaultModel(db, key) {
    const setting = await db.getModelControlSetting(key);
    const model = setting && typeof setting.model === 'string' ? setting.model.trim() : '';
    return model;
}

/**
 * The Codex and Antigravity pickers read the model registry Praxis builds from
 * each CLI's own model list (server/services/model-registry.js). Until
 * 2026-10-30 this file read ~/.codex/models_cache.json and shelled `agy models`
 * itself, with hand-kept fallback lists that had gone stale (Gemini 3.1 Pro,
 * GPT-5.5). Antigravity values are display names ("Gemini 4 Argon (High)"),
 * the form The Nexus stores and agy pins.
 */
function listCodexModels() {
    return modelRegistry.codexPickerModels();
}

function listAntigravityModels() {
    return Promise.resolve(modelRegistry.antigravityDisplayNames());
}

/**
 * Backend for Praxis's interactive chat: the permanent CLI session
 * ("claude-code" = standing Claude session on the claude-default model,
 * "codex" = standing Codex session) or "off" = the legacy in-process
 * routed-LLM loop. Read by Praxis's /api/chat handler (cached 60s there).
 */
const CHAT_BACKENDS = ['claude-code', 'codex', 'off'];
const CHAT_BACKEND_DEFAULT = 'claude-code';
async function getChatBackend(db) {
    const setting = await db.getModelControlSetting('chat_backend');
    const backend = setting && typeof setting.backend === 'string' ? setting.backend : '';
    return CHAT_BACKENDS.includes(backend) ? backend : CHAT_BACKEND_DEFAULT;
}

/**
 * Thinking level for the permanent chat session. "default" = whatever the
 * CLI does on its own; the rest map to `claude --effort` / codex's
 * model_reasoning_effort on the Praxis side.
 *
 * This is the ACCEPT list (the union of every tier any model supports) — the
 * narrower per-model set lives in discovery and rides along in the chat-config
 * payload as `thinkingTiers`. Validating against the union rather than the
 * effective model's set means switching models never retroactively 400s a
 * stored value; getChatConfig clamps instead (see below).
 */
const CHAT_THINKING_LEVELS = ALL_THINKING_TIERS;
async function getChatThinkingLevel(db) {
    const setting = await db.getModelControlSetting('chat_thinking_level');
    const level = setting && typeof setting.level === 'string' ? setting.level : '';
    return CHAT_THINKING_LEVELS.includes(level) ? level : 'default';
}

/** Chat-specific model override; empty = the executor's default-model chain. */
async function getChatModel(db, key) {
    const setting = await db.getModelControlSetting(key);
    return setting && typeof setting.model === 'string' ? setting.model : '';
}

/**
 * The model that will actually front the next chat turn — the chat-only
 * override if set, otherwise the executor's default-model chain. This is what
 * the thinking tiers must be computed against, not the (often empty) override.
 */
async function getEffectiveChatModel(db, backend, claudeModel, codexModel) {
    if (backend === 'codex') return codexModel || await getCliDefaultModel(db, 'codex_default_model');
    if (backend === 'claude-code') return claudeModel || await getClaudeDefaultModel(db);
    return '';
}

/** The whole chat-session config in one payload (Praxis fetches this per turn, cached 60s). */
async function getChatConfig(db) {
    const backend = await getChatBackend(db);
    const claudeModel = await getChatModel(db, 'chat_claude_model');
    const codexModel = await getChatModel(db, 'chat_codex_model');
    const storedLevel = await getChatThinkingLevel(db);

    const effectiveModel = await getEffectiveChatModel(db, backend, claudeModel, codexModel);
    // An EMPTY model means codex will pick its own default, which we can't
    // name — so we have no capability data for it. Fall back to the
    // conservative floor, NOT the full union: Praxis forwards this selection
    // verbatim, and codex's default could be a model that 400s on max/ultra.
    // Better to under-offer a tier than to kill the turn.
    const thinkingTiers = thinkingTiersForModelId(effectiveModel) || CONSERVATIVE_THINKING_TIERS;

    return {
        backend,
        claudeModel,
        codexModel,
        // Clamp, don't 400: a level picked for one model (say "max" on Fable 5)
        // must not survive a switch to a model whose backend would reject it.
        // Codex forwards this straight to the OpenAI API, which 400s an
        // unsupported enum and kills the turn outright.
        thinkingLevel: thinkingTiers.includes(storedLevel) ? storedLevel : 'default',
        thinkingTiers
    };
}

/**
 * ─── Per-model default thinking level ─────────────────────────────────────
 * Robert's standing "how hard should THIS model think" control. Stored as one
 * `thinking_levels` setting holding a { <api model id>: <level> } map, so a
 * roster change never leaves orphan setting keys behind.
 *
 * Who accepts what:
 *   - claude-code CLI `--effort`      → low | medium | high | xhigh | max
 *   - codex `model_reasoning_effort`  → minimal | low | medium | high | xhigh | max
 *     (per model, from the model registry: each codex model lists its own
 *     efforts, and some add ultra, which Praxis forwards in chat but
 *     deliberately does not forward for autonomous dispatch)
 *   - antigravity (agy) has NO reasoning-effort knob: its thinking level is
 *     baked into the model DISPLAY name ("Gemini 3.1 Pro (High)"), so no entry
 *     is offered for it.
 *
 * Validation is against the union (ALL_THINKING_TIERS) plus, when the slug is
 * recognised, the narrower per-model set — same clamp-don't-400 posture as the
 * chat thinking level.
 */
const THINKING_LEVEL_SEEDS = {
    // Robert 2026-09-03: Fable is the cheap fast lane; Opus is the one he wants
    // thinking as hard as the CLI allows ("very high" → xhigh, the highest
    // level `claude --effort` documents below `max`... `max` exists too, but he
    // asked for very high, so xhigh).
    'claude-fable-5-1': 'low',
    'claude-opus-5-5': 'xhigh',
    'claude-opus-5': 'xhigh',
};

function normalizeThinkingLevel(model, level) {
    const value = String(level ?? '').trim();
    if (!value || value === 'default') return { ok: true, value: '' };
    if (!ALL_THINKING_TIERS.includes(value)) {
        return { ok: false, error: `unsupported thinking level "${value}" (allowed: ${ALL_THINKING_TIERS.join(', ')})` };
    }
    const perModel = thinkingTiersForModelId(model);
    if (perModel && !perModel.includes(value)) {
        return { ok: false, error: `model ${model} does not accept thinking level "${value}" (accepts: ${perModel.join(', ')})` };
    }
    return { ok: true, value };
}

/** Stored map merged over the seeds; empty values mean "no per-model default". */
async function getThinkingLevels(db) {
    const setting = await db.getModelControlSetting('thinking_levels');
    const stored = setting && typeof setting === 'object' && setting.levels && typeof setting.levels === 'object'
        ? setting.levels
        : {};
    const merged = { ...THINKING_LEVEL_SEEDS };
    for (const [model, level] of Object.entries(stored)) {
        const key = String(model || '').trim();
        if (!key) continue;
        const value = String(level ?? '').trim();
        // An explicitly stored empty value OVERRIDES a seed — that is how
        // Robert clears a seeded default back to "whatever the CLI does".
        if (!value || value === 'default') delete merged[key];
        else if (ALL_THINKING_TIERS.includes(value)) merged[key] = value;
    }
    return merged;
}

/**
 * Backend chain for Praxis's autonomous system-agent runs. Codex-first
 * (ChatGPT subscription), Claude Code next, Gemini API as the last resort.
 */
const AGENT_BACKENDS = ['codex', 'claude-code', 'gemini'];
const AGENT_BACKEND_DEFAULT = { backend: 'codex', fallbacks: ['claude-code', 'gemini'] };
async function getAgentBackendConfig(db) {
    const setting = await db.getModelControlSetting('agent_backend');
    if (!setting || typeof setting !== 'object') return AGENT_BACKEND_DEFAULT;
    const backend = AGENT_BACKENDS.includes(setting.backend) ? setting.backend : AGENT_BACKEND_DEFAULT.backend;
    const fallbacks = Array.isArray(setting.fallbacks)
        ? setting.fallbacks.filter(f => AGENT_BACKENDS.includes(f) && f !== backend)
        : AGENT_BACKEND_DEFAULT.fallbacks.filter(f => f !== backend);
    return { backend, fallbacks };
}

/**
 * Fable-5 credit availability. When Robert exhausts his Fable credits this
 * flips `out:true`, and the Praxis model-router reroutes Fable-tier work per
 * his 2026-07-20 rule: primary/autonomous work → GPT-5.6 Sol, QA & correction
 * rounds → Opus 4.8. `until` (optional ISO) auto-clears the state once it
 * passes, so a "credits back Thursday" note reverts itself with no follow-up.
 */
async function getFableAvailability(db) {
    const setting = await db.getModelControlSetting('fable_availability');
    const out = !!(setting && setting.out === true);
    const until = setting && typeof setting.until === 'string' ? setting.until : null;
    const reason = setting && typeof setting.reason === 'string' ? setting.reason : null;
    // Auto-expire: a past `until` means credits are expected back — report available.
    if (out && until) {
        const untilMs = Date.parse(until);
        if (Number.isFinite(untilMs) && untilMs <= Date.now()) {
            return { out: false, until, reason, expired: true };
        }
    }
    return { out, until, reason };
}

/**
 * Key-aware routing state, degraded rather than fatal: the model-control
 * options payload is load-bearing for every dispatch surface, so a broken
 * credential read must never 500 it.
 */
function safeRoutingState() {
    try {
        return getRoutingState();
    } catch (error) {
        console.warn('[Model Control] credential routing state unavailable:', error.message);
        return null;
    }
}

function createModelControlRouter({ db, syncModelSources, callAI, io }) {
    const router = express.Router();

    // ─── STATE.md trigger ─────────────────────────────────────────────────
    // Every setting below is a fact in the vault's living STATE.md (Praxis
    // src/memory/state-doc.ts, task e524649b). Praxis regenerates it on a
    // 10-minute heartbeat; a model-control change should not wait that long
    // to be true in AGENTS.md, so each successful PUT pings the refresh
    // endpoint. Fire-and-forget: Praxis being down must never fail a PUT.
    const notifyPraxisStateDoc = (reason) => {
        try {
            const { praxisFetch } = require('../services/praxis-client');
            praxisFetch('/api/state-doc/refresh', {
                method: 'POST',
                body: { reason: `model-control: ${reason}` },
                timeoutMs: 15000,
            }).catch(() => { /* Praxis down or restarting — the heartbeat catches up */ });
        } catch {
            /* never let telemetry break a settings write */
        }
    };

    // ─── Key-aware routing ────────────────────────────────────────────────
    // Which dispatch routes have a live credential, and which are excluded
    // before execution (dead key / spent quota) rather than at the 402.
    router.get('/credentials', (_req, res) => {
        const state = safeRoutingState();
        if (!state) return res.status(503).json({ error: 'Credential routing state unavailable' });
        res.json(state);
    });

    router.get('/options', async (req, res) => {
        try {
            const projectId = req.query.projectId || null;
            // THE canonical model registry payload (full db rows — unlike
            // /api/models, which returns only the discovery service's
            // "latest" subset). Rows expose both api_model_id (db column)
            // and apiModelId (camelCase alias) so consumers don't need the
            // snake/camel fallback dance.
            const registryModels = (await db.getModels(true)).map(m => ({ ...m, apiModelId: m.api_model_id }));
            res.json({
                models: registryModels,
                aliases: await db.getModelAliases(true),
                projectAliases: projectId ? await db.getProjectModelAliases(projectId) : [],
                localOnly: await db.getModelControlSetting('local_only'),
                policy: await db.getModelControlSetting('model_policy'),
                claudeDefault: await getClaudeDefaultModel(db),
                codexDefault: await getCliDefaultModel(db, 'codex_default_model'),
                antigravityDefault: await getCliDefaultModel(db, 'antigravity_default_model'),
                // Per-model default thinking levels ({ model: level }) — see
                // getThinkingLevels. Antigravity is deliberately absent.
                thinkingLevels: await getThinkingLevels(db),
                // Real Codex roster (slugs + display names + efforts) for the
                // per-slot / task / chat model dropdowns — see listCodexModels.
                codexModels: listCodexModels(),
                // Every current CLI model as a role assignment (cli:<backend>/<id>),
                // from the registry; the role picker offers these.
                cliAssignments: modelRegistry.cliAssignmentOptions(),
                agentBackend: await getAgentBackendConfig(db),
                chatBackend: await getChatBackend(db),
                chatConfig: await getChatConfig(db),
                projectPolicy: projectId && typeof db.getProjectModelControlSetting === 'function'
                    ? await db.getProjectModelControlSetting(projectId, 'model_policy')
                    : null,
                // Key-aware routing: which executor lanes and API-key lanes can
                // actually spend a credential right now. Rides this payload so
                // every dispatch surface gets it in the call it already makes.
                credentials: safeRoutingState()
            });
        } catch (error) {
            console.error('[Model Control] Failed to load options:', error);
            res.status(500).json({ error: 'Failed to load model-control options: ' + error.message });
        }
    });

    // ─── Claude default model ─────────────────────────────────────────────
    // Read by Praxis's claude-code executor at dispatch time (cached 60s
    // there) and by the dashboard's Model Control panel.
    router.get('/claude-default', async (_req, res) => {
        try {
            res.json({ model: await getClaudeDefaultModel(db) });
        } catch (error) {
            console.error('[Model Control] Failed to read claude default:', error);
            res.status(500).json({ error: 'Failed to read claude default: ' + error.message });
        }
    });

    router.put('/claude-default', async (req, res) => {
        try {
            const model = typeof req.body.model === 'string' ? req.body.model.trim() : '';
            if (!model) return res.status(400).json({ error: 'model is required' });
            await db.setModelControlSetting('claude_default_model', { model });
            notifyPraxisStateDoc('claude-default');
            res.json({ model });
        } catch (error) {
            console.error('[Model Control] Failed to update claude default:', error);
            res.status(500).json({ error: 'Failed to update claude default: ' + error.message });
        }
    });

    // ─── Codex / Antigravity default models ──────────────────────────────
    // Read by Praxis's codex / antigravity executors at dispatch time
    // (cached 60s there) and by the dashboard's Model Control panel. Unlike
    // claude-default, an EMPTY model is valid and means "use the CLI's own
    // default" (no --model flag), so PUT accepts empty to clear.
    for (const [route, key] of [
        ['codex-default', 'codex_default_model'],
        ['antigravity-default', 'antigravity_default_model']
    ]) {
        router.get(`/${route}`, async (_req, res) => {
            try {
                res.json({ model: await getCliDefaultModel(db, key) });
            } catch (error) {
                console.error(`[Model Control] Failed to read ${route}:`, error);
                res.status(500).json({ error: `Failed to read ${route}: ` + error.message });
            }
        });

        router.put(`/${route}`, async (req, res) => {
            try {
                if (typeof req.body.model !== 'string') {
                    return res.status(400).json({ error: 'model must be a string (empty = CLI default)' });
                }
                const model = req.body.model.trim();
                await db.setModelControlSetting(key, { model });
                notifyPraxisStateDoc(route);
                res.json({ model });
            } catch (error) {
                console.error(`[Model Control] Failed to update ${route}:`, error);
                res.status(500).json({ error: `Failed to update ${route}: ` + error.message });
            }
        });
    }

    // ─── Per-model default thinking levels ───────────────────────────────
    // Read by Praxis at dispatch time (executors/thinking-levels.ts, cached
    // 60s) and by the dashboard's Model Control panel. PUT accepts either a
    // whole `levels` map or a single `{ model, level }`; an empty/"default"
    // level clears that model's entry.
    router.get('/thinking-levels', async (_req, res) => {
        try {
            res.json({ levels: await getThinkingLevels(db) });
        } catch (error) {
            console.error('[Model Control] Failed to read thinking levels:', error);
            res.status(500).json({ error: 'Failed to read thinking levels: ' + error.message });
        }
    });

    router.put('/thinking-levels', async (req, res) => {
        try {
            const body = req.body || {};
            let incoming;
            if (body.levels && typeof body.levels === 'object' && !Array.isArray(body.levels)) {
                incoming = body.levels;
            } else if (typeof body.model === 'string' && body.model.trim()) {
                incoming = { [body.model.trim()]: body.level };
            } else {
                return res.status(400).json({ error: 'levels object or { model, level } is required' });
            }

            const current = await db.getModelControlSetting('thinking_levels');
            const stored = current && typeof current === 'object' && current.levels && typeof current.levels === 'object'
                ? { ...current.levels }
                : {};
            for (const [rawModel, rawLevel] of Object.entries(incoming)) {
                const model = String(rawModel || '').trim();
                if (!model) return res.status(400).json({ error: 'model keys must be non-empty strings' });
                const normalized = normalizeThinkingLevel(model, rawLevel);
                if (!normalized.ok) return res.status(400).json({ error: normalized.error });
                // Store the cleared value explicitly so it can beat a seed.
                stored[model] = normalized.value;
            }
            await db.setModelControlSetting('thinking_levels', { levels: stored });
            notifyPraxisStateDoc('thinking-levels');
            res.json({ levels: await getThinkingLevels(db) });
        } catch (error) {
            console.error('[Model Control] Failed to update thinking levels:', error);
            res.status(500).json({ error: 'Failed to update thinking levels: ' + error.message });
        }
    });

    // Codex and Antigravity picker entries, from the model registry.
    router.get('/codex-models', (_req, res) => {
        try {
            res.json({ models: listCodexModels(), source: modelRegistry.registrySource('codex') });
        } catch (error) {
            console.error('[Model Control] Failed to list codex models:', error);
            res.status(500).json({ error: 'Failed to list codex models: ' + error.message });
        }
    });

    // The whole registry: every model each executor CLI offers (Praxis
    // src/models/registry.ts). The dashboard's model pickers read this.
    router.get('/available-models', (_req, res) => {
        const registry = modelRegistry.readModelRegistry();
        if (!registry) return res.status(404).json({ error: modelRegistry.registrySource('codex') });
        res.json(registry);
    });

    router.get('/antigravity-models', async (_req, res) => {
        try {
            res.json({ models: await listAntigravityModels(), source: modelRegistry.registrySource('antigravity') });
        } catch (error) {
            console.error('[Model Control] Failed to list antigravity models:', error);
            res.status(500).json({ error: 'Failed to list antigravity models: ' + error.message });
        }
    });

    // ─── Praxis chat backend ──────────────────────────────────────────────
    // Which engine fronts Robert's interactive chat: the permanent Claude
    // CLI session, the permanent Codex CLI session, or the legacy in-process
    // routed-LLM loop ("off").
    router.get('/chat-backend', async (_req, res) => {
        try {
            res.json({ backend: await getChatBackend(db) });
        } catch (error) {
            console.error('[Model Control] Failed to read chat backend:', error);
            res.status(500).json({ error: 'Failed to read chat backend: ' + error.message });
        }
    });

    router.put('/chat-backend', async (req, res) => {
        try {
            const backend = CHAT_BACKENDS.includes(req.body.backend) ? req.body.backend : null;
            if (!backend) {
                return res.status(400).json({ error: `backend must be one of: ${CHAT_BACKENDS.join(', ')}` });
            }
            await db.setModelControlSetting('chat_backend', { backend });
            notifyPraxisStateDoc('chat-backend');
            res.json({ backend });
        } catch (error) {
            console.error('[Model Control] Failed to update chat backend:', error);
            res.status(500).json({ error: 'Failed to update chat backend: ' + error.message });
        }
    });

    // ─── Praxis chat config (backend + model + thinking level) ────────────
    // One payload for everything that shapes the permanent chat session.
    // Read by Praxis chat-cli-session.ts (cached 60s) and the dashboard
    // settings modal. PUT accepts partial updates; chat models may be empty
    // (= fall back to the executor's default-model chain).
    router.get('/chat-config', async (_req, res) => {
        try {
            res.json(await getChatConfig(db));
        } catch (error) {
            console.error('[Model Control] Failed to read chat config:', error);
            res.status(500).json({ error: 'Failed to read chat config: ' + error.message });
        }
    });

    router.put('/chat-config', async (req, res) => {
        try {
            const body = req.body || {};
            // Validate everything up front — a bad field must not leave a
            // partial update behind.
            if ('backend' in body && !CHAT_BACKENDS.includes(body.backend)) {
                return res.status(400).json({ error: `backend must be one of: ${CHAT_BACKENDS.join(', ')}` });
            }
            if ('thinkingLevel' in body && !CHAT_THINKING_LEVELS.includes(body.thinkingLevel)) {
                return res.status(400).json({ error: `thinkingLevel must be one of: ${CHAT_THINKING_LEVELS.join(', ')}` });
            }
            for (const field of ['claudeModel', 'codexModel']) {
                if (field in body && typeof body[field] !== 'string') {
                    return res.status(400).json({ error: `${field} must be a string (empty = executor default)` });
                }
            }
            if ('backend' in body) await db.setModelControlSetting('chat_backend', { backend: body.backend });
            if ('thinkingLevel' in body) await db.setModelControlSetting('chat_thinking_level', { level: body.thinkingLevel });
            if ('claudeModel' in body) await db.setModelControlSetting('chat_claude_model', { model: body.claudeModel.trim() });
            if ('codexModel' in body) await db.setModelControlSetting('chat_codex_model', { model: body.codexModel.trim() });
            notifyPraxisStateDoc('chat-config');
            res.json(await getChatConfig(db));
        } catch (error) {
            console.error('[Model Control] Failed to update chat config:', error);
            res.status(500).json({ error: 'Failed to update chat config: ' + error.message });
        }
    });

    // ─── Praxis agent backend ─────────────────────────────────────────────
    // Which engine runs Praxis's autonomous SYSTEM agent tasks (wakeups,
    // morning routine, HITL resumes). "codex"/"claude-code" = signed-in CLI
    // subscriptions; "gemini" = the in-process API loop (always the implicit
    // last resort even if not listed in fallbacks).
    router.get('/agent-backend', async (_req, res) => {
        try {
            res.json(await getAgentBackendConfig(db));
        } catch (error) {
            console.error('[Model Control] Failed to read agent backend:', error);
            res.status(500).json({ error: 'Failed to read agent backend: ' + error.message });
        }
    });

    router.put('/agent-backend', async (req, res) => {
        try {
            const backend = AGENT_BACKENDS.includes(req.body.backend) ? req.body.backend : null;
            if (!backend) {
                return res.status(400).json({ error: `backend must be one of: ${AGENT_BACKENDS.join(', ')}` });
            }
            const fallbacks = Array.isArray(req.body.fallbacks)
                ? req.body.fallbacks.filter(f => AGENT_BACKENDS.includes(f) && f !== backend)
                : AGENT_BACKEND_DEFAULT.fallbacks.filter(f => f !== backend);
            const value = { backend, fallbacks };
            await db.setModelControlSetting('agent_backend', value);
            notifyPraxisStateDoc('agent-backend');
            res.json(value);
        } catch (error) {
            console.error('[Model Control] Failed to update agent backend:', error);
            res.status(500).json({ error: 'Failed to update agent backend: ' + error.message });
        }
    });

    // ─── Fable-5 credit availability ──────────────────────────────────────
    // out:true → Praxis reroutes Fable-tier dispatches (primary → Sol,
    // QA/correction → Opus 4.8). `until` (ISO) auto-reverts when it passes.
    router.get('/fable-availability', async (_req, res) => {
        try {
            res.json(await getFableAvailability(db));
        } catch (error) {
            console.error('[Model Control] Failed to read fable availability:', error);
            res.status(500).json({ error: 'Failed to read fable availability: ' + error.message });
        }
    });

    router.put('/fable-availability', async (req, res) => {
        try {
            const body = req.body || {};
            const out = body.out === true || body.out === 'true';
            let until = null;
            if (body.until != null && body.until !== '') {
                const ms = Date.parse(body.until);
                if (!Number.isFinite(ms)) {
                    return res.status(400).json({ error: 'until must be an ISO date string' });
                }
                until = new Date(ms).toISOString();
            }
            const reason = typeof body.reason === 'string' ? body.reason.slice(0, 300) : null;
            await db.setModelControlSetting('fable_availability', { out, until, reason });
            notifyPraxisStateDoc('fable-availability');
            res.json(await getFableAvailability(db));
        } catch (error) {
            console.error('[Model Control] Failed to update fable availability:', error);
            res.status(500).json({ error: 'Failed to update fable availability: ' + error.message });
        }
    });

    router.post('/resolve', async (req, res) => {
        try {
            const body = req.body || {};
            const resolved = await resolveModelAssignment(db, body);

            // Praxis's calendar poller (owner of the firing loop since the
            // 2026-07-06 consolidation) asks resolve to also record the
            // execution snapshot and announce redirects, so those DB/chat
            // writes stay server-side. Both enrich — never gate — resolution.
            try {
                if (body.snapshot && typeof body.snapshot === 'object') {
                    await recordModelExecutionSnapshot(db, resolved, body.snapshot);
                }
                if (body.announceTitle && (resolved.localOnlyActive || resolved.fallbackUsed)) {
                    const reason = resolved.localOnlyActive
                        ? `local-only mode${resolved.localOnlyReason ? ` (${resolved.localOnlyReason})` : ''}`
                        : `fallback (${resolved.fallbackReason || 'requested model unavailable'})`;
                    await writeModelSystemMessage(
                        db,
                        io,
                        `Model control redirected scheduled event "${body.announceTitle}" to ${resolved.label || resolved.apiModelId} via ${reason}.`,
                        { modelControl: { resolved, modelAssignment: body.model_assignment, calendarEventId: body.calendarEventId } }
                    );
                }
            } catch (sideEffectError) {
                console.warn('[Model Control] resolve side effects failed (resolution still returned):', sideEffectError.message);
            }

            res.json(resolved);
        } catch (error) {
            console.error('[Model Control] Failed to resolve assignment:', error);
            res.status(500).json({ error: 'Failed to resolve model assignment: ' + error.message });
        }
    });

    router.post('/probe', async (req, res) => {
        try {
            const body = req.body || {};
            const mode = body.mode === 'live' ? 'live' : 'resolve';
            const projectId = body.projectId || body.project_id || null;
            const modelAssignment = body.model_assignment || body.modelAssignment || body.assignment || 'alias:local_default';
            const resolved = await resolveModelAssignment(db, {
                ...body,
                model_assignment: modelAssignment,
                requestedAssignment: modelAssignment,
                projectId,
                project_id: projectId,
                role: body.role || 'model_control_probe'
            });

            if (mode !== 'live') {
                return res.json({ mode: 'resolve', live: false, resolved });
            }
            if (typeof callAI !== 'function') {
                return res.status(503).json({ error: 'Live model probe is not configured' });
            }

            const prompt = body.prompt || 'Reply with exactly: model control probe ok';
            const result = await callAI(
                toModelOverride(resolved),
                prompt,
                'You are running a tiny live Model Control probe. Reply briefly.',
                [],
                { returnFullResult: true }
            );
            const snapshot = await recordModelExecutionSnapshot(db, resolved, {
                project_id: projectId,
                command_id: 'model-control-probe'
            });
            if (resolved.localOnlyActive || resolved.fallbackUsed) {
                const reason = resolved.localOnlyActive
                    ? `local-only mode${resolved.localOnlyReason ? ` (${resolved.localOnlyReason})` : ''}`
                    : `fallback (${resolved.fallbackReason || 'requested model unavailable'})`;
                await writeModelSystemMessage(
                    db,
                    io,
                    `Model control live probe routed to ${resolved.label || resolved.apiModelId} via ${reason}.`,
                    { modelControl: { resolved, modelAssignment, probe: true } }
                );
            }
            res.json({
                mode: 'live',
                live: true,
                resolved,
                response: result?.text || String(result || ''),
                usage: result?.usage || null,
                snapshot
            });
        } catch (error) {
            console.error('[Model Control] Failed to run probe:', error);
            res.status(500).json({ error: 'Failed to run model-control probe: ' + error.message });
        }
    });

    router.get('/executions', async (req, res) => {
        try {
            res.json(await db.getModelExecutionSnapshots({
                projectId: req.query.projectId || undefined,
                taskId: req.query.taskId || undefined,
                calendarEventId: req.query.calendarEventId || undefined,
                workflowId: req.query.workflowId || undefined,
                workflowRunId: req.query.workflowRunId || undefined,
                nodeId: req.query.nodeId || undefined,
                conversationId: req.query.conversationId || undefined,
                messageId: req.query.messageId || undefined,
                commandId: req.query.commandId || undefined,
                provider: req.query.provider || undefined,
                resolvedModelId: req.query.resolvedModelId || undefined,
                fallbackUsed: req.query.fallbackUsed === undefined ? undefined : req.query.fallbackUsed === 'true',
                localOnlyActive: req.query.localOnlyActive === undefined ? undefined : req.query.localOnlyActive === 'true',
                limit: Number(req.query.limit) || 50,
                offset: Number(req.query.offset) || 0
            }));
        } catch (error) {
            console.error('[Model Control] Failed to load execution snapshots:', error);
            res.status(500).json({ error: 'Failed to load model execution snapshots: ' + error.message });
        }
    });

    router.get('/budget-status', async (req, res) => {
        try {
            const projectId = req.query.projectId || null;
            const globalPolicy = await db.getModelControlSetting('model_policy');
            const projectPolicy = projectId && typeof db.getProjectModelControlSetting === 'function'
                ? await db.getProjectModelControlSetting(projectId, 'model_policy')
                : null;
            const policy = mergePolicies(globalPolicy, projectPolicy);
            res.json(await getBudgetStatus(db, policy));
        } catch (error) {
            console.error('[Model Control] Failed to load budget status:', error);
            res.status(500).json({ error: 'Failed to load budget status: ' + error.message });
        }
    });

    // The dashboard's sync button: re-read the CLI registry and the OpenRouter
    // catalog Praxis writes and bring the model rows in line. No vendor calls.
    router.post('/discover', async (_req, res) => {
        try {
            if (typeof syncModelSources !== 'function') {
                return res.status(503).json({ error: 'Model source sync is not configured' });
            }
            res.json(await syncModelSources({ db }));
        } catch (error) {
            console.error('[Model Control] Failed to sync model sources:', error);
            res.status(500).json({ error: 'Failed to sync model sources: ' + error.message });
        }
    });

    router.put('/aliases/:alias', async (req, res) => {
        try {
            res.json(await db.upsertModelAlias({
                alias: req.params.alias,
                target: req.body.target,
                description: req.body.description,
                is_active: req.body.is_active
            }));
        } catch (error) {
            console.error('[Model Control] Failed to update alias:', error);
            res.status(500).json({ error: 'Failed to update model alias: ' + error.message });
        }
    });

    router.get('/roles', async (req, res) => {
        try {
            const roles = await db.getModelRoles(false);
            // Resolve each role to its current model so the UI / probe shows
            // exactly what every call site will hit right now.
            const resolved = await Promise.all(roles.map(async (r) => {
                let resolution = null;
                try { resolution = await resolveModelAssignment(db, { role: r.role }); } catch (_) { /* show raw */ }
                return {
                    role: r.role,
                    assignment: r.assignment,
                    description: r.description,
                    is_active: r.is_active,
                    resolvedProvider: resolution?.provider || null,
                    resolvedModel: resolution?.apiModelId || null,
                    resolvedLabel: resolution?.label || null,
                    // CLI-lane roles: the per-role thinking selector and the
                    // full lane target, so the UI shows model+thinking at a glance.
                    resolvedThinking: resolution?.cli?.thinking || resolution?.parameters?.thinking_level || null,
                    cli: resolution?.cli || null,
                    source: resolution?.source || null
                };
            }));
            res.json({ roles: resolved });
        } catch (error) {
            console.error('[Model Control] Failed to load roles:', error);
            res.status(500).json({ error: 'Failed to load model roles: ' + error.message });
        }
    });

    router.put('/roles/:role', async (req, res) => {
        try {
            res.json(await db.upsertModelRole({
                role: req.params.role,
                assignment: req.body.assignment,
                description: req.body.description,
                is_active: req.body.is_active
            }));
        } catch (error) {
            console.error('[Model Control] Failed to update role:', error);
            res.status(500).json({ error: 'Failed to update model role: ' + error.message });
        }
    });

    router.put('/local-only', async (req, res) => {
        try {
            res.json(await db.setModelControlSetting('local_only', {
                enabled: !!req.body.enabled,
                reason: req.body.reason || null
            }));
        } catch (error) {
            console.error('[Model Control] Failed to update local-only mode:', error);
            res.status(500).json({ error: 'Failed to update local-only mode: ' + error.message });
        }
    });

    router.put('/policy', async (req, res) => {
        try {
            res.json(await db.setModelControlSetting('model_policy', normalizePolicyInput(req.body)));
        } catch (error) {
            console.error('[Model Control] Failed to update model policy:', error);
            res.status(500).json({ error: 'Failed to update model policy: ' + error.message });
        }
    });

    router.put('/projects/:id/aliases/:alias', async (req, res) => {
        try {
            res.json(await db.upsertProjectModelAlias(req.params.id, {
                alias: req.params.alias,
                target: req.body.target,
                description: req.body.description
            }));
        } catch (error) {
            console.error('[Model Control] Failed to update project alias:', error);
            res.status(500).json({ error: 'Failed to update project model alias: ' + error.message });
        }
    });

    router.put('/projects/:id/policy', async (req, res) => {
        try {
            res.json(await db.setProjectModelControlSetting(req.params.id, 'model_policy', normalizePolicyInput(req.body)));
        } catch (error) {
            console.error('[Model Control] Failed to update project model policy:', error);
            res.status(500).json({ error: 'Failed to update project model policy: ' + error.message });
        }
    });

    return router;
}

module.exports = createModelControlRouter;
// Test/operator seam for the Codex roster (reads the model registry, no router needed).
module.exports.listCodexModels = listCodexModels;
