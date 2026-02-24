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

module.exports = {
    isLangGraphAvailable,
    runLangGraphWorkflow,
    getLangGraphRunStatus,
    getLangGraphCheckpoints,
    cancelLangGraphRun,
    getDefaultTaskPipeline,
    getNexusArtifacts,
    LANGGRAPH_URL
};

