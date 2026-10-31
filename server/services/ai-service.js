/**
 * AI service — thin relay to Praxis's LLM manager.
 *
 * 2026-07-06 consolidation: TheNexus no longer owns provider SDKs or API
 * keys for chat completions. callAI() keeps its signature and result
 * contract ({ text, usage, finishReason, truncated } / plain text) but every call rides Praxis's
 * POST /v1/llm/chat/completions (the OpenAI-wire raw-completion gateway;
 * ported off /v1/brain/chat by ticket C-1, 2026-09-04) with an explicit
 * provider/model pin or a model-control role — Praxis
 * normalizes response_format per provider, enforces budget/semaphore,
 * logs usage to the shared llm_calls ledger, and cascades on provider
 * failure. (runDeepResearch, the last direct Gemini client here, had no
 * caller and was removed 2026-10-30.)
 */
const fs = require('fs');
const path = require('path');

// Configuration
const PROJECT_ROOT = process.env.PROJECT_ROOT || path.resolve(process.env.USERPROFILE || process.env.HOME, 'Projects');
const AGENT_CONFIG_PATH = path.join(PROJECT_ROOT, 'TheNexus', 'agent-config.json'); // Assumption based on context
const tokenTracker = require('../utils/token-tracker');
const db = require('../../db');

const { praxisFetch } = require('./praxis-client');
// Local-model turns can take minutes; match the generous chat relay timeout.
const PRAXIS_BRAIN_TIMEOUT_MS = Number(process.env.PRAXIS_BRAIN_TIMEOUT_MS || 600000);

// Maps task types to agent IDs in config file
const TASK_TO_AGENT_MAP = {
    plan: 'plan-generator',
    research: 'auto-research',
    implementation: 'implementation',
    quick: 'quick-research'
};

function normalizeProvider(provider) {
    const value = String(provider || '').toLowerCase();
    if (value === 'gemini') return 'google';
    if (value === 'claude') return 'anthropic';
    if (value === 'grok') return 'xai';
    return value || 'google';
}

/**
 * Get AI model config for a task
 * Priority: 1. Database (is_default_for_task), 2. agent-config.json
 * @param {string} taskType - Task type: 'plan', 'research', 'implementation', 'quick'
 * @returns {Promise<Object>} Model configuration
 * @throws {Error} If no model configuration found
 */
async function getAIModelConfig(taskType) {
    // 1. Try database first - get model marked as default for this task type
    try {
        const dbModel = await db.getDefaultModelForTask(taskType);
        if (dbModel) {
            console.log(`[AI Config] Task '${taskType}' using DB model -> ${dbModel.provider}/${dbModel.id}`);
            return {
                provider: dbModel.provider,
                model: dbModel.id,
                api_model_id: dbModel.api_model_id || dbModel.apiModelId,
                thinkingEnabled: dbModel.capabilities?.thinking || false,
                thinkingConfig: dbModel.parameters?.thinking_config,
                description: dbModel.name
            };
        }
    } catch (dbError) {
        console.error(`[AI Config] Database error for '${taskType}':`, dbError.message);
        throw new Error(`Failed to get model config from database: ${dbError.message}`);
    }

    // 2. Try agent-config.json as fallback
    try {
        if (fs.existsSync(AGENT_CONFIG_PATH)) {
            const configData = fs.readFileSync(AGENT_CONFIG_PATH, 'utf-8');
            const config = JSON.parse(configData);
            const agentId = TASK_TO_AGENT_MAP[taskType];

            if (agentId && config.agents) {
                const agent = config.agents[agentId];
                if (agent && agent.defaultModel) {
                    const modelId = agent.defaultModel;
                    // Determine provider from model name
                    let provider = 'google';
                    if (modelId.startsWith('claude') || modelId.includes('anthropic')) {
                        provider = 'anthropic';
                    } else if (modelId.startsWith('gpt') || modelId.includes('openai')) {
                        provider = 'openai';
                    } else if (modelId.startsWith('local/') || modelId.includes('local')) {
                        provider = 'local';
                    }

                    console.log(`[AI Config] Task '${taskType}' using agent-config.json '${agentId}' -> ${provider}/${modelId}`);

                    return {
                        provider,
                        model: modelId,
                        thinkingEnabled: agent.thinkingEnabled || false,
                        thinkingConfig: agent.thinkingLevel ? { thinking_level: agent.thinkingLevel } : undefined,
                        description: agent.description || taskType
                    };
                }
            }
        }
    } catch (fileError) {
        console.warn(`[AI Config] Error reading agent-config.json for '${taskType}':`, fileError.message);
    }

    // 3. No config found - throw error (no hardcoded fallbacks)
    throw new Error(`No model configuration found for task type '${taskType}'. Please configure a default model in the database.`);
}

