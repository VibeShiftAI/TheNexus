/** Local operator credential exchange. No cookies are accepted as credentials at sign-in. */
const express = require('express');
const rateLimit = require('express-rate-limit');
const { localOperatorSessions, localRequest, COOKIE, COOKIE_OPTIONS, TTL_MS } = require('../services/local-operator-session');

module.exports = function createOperatorSessionRouter({ sessions = localOperatorSessions } = {}) {
    const router = express.Router();
    router.use((req, res, next) => {
        res.set('Cache-Control', 'no-store');
        if (!localRequest(req)) return res.status(403).json({ code: 'operator_required', error: 'Use http://localhost:3000 to sign in locally.' });
        next();
    });
    router.get('/', (req, res) => {
        const result = sessions.inspect(req);
        res.json({ operator: result.ok, ...(result.ok ? { expiresAt: result.expiresAt } : {}) });
    });
    router.post('/', rateLimit({
        windowMs: 60_000, limit: 10, keyGenerator: () => 'local-sign-in',
        standardHeaders: true, legacyHeaders: false,
        message: { code: 'operator_required', error: 'Too many sign-in attempts. Wait one minute.' },
    }), (req, res) => {
        try {
            const { token, expiresAt } = sessions.mint(req);
            res.cookie(COOKIE, token, { ...COOKIE_OPTIONS, maxAge: TTL_MS });
            return res.status(201).json({ operator: true, expiresAt });
        } catch (err) {
            // Never echo request data, credentials or internal error messages.
            return res.status(err.status || 503).json({
                code: err.status === 503 ? 'operator_credential_unconfigured' : 'operator_required',
                error: err.status === 503 ? 'Local operator sign-in is not configured.' : 'Operator sign-in refused.',
            });
        }
    });
    router.delete('/', (req, res) => {
        sessions.revoke(req);
        res.clearCookie(COOKIE, COOKIE_OPTIONS);
        res.json({ operator: false });
    });
    return router;
};
