/**
 * Dashboard Initiative Supervisor
 * 
 * Orchestrates cross-project initiatives (Security Sweeps, Dependency Audits, etc.)
 * by iterating over target projects and executing the appropriate action.
 * 
 * This is the dashboard-level equivalent of project-workflow-supervisor.js,
 * but operates across multiple projects rather than within a single project.
 * 
 * Supported Initiative Types:
 * - security-sweep: Scan for vulnerabilities, auto-create fix features
 * - dependency-audit: Check for outdated dependencies across projects
 * - documentation: Trigger documentation generation workflows
 * - custom: User-defined actions (future)
 */

const fs = require('fs');
const path = require('path');
const db = require('../../db');

// Initiative status values
const INITIATIVE_STATUS = {
    IDLE: 'idle',
    INITIALIZING: 'initializing',
    RUNNING: 'running',
    COMPLETED: 'completed',
    FAILED: 'failed',
    ERROR: 'error'
};

// Project-level progress status
const PROJECT_STATUS = {
    PENDING: 'pending',
    IN_PROGRESS: 'in_progress',
    COMPLETE: 'complete',
    SKIPPED: 'skipped',
    FAILED: 'failed'
};

/**
 * Run a dashboard initiative across all targeted projects
 * 
 * @param {Object} options
 * @param {string} options.initiativeId - The initiative ID
 * @param {Object} options.tools - Optional tools object (dependency, git, codeAnalysis)
 * @returns {Promise<Object>} Result with success status and details
 */
async function runDashboardInitiativeSupervisor(options) {
    const { initiativeId, tools = {} } = options;

    console.log(`[InitiativeSupervisor] Starting initiative ${initiativeId}`);

    // Get the initiative
    const initiative = await db.getDashboardInitiative(initiativeId);
    if (!initiative) {
        return { success: false, error: 'Initiative not found' };
    }

    const { workflow_type, target_projects, configuration } = initiative;

    // Update status to running
    await updateInitiativeStatus(initiativeId, INITIATIVE_STATUS.INITIALIZING);

    try {
        // Validate we have target projects
        if (!target_projects || target_projects.length === 0) {
            // If no specific projects, get all projects
            const allProjects = await db.getProjects();
            initiative.target_projects = allProjects.map(p => p.id);
        }

        const projectIds = initiative.target_projects;
        console.log(`[InitiativeSupervisor] Processing ${projectIds.length} projects for ${workflow_type}`);

        // Update to running status
        await updateInitiativeStatus(initiativeId, INITIATIVE_STATUS.RUNNING, {
            totalProjects: projectIds.length,
            startedAt: new Date().toISOString()
        });

        // Process each project
        const results = [];
        let completedCount = 0;
        let failedCount = 0;

        for (const projectId of projectIds) {
            // Mark project as in progress
            await db.updateInitiativeProjectStatus(initiativeId, projectId, {
                status: PROJECT_STATUS.IN_PROGRESS,
                started_at: new Date().toISOString()
            });

            try {
                // Execute the initiative type handler
                const result = await executeInitiativeForProject({
                    initiativeId,
                    projectId,
                    workflowType: workflow_type,
                    configuration,
                    tools
                });

                results.push({ projectId, ...result });

                // Update project status
                await db.updateInitiativeProjectStatus(initiativeId, projectId, {
                    status: result.success ? PROJECT_STATUS.COMPLETE : PROJECT_STATUS.FAILED,
                    result: result.data || {},
                    error_message: result.error || null,
                    completed_at: new Date().toISOString()
                });

                if (result.success) {
                    completedCount++;
                } else {
                    failedCount++;
                }

                // Update initiative progress
                const progress = {};
                for (const pid of projectIds) {
                    const projResult = results.find(r => r.projectId === pid);
                    if (projResult) {
                        progress[pid] = {
                            status: projResult.success ? 'complete' : 'failed',
                            summary: projResult.summary || ''
                        };
                    }
                }
                await db.updateDashboardInitiative(initiativeId, { progress });

            } catch (projectError) {
                console.error(`[InitiativeSupervisor] Error processing project ${projectId}:`, projectError);

                await db.updateInitiativeProjectStatus(initiativeId, projectId, {
                    status: PROJECT_STATUS.FAILED,
                    error_message: projectError.message,
                    completed_at: new Date().toISOString()
                });

                failedCount++;
                results.push({
                    projectId,
                    success: false,
                    error: projectError.message
                });
            }
        }

        // Mark initiative as complete
        const finalStatus = failedCount === projectIds.length
            ? 'cancelled'
            : 'complete';

        await db.updateDashboardInitiative(initiativeId, {
            status: finalStatus,
            supervisor_status: INITIATIVE_STATUS.COMPLETED,
            supervisor_details: {
                completedAt: new Date().toISOString(),
                totalProjects: projectIds.length,
                completedProjects: completedCount,
                failedProjects: failedCount
            }
        });

        console.log(`[InitiativeSupervisor] Initiative ${initiativeId} completed: ${completedCount}/${projectIds.length} projects`);

        return {
            success: true,
            message: `Initiative completed: ${completedCount}/${projectIds.length} projects processed`,
            results,
            summary: {
                total: projectIds.length,
                completed: completedCount,
                failed: failedCount
            }
        };

    } catch (error) {
        console.error(`[InitiativeSupervisor] Initiative ${initiativeId} failed:`, error);

        await updateInitiativeStatus(initiativeId, INITIATIVE_STATUS.ERROR, {
            error: error.message,
            failedAt: new Date().toISOString()
        });

        await db.updateDashboardInitiative(initiativeId, {
            status: 'paused',
            supervisor_status: INITIATIVE_STATUS.ERROR,
            supervisor_details: {
                error: error.message,
                failedAt: new Date().toISOString()
            }
        });

        return { success: false, error: error.message };
    }
}

