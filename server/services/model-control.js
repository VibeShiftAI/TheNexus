const { buildChatMessageEvent } = require('../chat-message-format');

function normalizeProvider(provider) {
    const value = String(provider || '').toLowerCase();
    if (value === 'gemini') return 'google';
    if (value === 'claude') return 'anthropic';
    if (value === 'grok') return 'xai';
    return value || 'local';
}

function normalizeAssignment(value) {
    if (!value || typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length ? trimmed : null;
}

function pickRequestedAssignment(context = {}) {
    return normalizeAssignment(
        context.model_assignment
        || context.modelAssignment
        || context.assignment
        || context.requestedAssignment
        || context.task?.model_assignment
        || context.calendarEvent?.model_assignment
        || context.workflowNode?.model_assignment
        || context.workflowNode?.data?.model_assignment
        || context.workflow?.model_assignment
        || context.defaultAssignment
    );
}

function providerHasCredentials(provider) {
    switch (normalizeProvider(provider)) {
        case 'google':
            return !!(process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY);
        case 'openai':
            return !!process.env.OPENAI_API_KEY;
        case 'anthropic':
            return !!process.env.ANTHROPIC_API_KEY;
        case 'xai':
            return !!process.env.XAI_API_KEY;
        case 'local':
            return true;
        default:
            return false;
    }
}

function isModelAvailable(model) {
    if (!model) return { available: false, reason: 'model not found' };
    if (model.is_active === false || model.is_active === 0) return { available: false, reason: 'model is inactive' };
    if (['unavailable', 'disabled', 'retired'].includes(String(model.availability_status || '').toLowerCase())) {
        return { available: false, reason: `model is ${model.availability_status}` };
    }
    if (!providerHasCredentials(model.provider)) {
        return { available: false, reason: `missing API key for provider ${normalizeProvider(model.provider)}` };
    }
    return { available: true };
}

function compareVersionSort(a, b) {
    const av = a.version_sort || a.api_model_id || a.id || '';
    const bv = b.version_sort || b.api_model_id || b.id || '';
    return String(bv).localeCompare(String(av), undefined, { numeric: true, sensitivity: 'base' });
}

function summarizeParameters(parameters = {}) {
    const summary = {};
    for (const key of ['temperature', 'top_p', 'max_tokens', 'max_output_tokens', 'reasoning_effort', 'thinking_budget']) {
        if (parameters[key] !== undefined) summary[key] = parameters[key];
    }
    if (parameters.thinking_config) summary.thinking_config = true;
    return summary;
}

function buildResolved(model, requestedAssignment, source, extras = {}) {
    const parameters = {
        ...(model.default_parameters || {}),
        ...(model.parameters || {}),
        ...(extras.parameters || {})
    };
    const provider = normalizeProvider(model.provider);
    const apiModelId = model.api_model_id || model.apiModelId || model.model || model.id;
    return {
        requestedAssignment,
        assignment: `model:${model.id}`,
        resolvedModelId: model.id,
        provider,
        apiModelId,
        model: apiModelId,
        parameters,
        label: model.display_name || model.name || model.id,
        source,
        localOnlyActive: false,
        fallbackUsed: false,
        ...extras
    };
}

function parseFallbackChain(assignment) {
    const raw = assignment.replace(/^fallback_chain:/, '').trim();
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.map(normalizeAssignment).filter(Boolean) : [];
    } catch (_err) {
        return raw.replace(/^\[/, '').replace(/\]$/, '')
            .split(',')
            .map(part => normalizeAssignment(part.replace(/^["']|["']$/g, '')))
            .filter(Boolean);
    }
}

async function resolveAlias(db, aliasName, context, requestedAssignment, fallbackState) {
    const projectId = context.project_id || context.projectId || context.project?.id || null;
    if (projectId && typeof db.getProjectModelAliases === 'function') {
        const projectAliases = await db.getProjectModelAliases(projectId);
        const projectAlias = (projectAliases || []).find(a => a.alias === aliasName);
        if (projectAlias) {
            return resolveAssignment(db, projectAlias.target, context, requestedAssignment, {
                ...fallbackState,
                sourceOverride: 'project_alias'
            });
        }
    }

    const aliases = typeof db.getModelAliases === 'function' ? await db.getModelAliases(true) : [];
    const globalAlias = (aliases || []).find(a => a.alias === aliasName);
    if (!globalAlias) {
        return { unavailable: true, reason: `alias ${aliasName} not found` };
    }
    return resolveAssignment(db, globalAlias.target, context, requestedAssignment, {
        ...fallbackState,
        sourceOverride: 'global_alias'
    });
}

async function resolveFamilyLatest(db, assignment, requestedAssignment, fallbackState) {
    const [, spec] = assignment.split(':');
    const [providerRaw, family] = String(spec || '').split('/');
    const provider = normalizeProvider(providerRaw);
    const models = await db.getModels(true);
    const candidates = (models || [])
        .filter(model => normalizeProvider(model.provider) === provider && model.family === family)
        .sort(compareVersionSort);

    for (const model of candidates) {
        const availability = isModelAvailable(model);
        if (availability.available) {
            return buildResolved(model, requestedAssignment, fallbackState.sourceOverride || 'family_latest', fallbackState);
        }
    }
    return { unavailable: true, reason: `no available ${provider}/${family} model` };
}

async function resolveCapabilityBest(db, assignment, requestedAssignment, fallbackState) {
    const capability = assignment.replace(/^capability_best:/, '').trim();
    const models = await db.getModels(true);
    const candidates = (models || [])
        .filter(model => model.capabilities && model.capabilities[capability])
        .sort(compareVersionSort);

    for (const model of candidates) {
        const availability = isModelAvailable(model);
        if (availability.available) {
            return buildResolved(model, requestedAssignment, fallbackState.sourceOverride || 'capability_best', fallbackState);
        }
    }
    return { unavailable: true, reason: `no available model for capability ${capability}` };
}

async function resolveModel(db, modelId, requestedAssignment, fallbackState) {
    const model = await db.getModel(modelId);
    const availability = isModelAvailable(model);
    if (!availability.available) {
        return { unavailable: true, reason: availability.reason };
    }
    return buildResolved(model, requestedAssignment, fallbackState.sourceOverride || 'item', fallbackState);
}

async function resolveAssignment(db, assignment, context, requestedAssignment, fallbackState = {}) {
    const normalized = normalizeAssignment(assignment);
    if (!normalized) return { unavailable: true, reason: 'no assignment provided' };

    if (normalized.startsWith('fallback_chain:')) {
        const chain = parseFallbackChain(normalized);
        let fallbackReason = null;
        for (const candidate of chain) {
            const resolved = await resolveAssignment(db, candidate, context, requestedAssignment, {
                ...fallbackState,
                fallbackUsed: !!fallbackReason,
                fallbackReason
            });
            if (!resolved.unavailable) return resolved;
            fallbackReason = resolved.reason;
        }
        return { unavailable: true, reason: fallbackReason || 'fallback chain did not resolve' };
    }

    if (normalized.startsWith('model:')) {
        return resolveModel(db, normalized.slice('model:'.length), requestedAssignment, fallbackState);
    }
    if (normalized.startsWith('alias:')) {
        return resolveAlias(db, normalized.slice('alias:'.length), context, requestedAssignment, fallbackState);
    }
    if (normalized.startsWith('family_latest:')) {
        return resolveFamilyLatest(db, normalized, requestedAssignment, fallbackState);
    }
    if (normalized.startsWith('capability_best:')) {
        return resolveCapabilityBest(db, normalized, requestedAssignment, fallbackState);
    }

    return resolveModel(db, normalized, requestedAssignment, fallbackState);
}

async function resolveFirstLocalModel(db, requestedAssignment, extras = {}) {
    const localAlias = await resolveAssignment(db, 'alias:local_default', {}, requestedAssignment, {
        sourceOverride: extras.sourceOverride || 'local_fallback',
        ...extras
    });
    if (!localAlias.unavailable && localAlias.provider === 'local') return localAlias;

    const models = await db.getModels(true);
    const local = (models || [])
        .filter(model => normalizeProvider(model.provider) === 'local')
        .sort(compareVersionSort)
        .find(model => isModelAvailable(model).available);
    if (!local) throw new Error('No active local model is available for model-control fallback');
    return buildResolved(local, requestedAssignment, extras.sourceOverride || 'local_fallback', extras);
}

async function resolveLocalOnly(db, requestedAssignment, reason) {
    const resolved = await resolveFirstLocalModel(db, requestedAssignment, {
        sourceOverride: 'local_only',
        localOnlyActive: true,
        localOnlyReason: reason || null,
        fallbackUsed: !!requestedAssignment && !String(requestedAssignment).startsWith('model:local'),
        fallbackReason: reason ? `local-only override: ${reason}` : 'local-only override'
    });
    resolved.localOnlyActive = true;
    resolved.localOnlyReason = reason || null;
    resolved.source = 'local_only';
    return resolved;
}

async function resolveNormal(db, requestedAssignment, context = {}) {
    const candidate = requestedAssignment || context.projectDefaultAssignment || context.globalDefaultAssignment || 'alias:local_default';
    const resolved = await resolveAssignment(db, candidate, context, candidate);
    if (!resolved.unavailable) return resolved;

    const local = await resolveFirstLocalModel(db, candidate, {
        sourceOverride: 'local_fallback',
        fallbackUsed: true,
        fallbackReason: resolved.reason
    });
    local.fallbackUsed = true;
    local.fallbackReason = resolved.reason;
    return local;
}

async function resolveModelAssignment(db, context = {}) {
    const settings = await db.getModelControlSetting('local_only');
    const requestedAssignment = pickRequestedAssignment(context);
    if (settings?.enabled) {
        return resolveLocalOnly(db, requestedAssignment, settings.reason);
    }
    return resolveNormal(db, requestedAssignment, context);
}

async function recordModelExecutionSnapshot(db, resolved, links = {}) {
    if (!resolved) return null;
    return db.createModelExecutionSnapshot({
        requested_assignment: resolved.requestedAssignment,
        resolved_model_id: resolved.resolvedModelId,
        provider: resolved.provider,
        api_model_id: resolved.apiModelId,
        parameters_summary: summarizeParameters(resolved.parameters),
        source: resolved.source,
        local_only_active: resolved.localOnlyActive ? 1 : 0,
        local_only_reason: resolved.localOnlyReason || null,
        fallback_used: resolved.fallbackUsed ? 1 : 0,
        fallback_reason: resolved.fallbackReason || null,
        ...links
    });
}

async function writeModelSystemMessage(db, io, message, metadata = {}) {
    const conversation = await db.getActiveConversation?.('praxis');
    if (!conversation) return null;
    const saved = await db.saveChatMessage({
        conversation_id: conversation.id,
        role: 'system',
        content: message,
        mode: 'praxis',
        metadata
    });
    if (saved && io) io.emit('chat-message', buildChatMessageEvent(saved));
    return saved;
}

module.exports = {
    normalizeProvider,
    resolveModelAssignment,
    recordModelExecutionSnapshot,
    summarizeParameters,
    writeModelSystemMessage
};
