/**
 * Models Routes
 * 
 * GET    /api/models     — List all models
 * POST   /api/models     — Create/update a model
 * DELETE /api/models/:id — Delete a model
 */
const express = require('express');
const { invalidateModelsCache } = require('../shared/models-cache');

function createModelsRouter({ db, getModels }) {
    const router = express.Router();

    // GET /api/models - List all available models (from discovery service)
    router.get('/', (req, res) => {
        const models = getModels();
        res.json({ models });
    });

    // POST /api/models - Create or update a model
    router.post('/', async (req, res) => {
        try {
            const model = req.body;

            if (!model.id || !model.name || !model.provider) {
                return res.status(400).json({ error: 'id, name, and provider are required' });
            }

            const result = await db.upsertModel(model);
            invalidateModelsCache();
            res.json(result);
        } catch (error) {
            console.error('[Models] Error upserting model:', error);
            res.status(500).json({ error: 'Failed to save model: ' + error.message });
        }
    });

    // DELETE /api/models/:id - Delete a model
    router.delete('/:id', async (req, res) => {
        try {
            const { id } = req.params;
            await db.deleteModel(id);
            invalidateModelsCache();
            res.json({ success: true });
        } catch (error) {
            console.error('[Models] Error deleting model:', error);
            res.status(500).json({ error: 'Failed to delete model: ' + error.message });
        }
    });

    return router;
}

module.exports = createModelsRouter;
