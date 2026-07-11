/**
 * Token-usage proxy — /api/token-usage
 *
 * The daily token-throughput aggregation lives in the Next.js dashboard
 * (dashboard/src/app/api/token-usage — it scans the CLI session logs and the
 * Praxis cost ledger with its own mtime caching). At home the browser talks
 * to :3000 directly and hits that route, but the Cloudflare tunnel sends ALL
 * /api/* to this server (:4000), so remote viewers (the travel shell) land
 * here instead. Forward to the dashboard rather than duplicating the
 * aggregation.
 */
const express = require('express');
const { DASHBOARD_URL } = require('../shared/constants');

function createTokenUsageRouter() {
    const router = express.Router();

    router.get('/', async (_req, res) => {
        try {
            const response = await fetch(`${DASHBOARD_URL}/api/token-usage`, {
                headers: { Accept: 'application/json' },
            });
            const text = await response.text();
            res.status(response.status);
            res.setHeader('Content-Type', response.headers.get('content-type') || 'application/json');
            res.send(text);
        } catch (err) {
            res.status(502).json({ error: err.message || 'Dashboard unreachable' });
        }
    });

    return router;
}

module.exports = createTokenUsageRouter;
