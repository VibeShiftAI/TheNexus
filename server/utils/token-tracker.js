/**
 * Token Usage Tracker
 * Centralized logging of AI token consumption
 * Uses SQLite database for persistence
 */

const db = require('../../db');

// Pricing per 1M tokens (input/output) in USD - approximate values
const PRICING = {
    // API model names (Node.js path writes these)
    'gemini-3-flash-preview': { input: 0.075, output: 0.30 },
    'gemini-3-pro-preview': { input: 1.25, output: 5.00 },
    'claude-opus-4-5-20251101': { input: 15.00, output: 75.00 },
    'claude-sonnet-4-20250514': { input: 3.00, output: 15.00 },
    'gpt-4o': { input: 2.50, output: 10.00 },
    'gpt-4o-mini': { input: 0.15, output: 0.60 },
    'grok-3': { input: 3.00, output: 15.00 },
    'grok-3-mini': { input: 0.30, output: 0.50 },
    // Registry model IDs (Cortex/Python path writes these)
    'grok-4.1': { input: 3.00, output: 15.00 },
    'gpt-5-mini': { input: 1.50, output: 6.00 },
    'gpt-5.2': { input: 5.00, output: 15.00 },
    'gpt-5.2-codex': { input: 5.00, output: 15.00 },
    'claude-opus': { input: 15.00, output: 75.00 },
    'claude-sonnet': { input: 3.00, output: 15.00 },
    'gemini-pro': { input: 1.25, output: 5.00 },
    'gemini-flash': { input: 0.075, output: 0.30 },
    // Default fallback
    'default': { input: 1.00, output: 4.00 }
};

/**
 * Calculate estimated cost for token usage
 * @param {string} model - Model name
 * @param {number} inputTokens - Input token count
 * @param {number} outputTokens - Output token count
 * @returns {number} Estimated cost in USD
 */
function calculateCost(model, inputTokens, outputTokens) {
    const pricing = PRICING[model] || PRICING['default'];
    const inputCost = (inputTokens / 1000000) * pricing.input;
    const outputCost = (outputTokens / 1000000) * pricing.output;
    return Math.round((inputCost + outputCost) * 1000000) / 1000000; // 6 decimal places
}

/**
 * Track token usage for an AI call
 * Uses database for persistence via db.recordUsage()
 * @param {Object} params - Usage parameters
 * @param {string} params.provider - Provider name (google, anthropic, openai)
 * @param {string} params.model - Model identifier
 * @param {number} params.inputTokens - Input/prompt token count
 * @param {number} params.outputTokens - Output/completion token count
 * @param {string} [params.projectId] - Associated project ID
 * @param {string} [params.task] - Task type (research, plan, implement, chat)
 */
function trackUsage({ provider, model, inputTokens, outputTokens, projectId = null, task = null }) {
    const totalTokens = inputTokens + outputTokens;
    const cost = calculateCost(model, inputTokens, outputTokens);

    // Record to database (async, fire-and-forget)
    if (db.isDatabaseEnabled()) {
        db.recordUsage(model, inputTokens, outputTokens, 'nexus').catch(err => {
            console.error('[TokenTracker] Database error:', err.message);
        });
    }

    console.log(`[TokenTracker] ${provider}/${model}: ${inputTokens}+${outputTokens}=${totalTokens} tokens ($${cost.toFixed(6)})`);

    return {
        timestamp: new Date().toISOString(),
        provider,
        model,
        inputTokens,
        outputTokens,
        totalTokens,
        cost,
        projectId,
        task
    };
}

/**
 * Derive provider from model name
 * @param {string} model - Model identifier
 * @returns {string} Provider name
 */
function getProviderFromModel(model) {
    if (!model) return 'unknown';
    const m = model.toLowerCase();
    if (m.includes('gemini') || m.includes('google')) return 'google';
    if (m.includes('claude') || m.includes('anthropic')) return 'anthropic';
    if (m.includes('gpt') || m.includes('openai')) return 'openai';
    if (m.includes('grok') || m.includes('xai')) return 'xai';
    return 'other';
}