/**
 * Message for an answer the model stopped writing at its output limit.
 * Praxis already retried such a call once without `max_tokens`, so a
 * "length" stop that reaches The Nexus is the model's own limit.
 */
const OUTPUT_LIMIT_NOTE = 'The model stopped at its output limit (finish_reason "length"), so this answer is cut short.';

/**
 * Relay one completion through Praxis's raw-completion gateway
 * POST /v1/llm/chat/completions. The body is the gateway's brain-form
 * superset: `role` (wins when set) or `provider` + bare `model` pin, plus
 * `system`, `messages`, and `max_tokens` only when the caller passes
 * `options.maxTokens` (2026-10-31: every call used to send 8192; without it
 * the model's own output limit applies). Returns the { text, usage }
 * contract the retired provider handlers used, plus `finishReason` and
 * `truncated` (true when the model stopped for length).
 */
async function callPraxisBrain(message, provider, modelId, systemPrompt, history, options = {}) {
    const messages = [
        // Normalize Gemini-style 'model' role to OpenAI-style 'assistant'.
        ...(Array.isArray(history) ? history : []).map(h => ({
            role: h.role === 'model' ? 'assistant' : h.role,
            content: h.content
        })),
        { role: 'user', content: message }
    ];

    const response = await praxisFetch('/v1/llm/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-MCP-Caller': 'nexus.ai-service'
        },
        body: {
            provider,
            model: modelId,
            // Role-tagged relay (task 0a62d8a6): when set, Praxis routes by
            // model-control role (subscription CLI lane first) and the
            // provider/model pin above is ignored on that side.
            role: options.role || undefined,
            system: systemPrompt || undefined,
            messages,
            ...(options.maxTokens ? { max_tokens: options.maxTokens } : {})
        },
        timeoutMs: PRAXIS_BRAIN_TIMEOUT_MS
    });

    if (!response.ok) {
        const errText = await response.text().catch(() => '');
        throw new Error(`Praxis llm gateway relay failed (${response.status}): ${errText}`);
    }

    const data = await response.json();
    const choice = data.choices?.[0] || {};
    const msg = choice.message || {};
    const finishReason = typeof choice.finish_reason === 'string' ? choice.finish_reason : null;
    const truncated = finishReason === 'length';
    // reasoning_content salvage: local Gemma emits most tokens there. A
    // salvaged answer that stopped for length still carries `truncated`.
    const text = (typeof msg.content === 'string' && msg.content.trim())
        || (typeof msg.reasoning_content === 'string' && msg.reasoning_content.trim())
        || 'No response from model';

    const usage = data.usage || {};
    if (truncated) {
        console.warn(`[callAI] ${data.model || modelId} stopped at its output limit after ${usage.completion_tokens ?? 'an unknown number of'} completion tokens; the answer is cut short.`);
    }
    tokenTracker.trackUsage({
        provider,
        model: data.model || modelId,
        inputTokens: usage.prompt_tokens || 0,
        outputTokens: usage.completion_tokens || 0,
        task: 'chat'
    });

    return {
        text,
        usage: {
            inputTokens: usage.prompt_tokens || 0,
            outputTokens: usage.completion_tokens || 0,
            totalTokens: usage.total_tokens || 0
        },
        // Praxis may have cascaded past the pinned model — surface what ran.
        servedBy: data.model || modelId,
        finishReason,
        truncated
    };
}

