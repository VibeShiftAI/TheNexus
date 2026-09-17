/**
 * Dashboard Routes
 * 
 * GET /api/dashboard/stats — Dashboard statistics
 * GET /api/board-state     — Board state with dependency resolution
 */
const express = require('express');
const { guardDispatchPayload } = require('../lib/provenance');
const { parseSummaryQuery } = require('../../db/board-summary');

// Shared by the dashboard route and the authenticated planning endpoint.
function createBoardStateHandler({ db, compat = false }) {
    return async (req, res) => {
        try {
            if (req.query.view !== undefined && !['full', 'summary'].includes(req.query.view)) {
                return res.status(400).json({ error: 'view must be full or summary' });
            }
            if (req.query.view === 'summary') {
                return res.json(await db.getBoardSummary(parseSummaryQuery(req.query)));
            }
            const projectId = req.query.project_id;
            const boardState = await db.getBoardState(projectId || undefined);
            // Board state carries antigravity_payload per task — gate external-
            // tier payloads at this read seam (server/lib/provenance.js).
            res.json(boardState.map(project => ({
                ...project,
                tasks: (project.tasks || []).map(t => ({
                    ...t,
                    ...(compat ? { title: t.name, createdAt: t.created_at, updatedAt: t.updated_at } : {}),
                    ...(t.antigravity_payload ? { antigravity_payload: guardDispatchPayload(t) } : {}),
                })),
            })));
        } catch (error) {
            if (error.code === 'invalid_board_summary_query') {
                return res.status(400).json({ error: error.message });
            }
            console.error('Error getting board state:', error);
            res.status(500).json({ error: compat ? 'Failed to compute board state' : 'Failed to get board state: ' + error.message });
        }
    };
}

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

    router.get('/board-state', createBoardStateHandler({ db }));

    return router;
}

module.exports = createDashboardRouter;

module.exports.createBoardStateHandler = createBoardStateHandler;
