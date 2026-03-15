const { GoogleGenAI } = require('@google/genai');
const fs = require('fs');
const path = require('path');

// Configuration
const PROJECT_ROOT = process.env.PROJECT_ROOT || path.resolve(process.env.USERPROFILE || process.env.HOME, 'Projects');
const AGENT_CONFIG_PATH = path.join(PROJECT_ROOT, 'TheNexus', 'agent-config.json'); // Assumption based on context
const tokenTracker = require('../utils/token-tracker');
const db = require('../../db');

// Maps task types to agent IDs in config file
const TASK_TO_AGENT_MAP = {
    plan: 'plan-generator',
    research: 'auto-research',
    implementation: 'implementation',
    quick: 'quick-research'
};

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

// ═══════════════════════════════════════════════════════════════
// GOOGLE GEMINI API HANDLER
// ═══════════════════════════════════════════════════════════════
async function callGemini(message, config, systemPrompt, history, apiKey) {
    const modelId = config.apiModelId;
    const params = config.parameters || {};

    // Use the official @google/genai SDK (API key sent via header, not URL)
    const genAI = new GoogleGenAI({ apiKey });

    // Build generation config with thinking parameters
    const generationConfig = {};

    if (params.thinking_config) {
        generationConfig.thinkingConfig = params.thinking_config;
        console.log(`[Gemini] Using thinking_level: ${params.thinking_config.thinking_level}`);
    }

    if (params.thinking_budget !== undefined) {
        generationConfig.thinkingBudget = params.thinking_budget;
        console.log(`[Gemini] Using thinking_budget: ${params.thinking_budget}`);
    }

    // Build conversation contents
    const contents = [];

    // Add history if present
    if (history && history.length > 0) {
        for (const msg of history) {
            contents.push({
                role: msg.role === 'assistant' ? 'model' : 'user',
                parts: [{ text: msg.content }]
            });
        }
    }

    // Add current message
    contents.push({
        role: 'user',
        parts: [{ text: message }]
    });

    // Build SDK config
    const sdkConfig = {};
    if (systemPrompt) {
        sdkConfig.systemInstruction = systemPrompt;
    }
    if (Object.keys(generationConfig).length > 0) {
        Object.assign(sdkConfig, generationConfig);
    }

    const response = await genAI.models.generateContent({
        model: modelId,
        contents,
        config: Object.keys(sdkConfig).length > 0 ? sdkConfig : undefined
    });

    // Extract text from SDK response
    let text = 'No response from Gemini';
    if (response.candidates && response.candidates[0]) {
        const parts = response.candidates[0].content?.parts || [];
        const textParts = parts.filter(p => p.text).map(p => p.text);
        if (textParts.length > 0) {
            text = textParts.join('');
        }
    }

    const usageMetadata = response.usageMetadata || {};

    // Track usage for resource monitor
    tokenTracker.trackUsage({
        provider: 'google',
        model: modelId,
        inputTokens: usageMetadata.promptTokenCount || 0,
        outputTokens: usageMetadata.candidatesTokenCount || 0,
        task: 'chat'
    });

    return {
        text,
        usage: {
            inputTokens: usageMetadata.promptTokenCount || 0,
            outputTokens: usageMetadata.candidatesTokenCount || 0,
            totalTokens: usageMetadata.totalTokenCount || 0
        }
    };
}

// ═══════════════════════════════════════════════════════════════
// OPENAI GPT API HANDLER
// ═══════════════════════════════════════════════════════════════
async function callOpenAI(message, config, systemPrompt, history, apiKey) {
    const modelId = config.apiModelId;
    const params = config.parameters || {};

    const messages = [
        { role: 'system', content: systemPrompt }
    ];

    if (history && history.length > 0) {
        for (const msg of history) {
            messages.push({
                role: msg.role === 'assistant' ? 'assistant' : 'user',
                content: msg.content
            });
        }
    }

    messages.push({ role: 'user', content: message });

    const requestBody = {
        model: modelId,
        messages,
    };

    if (params.reasoning_effort) {
        requestBody.reasoning_effort = params.reasoning_effort;
        console.log(`[OpenAI] Using reasoning_effort: ${params.reasoning_effort}`);
    }

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(`OpenAI API error: ${response.status} - ${JSON.stringify(errorData)}`);
    }

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content || 'No response from OpenAI';

    const usage = data.usage || {};

    // Track usage for resource monitor
    tokenTracker.trackUsage({
        provider: 'openai',
        model: modelId,
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
        }
    };
}