/**
 * Get usage statistics from database
 * @param {Object} options - Filter options
 * @param {number} [options.days] - Filter by last N days (default: 30)
 * @returns {Promise<Object>} Usage statistics
 */
async function getUsageStats(options = {}) {
    if (!db.isDatabaseEnabled()) {
        return {
            totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUSD: 0 },
            byProvider: {},
            byModel: {},
            recentUsage: [],
            error: 'Database not configured'
        };
    }

    const days = options.days || 30;
    const endDate = new Date().toISOString().split('T')[0];
    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    try {
        const rawStats = await db.getUsageStats(startDate, endDate);

        // Aggregate the stats
        let totals = { inputTokens: 0, outputTokens: 0, totalTokens: 0, requestCount: 0 };
        const byModel = {};
        const byProvider = {};

        for (const row of rawStats) {
            const inputTokens = row.input_tokens || 0;
            const outputTokens = row.output_tokens || 0;
            const totalTokens = row.total_tokens || 0;
            const requestCount = row.request_count || 0;
            const provider = getProviderFromModel(row.model);
            const cost = calculateCost(row.model, inputTokens, outputTokens);

            totals.inputTokens += inputTokens;
            totals.outputTokens += outputTokens;
            totals.totalTokens += totalTokens;
            totals.requestCount += requestCount;

            // Aggregate by model
            if (!byModel[row.model]) {
                byModel[row.model] = { inputTokens: 0, outputTokens: 0, totalTokens: 0, callCount: 0, cost: 0 };
            }
            byModel[row.model].inputTokens += inputTokens;
            byModel[row.model].outputTokens += outputTokens;
            byModel[row.model].totalTokens += totalTokens;
            byModel[row.model].callCount += requestCount;
            byModel[row.model].cost += cost;

            // Aggregate by provider
            if (!byProvider[provider]) {
                byProvider[provider] = { inputTokens: 0, outputTokens: 0, totalTokens: 0, callCount: 0, cost: 0 };
            }
            byProvider[provider].inputTokens += inputTokens;
            byProvider[provider].outputTokens += outputTokens;
            byProvider[provider].totalTokens += totalTokens;
            byProvider[provider].callCount += requestCount;
            byProvider[provider].cost += cost;
        }

        // Calculate total cost
        totals.estimatedCostUSD = Object.values(byModel).reduce((sum, m) => sum + m.cost, 0);

        // Transform recentUsage to match TokenUsageEntry interface expected by frontend
        const recentUsage = rawStats.slice(0, 100).map(row => ({
            timestamp: row.date || new Date().toISOString(),
            provider: getProviderFromModel(row.model),
            model: row.model || 'unknown',
            inputTokens: row.input_tokens || 0,
            outputTokens: row.output_tokens || 0,
            totalTokens: row.total_tokens || 0,
            cost: calculateCost(row.model, row.input_tokens || 0, row.output_tokens || 0),
            projectId: row.project_id || null,
            task: row.task || null
        }));

        return {
            totals,
            byProvider,
            byModel,
            recentUsage,
            dateRange: { startDate, endDate }
        };
    } catch (error) {
        console.error('[TokenTracker] Error fetching stats:', error);
        return {
            totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUSD: 0 },
            byProvider: {},
            byModel: {},
            recentUsage: [],
            error: error.message
        };
    }
}

/**
 * Reset all usage statistics
 * Note: This would require a database operation - not implemented for safety
 */
function resetUsageStats() {
    console.warn('[TokenTracker] Reset not implemented for database storage');
}

/**
 * Clear cache - no-op since we use database
 */
function clearCache() {
    // No-op - database handles caching
}

/**
 * Load usage data - returns empty structure for compatibility
 * @deprecated Use getUsageStats() instead
 */
function loadUsageData() {
    console.warn('[TokenTracker] loadUsageData() is deprecated - use getUsageStats()');
    return {
        created: new Date().toISOString(),
        lastUpdated: new Date().toISOString(),
        totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUSD: 0 },
        byProvider: {},
        byModel: {},
        byProject: {},
        recentUsage: []
    };
}

module.exports = {
    trackUsage,
    getUsageStats,
    resetUsageStats,
    clearCache,
    loadUsageData,
    calculateCost,
    PRICING
};
