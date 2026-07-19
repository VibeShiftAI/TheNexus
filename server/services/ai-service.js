/**
 * AI service — thin relay to Praxis's LLM manager.
 *
 * 2026-07-06 consolidation: TheNexus no longer owns provider SDKs or API
 * keys for chat completions. callAI() keeps its signature and result
 * contract ({ text, usage } / plain text) but every call rides Praxis's
 * POST /v1/brain/chat with an explicit provider/model pin — Praxis
 * normalizes response_format per provider, enforces budget/semaphore,
 * logs usage to the shared llm_calls ledger, and cascades on provider
 * failure. runDeepResearch keeps its own Gemini client: it drives the
 * long-poll interactions API, which has no completions equivalent.
 */
const { GoogleGenAI } = require('@google/genai');
const fs = require('fs');
const path = require('path');

// Configuration
const PROJECT_ROOT = process.env.PROJECT_ROOT || path.resolve(process.env.USERPROFILE || process.env.HOME, 'Projects');
const AGENT_CONFIG_PATH = path.join(PROJECT_ROOT, 'TheNexus', 'agent-config.json'); // Assumption based on context
const tokenTracker = require('../utils/token-tracker');
const db = require('../../db');

const PRAXIS_URL = process.env.PRAXIS_URL || 'http://127.0.0.1:54322';
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
 * Relay one completion through Praxis /v1/brain/chat (pinned provider/model).
 * Returns the { text, usage } contract the retired provider handlers used.
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

    const response = await fetch(`${PRAXIS_URL}/v1/brain/chat`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-MCP-Caller': 'nexus.ai-service'
        },
        body: JSON.stringify({
            provider,
            model: modelId,
            // Role-tagged relay (task 0a62d8a6): when set, Praxis routes by
            // model-control role (subscription CLI lane first) and the
            // provider/model pin above is ignored on that side.
            role: options.role || undefined,
            system: systemPrompt || undefined,
            messages,
            max_tokens: options.maxTokens || 8192
        }),
        signal: AbortSignal.timeout(PRAXIS_BRAIN_TIMEOUT_MS)
    });

    if (!response.ok) {
        const errText = await response.text().catch(() => '');
        throw new Error(`Praxis brain relay failed (${response.status}): ${errText.slice(0, 300)}`);
    }

    const data = await response.json();
    const msg = data.choices?.[0]?.message || {};
    // reasoning_content salvage: local Gemma emits most tokens there.
    const text = (typeof msg.content === 'string' && msg.content.trim())
        || (typeof msg.reasoning_content === 'string' && msg.reasoning_content.trim())
        || 'No response from model';

    const usage = data.usage || {};
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
        servedBy: data.model || modelId
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
 * @param {boolean} options.returnFullResult - If true, returns { text, usage } instead of just text
 * @returns {Promise<string|Object>} The AI response text, or { text, usage } if returnFullResult=true
 */
async function callAI(taskOrConfig, userPrompt, systemPrompt, history = [], options = {}) {
    let provider, modelId, role;

    // Determine if this is a task name or direct config
    if (typeof taskOrConfig === 'string') {
        // Task-based lookup from DB
        const taskConfig = await getAIModelConfig(taskOrConfig);
        provider = normalizeProvider(taskConfig.provider);
        modelId = taskConfig.api_model_id || taskConfig.apiModelId || taskConfig.model;
        // Task-type pins that resolve to a per-token API provider ride
        // Praxis's brain.chat role instead (task 0a62d8a6) — model-control
        // now routes that role through the subscription CLI lane, with the
        // local/Gemini chain (and the pin below) as Praxis-side fallback.
        // Local pins stay pinned: local is already free.
        role = provider === 'local' ? undefined : 'brain.chat';
        console.log(`[callAI] Task: ${taskOrConfig}, Provider: ${provider}, Model: ${modelId}${role ? `, Role: ${role}` : ''} (via Praxis)`);
    } else {
        // Direct config provided (studio picks, model-control probes) keeps
        // its explicit pin — the caller chose a specific model on purpose.
        provider = normalizeProvider(taskOrConfig.provider || 'google');
        modelId = taskOrConfig.apiModelId || taskOrConfig.api_model_id || taskOrConfig.model;
        console.log(`[callAI] Direct: Provider: ${provider}, Model: ${modelId} (via Praxis)`);
    }

    const result = await callPraxisBrain(userPrompt, provider, modelId, systemPrompt, history, { ...options, role });

    // Return full result or just text based on options
    if (options.returnFullResult) {
        return { ...result, provider, model: modelId };
    }
    return result.text;
}

// Helper for Deep Research Agent with polling & resume capability
async function runDeepResearch(prompt, apiKey, callbacks, existingInteractionId = null) {
    const { onStart, onComplete, onFail, onLog } = callbacks;
    const client = new GoogleGenAI({ apiKey });
    const log = onLog || console.log;

    try {
        let interactionId = existingInteractionId;

        if (!interactionId) {
            // Start new interaction
            const interaction = await client.interactions.create({
                agent: 'deep-research-pro-preview-12-2025',
                input: prompt,
                background: true
            });
            interactionId = interaction.id;
            if (onStart) onStart(interactionId);
            log(`[Deep Research] Started: ${interactionId}`);
        } else {
            log(`[Deep Research] Resuming interaction: ${interactionId}`);
        }

        const maxTime = 4 * 60 * 60 * 1000;
        const startTime = Date.now();
        const pollInterval = 10000;

        while (Date.now() - startTime < maxTime) {
            try {
                const check = await client.interactions.get(interactionId);

                if (check.status === 'completed') {
                    const content = check.outputs[check.outputs.length - 1].text;
                    log(`[Deep Research] Completed: ${interactionId}`);
                    if (onComplete) onComplete(content);
                    return content;
                } else if (check.status === 'failed') {
                    const errorMsg = check.error?.message || 'Research failed';
                    log(`[Deep Research] Failed: ${errorMsg}`);
                    throw new Error(errorMsg);
                }

                log(`[Deep Research] Polling ${interactionId}: ${check.status}...`);

            } catch (pollError) {
                if (pollError.message.includes('Research failed')) throw pollError;
                console.warn(`[Deep Research] Transient poll error: ${pollError.message}`);
            }

            await new Promise(resolve => setTimeout(resolve, pollInterval));
        }

        throw new Error('Research timed out after 4 hours');

    } catch (error) {
        if (onFail) onFail(error);
        throw error;
    }
}

module.exports = {
    getAIModelConfig,
    callAI,
    callPraxisBrain,
    runDeepResearch
};
