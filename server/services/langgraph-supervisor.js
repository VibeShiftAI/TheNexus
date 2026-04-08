/**
 * LangGraph Supervisor Service
 * 
 * Bridges the Node.js server with the Python LangGraph backend.
 * Replaces supervisor.js orchestration with LangGraph execution.
 * 
 * Note: Uses native fetch (Node.js 18+)
 */

// Python LangGraph backend URL
const LANGGRAPH_URL = process.env.PYTHON_BACKEND_URL || 'http://localhost:8000';

/**
 * Check if LangGraph engine is available
 */
async function isLangGraphAvailable() {
    try {
        const response = await fetch(`${LANGGRAPH_URL}/health`, { timeout: 2000 });
        const data = await response.json();
        return data.status === 'healthy';
    } catch (error) {
        return false;
    }
}

/**
 * Run a workflow via LangGraph
 * 
 * @param {Object} options
 * @param {string} options.projectPath - Absolute path to the project
 * @param {string} options.projectId - Project identifier
 * @param {string} options.taskId - Task identifier
 * @param {Object} options.taskData - Task data (title, description, etc.)
 * @param {string} options.templateId - Optional template ID to use
 * @param {Object} options.graphConfig - Optional custom graph config
 * @returns {Promise<Object>} Run result with run_id
 */
