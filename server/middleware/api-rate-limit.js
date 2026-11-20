const rateLimit = require('express-rate-limit');

function createApiRateLimit(max = 6000) {
    const options = {
        windowMs: 15 * 60 * 1000, max,
        standardHeaders: true, legacyHeaders: false,
        message: { error: 'Too many requests, please try again later.' }
    };
    const api = rateLimit(options);
    const health = rateLimit(options);
    // The supervisor restarts Nexus on failed GET /api/health probes. A busy
    // cockpit can exhaust its API quota while the process is still healthy.
    return (req, res, next) => {
        const probe = req.method === 'GET' && req.path === '/health';
        return (probe ? health : api)(req, res, next);
    };
}

module.exports = createApiRateLimit;
