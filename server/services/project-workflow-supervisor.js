/**
 * Project Workflow Supervisor
 * 
 * Orchestrates project-level workflows (Brand Development, Documentation, Release, etc.)
 * by spawning tasks and coordinating them through the existing task pipeline.
 * 
 * This is NOT a replacement for the task supervisor - it's a higher-level orchestrator
 * that creates and manages tasks as part of a larger workflow.
 * 
 * Workflow Flow:
 * 1. Workflow is created from a template (e.g., Brand Development)
 * 2. Supervisor generates tasks for the current stage
 * 3. Tasks are processed through the existing task pipeline
 * 4. When all stage tasks complete, supervisor advances to next stage
 * 5. Human checkpoint at each stage boundary
 */

const db = require('../../db');

// Workflow status values
const WORKFLOW_STATUS = {
    IDLE: 'idle',
    INITIALIZING: 'initializing',
    RUNNING: 'running',
    AWAITING_APPROVAL: 'awaiting_approval',
    ADVANCING_STAGE: 'advancing_stage',
    COMPLETED: 'completed',
    ERROR: 'error'
};

/**
 * Task generation templates for each workflow stage
 * These define what tasks get spawned for each stage of each workflow type
 */
const STAGE_TASK_GENERATORS = {
    'brand-development': {
        'discover': [
            {
                title: 'Brand Discovery Research',
                description: 'Research target audience, competitors, and brand positioning opportunities'
            }
        ],
        'concepts': [
            {
                title: 'Generate Brand Concept Options',
                description: 'Create 3-5 distinct brand concept directions based on discovery research'
            }
        ],
        'logo-design': [
            {
                title: 'Design Logo Concepts',
                description: 'Create logo variations based on approved brand concept, using AI image generation'
            }
        ],
        'color-palette': [
            {
                title: 'Define Color Palette',
                description: 'Create primary, secondary, and accent color palette with accessibility considerations'
            }
        ],
        'typography': [
            {
                title: 'Select Typography System',
                description: 'Choose heading and body fonts that align with brand personality'
            }
        ],
        'guidelines': [
            {
                title: 'Create Brand Guidelines Document',
                description: 'Compile all brand elements into a comprehensive guidelines document'
            }
        ]
    },
    'logo-development': {
        'brief': [
            {
                title: 'Logo Creative Brief',
                description: 'Document logo requirements, constraints, and inspiration references'
            }
        ],
        'concepts': [
            {
                title: 'Generate Logo Concepts',
                description: 'Create 5+ initial logo concepts using AI image generation'
            }
        ],
        'refinement': [
            {
                title: 'Refine Selected Concepts',
                description: 'Iterate on top 2-3 selected logo concepts with variations'
            }
        ],
        'finalization': [
            {
                title: 'Finalize Logo Design',
                description: 'Create final logo with approved concept, including variations for different uses'
            }
        ],
        'export': [
            {
                title: 'Export Logo Assets',
                description: 'Export logo in all required formats (SVG, PNG, ICO, etc.)'
            }
        ]
    },
    'documentation': {
        'readme': [
            {
                title: 'Generate README.md',
                description: 'Create comprehensive project README with installation, usage, and examples'
            }
        ],
        'api-docs': [
            {
                title: 'Generate API Documentation',
                description: 'Document all API endpoints with examples and response schemas'
            }
        ],
        'user-guide': [
            {
                title: 'Create User Guide',
                description: 'Write end-user documentation with screenshots and tutorials'
            }
        ],
        'contributing': [
            {
                title: 'Write Contributing Guide',
                description: 'Document how others can contribute to the project'
            }
        ]
    },
    'release': {
        'changelog': [
            {
                title: 'Generate Changelog',
                description: 'Compile all changes since last release into CHANGELOG.md'
            }
        ],
        'version-bump': [
            {
                title: 'Bump Version',
                description: 'Update version numbers in package.json and other relevant files'
            }
        ],
        'build': [
            {
                title: 'Create Production Build',
                description: 'Run build process and verify all tests pass'
            }
        ],
        'deploy': [
            {
                title: 'Deploy to Production',
                description: 'Execute deployment workflow to production environment'
            }
        ],
        'announce': [
            {
                title: 'Create Release Announcement',
                description: 'Draft release notes and social media announcement'
            }
        ]
    }
};

/**
 * Get a workflow with its project details
 */
async function getWorkflowWithProject(workflowId) {
    const workflow = await db.getProjectWorkflow(workflowId);
    if (!workflow) return null;

    // Get project details
    const project = await db.getProject(workflow.project_id);
    return { ...workflow, project };
}

