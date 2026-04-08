/**
 * Project Workflows Routes
 * CRUD, run, advance, and check for project-level workflows.
 */
const express = require('express');

function createProjectWorkflowsRouter({ db, getProjectById, PROJECT_ROOT }) {
    const router = express.Router();

    // GET all workflows for project
    router.get('/:id/workflows', async (req, res) => {
        try {
            const project = await getProjectById(PROJECT_ROOT, req.params.id);
            if (!project) return res.status(404).json({ error: 'Project not found' });
            res.json({ workflows: await db.getProjectWorkflows(project.id, req.query.status || null) });
        } catch (error) {
            res.status(500).json({ error: 'Failed to fetch project workflows' });
        }
    });

    // GET single workflow
    router.get('/:id/workflows/:workflowId', async (req, res) => {
        try {
            const workflow = await db.getProjectWorkflow(req.params.workflowId);
            if (!workflow) return res.status(404).json({ error: 'Workflow not found' });
            res.json({ workflow });
        } catch (error) {
            res.status(500).json({ error: 'Failed to fetch workflow' });
        }
    });

    // POST create workflow
    router.post('/:id/workflows', async (req, res) => {
        try {
            const project = await getProjectById(PROJECT_ROOT, req.params.id);
            if (!project) return res.status(404).json({ error: 'Project not found' });
            const { name, description, workflow_type, template_id, configuration, parent_initiative_id } = req.body;
            if (!name || !workflow_type) return res.status(400).json({ error: 'Name and workflow_type are required' });

            let stages = [];
            if (template_id) {
                const fs = require('fs');
                const path = require('path');
                const templatePath = path.resolve(__dirname, '../../config/templates/workflows', `${template_id}.json`);
                if (fs.existsSync(templatePath)) {
                    stages = JSON.parse(fs.readFileSync(templatePath, 'utf8')).stages || [];
                } else {
                    return res.status(400).json({ error: `Template not found: ${template_id}` });
                }
            }

            const workflow = await db.createProjectWorkflow({
                project_id: project.id, name, description: description || '', workflow_type,
                template_id: null, stages, configuration: { ...(configuration || {}), template_name: template_id || null },
                parent_initiative_id: parent_initiative_id || null, status: 'idea',
                current_stage: stages.length > 0 ? stages[0].id : null
            });
            if (!workflow) return res.status(500).json({ error: 'Failed to create workflow' });
            res.json({ success: true, workflow });
        } catch (error) {
            res.status(500).json({ error: 'Failed to create workflow' });
        }
    });

    // PATCH update workflow
    router.patch('/:id/workflows/:workflowId', async (req, res) => {
        try {
            const { name, description, status, current_stage, stages, configuration, outputs } = req.body;
            const updates = {};
            if (name !== undefined) updates.name = name;
            if (description !== undefined) updates.description = description;
            if (status !== undefined) updates.status = status;
            if (current_stage !== undefined) updates.current_stage = current_stage;
            if (stages !== undefined) updates.stages = stages;
            if (configuration !== undefined) updates.configuration = configuration;
            if (outputs !== undefined) updates.outputs = outputs;
            const workflow = await db.updateProjectWorkflow(req.params.workflowId, updates);
            if (!workflow) return res.status(404).json({ error: 'Workflow not found' });
            res.json({ success: true, workflow });
        } catch (error) {
            res.status(500).json({ error: 'Failed to update workflow' });
        }
    });

    // DELETE workflow
    router.delete('/:id/workflows/:workflowId', async (req, res) => {
        try {
            const success = await db.deleteProjectWorkflow(req.params.workflowId);
            if (!success) return res.status(404).json({ error: 'Workflow not found' });
            res.json({ success: true, message: 'Workflow deleted' });
        } catch (error) {
            res.status(500).json({ error: 'Failed to delete workflow' });
        }
    });

    // POST run workflow
    router.post('/:id/workflows/:workflowId/run', async (req, res) => {
        try {
            const workflow = await db.getProjectWorkflow(req.params.workflowId);
            if (!workflow) return res.status(404).json({ error: 'Workflow not found' });
            const { context } = req.body;
            const { runProjectWorkflowSupervisor } = require('../services/project-workflow-supervisor');
            const result = await runProjectWorkflowSupervisor({ workflowId: req.params.workflowId, action: 'start', context: context || workflow.configuration?.goal || workflow.description || '' });
            if (!result.success) return res.status(500).json({ error: result.error });
            const updatedWorkflow = await db.getProjectWorkflow(req.params.workflowId);
            res.json({ success: true, message: result.message, workflow: updatedWorkflow, featuresCreated: result.features?.length || 0 });
        } catch (error) {
            res.status(500).json({ error: 'Failed to run workflow' });
        }
    });

    // GET workflow progress
    router.get('/:id/workflows/:workflowId/progress', async (req, res) => {
        try {
            const { getWorkflowProgress } = require('../services/project-workflow-supervisor');
            const progress = await getWorkflowProgress(req.params.workflowId);
            if (!progress) return res.status(404).json({ error: 'Workflow not found' });
            res.json(progress);
        } catch (error) {
            res.status(500).json({ error: 'Failed to get workflow progress' });
        }
    });

    // POST advance workflow
    router.post('/:id/workflows/:workflowId/advance', async (req, res) => {
        try {
            const workflow = await db.getProjectWorkflow(req.params.workflowId);
            if (!workflow) return res.status(404).json({ error: 'Workflow not found' });
            const { runProjectWorkflowSupervisor } = require('../services/project-workflow-supervisor');
            const result = await runProjectWorkflowSupervisor({ workflowId: req.params.workflowId, action: 'advance' });
            if (!result.success) return res.status(500).json({ error: result.error });
            const updatedWorkflow = await db.getProjectWorkflow(req.params.workflowId);
            res.json({ success: true, message: result.message, workflow: updatedWorkflow, workflowComplete: result.workflowComplete || false, featuresCreated: result.features?.length || 0 });
        } catch (error) {
            res.status(500).json({ error: 'Failed to advance workflow' });
        }
    });

    // POST check workflow stage
    router.post('/:id/workflows/:workflowId/check', async (req, res) => {
        try {
            const { runProjectWorkflowSupervisor } = require('../services/project-workflow-supervisor');
            const result = await runProjectWorkflowSupervisor({ workflowId: req.params.workflowId, action: 'check' });
            if (!result.success) return res.status(500).json({ error: result.error });
            res.json(result);
        } catch (error) {
            res.status(500).json({ error: 'Failed to check workflow' });
        }
    });

    return router;
}

module.exports = createProjectWorkflowsRouter;