/**
 * Update initiative supervisor status
 */
async function updateInitiativeStatus(initiativeId, status, details = {}) {
    await db.updateDashboardInitiative(initiativeId, {
        supervisor_status: status,
        supervisor_details: details
    });
}

/**
 * Execute an initiative for a single project
 * 
 * REQUIRES a workflow template matching the workflow_type.
 * No fallbacks - if template is not found or Python backend is unavailable,
 * execution fails with a clear error message.
 */
async function executeInitiativeForProject(options) {
    const { initiativeId, projectId, workflowType, configuration } = options;

    // Get project details
    const project = await db.getProject(projectId);
    if (!project) {
        throw new Error(`Project not found: ${projectId}`);
    }

    console.log(`[InitiativeSupervisor] Processing ${workflowType} for project: ${project.name}`);

    // Execute using workflow template - no fallbacks
    const result = await executeWithWorkflowTemplate({
        workflowType,
        project,
        configuration,
        initiativeId
    });

    // Create actionable tasks from template stages — but ONLY if the workflow
    // was a dashboard-level template. Project-level LangGraph templates (like
    // documentation.json) create their own tasks via DocumentationTaskCreatorNode,
    // so we skip to avoid duplicates.
    if (result.success && result.data?.templateLevel !== 'project') {
        try {
            const taskIds = await createInitiativeTasks({
                initiativeId,
                projectId,
                workflowType,
                configuration,
                projectName: project.name
            });
            result.data = { ...result.data, tasksCreated: taskIds.length, taskIds };
            result.summary = `${result.summary} — ${taskIds.length} tasks created`;
            console.log(`[InitiativeSupervisor] Created ${taskIds.length} tasks for project: ${project.name}`);
        } catch (taskErr) {
            console.warn(`[InitiativeSupervisor] Task creation failed (non-blocking): ${taskErr.message}`);
            // Don't fail the overall initiative — the workflow was dispatched successfully
        }
    }

    return result;
}

/**
 * Execute a workflow template via Python LangGraph engine
 * 
 * THROWS errors if:
 * - Python backend is unavailable
 * - No matching template found for workflow type
 * - Workflow execution fails
 */
async function executeWithWorkflowTemplate(options) {
    const { workflowType, project, configuration, initiativeId } = options;

    const langGraphUrl = process.env.LANGGRAPH_URL || 'http://localhost:8000';

    // Fetch templates from Python backend
    let templates;
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);

        const templatesRes = await fetch(`${langGraphUrl}/templates`, {
            signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (!templatesRes.ok) {
            throw new Error(`HTTP ${templatesRes.status}: ${templatesRes.statusText}`);
        }

        const data = await templatesRes.json();
        templates = data.templates || [];
    } catch (err) {
        if (err.cause?.code === 'ECONNREFUSED' || err.name === 'TypeError') {
            throw new Error(`LangGraph Python backend is not running at ${langGraphUrl}. Start it with: cd python && uvicorn main:app --port 8000`);
        }
        if (err.name === 'AbortError') {
            throw new Error(`LangGraph Python backend timed out at ${langGraphUrl}. Check if the service is responsive.`);
        }
        throw new Error(`Failed to fetch workflow templates: ${err.message}`);
    }

    // Find the project-level template matching this workflow type.
    // Dashboard initiatives orchestrate project-level workflows across
    // multiple projects — they always delegate to project templates.
    const template = templates.find(t =>
        t.level === 'project' &&
        (t.workflow_type === workflowType ||
            t.name.toLowerCase().includes(workflowType.replace('-', ' ')))
    );

    if (!template) {
        const availableTemplates = templates
            .filter(t => t.level === 'project')
            .map(t => `${t.name} (${t.workflow_type})`)
            .join(', ') || 'None';

        throw new Error(
            `No project-level workflow template found for initiative type "${workflowType}". ` +
            `Create a project-level template that matches this type. ` +
            `Available project templates: [${availableTemplates}]`
        );
    }

    console.log(`[InitiativeSupervisor] Using template: ${template.name}`);

    // Execute the workflow via Python backend
    let runData;
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30000);

        const runRes = await fetch(`${langGraphUrl}/graph/run`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                graph_config: {
                    nodes: template.nodes,
                    edges: template.edges
                },
                project_id: project.id,
                input_data: {
                    project_id: project.id,
                    project_path: project.path,
                    project_name: project.name,
                    initiative_id: initiativeId,
                    workflow_type: workflowType,
                    configuration,
                    target_projects: [project.id]
                }
            }),
            signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (!runRes.ok) {
            const errBody = await runRes.text();
            throw new Error(`HTTP ${runRes.status}: ${errBody}`);
        }

        runData = await runRes.json();
    } catch (err) {
        throw new Error(`Failed to execute workflow "${template.name}": ${err.message}`);
    }

    if (!runData.success) {
        throw new Error(`Workflow "${template.name}" failed to start: ${runData.error || 'Unknown error'}`);
    }

    console.log(`[InitiativeSupervisor] Workflow started: ${runData.run_id}`);

    return {
        success: true,
        runId: runData.run_id,
        summary: `Workflow template "${template.name}" started`,
        data: { templateName: template.name, templateLevel: template.level }
    };
}