/**
 * What callAI will ask Praxis for: a model-control `role`, or a
 * `provider` + `modelId` pin. One place, so the context-window lookup
 * (services/context-window.js) asks about the same model the call reaches.
 *
 * @param {string|Object} taskOrConfig - as for callAI
 * @returns {Promise<{ provider: string, modelId: string, role: string|undefined, kind: 'task'|'direct' }>}
 */
async function resolveCallTarget(taskOrConfig) {
    if (typeof taskOrConfig === 'string') {
        // Task-based lookup from DB
        const taskConfig = await getAIModelConfig(taskOrConfig);
        const provider = normalizeProvider(taskConfig.provider);
        const modelId = taskConfig.api_model_id || taskConfig.apiModelId || taskConfig.model;
        // Task-type pins that resolve to a per-token API provider ride
        // Praxis's brain.chat role instead (task 0a62d8a6) — model-control
        // now routes that role through the subscription CLI lane, with the
        // local/Gemini chain (and the pin below) as Praxis-side fallback.
        // Local pins stay pinned: local is already free.
        const role = provider === 'local' ? undefined : 'brain.chat';
        return { provider, modelId, role, kind: 'task' };
    }
    // Direct config provided (studio picks, model-control probes) keeps
    // its explicit pin: the caller chose a specific model on purpose.
    const config = taskOrConfig || {};
    return {
        provider: normalizeProvider(config.provider || 'google'),
        modelId: config.apiModelId || config.api_model_id || config.model,
        role: undefined,
        kind: 'direct'
    };
}

/**
 * Unified AI call router - THE SINGLE ENTRY POINT for all AI calls
 *
 * Supports two calling patterns:
 * 1. Task-based: callAI('research', prompt, systemPrompt) - looks up model from DB
 * 2. Direct config: callAI({ provider, model, ... }, prompt, systemPrompt) - uses provided config
 *
 * @param {string|Object} taskOrConfig - Either a task name OR a model config object
 *   If string: Task type for DB lookup ('plan', 'research', 'implementation', 'quick')
 *   If object: Direct config with { provider, model/apiModelId, parameters, isThinking }
 * @param {string} userPrompt - The user message/prompt
 * @param {string} systemPrompt - System instructions
 * @param {Array} history - Optional conversation history
 * @param {Object} options - Additional options
 * @param {boolean} options.returnFullResult - If true, returns { text, usage, finishReason, truncated, ... } instead of just text
 * @param {number} [options.maxTokens] - Output budget to send; omitted by default so the model's own output limit applies
 * @returns {Promise<string|Object>} The AI response text, or the full result if returnFullResult=true.
 *   A plain-text call never hands back a cut answer as if it were whole: when
 *   the model stops for length it throws an Error with code 'output_truncated',
 *   `finishReason` and `partialText`. Ask for returnFullResult to receive a cut
 *   answer with `truncated: true` instead.
 */
async function callAI(taskOrConfig, userPrompt, systemPrompt, history = [], options = {}) {
    const { provider, modelId, role, kind } = await resolveCallTarget(taskOrConfig);
    if (kind === 'task') {
        console.log(`[callAI] Task: ${taskOrConfig}, Provider: ${provider}, Model: ${modelId}${role ? `, Role: ${role}` : ''} (via Praxis)`);
    } else {
        console.log(`[callAI] Direct: Provider: ${provider}, Model: ${modelId} (via Praxis)`);
    }

    const result = await callPraxisBrain(userPrompt, provider, modelId, systemPrompt, history, { ...options, role });

    // Return full result or just text based on options
    if (options.returnFullResult) {
        return { ...result, provider, model: modelId };
    }
    if (result.truncated) {
        throw Object.assign(new Error(OUTPUT_LIMIT_NOTE), {
            code: 'output_truncated',
            finishReason: result.finishReason,
            partialText: result.text
        });
    }
    return result.text;
}

module.exports = {
    getAIModelConfig,
    resolveCallTarget,
    callAI,
    callPraxisBrain
};
