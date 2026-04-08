/**
 * Health Routes
 * 
 * GET /         — API info
 * GET /health   — Health check
 */
const express = require('express');

function createHealthRouter() {
    const router = express.Router();

    // Root route - API info (mounted at /api)
    router.get('/', (req, res) => {
        res.json({
            name: 'The Nexus API',
            version: '1.0.0',
            status: 'running',
            endpoints: {
                projects: '/api/projects',
                activity: '/api/activity',
                agents: '/api/agents',
                health: '/api/health'
            }
        });
    });

    // Health check endpoint
    router.get('/health', (req, res) => {
        res.json({ status: 'healthy', timestamp: new Date().toISOString() });
    });

    return router;
}

module.exports = createHealthRouter;
