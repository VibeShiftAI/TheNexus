/**
 * LangGraph Routes — Python backend proxy, sync-output, implement, workflow status
 * Extracted from server.js for modularity
 */

const express = require('express');
const path = require('path');

module.exports = function createLangGraphRouter({ db, PROJECT_ROOT, getProjectById, contextSync, runAgent }) {
    const router = express.Router();

    const LANGGRAPH_URL = process.env.PYTHON_BACKEND_URL || 'http://localhost:8000';

    // Helper to proxy requests to LangGraph engine
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

    // GET LangGraph engine health
    router.get('/health', async (req, res) => {
        try {
            const health = await proxyToLangGraph('/health');
            res.json(health);
        } catch (error) {
            res.json({
                status: 'unavailable',
                error: 'LangGraph engine not running. Start it with: cd python && start.bat'
            });
        }
    });

    // GET available node types
    router.get('/node-types', async (req, res) => {
        try {
            const nodeTypes = await proxyToLangGraph('/node-types');
            res.json(nodeTypes);
        } catch (error) {
            res.status(503).json({ error: 'LangGraph engine unavailable' });
        }
    });

    // GET atomic node types (Phase 3 - Visual Builder)
    router.get('/node-types/atomic', async (req, res) => {
        try {
            const nodeTypes = await proxyToLangGraph('/node-types/atomic');
            res.json(nodeTypes);
        } catch (error) {
            res.status(503).json({ error: 'LangGraph engine unavailable' });
        }
    });

    // GET specific atomic node schema (Phase 3 - Visual Builder)
    router.get('/node-types/atomic/:typeId', async (req, res) => {
        try {
            const schema = await proxyToLangGraph(`/node-types/atomic/${req.params.typeId}`);
            res.json(schema);
        } catch (error) {
            if (error.message?.includes('404')) {
                res.status(404).json({ error: `Node type '${req.params.typeId}' not found` });
            } else {
                res.status(503).json({ error: 'LangGraph engine unavailable' });
            }
        }
    });

    // GET workflow templates (with level filtering support)
    router.get('/templates', async (req, res) => {
        try {
            const { level } = req.query;
            const url = level ? `/templates?level=${level}` : '/templates';
            const result = await proxyToLangGraph(url);

            // If the backend didn't filter by level, filter client-side
            if (level && result.templates && Array.isArray(result.templates)) {
                result.templates = result.templates.filter(t =>
                    !t.level || t.level === level
                );
            }

            res.json(result);
        } catch (error) {
            res.status(503).json({ error: 'LangGraph engine unavailable', templates: [] });
        }
    });

    // POST save workflow template
    router.post('/templates', async (req, res) => {
        try {
            const result = await proxyToLangGraph('/templates', {
                method: 'POST',
                body: JSON.stringify(req.body)
            });
            res.json(result);
        } catch (error) {
            console.error('[Templates] Save error:', error.message);
            if (error.message?.includes('409')) {
                res.status(409).json({ detail: 'Template with this name already exists' });
            } else {
                res.status(503).json({ error: 'LangGraph engine unavailable' });
            }
        }
    });

    // DELETE workflow template
    router.delete('/templates/:templateId', async (req, res) => {
        try {
            const result = await proxyToLangGraph(`/templates/${req.params.templateId}`, {
                method: 'DELETE'
            });
            res.json(result);
        } catch (error) {
            console.error('[Templates] Delete error:', error.message);
            if (error.message?.includes('404')) {
                res.status(404).json({ detail: 'Template not found' });
            } else {
                res.status(503).json({ error: 'LangGraph engine unavailable' });
            }
        }
    });

    // POST compile a graph (validate without executing)
    router.post('/compile', async (req, res) => {
        try {
            const result = await proxyToLangGraph('/graph/compile', {
                method: 'POST',
                body: JSON.stringify(req.body)
            });
            res.json(result);
        } catch (error) {
            res.status(503).json({ error: 'LangGraph engine unavailable' });
        }
    });

    // POST run a workflow
    router.post('/run', async (req, res) => {
        try {
            const result = await proxyToLangGraph('/graph/run', {
                method: 'POST',
                body: JSON.stringify(req.body)
            });
            res.json(result);
        } catch (error) {
            res.status(503).json({ error: 'LangGraph engine unavailable' });
        }
    });

    // GET run status
    router.get('/runs/:runId', async (req, res) => {
        try {
            const result = await proxyToLangGraph(`/runs/${req.params.runId}`);
            res.json(result);
        } catch (error) {
            res.status(503).json({ error: 'LangGraph engine unavailable' });
        }
    });

    // GET checkpoints for time-travel
    router.get('/runs/:runId/checkpoints', async (req, res) => {
        try {
            const result = await proxyToLangGraph(`/runs/${req.params.runId}/checkpoints`);
            res.json(result);
        } catch (error) {
            res.status(503).json({ error: 'LangGraph engine unavailable' });
        }
    });

    // POST rewind to checkpoint
    router.post('/runs/:runId/rewind', async (req, res) => {
        try {
            const result = await proxyToLangGraph(`/runs/${req.params.runId}/rewind`, {
                method: 'POST',
                body: JSON.stringify(req.body)
            });
            res.json(result);
        } catch (error) {
            res.status(503).json({ error: 'LangGraph engine unavailable' });
        }
    });

    // POST cancel a run
    router.post('/runs/:runId/cancel', async (req, res) => {
        try {
            const result = await proxyToLangGraph(`/runs/${req.params.runId}/cancel`, {
                method: 'POST'
            });
            res.json(result);
        } catch (error) {
            res.status(503).json({ error: 'LangGraph engine unavailable' });
        }
    });

    // POST callback from Python when a LangGraph workflow run completes
    router.post('/workflow-complete', async (req, res) => {
        const { run_id, workflow_id, project_id, status, error } = req.body;

        console.log(`[LangGraph Complete] Workflow ${workflow_id} run ${run_id}: ${status}`);

        if (!workflow_id) {
            return res.json({ success: false, error: 'Missing workflow_id' });
        }

        try {
            if (status === 'completed') {
                // Get the workflow to access its stages
                const workflow = await db.getProjectWorkflow(workflow_id);
                const completedOutputs = {};
                for (const stage of (workflow?.stages || [])) {
                    completedOutputs[stage.id] = {
                        status: 'complete',
                        completedAt: new Date().toISOString(),
                        mode: 'langgraph'
                    };
                }

                await db.updateProjectWorkflow(workflow_id, {
                    status: 'complete',
                    current_stage: null,
                    outputs: completedOutputs,
                    supervisor_status: 'completed',
                    supervisor_details: {
                        langgraph_run_id: run_id,
                        completedAt: new Date().toISOString(),
                        mode: 'langgraph'
                    }
                });
                console.log(`[LangGraph Complete] Workflow ${workflow_id} marked as complete`);

                // Auto-sync .context/ files to DB
                if (project_id) {
                    try {
                        const project = await getProjectById(PROJECT_ROOT, project_id);
                        if (project) {
                            const contextFiles = contextSync.readAllContextFiles(project.path);
                            if (contextFiles.length > 0) {
                                for (const ctx of contextFiles) {
                                    await db.updateProjectContext(project_id, ctx.type, ctx.content, ctx.status);
                                }
                                console.log(`[LangGraph Complete] Synced ${contextFiles.length} context file(s) to DB for project ${project_id}`);
                            }
                        }
                    } catch (syncErr) {
                        console.error('[LangGraph Complete] Context sync failed (non-fatal):', syncErr.message);
                    }
                }
            } else {
                // Failed — reset to idea so user can retry
                await db.updateProjectWorkflow(workflow_id, {
                    status: 'idea',
                    supervisor_status: 'error',
                    supervisor_details: {
                        langgraph_run_id: run_id,
                        error: error || 'Unknown error',
                        failedAt: new Date().toISOString()
                    }
                });
                console.log(`[LangGraph Complete] Workflow ${workflow_id} failed, reset to idea`);
            }

            res.json({ success: true });
        } catch (err) {
            console.error('[LangGraph Complete] Error:', err);
            res.status(500).json({ error: err.message });
        }
    });

    // POST sync node output from LangGraph to database
    router.post('/sync-output', async (req, res) => {
        const { run_id, node_id, project_id, task_id, feature_id, outputs } = req.body;

        // Prefer task_id, fallback to feature_id for backward compatibility
        const targetTaskId = task_id || feature_id;

        console.log(`[LangGraph Sync] Received outputs from node ${node_id || 'unknown'} for task ${targetTaskId}`);

        if (!targetTaskId || !outputs) {
            return res.json({ success: false, error: 'Missing task_id or outputs' });
        }

        try {
            const updates = {};

            // Research output (supports: research, quick_research)
            const researchContent = outputs.research || outputs.quick_research;
            if (researchContent) {
                updates.research_output = researchContent;
                updates.status = 'researched';
                console.log(`[LangGraph Sync] Setting research_output and status=researched`);
            }

            // Plan output (supports: plan, plan_generator)
            const planContent = outputs.plan || outputs.plan_generator;
            if (planContent) {
                updates.plan_output = planContent;
                updates.status = 'planned';
                console.log(`[LangGraph Sync] Setting plan_output and status=planned`);
            }

            // Implementation node synced
            const implementationContent = outputs.implementation || outputs.coder;
            if (implementationContent) {
                console.log(`[LangGraph Sync] Implementation output received (${typeof implementationContent === 'string' ? implementationContent.length : 'non-string'} chars)`);
                updates.walkthrough = JSON.stringify({
                    content: typeof implementationContent === 'string' ? implementationContent : JSON.stringify(implementationContent),
                    generatedAt: new Date().toISOString()
                });
                updates.status = 'testing';
            }

            // Review output (only if no implementation)
            if (outputs.review && !implementationContent) {
                updates.walkthrough = JSON.stringify({
                    content: typeof outputs.review === 'string' ? outputs.review : JSON.stringify(outputs.review),
                    generatedAt: new Date().toISOString()
                });
                console.log(`[LangGraph Sync] Setting walkthrough from review`);
            }

            // Direct walkthrough output from builder fleet
            if (outputs.walkthrough && !updates.walkthrough) {
                let walkthroughText = outputs.walkthrough;
                if (typeof walkthroughText !== 'string') {
                    if (Array.isArray(walkthroughText)) {
                        walkthroughText = walkthroughText
                            .map(p => (typeof p === 'string' ? p : (p.text || p.content || '')))
                            .join('\n');
                    } else if (typeof walkthroughText === 'object' && walkthroughText !== null) {
                        walkthroughText = walkthroughText.text || walkthroughText.content || JSON.stringify(walkthroughText);
                    }
                }
                // Handle Python repr stringified arrays
                if (typeof walkthroughText === 'string' && walkthroughText.trimStart().startsWith("[{")) {
                    try {
                        const fixed = walkthroughText.replace(/'/g, '"');
                        const parsed = JSON.parse(fixed);
                        if (Array.isArray(parsed)) {
                            walkthroughText = parsed
                                .map(p => (typeof p === 'string' ? p : (p.text || p.content || '')))
                                .join('\n');
                        }
                    } catch (e) {
                        // Not parseable, use as-is
                    }
                }
                updates.walkthrough = JSON.stringify({
                    content: walkthroughText,
                    generatedAt: new Date().toISOString()
                });
                updates.status = 'testing';
                console.log(`[LangGraph Sync] Setting walkthrough from builder (${walkthroughText.length} chars)`);
            }

            // Critic output
            if (outputs.critic) {
                updates.critic_feedback = outputs.critic;
                console.log(`[LangGraph Sync] Setting critic_feedback`);
            }

            // Log files written if coder produced any
            if (outputs.files_written && outputs.files_written.length > 0) {
                console.log(`[LangGraph Sync] Files written:`, outputs.files_written);
            }

            // Update in database if we have updates
            if (Object.keys(updates).length > 0) {
                const updatedTask = await db.updateTask(targetTaskId, updates);
                if (updatedTask) {
                    console.log(`[LangGraph Sync] Updated task ${targetTaskId} in database`);
                } else {
                    console.log(`[LangGraph Sync] Database update returned null (task may not exist in DB)`);
                }
            }

            res.json({ success: true, updates_applied: Object.keys(updates) });

            // Post-response: sync .context/ files to DB only after file-writing nodes
            const FILE_WRITING_NODES = ['write_docs', 'coder', 'implementation', 'doc_file_writer'];
            if (project_id && FILE_WRITING_NODES.includes(node_id)) {
                try {
                    const project = await getProjectById(PROJECT_ROOT, project_id);
                    if (project) {
                        const contextFiles = contextSync.readAllContextFiles(project.path);
                        if (contextFiles.length > 0) {
                            for (const ctx of contextFiles) {
                                await db.updateProjectContext(project_id, ctx.type, ctx.content, ctx.status);
                            }
                            console.log(`[LangGraph Sync] Auto-synced ${contextFiles.length} context file(s) for project ${project_id}`);
                        }
                    }
                } catch (syncErr) {
                    console.error('[LangGraph Sync] Context sync failed (non-fatal):', syncErr.message);
                }
            }
        } catch (error) {
            console.error('[LangGraph Sync] Error:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // POST implement - Called by Python LangGraph to run the Node.js agent with file tools
    router.post('/implement', async (req, res) => {
        const { project_id, feature_id, task_id, plan, feature_title, task_title, feature_description, task_description } = req.body;

        const targetTaskId = task_id || feature_id;
        const targetTitle = task_title || feature_title;
        const targetDescription = task_description || feature_description;

        console.log(`[LangGraph Implement] Received request for project=${project_id}, task=${targetTaskId}`);
        console.log(`[LangGraph Implement] Plan length: ${plan?.length || 0} chars`);

        try {
            const project = await getProjectById(PROJECT_ROOT, project_id);
            if (!project) {
                return res.status(404).json({ success: false, error: 'Project not found' });
            }

            const model = process.env.IMPLEMENTATION_MODEL || 'gemini-2.5-pro';
            const maxTurns = parseInt(process.env.IMPLEMENTATION_MAX_TURNS || '100');

            console.log(`[LangGraph Implement] Using model: ${model}, maxTurns: ${maxTurns}`);

            const implementPrompt = `You are implementing a new task for the project "${project.name}".

## APPROVED IMPLEMENTATION PLAN

${plan}

---

## YOUR TASK

Follow the plan above and implement the changes. Use your tools to:
1. Read existing files to understand the current code
2. Write/modify files as specified in the plan
3. Run commands if needed (e.g., to verify the build)

Be thorough and implement ALL changes from the plan.
`;

            // Update task status to implementing
            await db.updateTask(targetTaskId, {
                status: 'implementing',
                updated_at: new Date().toISOString()
            });

            // Run the agent with full tool access
            const agentResult = await runAgent({
                message: implementPrompt,
                history: [],
                projectRoot: PROJECT_ROOT,
                model: model,
                scopedProject: path.basename(project.path),
                projectId: project_id,
                maxTurns: maxTurns,
                projectPath: project.path,
                taskId: targetTaskId,
                taskTitle: targetTitle,
                onProgress: async (action, details) => {
                    console.log(`[LangGraph Implement] Progress: ${action}`);
                },
                onToolExecuted: async (tool, args, result) => {
                    console.log(`[LangGraph Implement] Tool: ${tool}`);
                }
            });

            console.log(`[LangGraph Implement] Agent completed`);

            const walkthroughContent = agentResult.response || 'Implementation completed.';
            await db.updateTask(targetTaskId, {
                status: 'testing',
                walkthrough: JSON.stringify({
                    content: walkthroughContent,
                    generatedAt: new Date().toISOString()
                }),
                updated_at: new Date().toISOString()
            });

            res.json({
                success: true,
                walkthrough: agentResult.response || 'Implementation completed.',
                files_written: agentResult.filesWritten || []
            });

        } catch (error) {
            console.error('[LangGraph Implement] Error:', error);

            try {
                await db.updateTask(targetTaskId, {
                    status: 'planned',
                    updated_at: new Date().toISOString()
                });
            } catch (e) {
                console.error('[LangGraph Implement] Could not revert status:', e);
            }

            res.status(500).json({ success: false, error: error.message });
        }
    });

    return router;
};
