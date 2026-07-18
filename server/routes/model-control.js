const express = require('express');
const { spawn } = require('child_process');
const {
    resolveModelAssignment,
    mergePolicies,
    getBudgetStatus,
    recordModelExecutionSnapshot,
    writeModelSystemMessage
} = require('../services/model-control');

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
const CLAUDE_DEFAULT_FALLBACK = 'claude-opus-4-8';
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
 * The model list the antigravity selector offers — ground truth is the local
 * `agy models` output (node-api runs on the same machine as the CLI). Cached
 * 10 minutes; falls back to the last-known list when the CLI is unavailable.
 */
const AGY_MODELS_FALLBACK = [
    'Gemini 3.5 Flash (Medium)',
    'Gemini 3.5 Flash (High)',
    'Gemini 3.5 Flash (Low)',
    'Gemini 3.1 Pro (Low)',
    'Gemini 3.1 Pro (High)',
    'Claude Sonnet 4.6 (Thinking)',
    'Claude Opus 4.6 (Thinking)',
    'GPT-OSS 120B (Medium)'
];
let agyModelsCache = null; // { models, expiresAt }
function listAntigravityModels() {
    if (agyModelsCache && agyModelsCache.expiresAt > Date.now()) {
        return Promise.resolve(agyModelsCache.models);
    }
    return new Promise((resolve) => {
        const agyBin = process.env.AGY_BIN || '/opt/homebrew/bin/agy';
        const finish = (stdout, failure) => {
            const parsed = !failure && stdout
                ? stdout.split('\n').map(line => line.trim()).filter(Boolean)
                : [];
            const models = parsed.length ? parsed : AGY_MODELS_FALLBACK;
            agyModelsCache = { models, expiresAt: Date.now() + 10 * 60 * 1000 };
            if (failure) console.warn('[Model Control] agy models unavailable, using fallback list:', failure);
            resolve(models);
        };
        let child;
        try {
            // stdin must be 'ignore' — agy errors out on a pipe stdin.
            child = spawn(agyBin, ['models'], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 });
        } catch (error) {
            return finish('', error.message);
        }
        let stdout = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.on('error', (error) => finish('', error.message));
        child.on('close', (code) => finish(stdout, code === 0 ? null : `agy models exited with code ${code}`));
    });
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
 * CLI does on its own; the rest map to MAX_THINKING_TOKENS (claude) /
 * model_reasoning_effort (codex) on the Praxis side.
 */
const CHAT_THINKING_LEVELS = ['default', 'low', 'medium', 'high'];
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

/** The whole chat-session config in one payload (Praxis fetches this per turn, cached 60s). */
async function getChatConfig(db) {
    return {
        backend: await getChatBackend(db),
        claudeModel: await getChatModel(db, 'chat_claude_model'),
        codexModel: await getChatModel(db, 'chat_codex_model'),
        thinkingLevel: await getChatThinkingLevel(db)
    };
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

function createModelControlRouter({ db, discoverModelRegistry, callAI, io }) {
    const router = express.Router();

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
                agentBackend: await getAgentBackendConfig(db),
                chatBackend: await getChatBackend(db),
                chatConfig: await getChatConfig(db),
                projectPolicy: projectId && typeof db.getProjectModelControlSetting === 'function'
                    ? await db.getProjectModelControlSetting(projectId, 'model_policy')
                    : null
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
                res.json({ model });
            } catch (error) {
                console.error(`[Model Control] Failed to update ${route}:`, error);
                res.status(500).json({ error: `Failed to update ${route}: ` + error.message });
            }
        });
    }

    // The model names the antigravity selector can offer (`agy models` output;
    // display names are the only values the agy CLI actually pins on).
    router.get('/antigravity-models', async (_req, res) => {
        try {
            res.json({ models: await listAntigravityModels() });
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
            res.json(value);
        } catch (error) {
            console.error('[Model Control] Failed to update agent backend:', error);
            res.status(500).json({ error: 'Failed to update agent backend: ' + error.message });
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

    router.post('/discover', async (_req, res) => {
        try {
            if (typeof discoverModelRegistry !== 'function') {
                return res.status(503).json({ error: 'Model discovery is not configured' });
            }
            res.json(await discoverModelRegistry({ db }));
        } catch (error) {
            console.error('[Model Control] Failed to run model discovery:', error);
            res.status(500).json({ error: 'Failed to run model discovery: ' + error.message });
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
