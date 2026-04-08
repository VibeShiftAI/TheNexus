/**
 * Usage Routes
 * 
 * GET  /api/ai/usage       — Get token usage stats
 * POST /api/ai/usage       — Record external token usage
 * POST /api/ai/usage/reset — Reset usage stats
 */
const express = require('express');

function createUsageRouter({ db, tokenTracker }) {
    const router = express.Router();

    // GET /api/ai/usage
    router.get('/', async (req, res) => {
        try {
            const stats = await tokenTracker.getUsageStats({
                projectId: req.query.projectId,
                provider: req.query.provider,
                days: req.query.days ? parseInt(req.query.days) : 30
            });
            res.json(stats);
        } catch (error) {
            console.error('Error getting usage stats:', error);
            res.status(500).json({ error: 'Failed to get usage stats' });
        }
    });

    // POST /api/ai/usage — Record external token usage
    router.post('/', async (req, res) => {
        try {
            const { model, inputTokens, outputTokens, source } = req.body;
            if (!model || inputTokens == null || outputTokens == null) {
                return res.status(400).json({ error: 'model, inputTokens, and outputTokens are required' });
            }
            const input = Math.max(0, Math.round(Number(inputTokens) || 0));
            const output = Math.max(0, Math.round(Number(outputTokens) || 0));
            const caller = source || 'unknown';
            await db.recordUsage(model, input, output, caller);
            res.json({ ok: true, recorded: { model, inputTokens: input, outputTokens: output, source: caller } });
        } catch (error) {
            console.error('Error recording external usage:', error);
            res.status(500).json({ error: 'Failed to record usage: ' + error.message });
        }
    });

    // POST /api/ai/usage/reset
    router.post('/reset', (req, res) => {
        try {
            tokenTracker.resetUsageStats();
            res.json({ success: true, message: 'Usage stats reset' });
        } catch (error) {
            console.error('[Token Tracker] Error resetting stats:', error);
            res.status(500).json({ error: 'Failed to reset usage stats' });
        }
    });

    return router;
}

module.exports = createUsageRouter;
