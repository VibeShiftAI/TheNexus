/**
 * Token Usage Tracker
 * Centralized logging of AI token consumption
 * Uses SQLite database for persistence
 */

const db = require('../../db');

const { priceForModel } = require('../services/model-prices');

/**
 * Estimated cost in USD for token usage, or null when the model is unpriced.
 *
 * Rates come from OpenRouter's catalog, which Praxis keeps in
 * data/openrouter-catalog.json (see ../services/model-prices.js). A model the
 * catalog does not price returns null rather than a default rate: the old
 * $1/$4 fallback billed free and local calls at a made-up price and inflated
 * every ledger and budget gate that read it.
 * @param {string} model - Model name as recorded
 * @param {number} inputTokens - Input token count
 * @param {number} outputTokens - Output token count
 * @returns {number|null} Estimated cost in USD, or null when unpriced
 */
function calculateCost(model, inputTokens, outputTokens) {
    const price = priceForModel(model);
    if (!price) return null;
    const inputCost = (inputTokens / 1000000) * price.in;
    const outputCost = (outputTokens / 1000000) * price.out;
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
    const priced = calculateCost(model, inputTokens, outputTokens);
    const cost = priced ?? 0;

    // Record to database (async, fire-and-forget)
    if (db.isDatabaseEnabled()) {
        db.recordUsage(model, inputTokens, outputTokens, 'nexus').catch(err => {
            console.error('[TokenTracker] Database error:', err.message);
        });
    }

    console.log(`[TokenTracker] ${provider}/${model}: ${inputTokens}+${outputTokens}=${totalTokens} tokens (${priced === null ? 'unpriced' : `$${cost.toFixed(6)}`})`);

    return {
        timestamp: new Date().toISOString(),
        provider,
        model,
        inputTokens,
        outputTokens,
        totalTokens,
        cost,
        priced: priced !== null,
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
            totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUSD: 0, unpricedRequests: 0 },
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
        // Unpriced rows add $0 to the estimate and are counted, so a total
        // with unpriced calls in it is never read as complete.
        let totals = { inputTokens: 0, outputTokens: 0, totalTokens: 0, requestCount: 0, unpricedRequests: 0 };
        const byModel = {};
        const byProvider = {};

        for (const row of rawStats) {
            const inputTokens = row.input_tokens || 0;
            const outputTokens = row.output_tokens || 0;
            const totalTokens = row.total_tokens || 0;
            const requestCount = row.request_count || 0;
            const provider = getProviderFromModel(row.model);
            const priced = calculateCost(row.model, inputTokens, outputTokens);
            const cost = priced ?? 0;
            const unpriced = priced === null ? requestCount : 0;

            totals.inputTokens += inputTokens;
            totals.outputTokens += outputTokens;
            totals.totalTokens += totalTokens;
            totals.requestCount += requestCount;
            totals.unpricedRequests += unpriced;

            // Aggregate by model
            if (!byModel[row.model]) {
                byModel[row.model] = { inputTokens: 0, outputTokens: 0, totalTokens: 0, callCount: 0, cost: 0, priced: priced !== null };
            }
            byModel[row.model].inputTokens += inputTokens;
            byModel[row.model].outputTokens += outputTokens;
            byModel[row.model].totalTokens += totalTokens;
            byModel[row.model].callCount += requestCount;
            byModel[row.model].cost += cost;

            // Aggregate by provider
            if (!byProvider[provider]) {
                byProvider[provider] = { inputTokens: 0, outputTokens: 0, totalTokens: 0, callCount: 0, cost: 0, unpricedCalls: 0 };
            }
            byProvider[provider].inputTokens += inputTokens;
            byProvider[provider].outputTokens += outputTokens;
            byProvider[provider].totalTokens += totalTokens;
            byProvider[provider].callCount += requestCount;
            byProvider[provider].cost += cost;
            byProvider[provider].unpricedCalls += unpriced;
        }

        // Calculate total cost
        totals.estimatedCostUSD = Object.values(byModel).reduce((sum, m) => sum + m.cost, 0);

        // Transform recentUsage to match TokenUsageEntry interface expected by frontend
        const recentUsage = rawStats.slice(0, 100).map(row => {
            const priced = calculateCost(row.model, row.input_tokens || 0, row.output_tokens || 0);
            return {
                timestamp: row.date || new Date().toISOString(),
                provider: getProviderFromModel(row.model),
                model: row.model || 'unknown',
                inputTokens: row.input_tokens || 0,
                outputTokens: row.output_tokens || 0,
                totalTokens: row.total_tokens || 0,
                cost: priced ?? 0,
                priced: priced !== null,
                projectId: row.project_id || null,
                task: row.task || null
            };
        });

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
            totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUSD: 0, unpricedRequests: 0 },
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
    calculateCost
};
