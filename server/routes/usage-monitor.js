/**
 * Usage-monitor proxy — /api/usage-monitor
 *
 * The usage/routing brain lives in Praxis (src/usage/usage-monitor.ts,
 * src/routing/model-router.ts); this thin proxy makes it reachable by the
 * dashboard and, through the tunnel (which sends all /api/* to :4000), the
 * travel shell. Distinct from /api/ai/usage (dashboard's own tokenTracker)
 * and /api/token-usage (daily throughput chip).
 *
 * GET  /api/usage-monitor/state     — tokens today, 5h windows, resets,
 *                                     rate-limit snapshots, recent decisions
 * POST /api/usage-monitor/recommend — routing recommendation for a task
 *                                     ({title, description?, workspace?});
 *                                     runs the Fable scorer, allow ~2 min.
 */
const express = require('express');
const { praxisProxyJson } = require('../services/praxis-client');

function createUsageMonitorRouter() {
    const router = express.Router();

    router.get('/state', (_req, res) =>
        praxisProxyJson(res, '/api/usage/state', { timeoutMs: 15_000 }));

    // The Fable scorer can run ~2 min — keep the generous budget.
    router.post('/recommend', (req, res) =>
        praxisProxyJson(res, '/api/routing/recommend', {
            method: 'POST',
            body: req.body ?? {},
            timeoutMs: 150_000,
        }));

    return router;
}

module.exports = createUsageMonitorRouter;
