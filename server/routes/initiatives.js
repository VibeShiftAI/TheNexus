/**
 * Initiatives Routes — Dashboard-level cross-project initiatives
 * Extracted from server.js for modularity
 */

const express = require('express');

module.exports = function createInitiativesRouter({ db }) {
    const router = express.Router();

    // GET all dashboard initiatives
    router.get('/', async (req, res) => {
        try {
            const { status } = req.query;
            const initiatives = await db.getDashboardInitiatives(status || null);
            res.json({ initiatives });
        } catch (error) {
            console.error('[Initiatives API] Error fetching initiatives:', error);
            res.status(500).json({ error: 'Failed to fetch initiatives' });
        }
    });

    // GET a single initiative with progress
    router.get('/:id', async (req, res) => {
        try {
            const initiative = await db.getDashboardInitiative(req.params.id);
            if (!initiative) {
                return res.status(404).json({ error: 'Initiative not found' });
            }

            // Get progress across all targeted projects
            const progress = await db.getInitiativeProgress(req.params.id);

            res.json({
                initiative,
                progress,
                summary: {
                    total: progress.length,
                    pending: progress.filter(p => p.status === 'pending').length,
                    inProgress: progress.filter(p => p.status === 'in_progress').length,
                    complete: progress.filter(p => p.status === 'complete').length,
                    failed: progress.filter(p => p.status === 'failed').length
                }
            });
        } catch (error) {
            console.error('[Initiatives API] Error fetching initiative:', error);
            res.status(500).json({ error: 'Failed to fetch initiative' });
        }
    });

    // POST create a new initiative
    router.post('/', async (req, res) => {
        try {
            const { name, description, workflow_type, target_projects, configuration } = req.body;

            if (!name || !workflow_type) {
                return res.status(400).json({ error: 'Name and workflow_type are required' });
            }

            const initiative = await db.createDashboardInitiative({
                name,
                description: description || '',
                workflow_type,
                target_projects: target_projects || [],
                configuration: configuration || {},
                status: 'idea'
            });

            if (!initiative) {
                return res.status(500).json({ error: 'Failed to create initiative' });
            }

            // Initialize progress entries for each target project
            for (const projectId of (target_projects || [])) {
                await db.updateInitiativeProjectStatus(initiative.id, projectId, {
                    status: 'pending'
                });
            }

            res.json({ success: true, initiative });
        } catch (error) {
            console.error('[Initiatives API] Error creating initiative:', error);
            res.status(500).json({ error: 'Failed to create initiative' });
        }
    });

    // PATCH update an initiative
    router.patch('/:id', async (req, res) => {
        try {
            const { name, description, status, configuration, target_projects } = req.body;

            const updates = {};
            if (name !== undefined) updates.name = name;
            if (description !== undefined) updates.description = description;
            if (status !== undefined) updates.status = status;
            if (configuration !== undefined) updates.configuration = configuration;
            if (target_projects !== undefined) updates.target_projects = target_projects;

            const initiative = await db.updateDashboardInitiative(req.params.id, updates);

            if (!initiative) {
                return res.status(404).json({ error: 'Initiative not found' });
            }

            res.json({ success: true, initiative });
        } catch (error) {
            console.error('[Initiatives API] Error updating initiative:', error);
            res.status(500).json({ error: 'Failed to update initiative' });
        }
    });

    // DELETE an initiative
    router.delete('/:id', async (req, res) => {
        try {
            const success = await db.deleteDashboardInitiative(req.params.id);
            if (!success) {
                return res.status(404).json({ error: 'Initiative not found' });
            }
            res.json({ success: true, message: 'Initiative deleted' });
        } catch (error) {
            console.error('[Initiatives API] Error deleting initiative:', error);
            res.status(500).json({ error: 'Failed to delete initiative' });
        }
    });

    // POST run an initiative (execute across targeted projects)
    router.post('/:id/run', async (req, res) => {
        try {
            const initiative = await db.getDashboardInitiative(req.params.id);
            if (!initiative) {
                return res.status(404).json({ error: 'Initiative not found' });
            }

            // Prevent duplicate runs — reject if already in progress
            if (initiative.status === 'in_progress') {
                return res.status(409).json({
                    error: 'Initiative is already running',
                    initiative_id: req.params.id,
                    supervisor_status: initiative.supervisor_status
                });
            }

            // Update initiative status to in_progress immediately
            await db.updateDashboardInitiative(req.params.id, {
                status: 'in_progress',
                supervisor_status: 'initializing'
            });

            // Import and run the supervisor asynchronously
            const { runDashboardInitiativeSupervisor } = require('../services/dashboard-initiative-supervisor');

            // Get tools if available
            const tools = {};
            try {
                const DependencyTool = require('../tools/DependencyTool');
                tools.dependency = new DependencyTool();
            } catch (e) {
                console.log('[Initiatives API] DependencyTool not available');
            }
            try {
                const GitTool = require('../tools/GitTool');
                tools.git = new GitTool();
            } catch (e) {
                console.log('[Initiatives API] GitTool not available');
            }

            // Run supervisor in background (don't await)
            runDashboardInitiativeSupervisor({
                initiativeId: req.params.id,
                tools
            }).then(result => {
                console.log(`[Initiatives API] Initiative ${req.params.id} completed:`, result.summary);
            }).catch(err => {
                console.error(`[Initiatives API] Initiative ${req.params.id} failed:`, err);
            });

            // Return immediately while processing continues in background
            res.json({
                success: true,
                message: 'Initiative started - processing in background',
                initiative: await db.getDashboardInitiative(req.params.id)
            });
        } catch (error) {
            console.error('[Initiatives API] Error running initiative:', error);
            res.status(500).json({ error: 'Failed to run initiative' });
        }
    });

    return router;
};
