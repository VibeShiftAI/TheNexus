const rateLimit = require('express-rate-limit');
const { createHmac, timingSafeEqual } = require('node:crypto');
const { stakeholderCredential, requireStakeholderAuthority } = require('../services/stakeholder-authority');

const WINDOW_MS = 15 * 60 * 1000;
// One core-second per elapsed second. The reference full-board read on the
// operator's database used 156.3 ms CPU (median including JSON serialization).
// See evidence/689be7c7/findings.md for the calibration and its limits.
const WINDOW_REQUESTS = Math.floor(WINDOW_MS / 156.3);

function isLocalRuntime(req) {
    const peer = req.socket.remoteAddress?.replace(/^::ffff:/, '');
    if (peer !== '127.0.0.1' && peer !== '::1') return false;
    const proof = req.get('x-nexus-runtime-traffic');
    if (!proof && !req.get('authorization')) return false;
    try {
        if (!proof) return requireStakeholderAuthority(req, 'runtime') === 'runtime_credential';
        const expected = createHmac('sha256', stakeholderCredential('runtime'))
            .update('nexus:request-allowance:v1').digest('hex');
        const supplied = Buffer.from(proof);
        return supplied.length === expected.length && timingSafeEqual(supplied, Buffer.from(expected));
    } catch {
        return false;
    }
}

function callerLabel(req) {
    const agent = req.get('user-agent') || '';
    if (/HeadlessChrome|curl|wget|python/i.test(agent)) return 'executor/cli';
    if (/okhttp|CFNetwork|Dart/i.test(agent)) return 'mobile';
    if (/Mozilla/i.test(agent)) return 'browser';
    return 'unverified';
}

function createApiRateLimit(max = WINDOW_REQUESTS) {
    const options = {
        windowMs: WINDOW_MS, max,
        standardHeaders: true, legacyHeaders: false,
        handler(req, res) {
            const lane = req.method === 'GET' && req.path === '/health' ? 'health' : 'general';
            console.warn('[ApiRateLimit]', {
                caller: lane === 'health' ? 'health-probe' : callerLabel(req),
                method: req.method, route: req.baseUrl + req.path, lane, reason: 'window_exhausted',
            });
            res.set('X-Nexus-Allowance', lane).status(429).json({ error: 'Too many requests, please try again later.' });
        },
    };
    const api = rateLimit(options);
    const health = rateLimit(options);
    return (req, res, next) => {
        if (req.method === 'GET' && req.path === '/health') return health(req, res, next);
        if (isLocalRuntime(req)) return next();
        return api(req, res, next);
    };
}

module.exports = createApiRateLimit;
