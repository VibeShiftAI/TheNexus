/**
 * Agents Routes
 * Atomic nodes registry (read-only from Python backend).
 */
const express = require('express');

function createAgentsRouter({ db }) {
    const router = express.Router();

    router.get('/', async (req, res) => {
        try {
            const PYTHON_URL = process.env.PYTHON_BACKEND_URL || 'http://localhost:8000';

            const fetchWithRetry = async (url, retries = 3, delay = 1000) => {
                for (let attempt = 1; attempt <= retries; attempt++) {
                    try {
                        const response = await fetch(url);
                        if (!response.ok) throw new Error(`Python backend returned ${response.status}`);
                        return await response.json();
                    } catch (err) {
                        if (attempt === retries) throw err;
                        console.log(`[Agents] Python backend not ready, retry ${attempt}/${retries}...`);
                        await new Promise(r => setTimeout(r, delay));
                        delay *= 2;
                    }
                }
            };

            const atomicData = await fetchWithRetry(`${PYTHON_URL}/node-types/atomic`);
            const atomicAgents = atomicData.node_types || [];

            const CATEGORY_ICONS = {
                research: '🔬', planning: '📋', implementation: '🔧',
                review: '✅', orchestration: '🎯', utility: '🔧',
                dashboard: '📊', project: '📁', memory: '🧠',
            };

            const agents = {};
            for (const node of atomicAgents) {
                const typeId = node.type || node.type_id || node.name;
                agents[typeId] = {
                    id: typeId, name: node.displayName || node.display_name || node.name,
                    description: node.description, category: node.category,
                    icon: CATEGORY_ICONS[node.category] || node.icon || '🔧',
                    levels: node.levels || [], isSystem: true, source: 'atomic', version: node.version,
                };
            }

            let availableModels = [];
            try {
                if (db.isDatabaseEnabled()) availableModels = await db.getModels(true) || [];
            } catch (dbErr) {
                console.warn('[Agents] Could not fetch models from DB:', dbErr.message);
            }

            res.json({ agents, availableModels });
        } catch (error) {
            console.error('[Agents] ERROR:', error.message);
            res.status(503).json({ error: 'Python backend unavailable - atomic nodes not loaded', agents: {}, availableModels: [] });
        }
    });

    return router;
}

module.exports = createAgentsRouter;
