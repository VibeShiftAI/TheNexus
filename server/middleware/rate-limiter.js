/**
 * Rate Limiter Middleware
 * 
 * Enforces usage quotas for agent runs based on:
 * - Daily/monthly token limits
 * - Daily/monthly request limits
 * - Cost limits (prevent runaway spending)
 */

const db = require('../../db');

// In-memory cache for quota checks (reduces DB hits)
const quotaCache = new Map();
const CACHE_TTL_MS = 60000; // 1 minute

/**
 * Get or create quota record for user/project
 */
async function getQuota(userId, projectId) {
    const cacheKey = `${userId || 'global'}-${projectId || 'global'}`;
    const cached = quotaCache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
        return cached.data;
    }

    if (!db.supabase) {
        // No database - return unlimited quota
        return {
            daily_token_limit: Infinity,
            monthly_token_limit: Infinity,
            daily_request_limit: Infinity,
            monthly_request_limit: Infinity,
            daily_cost_limit: Infinity,
            monthly_cost_limit: Infinity,
            daily_tokens_used: 0,
            monthly_tokens_used: 0,
            daily_requests_used: 0,
            monthly_requests_used: 0,
            daily_cost_used: 0,
            monthly_cost_used: 0,
        };
    }

    try {
        // Try to get existing quota
        let { data, error } = await db.supabase
            .from('usage_quotas')
            .select('*')
            .eq('user_id', userId)
            .maybeSingle();

        if (!data) {
            // Create default quota
            const { data: newQuota, error: insertError } = await db.supabase
                .from('usage_quotas')
                .insert({
                    user_id: userId,
                    project_id: projectId,
                })
                .select()
                .single();

            data = newQuota;
        }

        if (data) {
            quotaCache.set(cacheKey, { data, timestamp: Date.now() });
        }

        return data;
    } catch (e) {
        console.error('[RateLimiter] Error fetching quota:', e);
        return null;
    }
}

/**
 * Check if request should be rate limited
 */
async function checkRateLimit(userId, projectId) {
    const quota = await getQuota(userId, projectId);

    if (!quota) {
        return { allowed: true, reason: null };
    }

    // Check daily limits
    if (quota.daily_requests_used >= quota.daily_request_limit) {
        return {
            allowed: false,
            reason: 'daily_request_limit',
            message: `Daily request limit reached (${quota.daily_request_limit}). Resets at midnight.`
        };
    }

    if (quota.daily_tokens_used >= quota.daily_token_limit) {
        return {
            allowed: false,
            reason: 'daily_token_limit',
            message: `Daily token limit reached (${quota.daily_token_limit}). Resets at midnight.`
        };
    }

    if (parseFloat(quota.daily_cost_used) >= parseFloat(quota.daily_cost_limit)) {
        return {
            allowed: false,
            reason: 'daily_cost_limit',
            message: `Daily cost limit reached ($${quota.daily_cost_limit}). Resets at midnight.`
        };
    }

    // Check monthly limits
    if (quota.monthly_requests_used >= quota.monthly_request_limit) {
        return {
            allowed: false,
            reason: 'monthly_request_limit',
            message: `Monthly request limit reached (${quota.monthly_request_limit}).`
        };
    }

    if (quota.monthly_tokens_used >= quota.monthly_token_limit) {
        return {
            allowed: false,
            reason: 'monthly_token_limit',
            message: `Monthly token limit reached (${quota.monthly_token_limit}).`
        };
    }

    if (parseFloat(quota.monthly_cost_used) >= parseFloat(quota.monthly_cost_limit)) {
        return {
            allowed: false,
            reason: 'monthly_cost_limit',
            message: `Monthly cost limit reached ($${quota.monthly_cost_limit}).`
        };
    }

    return { allowed: true, reason: null, quota };
}

/**
 * Increment usage counters after request completes
 */
async function recordUsage(userId, projectId, { tokens = 0, cost = 0 }) {
    const cacheKey = `${userId || 'global'}-${projectId || 'global'}`;
    quotaCache.delete(cacheKey); // Invalidate cache

    if (!db.supabase) return;

    try {
        // Get current quota
        const { data: quota } = await db.supabase
            .from('usage_quotas')
            .select('id, daily_tokens_used, monthly_tokens_used, daily_requests_used, monthly_requests_used, daily_cost_used, monthly_cost_used')
            .eq('user_id', userId)
            .single();

        if (quota) {
            await db.supabase
                .from('usage_quotas')
                .update({
                    daily_tokens_used: (quota.daily_tokens_used || 0) + tokens,
                    monthly_tokens_used: (quota.monthly_tokens_used || 0) + tokens,
                    daily_requests_used: (quota.daily_requests_used || 0) + 1,
                    monthly_requests_used: (quota.monthly_requests_used || 0) + 1,
                    daily_cost_used: parseFloat(quota.daily_cost_used || 0) + cost,
                    monthly_cost_used: parseFloat(quota.monthly_cost_used || 0) + cost,
                    updated_at: new Date().toISOString(),
                })
                .eq('id', quota.id);
        }
    } catch (e) {
        console.error('[RateLimiter] Error recording usage:', e);
    }
}

/**
 * Express middleware for rate limiting
 */
function rateLimitMiddleware(options = {}) {
    return async (req, res, next) => {
        const userId = req.user?.id || req.headers['x-user-id'];
        const projectId = req.body?.projectId || req.query?.projectId;

        const result = await checkRateLimit(userId, projectId);

        if (!result.allowed) {
            console.log(`[RateLimiter] Blocked request: ${result.reason}`);
            return res.status(429).json({
                error: 'Rate limit exceeded',
                reason: result.reason,
                message: result.message,
            });
        }

        // Attach quota to request for later use
        req.quota = result.quota;

        // Hook to record usage after response
        res.on('finish', () => {
            const tokens = res.locals?.tokensUsed || 0;
            const cost = res.locals?.costIncurred || 0;
            recordUsage(userId, projectId, { tokens, cost });
        });

        next();
    };
}

module.exports = {
    getQuota,
    checkRateLimit,
    recordUsage,
    rateLimitMiddleware,
};
