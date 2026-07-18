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
const { PRAXIS_URL } = require('../shared/constants');

function createUsageMonitorRouter() {
    const router = express.Router();

    router.get('/state', async (_req, res) => {
        try {
            const response = await fetch(`${PRAXIS_URL}/api/usage/state`, {
                headers: { Accept: 'application/json' },
                signal: AbortSignal.timeout(15_000),
            });
            const text = await response.text();
            res.status(response.status);
            res.setHeader('Content-Type', response.headers.get('content-type') || 'application/json');
            res.send(text);
        } catch (err) {
            res.status(502).json({ error: err.message || 'Praxis unreachable' });
        }
    });

    router.post('/recommend', async (req, res) => {
        try {
            const response = await fetch(`${PRAXIS_URL}/api/routing/recommend`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(req.body ?? {}),
                signal: AbortSignal.timeout(150_000),
            });
            const text = await response.text();
            res.status(response.status);
            res.setHeader('Content-Type', response.headers.get('content-type') || 'application/json');
            res.send(text);
        } catch (err) {
            res.status(502).json({ error: err.message || 'Praxis unreachable' });
        }
    });

    return router;
}

module.exports = createUsageMonitorRouter;