async function runLangGraphWorkflow(options) {
    const { projectPath, projectId, taskId, taskData, templateId, graphConfig } = options;

    // Build request body
    console.log(`[LangGraph] Building body with taskData:`, JSON.stringify(taskData));
    const body = {
        project_id: projectId,
        task_id: taskId,
        input_data: {
            project_path: projectPath,
            project_id: projectId,
            task_id: taskId,
            task_title: taskData?.title || 'Untitled Task',
            task_description: taskData?.description || ''
        }
    };
    console.log(`[LangGraph] Built input_data:`, JSON.stringify(body.input_data));

    // Check if this is a Nexus Prime workflow
    if (templateId) {
        // Fetch template from Python backend
        const templatesRes = await fetch(`${LANGGRAPH_URL}/templates`);

        if (!templatesRes.ok) {
            const errorText = await templatesRes.text();
            console.error(`[LangGraph] Failed to fetch templates from ${LANGGRAPH_URL}/templates: ${templatesRes.status} ${templatesRes.statusText} - ${errorText}`);
            throw new Error(`Failed to fetch templates: ${templatesRes.statusText}`);
        }

        const templatesData = await templatesRes.json();
        const templates = templatesData.templates || [];

        console.log(`[LangGraph] Fetched ${templates.length} templates. IDs: ${templates.map(t => t.id).join(', ')}`);

        const template = templates.find(t => t.id === templateId);

        if (template) {
            // Check if this is Nexus Prime (AI Agents) workflow
            if (template.workflow_type === 'nexus-prime' || template.name?.includes('Nexus Prime')) {
                console.log(`[LangGraph] Detected Nexus Prime workflow, routing to /graph/nexus`);

                const response = await fetch(`${LANGGRAPH_URL}/graph/nexus`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        project_id: projectId,
                        task_id: taskId,
                        input_data: body.input_data
                    })
                });

                const result = await response.json();
                if (result.success) {
                    console.log(`[LangGraph] Nexus workflow started with run_id: ${result.run_id}`);
                } else {
                    console.error(`[LangGraph] Failed to start Nexus workflow: ${result.detail || result.error}`);
                }
                return result;
            }

            // Standard template handling
            console.log(`[LangGraph] Template "${templateId}" found. ConditionalEdges:`, template.conditionalEdges?.length || 0);
            body.graph_config = {
                nodes: template.nodes,
                edges: template.edges,
                conditionalEdges: template.conditionalEdges || []
            };
            console.log(`[LangGraph] graph_config.conditionalEdges:`, body.graph_config.conditionalEdges);
        } else {
            throw new Error(`Template '${templateId}' not found`);
        }
    } else if (graphConfig) {
        body.graph_config = graphConfig;
    } else {
        // Default to full task pipeline template
        body.graph_config = await getDefaultTaskPipeline();
    }

    // === AI DIVERSITY POLICY ===
    // Check if Coder and Reviewer are using the same provider
    if (body.graph_config && body.graph_config.nodes) {
        const coderParams = body.graph_config.nodes.find(n => n.type === 'coder')?.data?.config;
        const reviewerParams = body.graph_config.nodes.find(n => n.type === 'reviewer')?.data?.config;

        if (coderParams?.model && reviewerParams?.model) {
            const getProvider = (model) => {
                if (model.includes('gpt')) return 'openai';
                if (model.includes('claude')) return 'anthropic';
                if (model.includes('gemini')) return 'google';
                return 'unknown';
            };

            const coderProvider = getProvider(coderParams.model);
            const reviewerProvider = getProvider(reviewerParams.model);

            if (coderProvider !== 'unknown' && coderProvider === reviewerProvider) {
                console.warn(`[Diversity Policy WARNING] Coder and Reviewer are both using ${coderProvider} models. It is recommended to mix providers for better results.`);
                // We could add a header or flag here if we wanted to show it in the UI, 
                // but for now console warning satisfies the "policy" requirement.
            } else {
                console.log(`[Diversity Policy] Coder (${coderProvider}) and Reviewer (${reviewerProvider}) are diverse. Excellent.`);
            }
        }
    }

    console.log(`[LangGraph] Starting workflow for task ${taskId}`);

    const response = await fetch(`${LANGGRAPH_URL}/graph/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });

    const result = await response.json();

    if (result.success) {
        console.log(`[LangGraph] Workflow started with run_id: ${result.run_id}`);
    } else {
        console.error(`[LangGraph] Failed to start workflow: ${result.detail || result.error}`);
    }

    return result;
}

/**
 * Get the status of a running workflow
 */
async function getLangGraphRunStatus(runId) {
    try {
        const response = await fetch(`${LANGGRAPH_URL}/runs/${runId}`);
        return await response.json();
    } catch (error) {
        return { error: error.message };
    }
}

/**
 * Get checkpoints for a run (for time-travel)
 */
async function getLangGraphCheckpoints(runId) {
    try {
        const response = await fetch(`${LANGGRAPH_URL}/runs/${runId}/checkpoints`);
        const data = await response.json();
        return data.checkpoints || [];
    } catch (error) {
        return [];
    }
}

/**
 * Cancel a running workflow
 */
async function cancelLangGraphRun(runId) {
    try {
        const response = await fetch(`${LANGGRAPH_URL}/runs/${runId}/cancel`, {
            method: 'POST'
        });
        return await response.json();
    } catch (error) {
        return { success: false, error: error.message };
    }
}

/**
 * Get the default task pipeline graph config
 * This replicates the standard supervisor.js pattern:
 * Researcher → Planner → Coder → Reviewer
 */
async function getDefaultTaskPipeline() {
    return {
        nodes: [
            {
                id: 'researcher-1',
                type: 'researcher',
                position: { x: 250, y: 50 },
                data: { label: 'Researcher', config: { model: 'gemini-2.5-flash', depth: 'standard' } }
            },
            {
                id: 'planner-1',
                type: 'planner',
                position: { x: 250, y: 200 },
                data: { label: 'Planner', config: { model: 'claude-sonnet-4-20250514' } }
            },
            {
                id: 'coder-1',
                type: 'coder',
                position: { x: 250, y: 350 },
                data: { label: 'Coder', config: { model: 'claude-opus-4-20250514' } }
            },
            {
                id: 'reviewer-1',
                type: 'reviewer',
                position: { x: 250, y: 500 },
                data: { label: 'Reviewer', config: { model: 'claude-sonnet-4-20250514' } }
            }
        ],
        edges: [
            { id: 'e1', source: 'researcher-1', target: 'planner-1' },
            { id: 'e2', source: 'planner-1', target: 'coder-1' },
            { id: 'e3', source: 'coder-1', target: 'reviewer-1' }
        ]
    };
}

/**
 * Get artifacts from a Nexus Prime workflow run
 */
async function getNexusArtifacts(runId) {
    try {
        const response = await fetch(`${LANGGRAPH_URL}/graph/nexus/${runId}/artifacts`);
        return await response.json();
    } catch (error) {
        return { error: error.message };
    }
}

/**
 * Shared proxy helper for LangGraph Python backend requests.
 * Replaces duplicate helpers in routes/langgraph.js and routes/workflows.js.
 */
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

// ─── Callback Handlers (extracted from routes/langgraph.js) ──────────────────

/**
 * Handle workflow-complete callback from Python LangGraph.
 * Updates workflow status in DB and syncs context files.
 */
async function handleWorkflowComplete({ run_id, workflow_id, project_id, status, error }, { db, getProjectById, PROJECT_ROOT, contextSync }) {
    console.log(`[LangGraph Complete] Workflow ${workflow_id} run ${run_id}: ${status}`);

    if (!workflow_id) {
        return { success: false, error: 'Missing workflow_id' };
    }

    if (status === 'completed') {
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

    return { success: true };
}

/**
 * Handle sync-output callback from Python LangGraph.
 * Maps node outputs (research, plan, implementation, review, critic, walkthrough)
 * to task fields and updates the database.
 */
async function handleSyncOutput({ run_id, node_id, project_id, task_id, feature_id, outputs }, { db, getProjectById, PROJECT_ROOT, contextSync }) {
    const targetTaskId = task_id || feature_id;

    console.log(`[LangGraph Sync] Received outputs from node ${node_id || 'unknown'} for task ${targetTaskId}`);

    if (!targetTaskId || !outputs) {
        return { success: false, error: 'Missing task_id or outputs' };
    }

    const updates = {};

    // Research output (supports: research, quick_research)
    const researchContent = outputs.research || outputs.quick_research;
    if (researchContent) {
        updates.research_output = researchContent;
        updates.status = 'todo';
        console.log(`[LangGraph Sync] Setting research_output and status=todo`);
    }

    // Plan output (supports: plan, plan_generator)
    const planContent = outputs.plan || outputs.plan_generator;
    if (planContent) {
        updates.plan_output = planContent;
        updates.status = 'planning';
        console.log(`[LangGraph Sync] Setting plan_output and status=planning`);
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

        // Auto-promote to complete if the critic approved the changes
        let isApproved = false;
        if (typeof outputs.critic === 'object' && outputs.critic !== null) {
            isApproved = outputs.critic.approved === true;
        } else if (typeof outputs.critic === 'string') {
            try {
                const parsed = JSON.parse(outputs.critic);
                isApproved = parsed.approved === true;
            } catch (e) {
                isApproved = outputs.critic.includes('"approved": true') ||
                             outputs.critic.includes('"approved":true');
            }
        }

        if (isApproved) {
            updates.status = 'complete';
            console.log(`[LangGraph Sync] Critic approved -> auto-promoting task status to 'complete'`);
        }
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

    return { success: true, updates_applied: Object.keys(updates) };
}

/**
 * Handle implement callback from Python LangGraph.
 * Runs the Node.js agent with file tools to execute an approved plan.
 */
async function handleImplement({ project_id, feature_id, task_id, plan, feature_title, task_title, feature_description, task_description }, { db, runAgent, getProjectById, PROJECT_ROOT }) {
    const path = require('path');

    const targetTaskId = task_id || feature_id;
    const targetTitle = task_title || feature_title;

    console.log(`[LangGraph Implement] Received request for project=${project_id}, task=${targetTaskId}`);
    console.log(`[LangGraph Implement] Plan length: ${plan?.length || 0} chars`);

    const project = await getProjectById(PROJECT_ROOT, project_id);
    if (!project) {
        throw Object.assign(new Error('Project not found'), { statusCode: 404 });
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

    // Update task status to building
    await db.updateTask(targetTaskId, {
        status: 'building',
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
        onProgress: async (action) => {
            console.log(`[LangGraph Implement] Progress: ${action}`);
        },
        onToolExecuted: async (tool) => {
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

    return {
        success: true,
        walkthrough: agentResult.response || 'Implementation completed.',
        files_written: agentResult.filesWritten || []
    };
}

module.exports = {
    isLangGraphAvailable,
    runLangGraphWorkflow,
    getLangGraphRunStatus,
    getLangGraphCheckpoints,
    cancelLangGraphRun,
    getDefaultTaskPipeline,
    getNexusArtifacts,
    proxyToLangGraph,
    handleWorkflowComplete,
    handleSyncOutput,
    handleImplement,
    LANGGRAPH_URL
};