/**
 * Update workflow supervisor status
 */
async function updateWorkflowSupervisorStatus(workflowId, status, details = {}) {
    await db.updateProjectWorkflow(workflowId, {
        supervisor_status: status,
        supervisor_details: details
    });
}

/**
 * Gather context from completed tasks in previous stages
 * This includes research outputs, plan outputs, and any comments
 */
async function getPreviousStageContext(workflow) {
    const { outputs, stages, current_stage } = workflow;

    if (!outputs || !stages) return null;

    // Find the index of current stage
    const currentIndex = stages.findIndex(s => s.id === current_stage);
    if (currentIndex <= 0) return null; // No previous stage

    // Get all previous stage IDs
    const previousStages = stages.slice(0, currentIndex);
    const contextParts = [];

    for (const stage of previousStages) {
        const stageOutput = outputs[stage.id];
        // Checks for tasks or legacy features
        const stageTaskIds = stageOutput?.tasks || stageOutput?.features;

        if (!stageTaskIds?.length) continue;

        contextParts.push(`\n## ${stage.name} Stage Outputs\n`);

        // Fetch each task's outputs
        for (const taskId of stageTaskIds) {
            try {
                const task = await db.getTask(taskId);
                if (!task) continue;

                contextParts.push(`### ${task.title}`); // Task uses 'title' now (mapped from 'name' in DB if needed, but 'title' is standard)

                // Include research output if available
                if (task.researchReport) { // task uses researchReport object
                    let researchContent = task.researchReport;
                    if (typeof researchContent === 'object' && researchContent.content) {
                        researchContent = researchContent.content;
                    }
                    contextParts.push(`**Research:**\n${researchContent}\n`);
                } else if (task.research_output) { // Legacy fallback
                    contextParts.push(`**Research:**\n${task.research_output}\n`);
                }

                // Include plan output if available
                if (task.implementationPlan) {
                    let planContent = task.implementationPlan;
                    // Handle both string and object formats
                    if (typeof planContent === 'object' && planContent.content) {
                        planContent = planContent.content;
                    }
                    contextParts.push(`**Plan:**\n${planContent}\n`);
                } else if (task.plan_output) { // Legacy fallback
                    let planContent = task.plan_output;
                    if (typeof planContent === 'object' && planContent.content) {
                        planContent = planContent.content;
                    }
                    contextParts.push(`**Plan:**\n${planContent}\n`);
                }

                // Include walkthrough if available
                if (task.walkthrough) {
                    let walkthroughContent = task.walkthrough;
                    if (typeof walkthroughContent === 'object' && walkthroughContent.content) {
                        walkthroughContent = walkthroughContent.content;
                    }
                    contextParts.push(`**Walkthrough:**\n${walkthroughContent}\n`);
                }

            } catch (err) {
                console.warn(`[WorkflowSupervisor] Could not fetch task ${taskId}:`, err.message);
            }
        }
    }

    if (contextParts.length === 0) return null;

    return contextParts.join('\n');
}

/**
 * Generate tasks for the current workflow stage
 */
async function generateStageTasks(workflow, workflowContext = '') {
    const { id, project_id, workflow_type, current_stage, stages, configuration } = workflow;

    // Find current stage definition
    const currentStageObj = stages?.find(s => s.id === current_stage);
    if (!currentStageObj) {
        console.log(`[WorkflowSupervisor] No current stage found for workflow ${id}`);
        return [];
    }

    // Get task templates for this stage
    const stageId = currentStageObj.id;
    const taskTemplates = STAGE_TASK_GENERATORS[workflow_type]?.[stageId];

    if (!taskTemplates || taskTemplates.length === 0) {
        console.log(`[WorkflowSupervisor] No task templates for ${workflow_type}/${stageId}`);
        return [];
    }

    // Gather context from previous stages
    const previousStageContext = await getPreviousStageContext(workflow);
    if (previousStageContext) {
        console.log(`[WorkflowSupervisor] Including context from previous stages (${previousStageContext.length} chars)`);
    }

    // Create tasks for this stage
    const createdTasks = [];
    const errors = [];

    for (const template of taskTemplates) {
        // Build comprehensive description with all context
        let description = template.description;

        // Add workflow goal
        if (configuration?.goal) {
            description += `\n\n**Workflow Goal:** ${configuration.goal}`;
        }

        // Add user-provided context (from workflow start)
        if (workflowContext) {
            description += `\n\n**User Context:** ${workflowContext}`;
        }

        // Add previous stage outputs (research, plans, walkthroughs)
        if (previousStageContext) {
            description += `\n\n---\n# Context from Previous Stages\n${previousStageContext}`;
        }

        // Create the task
        const task = await db.createTask({
            project_id,
            name: `[${currentStageObj.name}] ${template.title}`,
            description,
            status: 'idea',
            source: `workflow:${id}:${workflow_type}`,
            metadata: {
                workflowStage: stageId,
                stageName: currentStageObj.name
            }
        });

        if (task) {
            createdTasks.push(task);
            console.log(`[WorkflowSupervisor] Created task: ${task.title || task.name}`);
        } else {
            const errorMsg = `Failed to create task: ${template.title}`;
            console.error(`[WorkflowSupervisor] ${errorMsg}`);
            errors.push(errorMsg);
        }
    }

    // If any tasks failed to create, throw an error
    if (errors.length > 0 && createdTasks.length === 0) {
        throw new Error(`Task creation failed: ${errors.join(', ')}`);
    }

    // Track which tasks were spawned for this stage
    await db.updateProjectWorkflow(id, {
        outputs: {
            ...(workflow.outputs || {}),
            [stageId]: {
                tasks: createdTasks.map(t => t.id), // Use 'tasks' key now
                createdAt: new Date().toISOString(),
                status: 'in_progress',
                errors: errors.length > 0 ? errors : undefined
            }
        }
    });

    return createdTasks;
}

