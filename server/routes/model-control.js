const express = require('express');
const { resolveModelAssignment } = require('../services/model-control');

function normalizePolicyInput(body = {}) {
    const budget = body.budget && typeof body.budget === 'object' ? body.budget : {};
    return {
        enabled: !!body.enabled,
        requiredCapabilities: Array.isArray(body.requiredCapabilities) ? body.requiredCapabilities : [],
        fallbackChain: Array.isArray(body.fallbackChain) ? body.fallbackChain : [],
        budget: {
            dailyTokenLimit: Number(budget.dailyTokenLimit) > 0 ? Number(budget.dailyTokenLimit) : null,
            dailyCostLimit: Number(budget.dailyCostLimit) > 0 ? Number(budget.dailyCostLimit) : null,
            autoLocalOnly: !!budget.autoLocalOnly
        }
    };
}

function createModelControlRouter({ db, discoverModelRegistry }) {
    const router = express.Router();

    router.get('/options', async (req, res) => {
        try {
            const projectId = req.query.projectId || null;
            res.json({
                models: await db.getModels(true),
                aliases: await db.getModelAliases(true),
                projectAliases: projectId ? await db.getProjectModelAliases(projectId) : [],
                localOnly: await db.getModelControlSetting('local_only'),
                policy: await db.getModelControlSetting('model_policy'),
                projectPolicy: projectId && typeof db.getProjectModelControlSetting === 'function'
                    ? await db.getProjectModelControlSetting(projectId, 'model_policy')
                    : null
            });
        } catch (error) {
            console.error('[Model Control] Failed to load options:', error);
            res.status(500).json({ error: 'Failed to load model-control options: ' + error.message });
        }
    });

    router.post('/resolve', async (req, res) => {
        try {
            res.json(await resolveModelAssignment(db, req.body || {}));
        } catch (error) {
            console.error('[Model Control] Failed to resolve assignment:', error);
            res.status(500).json({ error: 'Failed to resolve model assignment: ' + error.message });
        }
    });

    router.get('/executions', async (req, res) => {
        try {
            res.json(await db.getModelExecutionSnapshots({
                projectId: req.query.projectId || undefined,
                taskId: req.query.taskId || undefined,
                calendarEventId: req.query.calendarEventId || undefined,
                workflowId: req.query.workflowId || undefined,
                workflowRunId: req.query.workflowRunId || undefined,
                nodeId: req.query.nodeId || undefined,
                conversationId: req.query.conversationId || undefined,
                messageId: req.query.messageId || undefined,
                commandId: req.query.commandId || undefined,
                provider: req.query.provider || undefined,
                resolvedModelId: req.query.resolvedModelId || undefined,
                fallbackUsed: req.query.fallbackUsed === undefined ? undefined : req.query.fallbackUsed === 'true',
                localOnlyActive: req.query.localOnlyActive === undefined ? undefined : req.query.localOnlyActive === 'true',
                limit: Number(req.query.limit) || 50,
                offset: Number(req.query.offset) || 0
            }));
        } catch (error) {
            console.error('[Model Control] Failed to load execution snapshots:', error);
            res.status(500).json({ error: 'Failed to load model execution snapshots: ' + error.message });
        }
    });

    router.post('/discover', async (_req, res) => {
        try {
            if (typeof discoverModelRegistry !== 'function') {
                return res.status(503).json({ error: 'Model discovery is not configured' });
            }
            res.json(await discoverModelRegistry({ db }));
        } catch (error) {
            console.error('[Model Control] Failed to run model discovery:', error);
            res.status(500).json({ error: 'Failed to run model discovery: ' + error.message });
        }
    });

    router.put('/aliases/:alias', async (req, res) => {
        try {
            res.json(await db.upsertModelAlias({
                alias: req.params.alias,
                target: req.body.target,
                description: req.body.description,
                is_active: req.body.is_active
            }));
        } catch (error) {
            console.error('[Model Control] Failed to update alias:', error);
            res.status(500).json({ error: 'Failed to update model alias: ' + error.message });
        }
    });

    router.put('/local-only', async (req, res) => {
        try {
            res.json(await db.setModelControlSetting('local_only', {
                enabled: !!req.body.enabled,
                reason: req.body.reason || null
            }));
        } catch (error) {
            console.error('[Model Control] Failed to update local-only mode:', error);
            res.status(500).json({ error: 'Failed to update local-only mode: ' + error.message });
        }
    });

    router.put('/policy', async (req, res) => {
        try {
            res.json(await db.setModelControlSetting('model_policy', normalizePolicyInput(req.body)));
        } catch (error) {
            console.error('[Model Control] Failed to update model policy:', error);
            res.status(500).json({ error: 'Failed to update model policy: ' + error.message });
        }
    });

    router.put('/projects/:id/aliases/:alias', async (req, res) => {
        try {
            res.json(await db.upsertProjectModelAlias(req.params.id, {
                alias: req.params.alias,
                target: req.body.target,
                description: req.body.description
            }));
        } catch (error) {
            console.error('[Model Control] Failed to update project alias:', error);
            res.status(500).json({ error: 'Failed to update project model alias: ' + error.message });
        }
    });

    router.put('/projects/:id/policy', async (req, res) => {
        try {
            res.json(await db.setProjectModelControlSetting(req.params.id, 'model_policy', normalizePolicyInput(req.body)));
        } catch (error) {
            console.error('[Model Control] Failed to update project model policy:', error);
            res.status(500).json({ error: 'Failed to update project model policy: ' + error.message });
        }
    });

    return router;
}

module.exports = createModelControlRouter;
