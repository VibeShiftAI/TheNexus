const express = require('express');
const { resolveModelAssignment } = require('../services/model-control');

function createModelControlRouter({ db }) {
    const router = express.Router();

    router.get('/options', async (req, res) => {
        try {
            const projectId = req.query.projectId || null;
            res.json({
                models: await db.getModels(true),
                aliases: await db.getModelAliases(true),
                projectAliases: projectId ? await db.getProjectModelAliases(projectId) : [],
                localOnly: await db.getModelControlSetting('local_only')
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

    return router;
}

module.exports = createModelControlRouter;
