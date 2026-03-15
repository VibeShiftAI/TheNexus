/**
 * Workflows Routes — Project-level workflows + Nexus Prime status proxy
 * Extracted from server.js for modularity
 */

const express = require('express');
const fs = require('fs');
const path = require('path');

module.exports = function createWorkflowsRouter({ db, PROJECT_ROOT, getProjectById }) {
    const router = express.Router();

    const LANGGRAPH_URL = process.env.PYTHON_BACKEND_URL || 'http://localhost:8000';

    // Helper to proxy to LangGraph
    async function proxyToLangGraph(urlPath, options = {}) {
        const url = `${LANGGRAPH_URL}${urlPath}`;
        const response = await fetch(url, {
            ...options,
            headers: {
                'Content-Type': 'application/json',
                ...options.headers
            }
        });
        return response.json();
    }

    // === Nexus Prime workflow status (mounted at /api/workflows) ===

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
            const result = await proxyToLangGraph(`/graph/nexus/${req.params.runId}/artifacts`);
            res.json(result);
        } catch (error) {
            res.status(503).json({ error: 'LangGraph engine unavailable' });
        }
    });

    return router;
};
