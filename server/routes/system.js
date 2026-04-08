/**
 * System Routes
 * 
 * GET  /api/system/status     — CPU, memory, ports
 * GET  /api/system/resources   — Token budget dashboard
 * GET  /api/database/status    — Database connection status
 * GET  /api/critic/status      — Critic enabled?
 * POST /api/critic/toggle      — Enable/disable Critic
 * GET  /api/reasoning/config   — Reasoning config (stubbed)
 * POST /api/reasoning/level    — Set reasoning level (stubbed)
 */
const express = require('express');

function createSystemRouter({ db, systemMonitor, isCriticEnabled, setCriticEnabled }) {
    const router = express.Router();

    // GET /api/system/status
    router.get('/system/status', async (req, res) => {
        try {
            const refresh = req.query.refresh === 'true';
            const status = await systemMonitor.getSystemStatus(refresh);
            res.json(status);
        } catch (error) {
            console.error('Error getting system status:', error);
            res.status(500).json({ error: 'Failed to get system status' });
        }
    });

    // GET /api/system/resources — Token budget dashboard
    router.get('/system/resources', async (req, res) => {
        try {
            const today = new Date().toISOString().split('T')[0];
            const usageRows = await db.getUsageStats(today, today) || [];

            let tokensUsedToday = 0;
            let inputTokensToday = 0;
            let outputTokensToday = 0;
            let requestCountToday = 0;
            const breakdownByModel = {};

            let praxisTokensToday = 0;
            let praxisInputToday = 0;
            let praxisOutputToday = 0;
            let praxisRequestsToday = 0;
            const breakdownBySource = {};

            for (const row of usageRows) {
                const total = Number(row.total_tokens) || 0;
                const input = Number(row.input_tokens) || 0;
                const output = Number(row.output_tokens) || 0;
                const requests = Number(row.request_count) || 0;
                const source = row.source || 'unknown';

                tokensUsedToday += total;
                inputTokensToday += input;
                outputTokensToday += output;
                requestCountToday += requests;
                if (row.model) {
                    breakdownByModel[row.model] = (breakdownByModel[row.model] || 0) + total;
                }

                if (!breakdownBySource[source]) {
                    breakdownBySource[source] = { tokens: 0, input: 0, output: 0, requests: 0 };
                }
                breakdownBySource[source].tokens += total;
                breakdownBySource[source].input += input;
                breakdownBySource[source].output += output;
                breakdownBySource[source].requests += requests;

                if (source === 'praxis') {
                    praxisTokensToday += total;
                    praxisInputToday += input;
                    praxisOutputToday += output;
                    praxisRequestsToday += requests;
                }
            }

            let dailyLimit = 2_000_000;
            let quotaSource = 'default';

            const quotaEndpoints = ['anthropic', 'google', 'openai', 'default'];
            for (const endpoint of quotaEndpoints) {
                const quota = await db.getQuota(endpoint, 'daily');
                if (quota) {
                    dailyLimit = Number(quota.max_requests) || dailyLimit;
                    quotaSource = endpoint;
                    break;
                }
            }

            const tomorrow = new Date();
            tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
            tomorrow.setUTCHours(0, 0, 0, 0);
            const nextResetTimestamp = tomorrow.toISOString();

            let availableModels = [];
            try {
                const models = await db.getModels(true);
                availableModels = models.map(m => ({
                    id: m.id,
                    name: m.name || m.id,
                    provider: m.provider || 'unknown',
                    is_default: !!m.is_default
                }));
            } catch { /* Models table might not have data */ }

            const budgetPercentage = Math.round((praxisTokensToday / dailyLimit) * 1000) / 10;
            const budgetStatus = budgetPercentage >= 80 ? 'critical' : 'safe';

            res.json({
                praxis_tokens_today: praxisTokensToday,
                praxis_input_today: praxisInputToday,
                praxis_output_today: praxisOutputToday,
                praxis_requests_today: praxisRequestsToday,
                tokens_used_today: tokensUsedToday,
                input_tokens_today: inputTokensToday,
                output_tokens_today: outputTokensToday,
                request_count_today: requestCountToday,
                daily_limit: dailyLimit,
                budget_percentage: budgetPercentage,
                budget_status: budgetStatus,
                quota_source: quotaSource,
                next_reset_timestamp: nextResetTimestamp,
                available_models: availableModels,
                breakdown_by_model: breakdownByModel,
                breakdown_by_source: breakdownBySource,
                assessed_at: new Date().toISOString()
            });
        } catch (error) {
            console.error('Error getting system resources:', error);
            res.status(500).json({ error: 'Failed to get system resources: ' + error.message });
        }
    });

    // GET /api/database/status
    router.get('/database/status', async (req, res) => {
        try {
            const isEnabled = db.isDatabaseEnabled();

            if (!isEnabled) {
                return res.json({
                    enabled: false,
                    connected: false,
                    message: 'Database not configured. Check NEXUS_DB_PATH in .env',
                    tables: []
                });
            }

            const connectionResult = await db.testConnection();

            if (!connectionResult.success) {
                return res.json({
                    enabled: true,
                    connected: false,
                    error: connectionResult.error,
                    tables: []
                });
            }

            const tableCounts = {};

            res.json({
                enabled: true,
                connected: true,
                tables: tableCounts,
                message: 'Database connected successfully'
            });
        } catch (error) {
            console.error('[Database] Status check error:', error);
            res.status(500).json({
                enabled: db.isDatabaseEnabled(),
                connected: false,
                error: error.message
            });
        }
    });

    // GET /api/critic/status
    router.get('/critic/status', async (req, res) => {
        const enabled = await isCriticEnabled();
        res.json({
            enabled,
            message: enabled
                ? 'Critic is active - code will be reviewed before writes'
                : 'Critic disabled - code writes will not be reviewed'
        });
    });

    // POST /api/critic/toggle
    router.post('/critic/toggle', async (req, res) => {
        const { enabled } = req.body;
        if (typeof enabled !== 'boolean') {
            return res.status(400).json({ error: 'enabled must be a boolean' });
        }
        await setCriticEnabled(enabled);
        res.json({
            success: true,
            enabled,
            message: enabled
                ? 'Critic enabled - all code writes will be reviewed before writes'
                : 'Critic disabled - code writes will not be reviewed'
        });
    });

    // GET /api/reasoning/config (stubbed)
    router.get('/reasoning/config', (req, res) => {
        const reasoningConfig = {
            currentLevel: 'standard',
            levels: {}
        };
        res.json(reasoningConfig);
    });

    // POST /api/reasoning/level (stubbed)
    router.post('/reasoning/level', (req, res) => {
        const { level } = req.body;
        console.log(`[Reasoning] Level set to: ${level}`);
        res.json({ success: true, level });
    });

    return router;
}

module.exports = createSystemRouter;
