/**
 * Workflows Routes — Nexus Prime workflow status + artifacts proxy
 * Uses shared proxyToLangGraph from services/langgraph-supervisor.js
 */

const express = require('express');

module.exports = function createWorkflowsRouter({ db, PROJECT_ROOT, getProjectById }) {
    const router = express.Router();
    const { proxyToLangGraph } = require('../services/langgraph-supervisor');

    // GET Nexus Prime workflow status (for real-time activity log)
    router.get('/:runId/status', async (req, res) => {
        try {
            const result = await proxyToLangGraph(`/graph/nexus/${req.params.runId}`);
            console.log(`[Workflow Status] RunId: ${req.params.runId}, Result:`, JSON.stringify(result).substring(0, 500));
            res.json(result);
        } catch (error) {
            console.error(`[Workflow Status] Error for ${req.params.runId}:`, error);
            res.status(503).json({ error: 'LangGraph engine unavailable' });
        }
    });

    // GET Nexus Prime workflow artifacts
    router.get('/:runId/artifacts', async (req, res) => {
        try {
            res.json(await proxyToLangGraph(`/graph/nexus/${req.params.runId}/artifacts`));
        } catch (error) {
            res.status(503).json({ error: 'LangGraph engine unavailable' });
        }
    });

    return router;
};
