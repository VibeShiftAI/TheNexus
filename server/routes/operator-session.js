/** Automatic local application bootstrap; there is no operator sign-in form. */
const express = require('express');
const rateLimit = require('express-rate-limit');
const { localOperatorSessions, localRequest, COOKIE, COOKIE_OPTIONS, TTL_MS } = require('../services/local-operator-session');

module.exports = function createOperatorSessionRouter({ sessions = localOperatorSessions } = {}) {
    const router = express.Router();
    router.use((req, res, next) => {
        res.set('Cache-Control', 'no-store');
        if (!localRequest(req, req.path === '/bootstrap')) return res.status(403).json({ code: 'operator_required', error: 'Local operator session required.' });
        next();
    });
    router.get('/', (req, res) => {
        const result = sessions.inspect(req);
        res.json({ operator: result.ok, ...(result.ok ? { expiresAt: result.expiresAt } : {}),
            // Only bootstrap needs the direct peer; all decisions keep /api.
            bootstrapUrl: `http://localhost:${req.socket.localPort}/api/operator-session/bootstrap` });
    });
    router.post('/', (_req, res) => res.status(410).json({ code: 'operator_required', error: 'Separate operator sign-in has been retired.' }));
    router.post('/bootstrap', rateLimit({
        windowMs: 60_000, limit: 10, keyGenerator: () => 'local-bootstrap',
        standardHeaders: true, legacyHeaders: false,
        message: { code: 'operator_required', error: 'Too many session attempts. Wait one minute.' },
    }), async (req, res) => {
        res.set('Access-Control-Allow-Credentials', 'true');
        try {
            const { token, proof, expiresAt } = await sessions.mint(req);
            res.cookie(COOKIE, token, { ...COOKIE_OPTIONS, maxAge: TTL_MS });
            return res.status(201).json({ operator: true, proof, expiresAt });
        } catch (err) {
            // Never echo request data, credentials or internal error messages.
            return res.status(err.status || 503).json({
                code: err.status === 503 ? 'operator_credential_unconfigured' : 'operator_required',
                error: err.status === 503 ? 'Local operator session is not configured.' : 'This local application could not be verified.',
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