// ═══════════════════════════════════════════════════════════════
// ANTHROPIC CLAUDE API HANDLER
// ═══════════════════════════════════════════════════════════════
async function callAnthropic(message, config, systemPrompt, history, apiKey) {
    const modelId = config.apiModelId;
    const params = config.parameters || {};

    const messages = [];

    if (history && history.length > 0) {
        for (const msg of history) {
            messages.push({
                role: msg.role === 'assistant' ? 'assistant' : 'user',
                content: msg.content
            });
        }
    }

    messages.push({ role: 'user', content: message });

    const requestBody = {
        model: modelId,
        max_tokens: 8192,
        system: systemPrompt,
        messages,
    };

    if (params.thinking) {
        requestBody.thinking = params.thinking;
        requestBody.max_tokens = Math.max(requestBody.max_tokens, params.thinking.budget_tokens + 4096);
        console.log(`[Anthropic] Using thinking with budget_tokens: ${params.thinking.budget_tokens}`);
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(`Anthropic API error: ${response.status} - ${JSON.stringify(errorData)}`);
    }

    const data = await response.json();

    let text = 'No response from Claude';
    if (data.content && Array.isArray(data.content)) {
        const textBlocks = data.content.filter(block => block.type === 'text');
        text = textBlocks.map(block => block.text).join('\n') || 'No response from Claude';
    }

    const usage = data.usage || {};

    // Track usage for resource monitor
    tokenTracker.trackUsage({
        provider: 'anthropic',
        model: modelId,
        inputTokens: usage.input_tokens || 0,
        outputTokens: usage.output_tokens || 0,
        task: 'chat'
    });

    return {
        text,
        usage: {
            inputTokens: usage.input_tokens || 0,
            outputTokens: usage.output_tokens || 0,
            totalTokens: (usage.input_tokens || 0) + (usage.output_tokens || 0)
        }
    };
}

// ═══════════════════════════════════════════════════════════════
// XAI (GROK) API HANDLER — OpenAI-compatible endpoint
// ═══════════════════════════════════════════════════════════════
async function callXAI(message, config, systemPrompt, history, apiKey) {
    const modelId = config.apiModelId;
    const params = config.parameters || {};

    const messages = [
        { role: 'system', content: systemPrompt }
    ];

    if (history && history.length > 0) {
        for (const msg of history) {
            messages.push({
                role: msg.role === 'assistant' ? 'assistant' : 'user',
                content: msg.content
            });
        }
    }

    messages.push({ role: 'user', content: message });

    const requestBody = {
        model: modelId,
        messages,
    };

    if (params.reasoning_effort) {
        requestBody.reasoning_effort = params.reasoning_effort;
        console.log(`[xAI] Using reasoning_effort: ${params.reasoning_effort}`);
    }

    const response = await fetch('https://api.x.ai/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(`xAI API error: ${response.status} - ${JSON.stringify(errorData)}`);
    }

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content || 'No response from Grok';

    const usage = data.usage || {};

    // Track usage for resource monitor
    tokenTracker.trackUsage({
        provider: 'xai',
        model: modelId,
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
        }
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
    let provider, modelId, parameters;

    // Determine if this is a task name or direct config
    if (typeof taskOrConfig === 'string') {
        // Task-based lookup from DB
        const taskConfig = await getAIModelConfig(taskOrConfig);
        provider = taskConfig.provider.toLowerCase();
        modelId = taskConfig.model;
        parameters = {};

        // Apply thinking config for Gemini
        if (taskConfig.thinkingEnabled && provider === 'google') {
            parameters.thinking_config = taskConfig.thinkingConfig || { thinkingBudget: 8000 };
        }

        console.log(`[callAI] Task: ${taskOrConfig}, Provider: ${provider}, Model: ${modelId}`);
    } else {
        // Direct config provided (from chat endpoint)
        provider = (taskOrConfig.provider || 'google').toLowerCase();
        modelId = taskOrConfig.apiModelId || taskOrConfig.model;
        parameters = taskOrConfig.parameters || {};

        // Handle thinking config from frontend
        if (taskOrConfig.isThinking && provider === 'google') {
            parameters.thinking_config = parameters.thinking_config || { thinkingBudget: 8000 };
        }

        console.log(`[callAI] Direct: Provider: ${provider}, Model: ${modelId}`);
    }

    // Get API key for the provider
    const apiKeys = {
        google: process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY,
        openai: process.env.OPENAI_API_KEY,
        anthropic: process.env.ANTHROPIC_API_KEY,
        xai: process.env.XAI_API_KEY,
    };

    const apiKey = apiKeys[provider];
    if (!apiKey) throw new Error(`No API key configured for provider: ${provider}`);

    // Build config object expected by the main handlers
    const config = {
        apiModelId: modelId,
        parameters
    };

    // Route to appropriate handler
    let result;
    switch (provider) {
        case 'google':
            result = await callGemini(userPrompt, config, systemPrompt, history, apiKey);
            break;
        case 'anthropic':
            result = await callAnthropic(userPrompt, config, systemPrompt, history, apiKey);
            break;
        case 'openai':
            result = await callOpenAI(userPrompt, config, systemPrompt, history, apiKey);
            break;
        case 'xai':
            result = await callXAI(userPrompt, config, systemPrompt, history, apiKey);
            break;
        default:
            throw new Error(`Unsupported provider: ${provider}`);
    }

    // Return full result or just text based on options
    if (options.returnFullResult) {
        return result; // { text, usage }
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
    callGemini,
    callOpenAI,
    callAnthropic,
    callXAI,
    getAIModelConfig,
    callAI,
    runDeepResearch
};