// ═══════════════════════════════════════════════════════════════
// TASK CREATION FROM TEMPLATE STAGES
// ═══════════════════════════════════════════════════════════════

/**
 * Create tasks in a project from the initiative's workflow template stages.
 * 
 * Follows the same pattern as project-workflow-supervisor.js (line 321):
 * db.createTask({ project_id, name, description, status, source, metadata })
 * 
 * Reads the local template JSON from config/templates/workflows/ to get stages.
 * Each stage becomes one task in the target project.
 * 
 * @param {Object} options
 * @param {string} options.initiativeId
 * @param {string} options.projectId
 * @param {string} options.workflowType - e.g. 'security-sweep'
 * @param {Object} options.configuration - Initiative configuration
 * @param {string} options.projectName - For logging/descriptions
 * @returns {Promise<string[]>} Array of created task IDs
 */
async function createInitiativeTasks(options) {
    const { initiativeId, projectId, workflowType, configuration, projectName } = options;

    // Load the local template file to get stages
    const templatesDir = path.resolve(__dirname, '../../config/templates/workflows');
    const templatePath = path.join(templatesDir, `${workflowType}.json`);

    if (!fs.existsSync(templatePath)) {
        console.warn(`[InitiativeSupervisor] No local template at ${templatePath}, skipping task creation`);
        return [];
    }

    const template = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
    const stages = template.stages || [];

    if (stages.length === 0) {
        console.warn(`[InitiativeSupervisor] Template "${template.name}" has no stages`);
        return [];
    }

    const taskIds = [];

    for (const stage of stages) {
        // Build description with context
        let description = stage.description || '';
        if (configuration?.goal) {
            description += `\n\n**Initiative Goal:** ${configuration.goal}`;
        }
        if (projectName) {
            description += `\n\n**Target Project:** ${projectName}`;
        }

        // Create the task — same pattern as project-workflow-supervisor.js L321
        const task = await db.createTask({
            project_id: projectId,
            name: `[${template.name}] ${stage.name}`,
            description,
            status: 'idea',
            source: `initiative:${initiativeId}:${workflowType}`,
            metadata: {
                initiativeId,
                workflowType,
                stageId: stage.id,
                stageName: stage.name,
                stageOrder: stage.order
            }
        });

        if (task) {
            taskIds.push(task.id);
            console.log(`[InitiativeSupervisor] Created task: ${task.name || task.title}`);
        }
    }

    return taskIds;
}

/**
 * Get initiative progress summary
 */
async function getInitiativeProgress(initiativeId) {
    const initiative = await db.getDashboardInitiative(initiativeId);
    if (!initiative) return null;

    const projectProgress = await db.getInitiativeProgress(initiativeId);

    const summary = {
        total: projectProgress.length,
        pending: projectProgress.filter(p => p.status === 'pending').length,
        inProgress: projectProgress.filter(p => p.status === 'in_progress').length,
        complete: projectProgress.filter(p => p.status === 'complete').length,
        failed: projectProgress.filter(p => p.status === 'failed').length
    };

    const percentComplete = summary.total > 0
        ? Math.round(((summary.complete + summary.failed) / summary.total) * 100)
        : 0;

    return {
        initiative,
        projectProgress,
        summary,
        percentComplete,
        supervisorStatus: initiative.supervisor_status,
        supervisorDetails: initiative.supervisor_details
    };
}

module.exports = {
    runDashboardInitiativeSupervisor,
    getInitiativeProgress,
    INITIATIVE_STATUS,
    PROJECT_STATUS
};
