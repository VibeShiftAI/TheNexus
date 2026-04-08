/**
 * LangGraph Routes — Thin HTTP adapter for the LangGraph supervisor service.
 * 
 * Proxy routes delegate to proxyToLangGraph().
 * Business-logic callbacks (workflow-complete, sync-output, implement)
 * delegate to handlers in services/langgraph-supervisor.js.
 */

const express = require('express');

module.exports = function createLangGraphRouter({ db, PROJECT_ROOT, getProjectById, contextSync, runAgent }) {
    const router = express.Router();
    const lgService = require('../services/langgraph-supervisor');

    const deps = { db, getProjectById, PROJECT_ROOT, contextSync };

    // ─── Proxy Routes (thin pass-through to Python backend) ─────────────

    router.get('/health', async (req, res) => {
        try {
            res.json(await lgService.proxyToLangGraph('/health'));
        } catch (error) {
            res.json({ status: 'unavailable', error: 'LangGraph engine not running. Start it with: cd python && start.bat' });
        }
    });

    router.get('/node-types', async (req, res) => {
        try { res.json(await lgService.proxyToLangGraph('/node-types')); }
        catch (error) { res.status(503).json({ error: 'LangGraph engine unavailable' }); }
    });

    router.get('/node-types/atomic', async (req, res) => {
        try { res.json(await lgService.proxyToLangGraph('/node-types/atomic')); }
        catch (error) { res.status(503).json({ error: 'LangGraph engine unavailable' }); }
    });

    router.get('/node-types/atomic/:typeId', async (req, res) => {
        try {
            res.json(await lgService.proxyToLangGraph(`/node-types/atomic/${req.params.typeId}`));
        } catch (error) {
            if (error.message?.includes('404')) {
                res.status(404).json({ error: `Node type '${req.params.typeId}' not found` });
            } else {
                res.status(503).json({ error: 'LangGraph engine unavailable' });
            }
        }
    });

    router.get('/templates', async (req, res) => {
        try {
            const { level } = req.query;
            const url = level ? `/templates?level=${level}` : '/templates';
            const result = await lgService.proxyToLangGraph(url);
            if (level && result.templates && Array.isArray(result.templates)) {
                result.templates = result.templates.filter(t => !t.level || t.level === level);
            }
            res.json(result);
        } catch (error) { res.status(503).json({ error: 'LangGraph engine unavailable', templates: [] }); }
    });

    router.post('/templates', async (req, res) => {
        try {
            res.json(await lgService.proxyToLangGraph('/templates', { method: 'POST', body: JSON.stringify(req.body) }));
        } catch (error) {
            if (error.message?.includes('409')) res.status(409).json({ detail: 'Template with this name already exists' });
            else res.status(503).json({ error: 'LangGraph engine unavailable' });
        }
    });

    router.delete('/templates/:templateId', async (req, res) => {
        try {
            res.json(await lgService.proxyToLangGraph(`/templates/${req.params.templateId}`, { method: 'DELETE' }));
        } catch (error) {
            if (error.message?.includes('404')) res.status(404).json({ detail: 'Template not found' });
            else res.status(503).json({ error: 'LangGraph engine unavailable' });
        }
    });

    router.post('/compile', async (req, res) => {
        try { res.json(await lgService.proxyToLangGraph('/graph/compile', { method: 'POST', body: JSON.stringify(req.body) })); }
        catch (error) { res.status(503).json({ error: 'LangGraph engine unavailable' }); }
    });

    router.post('/run', async (req, res) => {
        try { res.json(await lgService.proxyToLangGraph('/graph/run', { method: 'POST', body: JSON.stringify(req.body) })); }
        catch (error) { res.status(503).json({ error: 'LangGraph engine unavailable' }); }
    });

    router.get('/runs/:runId', async (req, res) => {
        try { res.json(await lgService.proxyToLangGraph(`/runs/${req.params.runId}`)); }
        catch (error) { res.status(503).json({ error: 'LangGraph engine unavailable' }); }
    });

    router.get('/runs/:runId/checkpoints', async (req, res) => {
        try { res.json(await lgService.proxyToLangGraph(`/runs/${req.params.runId}/checkpoints`)); }
        catch (error) { res.status(503).json({ error: 'LangGraph engine unavailable' }); }
    });

    router.post('/runs/:runId/rewind', async (req, res) => {
        try { res.json(await lgService.proxyToLangGraph(`/runs/${req.params.runId}/rewind`, { method: 'POST', body: JSON.stringify(req.body) })); }
        catch (error) { res.status(503).json({ error: 'LangGraph engine unavailable' }); }
    });

    router.post('/runs/:runId/cancel', async (req, res) => {
        try { res.json(await lgService.proxyToLangGraph(`/runs/${req.params.runId}/cancel`, { method: 'POST' })); }
        catch (error) { res.status(503).json({ error: 'LangGraph engine unavailable' }); }
    });

    // ─── Business Logic Callbacks (delegate to service handlers) ─────────

    router.post('/workflow-complete', async (req, res) => {
        try {
            const result = await lgService.handleWorkflowComplete(req.body, deps);
            res.json(result);
        } catch (err) {
            console.error('[LangGraph Complete] Error:', err);
            res.status(500).json({ error: err.message });
        }
    });

    router.post('/sync-output', async (req, res) => {
        try {
            const result = await lgService.handleSyncOutput(req.body, deps);
            res.json(result);
        } catch (error) {
            console.error('[LangGraph Sync] Error:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    router.post('/implement', async (req, res) => {
        try {
            const result = await lgService.handleImplement(req.body, { ...deps, runAgent });
            res.json(result);
        } catch (error) {
            console.error('[LangGraph Implement] Error:', error);

            // Revert task status on failure
            const targetTaskId = req.body.task_id || req.body.feature_id;
            try {
                await db.updateTask(targetTaskId, { status: 'planning', updated_at: new Date().toISOString() });
            } catch (e) {
                console.error('[LangGraph Implement] Could not revert status:', e);
            }

            res.status(error.statusCode || 500).json({ success: false, error: error.message });
        }
    });

    return router;
};
