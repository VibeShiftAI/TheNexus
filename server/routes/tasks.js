/**
 * Tasks Routes
 * Handles task CRUD, batch creation, reorder, research feedback,
 * approve/reject research/plan, and LangGraph dispatch.
 */
const express = require('express');
const crypto = require('crypto');

function createTasksRouter({ db, PROJECT_ROOT, getProjectById, getAllProjects, callAI, runDeepResearch, validateInitiativeRequest, pushService }) {
    const router = express.Router();

    // ─── List tasks by project_id (Praxis compatibility) ────────────────
    // Praxis calls GET /api/tasks?project_id=xxx — this was project-scoped
    // (GET /api/projects/:id/tasks) after the refactor but Praxis still
    // expects the flat endpoint.
    router.get('/', async (req, res) => {
        const { project_id } = req.query;
        if (!project_id) return res.status(400).json({ error: 'project_id query parameter is required' });
        try {
            const tasks = await db.getTasks(project_id);
            res.json({ tasks: tasks.map(t => ({ ...t, title: t.name, createdAt: t.created_at, updatedAt: t.updated_at })) });
        } catch (err) {
            res.status(500).json({ error: 'Database error' });
        }
    });

    // ─── Get single task by ID (Praxis compatibility) ───────────────────
    router.get('/:taskId', async (req, res) => {
        try {
            const task = await db.getTask(req.params.taskId);
            if (!task) return res.status(404).json({ error: 'Task not found' });
            res.json({ ...task, title: task.name, createdAt: task.created_at, updatedAt: task.updated_at });
        } catch (err) {
            res.status(500).json({ error: 'Database error' });
        }
    });

    // ─── Create Task (top-level) ─────────────────────────────────────────
    router.post('/', async (req, res) => {
        const { project_id, title, status, priority, description, templateId } = req.body;
        if (!project_id || !title) return res.status(400).json({ error: 'project_id and title are required' });
        try {
            const result = await db.createTask({
                project_id, name: title, status: status || 'planning',
                priority: priority === 'high' ? 2 : 1, description: description || '',
                langgraph_template: templateId || null
            });
            res.status(201).json(result);
        } catch (error) {
            res.status(500).json({ error: 'Failed to create task: ' + error.message });
        }
    });

    // ─── PATCH update task by ID (LangGraph workflow sync) ───────────────
    router.patch('/:taskId', async (req, res) => {
        const { taskId } = req.params;
        const { status, research_output, plan_output, walkthrough, status_message } = req.body;
        try {
            const existing = await db.getTask(taskId);
            if (!existing) return res.status(404).json({ error: 'Task not found' });
            const updates = { updated_at: new Date().toISOString() };
            if (status !== undefined) updates.status = status;
            if (research_output !== undefined) updates.research_output = research_output;
            if (plan_output !== undefined) updates.plan_output = plan_output;
            if (walkthrough !== undefined) updates.walkthrough = walkthrough;
            if (status_message !== undefined) {
                updates.metadata = { ...(existing.metadata || {}), status_message };
            }
            console.log(`[Task Sync] Updating task ${taskId}: ${Object.keys(updates).filter(k => k !== 'updated_at').join(', ')}`);
            const updated = await db.updateTask(taskId, updates);
            res.json({ success: true, task: updated });
        } catch (err) {
            console.error('[Task Sync] Error updating task:', err);
            res.status(500).json({ error: 'Database error' });
        }
    });

    // ─── Batch create tasks ──────────────────────────────────────────────
    router.post('/batch', async (req, res) => {
        const { project_id, tasks } = req.body;
        if (!project_id || !tasks || !Array.isArray(tasks)) return res.status(400).json({ error: 'project_id and tasks array are required' });
        if (tasks.length > 50) return res.status(400).json({ error: `Batch too large (${tasks.length}). Max 50 tasks per batch.` });
        try {
            const project = await db.getProject(project_id);
            if (!project) return res.status(404).json({ error: `Project '${project_id}' not found.` });
            const stableIdToRealId = new Map();
            const preparedTasks = tasks.map(task => {
                const realId = crypto.randomUUID();
                if (task.stable_id) stableIdToRealId.set(task.stable_id, realId);
                return { ...task, id: realId, project_id };
            });
            for (const task of preparedTasks) {
                if (task.dependencies?.length > 0) {
                    task.dependencies = task.dependencies.map(depId => stableIdToRealId.get(depId) || depId);
                }
                delete task.stable_id;
            }
            const created = await db.batchCreateTasks(preparedTasks);
            res.status(201).json({
                success: true, project: project.name, created_count: created.length,
                tasks: created.map(t => ({ id: t.id, name: t.name, status: t.status, sort_order: t.sort_order, has_payload: !!t.antigravity_payload, dependencies: t.dependencies || [] }))
            });
        } catch (error) {
            res.status(500).json({ error: 'Failed to batch-create tasks: ' + error.message });
        }
    });

    // ─── Reorder tasks ───────────────────────────────────────────────────
    router.patch('/reorder', async (req, res) => {
        const { ordering } = req.body;
        if (!ordering || !Array.isArray(ordering)) return res.status(400).json({ error: 'ordering array is required' });
        try {
            const success = await db.reorderTasks(ordering);
            if (!success) return res.status(500).json({ error: 'Failed to reorder tasks.' });
            res.json({ success: true, reordered_count: ordering.length });
        } catch (error) {
            res.status(500).json({ error: 'Failed to reorder tasks: ' + error.message });
        }
    });

    // ─── Project-scoped task routes ──────────────────────────────────────

    // GET tasks for a project
    router.get('/:id/tasks', async (req, res) => {
        const project = await getProjectById(PROJECT_ROOT, req.params.id);
        if (!project) return res.status(404).json({ error: 'Project not found' });
        try {
            const tasks = await db.getTasks(project.id);
            res.json({ tasks: tasks.map(t => ({ ...t, title: t.name, createdAt: t.created_at, updatedAt: t.updated_at })) });
        } catch (err) {
            res.status(500).json({ error: 'Database error' });
        }
    });

    // POST add task to project
    router.post('/:id/tasks', async (req, res) => {
        const { title, description, templateId } = req.body;
        if (!title?.trim()) return res.status(400).json({ error: 'Task title is required' });

        let validation = {};
        try {
            validation = await validateInitiativeRequest({ title, description });
        } catch (valErr) {
            validation = { error: valErr.message };
        }

        const project = await getProjectById(PROJECT_ROOT, req.params.id);
        if (!project) return res.status(404).json({ error: 'Project not found' });
        try {
            const created = await db.createTask({
                project_id: project.id, name: title.trim(), description: description?.trim() || '',
                status: 'idea', priority: 0, initiative_validation: validation, source: 'user',
                langgraph_template: templateId || null, metadata: { classifiedAt: new Date().toISOString() }
            });
            res.json({ success: true, task: { ...created, title: created.name, createdAt: created.created_at } });
        } catch (error) {
            res.status(500).json({ error: 'Failed to create task' });
        }
    });

    // DELETE task
    router.delete('/:id/tasks/:taskId', async (req, res) => {
        const project = await getProjectById(PROJECT_ROOT, req.params.id);
        if (!project) return res.status(404).json({ error: 'Project not found' });
        try {
            const success = await db.deleteTask(req.params.taskId);
            if (!success) return res.status(404).json({ error: 'Task not found or failed to delete' });
            res.json({ success: true, message: 'Task deleted' });
        } catch (err) {
            res.status(500).json({ error: 'Database error' });
        }
    });

    // PATCH update task (project-scoped)
    router.patch('/:id/tasks/:taskId', async (req, res) => {
        const { taskId } = req.params;
        const { title, description, status } = req.body;
        const project = await getProjectById(PROJECT_ROOT, req.params.id);
        if (!project) return res.status(404).json({ error: 'Project not found' });
        try {
            const existing = await db.getTask(taskId);
            if (!existing) return res.status(404).json({ error: 'Task not found' });
            const updates = { updated_at: new Date().toISOString() };
            if (title !== undefined) updates.name = title.trim();
            if (description !== undefined) updates.description = description.trim();
            if (status !== undefined) {
                updates.status = status;
                if (status === 'idea') {
                    Object.assign(updates, {
                        research_output: null, plan_output: null, walkthrough: null,
                        research_interaction_id: null, supervisor_status: null, task_ledger: [],
                        metadata: {}, initiative_validation: null, research_metadata: null, plan_metadata: null,
                        langgraph_run_id: null, langgraph_status: null, langgraph_template: null, langgraph_started_at: null
                    });
                }
            }
            const oldStatus = existing.status;
            const updated = await db.updateTask(taskId, updates);
            if (status && status !== oldStatus) {
                const notifyStatuses = ['completed', 'failed', 'blocked', 'awaiting_approval', 'suspended'];
                if (notifyStatuses.includes(status)) {
                    pushService.notifyTaskUpdate(updated, oldStatus).catch(err => console.warn('[Push] Task notification failed:', err.message));
                }
            }
            res.json({ success: true, task: { ...updated, title: updated.name, createdAt: updated.created_at, updatedAt: updated.updated_at } });
        } catch (err) {
            res.status(500).json({ error: 'Database error' });
        }
    });

    // ─── Research feedback ───────────────────────────────────────────────
    router.post('/:id/tasks/:taskId/research-feedback', async (req, res) => {
        const project = await getProjectById(PROJECT_ROOT, req.params.id);
        if (!project) return res.status(404).json({ error: 'Project not found' });
        const task = await db.getTask(req.params.taskId);
        if (!task) return res.status(404).json({ error: 'Task not found' });
        const newFeedback = { id: crypto.randomUUID(), content: req.body.feedback, createdAt: new Date().toISOString(), action: 'comment', stage: 'research' };
        const updatedFeedback = [...(task.feedback || []), newFeedback];
        await db.updateTask(req.params.taskId, { feedback: updatedFeedback, updated_at: new Date().toISOString() });
        res.json({ success: true, task: { ...task, feedback: updatedFeedback } });
    });

    // ─── Reject research ─────────────────────────────────────────────────
    router.post('/:id/tasks/:taskId/reject-research', async (req, res) => {
        const project = await getProjectById(PROJECT_ROOT, req.params.id);
        if (!project) return res.status(404).json({ error: 'Project not found' });
        const task = await db.getTask(req.params.taskId);
        if (!task) return res.status(404).json({ error: 'Task not found' });
        let updatedFeedback = task.feedback || [];
        if (req.body.feedback) {
            updatedFeedback.push({ id: crypto.randomUUID(), content: req.body.feedback, createdAt: new Date().toISOString(), action: 'reject', stage: 'research' });
        }
        await db.updateTask(req.params.taskId, { status: 'rejected', updated_at: new Date().toISOString(), feedback: updatedFeedback, research_metadata: { ...task.research_metadata, rejectedAt: new Date().toISOString() } });
        res.json({ success: true, task: { ...task, status: 'rejected', feedback: updatedFeedback } });
    });

    // ─── Approve research ────────────────────────────────────────────────
    router.post('/:id/tasks/:taskId/approve-research', async (req, res) => {
        const project = await getProjectById(PROJECT_ROOT, req.params.id);
        if (!project) return res.status(404).json({ error: 'Project not found' });
        const task = await db.getTask(req.params.taskId);
        if (!task) return res.status(404).json({ error: 'Task not found' });
        let updatedFeedback = task.feedback || [];
        const { feedback } = req.body || {};
        if (feedback) updatedFeedback.push({ id: crypto.randomUUID(), content: feedback, createdAt: new Date().toISOString(), action: 'approve', stage: 'research' });
        const runId = task.langgraph_run_id;
        if (runId) {
            const langGraphUrl = process.env.LANGGRAPH_URL || 'http://localhost:8000';
            try {
                const resumeResponse = await fetch(`${langGraphUrl}/graph/nexus/${runId}/resume`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ approval_action: 'approve', feedback: feedback || null }) });
                if (!resumeResponse.ok) { const errorText = await resumeResponse.text(); return res.status(500).json({ error: `Failed to resume workflow: ${errorText}` }); }
                const resumeResult = await resumeResponse.json();
                await db.updateTask(req.params.taskId, { updated_at: new Date().toISOString(), feedback: updatedFeedback, research_metadata: { ...task.research_metadata, approvedAt: new Date().toISOString() } });
                return res.json({ success: true, message: 'Research approved - LangGraph workflow resuming', runId, resumeStatus: resumeResult.status, task: { ...task, feedback: updatedFeedback } });
            } catch (fetchError) {
                return res.status(500).json({ error: `Failed to resume workflow: ${fetchError.message}` });
            }
        }
        return res.status(400).json({ error: 'This task is not part of an active workflow. Please restart the task using a Workflow Template.' });
    });

    // ─── Approve plan ────────────────────────────────────────────────────
    router.post('/:id/tasks/:taskId/approve-plan', async (req, res) => {
        const project = await getProjectById(PROJECT_ROOT, req.params.id);
        if (!project) return res.status(404).json({ error: 'Project not found' });
        try {
            const task = await db.getTask(req.params.taskId);
            if (!task) return res.status(404).json({ error: 'Task not found' });
            const planMeta = task.plan_metadata || {};
            const { feedback } = req.body || {};
            if (feedback?.trim()) {
                planMeta.feedback = [...(planMeta.feedback || []), { id: `fb-${Date.now()}`, content: feedback.trim(), createdAt: new Date().toISOString(), action: 'approve' }];
            }
            const runId = task.langgraph_run_id;
            if (runId) {
                const langGraphUrl = process.env.LANGGRAPH_URL || 'http://localhost:8000';
                const resumeResponse = await fetch(`${langGraphUrl}/graph/nexus/${runId}/resume`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ approval_action: 'approve', feedback: feedback || null }) });
                if (!resumeResponse.ok) { const errorText = await resumeResponse.text(); return res.status(500).json({ error: `Failed to resume workflow: ${errorText}` }); }
                const resumeResult = await resumeResponse.json();
                await db.updateTask(req.params.taskId, { status: 'building', updated_at: new Date().toISOString(), plan_metadata: { ...planMeta, approvedAt: new Date().toISOString() } });
                const updated = await db.getTask(req.params.taskId);
                return res.json({ success: true, message: 'Plan approved - LangGraph workflow resuming to builder phase', runId, resumeStatus: resumeResult.status, task: { ...updated, title: updated.name, createdAt: updated.created_at } });
            }
            return res.status(400).json({ error: 'This task is not part of an active workflow. Please restart the task using a Workflow Template.' });
        } catch (err) {
            res.status(500).json({ error: 'Database error: ' + err.message });
        }
    });

    // ─── LangGraph dispatch ──────────────────────────────────────────────
    router.post('/:id/tasks/:taskId/langgraph/run', async (req, res) => {
        const { id: projectId, taskId } = req.params;
        const { templateId, graphConfig } = req.body;
        try {
            const project = await getProjectById(PROJECT_ROOT, projectId);
            if (!project) return res.status(404).json({ error: 'Project not found' });
            const task = await db.getTask(taskId);
            if (!task) return res.status(404).json({ error: 'Task not found' });
            const lgSupervisor = require('../services/langgraph-supervisor');
            const result = await lgSupervisor.runLangGraphWorkflow({
                projectPath: project.path, projectId, taskId,
                taskData: { title: task.name || task.title || 'Untitled', description: task.description || '' },
                templateId, graphConfig
            });
            if (result.success && result.run_id) {
                const newStatus = task.status === 'idea' ? 'todo' : task.status;
                await db.updateTask(taskId, { langgraph_run_id: result.run_id, langgraph_status: 'running', langgraph_template: templateId || null, langgraph_started_at: new Date().toISOString(), status: newStatus });
            }
            res.json(result);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // GET LangGraph status
    router.get('/:id/tasks/:taskId/langgraph/status', async (req, res) => {
        const { runId } = req.query;
        if (!runId) return res.status(400).json({ error: 'runId query parameter required' });
        try {
            const lgSupervisor = require('../services/langgraph-supervisor');
            res.json(await lgSupervisor.getLangGraphRunStatus(runId));
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // ─── Execution Timeline ──────────────────────────────────────────────
    router.get('/:id/features/:featureId/timeline', async (req, res) => {
        try { res.json({ timeline: await db.getExecutionTimeline(req.params.featureId) || [] }); }
        catch (error) { res.status(500).json({ error: 'Failed to get timeline' }); }
    });

    router.post('/:id/features/:featureId/timeline', async (req, res) => {
        try {
            const { stage, action, node_id, details, next_stage } = req.body;
            const step = await db.addExecutionStep(req.params.featureId, { stage: stage || 'unknown', action: action || 'step', node_id, details, next_stage });
            res.json({ success: true, step });
        } catch (error) { res.status(500).json({ error: 'Failed to add timeline step' }); }
    });

    // ─── Inline Comments ─────────────────────────────────────────────────
    router.get('/:id/features/:featureId/comments', async (req, res) => {
        try { res.json({ comments: await db.getInlineComments(req.params.featureId, req.query.stage || null) || [] }); }
        catch (error) { res.status(500).json({ error: 'Failed to get comments' }); }
    });

    router.post('/:id/features/:featureId/comments', async (req, res) => {
        try {
            const { stage, section_id, content, line_start, line_end, author } = req.body;
            if (!stage || !content) return res.status(400).json({ error: 'stage and content are required' });
            const comment = await db.addInlineComment(req.params.featureId, { stage, section_id: section_id || null, content, line_start: line_start || null, line_end: line_end || null, author: author || 'user' });
            res.json({ success: true, comment });
        } catch (error) { res.status(500).json({ error: 'Failed to add comment' }); }
    });

    router.patch('/:id/features/:featureId/comments/:commentId', async (req, res) => {
        try {
            const comment = await db.updateInlineComment(req.params.commentId, { resolved: req.body.resolved });
            if (!comment) return res.status(404).json({ error: 'Comment not found' });
            res.json({ success: true, comment });
        } catch (error) { res.status(500).json({ error: 'Failed to update comment' }); }
    });

    // ─── Resume suspended task ───────────────────────────────────────────
    router.post('/:id/tasks/:taskId/resume', async (req, res) => {
        const { taskId } = req.params;
        const { humanInput, action } = req.body;
        // action: "resume" (default) | "cancel"
        try {
            const task = await db.getTask(taskId);
            if (!task) return res.status(404).json({ error: 'Task not found' });
            if (task.status !== 'suspended') {
                return res.status(400).json({ error: `Task is not suspended (current status: ${task.status})` });
            }

            if (action === 'cancel') {
                await db.updateTask(taskId, {
                    status: 'cancelled',
                    suspended_at: null,
                    suspended_reason: null,
                    suspended_context: null,
                    resume_action: null,
                    updated_at: new Date().toISOString(),
                });
                return res.json({ success: true, action: 'cancelled' });
            }

            // Build resume instructions from human input + original context
            const context = task.suspended_context || {};
            const resumeAction = task.resume_action || {};
            const resumeInstructions =
                `[RESUMED FROM SUSPENSION]\n` +
                `Previous context: ${context.partialResult || 'none'}\n` +
                `Question asked: ${context.question || 'none'}\n` +
                `Human answer: ${humanInput || '(no input provided)'}\n\n` +
                `Continue the task with this guidance.`;

            // Clear suspension metadata and set back to in-progress
            await db.updateTask(taskId, {
                status: 'in-progress',
                suspended_at: null,
                suspended_reason: null,
                suspended_context: null,
                resume_action: null,
                updated_at: new Date().toISOString(),
            });

            // Re-dispatch to Praxis if the resume action says to
            if (resumeAction.type === 'redispatch' || !resumeAction.type) {
                try {
                    await fetch('http://127.0.0.1:54322/resume-task', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            nexusTaskId: taskId,
                            workspace: resumeAction.workspace || context.workspace,
                            instructions: resumeInstructions,
                            modelOverride: resumeAction.modelOverride,
                        }),
                    });
                } catch (fetchErr) {
                    console.warn('[Tasks] Resume dispatch to Praxis failed:', fetchErr.message);
                    // Task is already set to in-progress — Praxis just won't auto-dispatch
                }
            }

            const updated = await db.getTask(taskId);
            res.json({
                success: true,
                action: 'resumed',
                task: { ...updated, title: updated.name, createdAt: updated.created_at, updatedAt: updated.updated_at },
            });
        } catch (err) {
            console.error('[Tasks] Error resuming task:', err);
            res.status(500).json({ error: 'Failed to resume task: ' + err.message });
        }
    });

    return router;
}

module.exports = createTasksRouter;
