const express = require('express');
const { openRaw, resolveNexusDbPath } = require('../../db/raw');
const { aggregateRoutingEconomics } = require('../services/routing-economics');

module.exports = function createRoutingEconomicsRouter({ dbPath = resolveNexusDbPath() } = {}) {
    const router = express.Router();
    router.get('/', (_req, res) => {
        let db;
        try {
            db = openRaw(dbPath, { readonly: true, fileMustExist: true, cache: false });
            // One consistent snapshot, full history rather than a display page.
            const data = db.transaction(() => {
                const rows = db.prepare(`SELECT id, task_id, executor, model, tokens, tokens_estimated,
                    outcome, started_at, completed_at FROM task_dispatches`).all();
                const hasModels = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='models'").get();
                const models = hasModels ? db.prepare('SELECT id, api_model_id, provider, is_active FROM models').all() : [];
                return aggregateRoutingEconomics(rows, models);
            })();
            res.set('Cache-Control', 'no-store').json({ ...data, generatedAt: new Date().toISOString() });
        } catch (error) {
            console.error('[Routing economics] Read failed:', error.message);
            res.status(503).json({ error: 'Routing economics unavailable; dispatch history could not be read.' });
        } finally { if (db) db.close(); }
    });
    return router;
};
