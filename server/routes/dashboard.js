/**
 * Dashboard Routes
 * 
 * GET /api/dashboard/stats — Dashboard statistics
 * GET /api/board-state     — Board state with dependency resolution
 */
const express = require('express');

function createDashboardRouter({ db }) {
    const router = express.Router();

    // GET /api/dashboard/stats
    router.get('/stats', async (req, res) => {
        try {
            const stats = await db.getDashboardStats();
            res.json(stats);
        } catch (error) {
            console.error('Error getting dashboard stats:', error);
            res.status(500).json({ error: 'Failed to get dashboard stats' });
        }
    });

    // GET /api/board-state
    router.get('/board-state', async (req, res) => {
        try {
            const projectId = req.query.project_id;
            const boardState = await db.getBoardState(projectId || undefined);
            res.json(boardState);
        } catch (error) {
            console.error('Error getting board state:', error);
            res.status(500).json({ error: 'Failed to get board state: ' + error.message });
        }
    });

    return router;
}

module.exports = createDashboardRouter;
