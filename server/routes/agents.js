/**
 * Agents Routes
 * Local model catalog view for dashboard agent surfaces.
 */
const express = require('express');

function createAgentsRouter({ db }) {
    const router = express.Router();

    router.get('/', async (req, res) => {
        let availableModels = [];
        try {
            if (db.isDatabaseEnabled()) availableModels = await db.getModels(true) || [];
            res.json({ agents: {}, availableModels });
        } catch (error) {
            console.error('[Agents] ERROR:', error.message);
            res.status(500).json({ error: 'Failed to load model catalog', agents: {}, availableModels });
        }
    });

    return router;
}

module.exports = createAgentsRouter;
