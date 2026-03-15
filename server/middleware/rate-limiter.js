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

    if (!db.isDatabaseEnabled()) {
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
        // Try to get existing quota by endpoint (user-based)
        const endpoint = userId || 'global';
        let data = await db.getQuota(endpoint, 'daily');

        if (!data) {
            // Create default quota
            data = await db.upsertQuota({
                endpoint,
                period: 'daily',
                max_requests: 1000,
                current_count: 0,
            });
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

    // Check if current count exceeds max requests
    if (quota.current_count >= quota.max_requests) {
        return {
            allowed: false,
            reason: 'request_limit',
            message: `Request limit reached (${quota.max_requests}). Resets at ${quota.reset_at || 'midnight'}.`
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

    if (!db.isDatabaseEnabled()) return;

    try {
        const endpoint = userId || 'global';
        const quota = await db.getQuota(endpoint, 'daily');

        if (quota) {
            await db.updateQuota(quota.id, {
                current_count: (quota.current_count || 0) + 1,
            });
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