/**
 * Check if all tasks for current stage are complete
 */
async function checkStageCompletion(workflow) {
    const { id, current_stage, outputs } = workflow;

    const stageOutput = outputs?.[current_stage];
    // Check 'tasks' first, then legacy 'features'
    const stageTaskIds = stageOutput?.tasks || stageOutput?.features;

    if (!stageTaskIds?.length) {
        return { complete: true, tasks: [] };
    }

    // Get all tasks for this stage
    const taskStatuses = [];
    for (const taskId of stageTaskIds) {
        const task = await db.getTask(taskId);
        if (task) {
            taskStatuses.push({
                id: task.id,
                title: task.title,
                status: task.status
            });
        }
    }

    // Check if all tasks are complete (or rejected/cancelled)
    const terminalStatuses = ['complete', 'rejected', 'cancelled'];
    const allComplete = taskStatuses.every(t => terminalStatuses.includes(t.status));

    return {
        complete: allComplete,
        tasks: taskStatuses,
        summary: {
            total: taskStatuses.length,
            complete: taskStatuses.filter(t => t.status === 'complete').length,
            inProgress: taskStatuses.filter(t => !terminalStatuses.includes(t.status)).length
        }
    };
}

/**
 * Advance workflow to the next stage
 */
async function advanceToNextStage(workflow) {
    const { id, stages, current_stage, outputs } = workflow;

    // Mark current stage as complete
    if (current_stage && outputs?.[current_stage]) {
        await db.updateProjectWorkflow(id, {
            outputs: {
                ...outputs,
                [current_stage]: {
                    ...outputs[current_stage],
                    status: 'complete',
                    completedAt: new Date().toISOString()
                }
            }
        });
    }

    // Find next stage
    const currentIndex = stages?.findIndex(s => s.id === current_stage) ?? -1;
    const nextIndex = currentIndex + 1;

    if (nextIndex >= (stages?.length || 0)) {
        // No more stages - workflow complete
        console.log(`[WorkflowSupervisor] Workflow ${id} completed all stages`);

        await db.updateProjectWorkflow(id, {
            status: 'complete',
            current_stage: null
        });

        return { complete: true };
    }

    const nextStage = stages[nextIndex];
    console.log(`[WorkflowSupervisor] Advancing workflow ${id} to stage: ${nextStage.name}`);

    await db.updateProjectWorkflow(id, {
        current_stage: nextStage.id
    });

    return { complete: false, nextStage };
}

/**
 * Run the project workflow supervisor
 * 
 * This function is called when:
 * 1. A workflow is started
 * 2. A stage needs to generate tasks
 * 3. Checking if stage is complete to advance
 * 
 * @param {Object} options
 * @param {string} options.workflowId - The workflow ID
 * @param {string} options.action - 'start', 'generate', 'check', 'advance'
 * @param {string} options.context - Additional context for task generation
 */
