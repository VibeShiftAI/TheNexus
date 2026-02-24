/**
 * Retry utility with exponential backoff
 * Used for resilient API calls to AI providers
 */

// Rate limit specific delays (much longer to allow quota reset)
const RATE_LIMIT_BASE_DELAY = 30000; // Start at 30 seconds for rate limits
const RATE_LIMIT_MAX_DELAY = 120000; // Cap at 2 minutes

/**
 * Calculate delay for rate limit errors (longer than normal errors)
 */
function getRateLimitDelay(attempt) {
    return Math.min(
        RATE_LIMIT_BASE_DELAY * Math.pow(2, attempt - 1),
        RATE_LIMIT_MAX_DELAY
    );
}

/**
 * Wraps an async function with retry logic and exponential backoff
 * @param {Function} fn - Async function to execute
 * @param {Object} options - Configuration options
 * @param {number} options.maxAttempts - Maximum retry attempts (default: 3)
 * @param {number} options.baseDelay - Base delay in ms (default: 1000)
 * @param {Function} options.onRetry - Callback called before each retry (attempt, delay, error)
 * @param {Function} options.shouldRetry - Function to determine if error is retryable (default: always retry)
 * @returns {Promise<any>} Result of the function
 */
async function withRetry(fn, options = {}) {
    const {
        maxAttempts = 3,
        baseDelay = 1000,
        onRetry = null,
        shouldRetry = () => true
    } = options;

    let lastError;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;

            // Check if we should retry this error
            if (!shouldRetry(error)) {
                throw error;
            }

            // If this was the last attempt, throw
            if (attempt === maxAttempts) {
                throw error;
            }

            // Calculate delay - much longer for rate limits
            const isRateLimit = categorizeError(error) === 'RATE_LIMIT';
            const delay = isRateLimit
                ? getRateLimitDelay(attempt)
                : baseDelay * Math.pow(4, attempt - 1);

            // Call retry callback if provided
            if (onRetry) {
                onRetry(attempt, delay, error);
            }

            // Wait before retrying
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }

    throw lastError;
}


/**
 * Check if an error is likely retryable (rate limits, network issues)
 * @param {Error} error - The error to check
 * @returns {boolean} Whether the error is retryable
 */
function isRetryableError(error) {
    const message = error.message?.toLowerCase() || '';
    const retryablePatterns = [
        'rate limit',
        'rate_limit',
        'too many requests',
        '429',
        'timeout',
        'econnreset',
        'econnrefused',
        'socket hang up',
        'network error',
        'fetch failed',
        'temporarily unavailable',
        '503',
        '502',
        'bad gateway',
        'service unavailable'
    ];

    return retryablePatterns.some(pattern => message.includes(pattern));
}

/**
 * Categorize an error for logging/handling
 * @param {Error} error - The error to categorize
 * @returns {string} Error category
 */
function categorizeError(error) {
    const message = error.message?.toLowerCase() || '';

    if (message.includes('rate limit') || message.includes('429') || message.includes('too many')) {
        return 'RATE_LIMIT';
    }
    if (message.includes('timeout') || message.includes('timed out')) {
        return 'TIMEOUT';
    }
    if (message.includes('network') || message.includes('econn') || message.includes('socket')) {
        return 'NETWORK';
    }
    if (message.includes('api key') || message.includes('unauthorized') || message.includes('401')) {
        return 'AUTH';
    }
    if (message.includes('not found') || message.includes('404')) {
        return 'NOT_FOUND';
    }
    if (message.includes('invalid') || message.includes('malformed')) {
        return 'INVALID_REQUEST';
    }

    return 'UNKNOWN';
}

module.exports = {
    withRetry,
    isRetryableError,
    categorizeError
};