async function runProjectWorkflowSupervisor(options) {
    const { workflowId, action = 'check', context = '' } = options;

    console.log(`[WorkflowSupervisor] Running action '${action}' for workflow ${workflowId}`);

    const workflow = await getWorkflowWithProject(workflowId);
    if (!workflow) {
        return { success: false, error: 'Workflow not found' };
    }

    try {
        switch (action) {
            case 'start':
                return await handleStartWorkflow(workflow, context);

            case 'generate':
                return await handleGenerateTasks(workflow, context);

            case 'check':
                return await handleCheckProgress(workflow);

            case 'advance':
                return await handleAdvanceStage(workflow);

            default:
                return { success: false, error: `Unknown action: ${action}` };
        }
    } catch (error) {
        console.error(`[WorkflowSupervisor] Error in ${action} for ${workflowId}:`, error);
        await updateWorkflowSupervisorStatus(workflowId, WORKFLOW_STATUS.ERROR, {
            error: error.message,
            timestamp: new Date().toISOString()
        });
        return { success: false, error: error.message };
    }
}

/**
 * Handle starting a workflow
 * 
 * For workflows with a matching project-level LangGraph template,
 * this delegates execution to the Python backend via /graph/run.
 * For legacy workflows without a template, falls back to generateStageTasks.
 */
async function handleStartWorkflow(workflow, context) {
    const { id, stages, status, current_stage } = workflow;

    // Only start if workflow is in 'idea' or 'planning' status
    if (status !== 'idea' && status !== 'planning') {
        console.log(`[WorkflowSupervisor] Workflow ${id} already in progress (status: ${status})`);
        return { success: true, message: 'Workflow already in progress' };
    }

    await updateWorkflowSupervisorStatus(id, WORKFLOW_STATUS.INITIALIZING);

    // Set status to in_progress and ensure current_stage is set
    const firstStage = current_stage || (stages?.length > 0 ? stages[0].id : null);

    if (!firstStage) {
        return { success: false, error: 'Workflow has no stages defined' };
    }

    await db.updateProjectWorkflow(id, {
        status: 'in_progress',
        current_stage: firstStage
    });

    // ═══════════════════════════════════════════════════════════════
    // Execute via LangGraph Python backend
    // ═══════════════════════════════════════════════════════════════
    const langGraphUrl = process.env.LANGGRAPH_URL || 'http://localhost:8000';
    const workflowType = workflow.workflow_type || workflow.type;

    if (!workflowType) {
        return { success: false, error: 'No workflow_type defined' };
    }

    try {
        // Fetch project-level templates from Python backend
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);

        const templatesRes = await fetch(`${langGraphUrl}/templates?level=project`, {
            signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (!templatesRes.ok) {
            throw new Error(`Template fetch failed: ${templatesRes.status}`);
        }

        const data = await templatesRes.json();
        const templates = data.templates || [];

        // Find matching template
        const template = templates.find(t =>
            t.workflow_type === workflowType ||
            t.name.toLowerCase().includes(workflowType.replace('-', ' '))
        );

        if (!template) {
            throw new Error(`No LangGraph template found for workflow type: ${workflowType}`);
        }

        console.log(`[WorkflowSupervisor] Found LangGraph template: ${template.name}`);

        // Get project info for context
        const project = workflow.project || await db.getProject(workflow.project_id);

        // Execute via Python /graph/run
        const runController = new AbortController();
        const runTimeoutId = setTimeout(() => runController.abort(), 120000); // 2 min for full run

        const runRes = await fetch(`${langGraphUrl}/graph/run`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                graph_config: {
                    nodes: template.nodes,
                    edges: template.edges,
                    conditionalEdges: template.conditionalEdges || []
                },
                project_id: workflow.project_id,
                input_data: {
                    project_id: workflow.project_id,
                    project_path: project?.path || project?.local_path || '',
                    project_name: project?.name || '',
                    workflow_id: id,
                    workflow_type: workflowType,
                    context: context || ''
                }
            }),
            signal: runController.signal
        });
        clearTimeout(runTimeoutId);

        if (!runRes.ok) {
            throw new Error(`LangGraph run failed: ${runRes.status}`);
        }

        const runData = await runRes.json();

        if (!runData.success) {
            throw new Error(`LangGraph run returned error: ${runData.error || 'unknown'}`);
        }

        console.log(`[WorkflowSupervisor] LangGraph workflow started: run_id=${runData.run_id}`);

        // Store the LangGraph run_id — workflow stays in_progress
        // Completion will be triggered by Python callback to /api/langgraph/workflow-complete
        await db.updateProjectWorkflow(id, {
            supervisor_status: WORKFLOW_STATUS.RUNNING,
            supervisor_details: {
                langgraph_run_id: runData.run_id,
                template_name: template.name,
                startedAt: new Date().toISOString(),
                mode: 'langgraph'
            }
        });

        return {
            success: true,
            message: `Workflow started via LangGraph (${template.name})`,
            runId: runData.run_id,
            mode: 'langgraph'
        };

    } catch (err) {
        console.error(`[WorkflowSupervisor] Workflow ${id} failed: ${err.message}`);
        await db.updateProjectWorkflow(id, {
            status: 'idea',
            supervisor_status: WORKFLOW_STATUS.ERROR,
            supervisor_details: {
                error: err.message,
                timestamp: new Date().toISOString()
            }
        });
        return { success: false, error: err.message };
    }
}

/**
 * Handle generating tasks for current stage
 */
async function handleGenerateTasks(workflow, context) {
    const { id, current_stage, stages } = workflow;

    const currentStageObj = stages?.find(s => s.id === current_stage);
    if (!currentStageObj) {
        return { success: false, error: 'No current stage' };
    }

    const tasks = await generateStageTasks(workflow, context);

    await updateWorkflowSupervisorStatus(id, WORKFLOW_STATUS.RUNNING, {
        currentStage: currentStageObj.name,
        tasksCreated: tasks.length
    });

    return {
        success: true,
        tasks,
        stageName: currentStageObj.name
    };
}

/**
 * Handle checking workflow progress
 */
async function handleCheckProgress(workflow) {
    const { id, current_stage, stages, status } = workflow;

    if (status === 'complete') {
        return { success: true, complete: true };
    }

    const currentStageObj = stages?.find(s => s.id === current_stage);
    const completion = await checkStageCompletion(workflow);

    if (completion.complete) {
        await updateWorkflowSupervisorStatus(id, WORKFLOW_STATUS.AWAITING_APPROVAL, {
            currentStage: currentStageObj?.name,
            readyToAdvance: true
        });

        return {
            success: true,
            stageComplete: true,
            stageName: currentStageObj?.name,
            readyToAdvance: true,
            ...completion
        };
    }

    await updateWorkflowSupervisorStatus(id, WORKFLOW_STATUS.RUNNING, {
        currentStage: currentStageObj?.name,
        progress: completion.summary
    });

    return {
        success: true,
        stageComplete: false,
        stageName: currentStageObj?.name,
        ...completion
    };
}

/**
 * Handle advancing to next stage (human-triggered)
 */
async function handleAdvanceStage(workflow) {
    const { id, stages } = workflow;

    await updateWorkflowSupervisorStatus(id, WORKFLOW_STATUS.ADVANCING_STAGE);

    const result = await advanceToNextStage(workflow);

    if (result.complete) {
        await updateWorkflowSupervisorStatus(id, WORKFLOW_STATUS.COMPLETED);
        return {
            success: true,
            workflowComplete: true,
            message: 'Workflow completed successfully'
        };
    }

    // Generate tasks for next stage
    const updatedWorkflow = await db.getProjectWorkflow(id);
    const tasks = await generateStageTasks(updatedWorkflow);

    await updateWorkflowSupervisorStatus(id, WORKFLOW_STATUS.RUNNING, {
        currentStage: result.nextStage.name,
        tasksCreated: tasks.length
    });

    return {
        success: true,
        advancedTo: result.nextStage.name,
        tasksCreated: tasks.length,
        tasks,
        message: `Advanced to stage: ${result.nextStage.name}`
    };
}

/**
 * Get workflow status with progress details
 */
async function getWorkflowProgress(workflowId) {
    const workflow = await db.getProjectWorkflow(workflowId);
    if (!workflow) return null;

    const { stages, current_stage, outputs, supervisor_status, supervisor_details } = workflow;

    // Calculate overall progress
    const currentIndex = stages?.findIndex(s => s.id === current_stage) ?? -1;
    const stagesCompleted = currentIndex >= 0 ? currentIndex : 0;
    const totalStages = stages?.length || 0;

    // Get current stage task completion
    let stageCompletion = null;
    if (current_stage) {
        const result = await checkStageCompletion(workflow);
        stageCompletion = result;
    }

    return {
        workflow,
        progress: {
            stagesCompleted,
            totalStages,
            percentComplete: totalStages > 0 ? Math.round((stagesCompleted / totalStages) * 100) : 0,
            currentStage: stages?.find(s => s.id === current_stage)?.name,
            stageCompletion
        },
        supervisorStatus: supervisor_status,
        supervisorDetails: supervisor_details
    };
}

module.exports = {
    runProjectWorkflowSupervisor,
    getWorkflowProgress,
    checkStageCompletion,
    advanceToNextStage,
    generateStageTasks,
    WORKFLOW_STATUS,
    STAGE_TASK_GENERATORS
};
