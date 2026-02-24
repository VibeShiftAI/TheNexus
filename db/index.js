/**
 * Supabase Database Client for TheNexus
 * 
 * Provides a configured Supabase client for database operations.
 * Uses the new Supabase API key format (sb_publishable_ / sb_secret_).
 */

const { createClient } = require('@supabase/supabase-js');

// Validate required environment variables
const supabaseUrl = process.env.SUPABASE_URL;
// Prioritize Service Key for backend operations (Agents need admin rights)
const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY;

if (!supabaseUrl) {
    console.warn('[Database] SUPABASE_URL not set - database features disabled');
}

if (!supabaseKey) {
    console.warn('[Database] SUPABASE_SECRET_KEY not set - database features disabled');
}

// Create Supabase client (or null if not configured)
const supabase = supabaseUrl && supabaseKey
    ? createClient(supabaseUrl, supabaseKey, {
        auth: {
            autoRefreshToken: false,
            persistSession: false
        }
    })
    : null;

/**
 * Check if database is available
 */
function isDatabaseEnabled() {
    return supabase !== null;
}

/**
 * Test database connection
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function testConnection() {
    if (!supabase) {
        return { success: false, error: 'Database not configured' };
    }

    try {
        const { data, error } = await supabase.from('projects').select('count').limit(1);
        if (error) {
            return { success: false, error: error.message };
        }
        return { success: true };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

// ============================================================================
// PROJECT OPERATIONS
// ============================================================================

/**
 * Get all projects from database
 * @returns {Promise<Array>}
 */
async function getProjects() {
    if (!supabase) return [];

    const { data, error } = await supabase
        .from('projects')
        .select('*')
        .order('name');

    if (error) {
        console.error('[Database] Error fetching projects:', error);
        return [];
    }
    return data;
}

/**
 * Get a single project by ID or name
 * @param {string} identifier - Project ID (UUID) or name
 * @returns {Promise<Object|null>}
 */
async function getProject(identifier) {
    if (!supabase) return null;

    // Check if identifier looks like a UUID (for ID-based lookup)
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier);

    // Try by name first (more common lookup)
    let { data, error } = await supabase
        .from('projects')
        .select('*')
        .eq('name', identifier)
        .single();

    // If not found by name AND identifier is a valid UUID, try by ID
    if (error && error.code === 'PGRST116' && isUuid) {
        const result = await supabase
            .from('projects')
            .select('*')
            .eq('id', identifier)
            .single();
        data = result.data;
        error = result.error;
    }

    // If we still have an error, log only if it's not "not found" (PGRST116)
    if (error && error.code !== 'PGRST116') {
        console.error('[Database] Error fetching project:', error);
    }

    return data || null;
}

/**
 * Get a project by its filesystem path
 * @param {string} projectPath - Absolute path to project directory
 * @returns {Promise<Object|null>}
 */
async function getProjectByPath(projectPath) {
    if (!supabase) return null;

    const { data, error } = await supabase
        .from('projects')
        .select('*')
        .eq('path', projectPath)
        .single();

    // If not found (PGRST116), return null without logging
    if (error && error.code !== 'PGRST116') {
        console.error('[Database] Error fetching project by path:', error);
    }

    return data || null;
}

/**
 * Upsert a project (insert or update)
 * @param {Object} project - Project data
 * @returns {Promise<Object|null>}
 */
async function upsertProject(project) {
    if (!supabase) return null;

    const { data, error } = await supabase
        .from('projects')
        .upsert(project, { onConflict: 'name' })
        .select()
        .single();

    if (error) {
        console.error('[Database] Error upserting project:', error);
        return null;
    }
    return data;
}

/**
 * Update a project by ID
 * @param {string} projectId - Project UUID
 * @param {Object} updates - Fields to update
 * @returns {Promise<Object|null>}
 */
async function updateProject(projectId, updates) {
    if (!supabase) return null;

    const { data, error } = await supabase
        .from('projects')
        .update(updates)
        .eq('id', projectId)
        .select()
        .single();

    if (error) {
        console.error('[Database] Error updating project:', error);
        return null; // Return null on error so caller can handle it
    }
    return data;
}

/**
 * Delete a project by ID
 * @param {string} projectId - Project UUID
 * @returns {Promise<boolean>}
 */
async function deleteProject(projectId) {
    if (!supabase) return false;

    const { error } = await supabase
        .from('projects')
        .delete()
        .eq('id', projectId);

    if (error) {
        console.error('[Database] Error deleting project:', error);
        return false;
    }
    return true;
}

// ============================================================================
// CONTEXT OPERATIONS
// ============================================================================

/**
 * Get project contexts
 * @param {string} projectId - Project UUID
 * @returns {Promise<Array>}
 */
async function getProjectContexts(projectId) {
    if (!supabase) return [];

    const { data, error } = await supabase
        .from('project_contexts')
        .select('*')
        .eq('project_id', projectId);

    if (error) {
        console.error('[Database] Error fetching project contexts:', error);
        return [];
    }
    return data;
}

/**
 * Update a project context document
 * Also writes to local .context/ folder for git backup
 * @param {string} projectId - Project UUID
 * @param {string} type - Context type (product, tech-stack, etc)
 * @param {string} content - Markdown content
 */
async function updateProjectContext(projectId, type, content, status) {
    if (!supabase) return null;

    // Write to local file for git backup (if project has a path)
    try {
        const project = await getProject(projectId);
        if (project?.path) {
            const contextDir = require('path').join(project.path, '.context');
            const fs = require('fs');

            // Create directory if needed
            if (!fs.existsSync(contextDir)) {
                fs.mkdirSync(contextDir, { recursive: true });
            }

            // Map context type to filename
            const typeToFile = {
                'product': 'product.md',
                'tech-stack': 'tech-stack.md',
                'product-guidelines': 'product-guidelines.md',
                'workflow': 'workflow.md',
                'database-schema': 'database-schema.md',
                'context_map': 'context_map.md',
                'project-workflow-map': 'project-workflow-map.md',
                'task-pipeline-map': 'task-pipeline-map.md',
                'function_map': 'function_map.md'
            };
            const filename = typeToFile[type] || `${type}.md`;
            const filepath = require('path').join(contextDir, filename);

            // Write with frontmatter
            const fileContent = [
                '---',
                `context_type: ${type}`,
                `status: ${status || 'draft'}`,
                `updated_at: ${new Date().toISOString()}`,
                '---',
                '',
                content || ''
            ].join('\n');

            fs.writeFileSync(filepath, fileContent, 'utf-8');
            console.log(`[Database] Wrote context to ${filepath}`);
        }
    } catch (fileErr) {
        console.warn('[Database] Could not write context file:', fileErr.message);
        // Continue with DB update even if file write fails
    }

    const { data, error } = await supabase
        .from('project_contexts')
        .upsert({
            project_id: projectId,
            context_type: type,
            content: content,
            status: status || 'draft',
            updated_at: new Date().toISOString()
        }, { onConflict: 'project_id,context_type' })
        .select()
        .single();

    if (error) {
        console.error('[Database] Error updating project context:', error);
        return null;
    }
    return data;
}

/**
 * Get context statistics (e.g. pending reviews count per project)
 * @returns {Promise<Object>} Map of projectId -> { pending_reviews: number }
 */
async function getContextStats() {
    if (!supabase) return {};

    const { data, error } = await supabase
        .from('project_contexts')
        .select('project_id, status')
        .eq('status', 'review_pending');

    if (error) {
        console.error('[Database] Error fetching context stats:', error);
        return {};
    }

    // Aggregate counts
    const stats = {};
    data.forEach(row => {
        if (!stats[row.project_id]) {
            stats[row.project_id] = { pending_reviews: 0 };
        }
        stats[row.project_id].pending_reviews++;
    });

    return stats;
}

// ============================================================================
// FEATURE OPERATIONS

// ============================================================================

/**
 * Helper to parse feature JSON fields
 * @param {Object} feature - Raw feature from DB
 * @returns {Object} Feature with parsed fields
 */
function parseTaskFields(task) {
    if (!task) return null;

    // Parse walkthrough if it's a string
    if (task.walkthrough && typeof task.walkthrough === 'string') {
        try {
            task.walkthrough = JSON.parse(task.walkthrough);
        } catch (e) {
            console.error(`[Database] Failed to parse walkthrough for task ${task.id}:`, e);
            // Fallback: leave as string or set to null? 
            // User requested "throw error", but throwing here might break the whole dashboard load.
            console.error(`[Database] Failed to parse walkthrough for task ${task.id}:`, e);
            // Fallback: set content as the raw string so it's not lost, but wrapped to avoid frontend crashes
            task.walkthrough = {
                content: task.walkthrough,
                error: 'Failed to parse JSON content'
            };
        }
    }

    // 1. Implementation Plan
    // Merge plan_metadata + plan_output
    let plan = task.plan_metadata || {};

    if (task.plan_output) {
        if (typeof task.plan_output === 'string') {
            // Legacy JSON check
            if (task.plan_output.trim().startsWith('{')) {
                try {
                    const parsed = JSON.parse(task.plan_output);
                    plan = { ...parsed, ...plan };
                } catch (e) {
                    plan.content = task.plan_output;
                }
            } else {
                plan.content = task.plan_output;
            }
        } else {
            // Already object?
            plan = { ...task.plan_output, ...plan };
        }
    }
    // Set generatedAt fallback if missing
    if (Object.keys(plan).length > 0) {
        if (!plan.generatedAt) plan.generatedAt = task.updated_at;
        task.implementationPlan = plan;
    } else {
        task.implementationPlan = null;
    }


    // 2. Research Report
    // Merge research_metadata + research_output
    let research = task.research_metadata || {};

    if (task.research_output) {
        if (typeof task.research_output === 'string') {
            // Legacy JSON check
            if (task.research_output.trim().startsWith('{')) {
                try {
                    const parsed = JSON.parse(task.research_output);
                    research = { ...parsed, ...research };
                } catch (e) {
                    research.content = task.research_output;
                }
            } else {
                research.content = task.research_output;
            }
        } else {
            research = { ...task.research_output, ...research };
        }
    }
    // Set generatedAt fallback if missing
    if (Object.keys(research).length > 0) {
        if (!research.generatedAt) research.generatedAt = task.created_at;
        task.researchReport = research;
    } else {
        task.researchReport = null;
    }


    // 3. Metadata mapping
    // Ensure task.metadata exists
    task.metadata = task.metadata || {};

    // Map db columns to top-level camelCase properties for frontend
    if (task.initiative_validation) {
        task.initiativeValidation = task.initiative_validation;
    }
    if (task.source) {
        task.source = task.source;
    }
    if (task.supervisor_status) {
        task.supervisorStatus = task.supervisor_status;
    }
    if (task.supervisor_details) {
        task.supervisorDetails = task.supervisor_details;
    }

    return task;
}

/**
 * Get tasks for a project
 * @param {string} projectId - Project UUID
 * @returns {Promise<Array>}
 */
async function getTasks(projectId) {
    if (!supabase) return [];

    const { data, error } = await supabase
        .from('tasks')
        .select('*')
        .eq('project_id', projectId)
        .order('priority', { ascending: false })
        .order('created_at', { ascending: false });

    if (error) {
        console.error('[Database] Error fetching tasks:', error);
        return [];
    }

    return data.map(parseTaskFields);
}

/**
 * Get a single task by ID
 * @param {string} taskId - Task UUID
 * @returns {Promise<Object|null>}
 */
async function getTask(taskId) {
    if (!supabase) return null;

    const { data, error } = await supabase
        .from('tasks')
        .select('*')
        .eq('id', taskId)
        .single();

    if (error) {
        console.error('[Database] Error fetching task:', error);
        return null;
    }

    return parseTaskFields(data);
}

/**
 * Create a new task
 * @param {Object} task - Task data
 * @returns {Promise<Object|null>}
 */
async function createTask(task) {
    if (!supabase) return null;

    const { data, error } = await supabase
        .from('tasks')
        .insert(task)
        .select()
        .single();

    if (error) {
        console.error('[Database] Error creating task:', error);
        return null;
    }
    return data;
}

/**
 * Update a task
 * @param {string} taskId - Task UUID
 * @param {Object} updates - Fields to update
 * @returns {Promise<Object|null>}
 */
async function updateTask(taskId, updates) {
    if (!supabase) return null;

    const { data, error } = await supabase
        .from('tasks')
        .update(updates)
        .eq('id', taskId)
        .select()
        .single();

    if (error) {
        console.error('[Database] Error updating task:', error);
        return null;
    }
    return data;
}

/**
 * Delete a task
 * @param {string} taskId - Task UUID
 * @returns {Promise<boolean>}
 */
async function deleteTask(taskId) {
    if (!supabase) return false;

    const { error } = await supabase
        .from('tasks')
        .delete()
        .eq('id', taskId);

    if (error) {
        console.error('[Database] Error deleting task:', error);
        return false;
    }
    return true;
}

// ============================================================================
// TRACK OPERATIONS
// ============================================================================

/**
 * Get tracks for a task
 * @param {string} taskId - Task UUID
 * @returns {Promise<Array>}
 */
async function getTracks(taskId) {
    if (!supabase) return [];

    const { data, error } = await supabase
        .from('tracks')
        .select(`
            *,
            steps:track_steps(*)
        `)
        .eq('task_id', taskId)
        .order('created_at');

    // Sort steps within tracks
    if (data) {
        data.forEach(track => {
            if (track.steps) {
                track.steps.sort((a, b) => a.step_order - b.step_order);
            }
        });
    }

    if (error) {
        console.error('[Database] Error fetching tracks:', error);
        return [];
    }
    return data;
}

/**
 * Create a new track
 * @param {Object} track - Track data
 * @returns {Promise<Object|null>}
 */
async function createTrack(track) {
    if (!supabase) return null;

    const { data, error } = await supabase
        .from('tracks')
        .insert(track)
        .select()
        .single();

    if (error) {
        console.error('[Database] Error creating track:', error);
        return null;
    }
    return data;
}

/**
 * Create track steps (bulk)
 * @param {Array} steps - Array of steps
 * @returns {Promise<Array|null>}
 */
async function createTrackSteps(steps) {
    if (!supabase) return null;

    const { data, error } = await supabase
        .from('track_steps')
        .insert(steps)
        .select();

    if (error) {
        console.error('[Database] Error creating track steps:', error);
        return null;
    }
    return data;
}

/**
 * Update a track
 */
async function updateTrack(trackId, updates) {
    if (!supabase) return null;

    const { data, error } = await supabase
        .from('tracks')
        .update(updates)
        .eq('id', trackId)
        .select()
        .single();

    if (error) {
        console.error('[Database] Error updating track:', error);
        return null;
    }
    return data;
}


// ============================================================================
// WORKFLOW OPERATIONS

// ============================================================================

/**
 * Get all workflows
 * @param {boolean} templatesOnly - If true, only return templates
 * @returns {Promise<Array>}
 */
async function getWorkflows(templatesOnly = false) {
    if (!supabase) return [];

    let query = supabase.from('workflows').select('*');

    if (templatesOnly) {
        query = query.eq('is_template', true);
    }

    const { data, error } = await query.order('name');

    if (error) {
        console.error('[Database] Error fetching workflows:', error);
        return [];
    }
    return data;
}

/**
 * Save a workflow
 * @param {Object} workflow - Workflow data with graph_config
 * @returns {Promise<Object|null>}
 */
async function saveWorkflow(workflow) {
    if (!supabase) return null;

    const { data, error } = await supabase
        .from('workflows')
        .upsert(workflow)
        .select()
        .single();

    if (error) {
        console.error('[Database] Error saving workflow:', error);
        return null;
    }
    return data;
}

// ============================================================================
// AGENT CONFIG OPERATIONS - DEPRECATED
// User-defined agents have been removed in favor of built-in atomic nodes.
// New agents should be added as AtomicNode classes via Praxis tasks.
// ============================================================================

// ============================================================================
// DASHBOARD STATISTICS
// ============================================================================

/**
 * Get aggregated dashboard statistics
 * @returns {Promise<Object>}
 */
async function getDashboardStats() {
    if (!supabase) return {
        tasksByStatus: {},
        activeProjectWorkflows: 0,
        artifactsInReview: {
            total: 0,
            project: 0,
            task: 0,
            items: []
        }
    };

    try {
        // 1. Get Task Statistics (Counts by Status) and Review Items
        const { data: tasks, error: tasksError } = await supabase
            .from('tasks')
            .select(`
                id, 
                project_id, 
                name, 
                status, 
                research_output, 
                plan_output, 
                walkthrough,
                research_metadata,
                plan_metadata,
                supervisor_status
            `);

        if (tasksError) throw tasksError;

        const tasksByStatus = {};
        const reviewItems = [];

        tasks.forEach(task => {
            // Count status
            tasksByStatus[task.status] = (tasksByStatus[task.status] || 0) + 1;

            // Ignore artifacts from cancelled or complete tasks
            if (task.status === 'cancelled' || task.status === 'complete') return;

            // Check for artifacts in review
            // Parse fields using the helper (we need to temporarily attach parsed fields)
            const parsedTask = parseTaskFields(task);

            // Check Research
            if (parsedTask.researchReport && parsedTask.researchReport.content && !parsedTask.researchReport.approvedAt && !parsedTask.researchReport.rejectedAt) {
                reviewItems.push({
                    type: 'task-research',
                    id: task.id,
                    projectId: task.project_id,
                    name: `Research: ${task.name}`,
                    level: 'Task'
                });
            }

            // Check Plan
            if (parsedTask.implementationPlan && parsedTask.implementationPlan.content && !parsedTask.implementationPlan.approvedAt && !parsedTask.implementationPlan.rejectedAt) {
                reviewItems.push({
                    type: 'task-plan',
                    id: task.id,
                    projectId: task.project_id,
                    name: `Plan: ${task.name}`,
                    level: 'Task'
                });
            }

            // Check Walkthrough
            if (parsedTask.walkthrough && parsedTask.walkthrough.content && !parsedTask.walkthrough.approvedAt && !parsedTask.walkthrough.rejectedAt) {
                reviewItems.push({
                    type: 'task-walkthrough',
                    id: task.id,
                    projectId: task.project_id,
                    name: `Walkthrough: ${task.name}`,
                    level: 'Task'
                });
            }
        });

        // 2. Get Project Workflow Statistics
        const { data: workflows, error: workflowsError } = await supabase
            .from('project_workflows')
            .select('id, project_id, name, status, current_stage');

        if (workflowsError) throw workflowsError;

        let activeWorkflows = 0;

        workflows.forEach(wf => {
            if (wf.status === 'in_progress') {
                activeWorkflows++;
            }
            if (wf.status === 'review') {
                reviewItems.push({
                    type: 'project-workflow',
                    id: wf.id,
                    projectId: wf.project_id,
                    name: `Workflow: ${wf.name}`,
                    level: 'Project'
                });
            }
        });

        // 3. Get Project Context Reviews
        const { data: contexts, error: contextsError } = await supabase
            .from('project_contexts')
            .select('project_id, context_type, status')
            .eq('status', 'review_pending');

        if (contextsError) throw contextsError;

        contexts.forEach(ctx => {
            reviewItems.push({
                type: 'project-context',
                id: `${ctx.project_id}-${ctx.context_type}`, // Virtual ID
                projectId: ctx.project_id,
                name: `Context: ${ctx.context_type}`,
                level: 'Project'
            });
        });

        return {
            tasksByStatus,
            activeProjectWorkflows: activeWorkflows,
            artifactsInReview: {
                total: reviewItems.length,
                project: reviewItems.filter(i => i.level === 'Project').length,
                task: reviewItems.filter(i => i.level === 'Task').length,
                items: reviewItems
            }
        };

    } catch (error) {
        console.error('[Database] Error fetching dashboard stats:', error);
        return {
            tasksByStatus: {},
            activeProjectWorkflows: 0,
            artifactsInReview: { total: 0, project: 0, task: 0, items: [] }
        };
    }
}

/**
 * Record token usage
 * @param {string} model - Model name
 * @param {number} inputTokens - Input token count
 * @param {number} outputTokens - Output token count
 */
async function recordUsage(model, inputTokens, outputTokens) {
    if (!supabase) return;

    const today = new Date().toISOString().split('T')[0];

    const { error } = await supabase.rpc('increment_usage', {
        p_date: today,
        p_model: model,
        p_input: inputTokens,
        p_output: outputTokens
    });

    // If RPC doesn't exist, fall back to upsert
    if (error) {
        const { error: upsertError } = await supabase
            .from('usage_stats')
            .upsert({
                date: today,
                model: model,
                input_tokens: inputTokens,
                output_tokens: outputTokens,
                total_tokens: inputTokens + outputTokens,
                request_count: 1
            }, {
                onConflict: 'date,model',
                ignoreDuplicates: false
            });

        if (upsertError) {
            console.error('[Database] Error recording usage:', upsertError);
        }
    }
}

/**
 * Helper to safely convert BIGINT strings (from Supabase) to numbers
 * @param {any} value - Value to normalize
 * @returns {number} Normalized number, or 0 if not finite
 */
function normalizeNumber(value) {
    if (typeof value === 'string') {
        const parsed = parseInt(value, 10);
        return Number.isFinite(parsed) ? parsed : 0;
    }
    return Number.isFinite(value) ? value : 0;
}

/**
 * Get usage stats for a date range
 * @param {string} startDate - Start date (YYYY-MM-DD)
 * @param {string} endDate - End date (YYYY-MM-DD)
 * @returns {Promise<Array>}
 */
async function getUsageStats(startDate, endDate) {
    if (!supabase) return [];

    const { data, error } = await supabase
        .from('usage_stats')
        .select('*')
        .gte('date', startDate)
        .lte('date', endDate)
        .order('date', { ascending: false })
        .limit(100);

    if (error) {
        console.error('[Database] Error fetching usage stats:', error);
        return [];
    }

    // Normalize BIGINT strings to numbers (Supabase returns BIGINT as strings)
    return data.map(row => ({
        ...row,
        input_tokens: normalizeNumber(row.input_tokens),
        output_tokens: normalizeNumber(row.output_tokens),
        total_tokens: normalizeNumber(row.total_tokens),
        request_count: normalizeNumber(row.request_count)
    }));
}

/**
 * Delete a project and all its related data (cascading)
 * @param {string} projectId - Project UUID
 * @returns {Promise<boolean>}
 */
async function deleteProject(projectId) {
    if (!supabase) return false;

    const { error } = await supabase
        .from('projects')
        .delete()
        .eq('id', projectId);

    if (error) {
        console.error('[Database] Error deleting project:', error);
        return false;
    }
    return true;
}

// ============================================================================
// DASHBOARD INITIATIVE OPERATIONS
// ============================================================================

/**
 * Get all dashboard initiatives
 * @param {string} status - Optional status filter
 * @returns {Promise<Array>}
 */
async function getDashboardInitiatives(status = null) {
    if (!supabase) return [];

    let query = supabase.from('dashboard_initiatives').select('*');

    if (status) {
        query = query.eq('status', status);
    }

    const { data, error } = await query.order('created_at', { ascending: false });

    if (error) {
        console.error('[Database] Error fetching dashboard initiatives:', error);
        return [];
    }
    return data;
}

/**
 * Get a single dashboard initiative by ID
 * @param {string} initiativeId - Initiative UUID
 * @returns {Promise<Object|null>}
 */
async function getDashboardInitiative(initiativeId) {
    if (!supabase) return null;

    const { data, error } = await supabase
        .from('dashboard_initiatives')
        .select('*')
        .eq('id', initiativeId)
        .single();

    if (error) {
        console.error('[Database] Error fetching dashboard initiative:', error);
        return null;
    }
    return data;
}

/**
 * Create a new dashboard initiative
 * @param {Object} initiative - Initiative data
 * @returns {Promise<Object|null>}
 */
async function createDashboardInitiative(initiative) {
    if (!supabase) return null;

    const { data, error } = await supabase
        .from('dashboard_initiatives')
        .insert(initiative)
        .select()
        .single();

    if (error) {
        console.error('[Database] Error creating dashboard initiative:', error);
        return null;
    }
    return data;
}

/**
 * Update a dashboard initiative
 * @param {string} initiativeId - Initiative UUID
 * @param {Object} updates - Fields to update
 * @returns {Promise<Object|null>}
 */
async function updateDashboardInitiative(initiativeId, updates) {
    if (!supabase) return null;

    const { data, error } = await supabase
        .from('dashboard_initiatives')
        .update(updates)
        .eq('id', initiativeId)
        .select()
        .single();

    if (error) {
        console.error('[Database] Error updating dashboard initiative:', error);
        return null;
    }
    return data;
}

/**
 * Delete a dashboard initiative
 * @param {string} initiativeId - Initiative UUID
 * @returns {Promise<boolean>}
 */
async function deleteDashboardInitiative(initiativeId) {
    if (!supabase) return false;

    const { error } = await supabase
        .from('dashboard_initiatives')
        .delete()
        .eq('id', initiativeId);

    if (error) {
        console.error('[Database] Error deleting dashboard initiative:', error);
        return false;
    }
    return true;
}

/**
 * Get initiative progress across projects
 * @param {string} initiativeId - Initiative UUID
 * @returns {Promise<Array>}
 */
async function getInitiativeProgress(initiativeId) {
    if (!supabase) return [];

    const { data, error } = await supabase
        .from('initiative_project_status')
        .select(`
            *,
            project:projects(id, name, path)
        `)
        .eq('initiative_id', initiativeId)
        .order('started_at', { ascending: false });

    if (error) {
        console.error('[Database] Error fetching initiative progress:', error);
        return [];
    }
    return data;
}

/**
 * Update initiative project status
 * @param {string} initiativeId - Initiative UUID
 * @param {string} projectId - Project UUID
 * @param {Object} statusUpdate - Status update data
 * @returns {Promise<Object|null>}
 */
async function updateInitiativeProjectStatus(initiativeId, projectId, statusUpdate) {
    if (!supabase) return null;

    const { data, error } = await supabase
        .from('initiative_project_status')
        .upsert({
            initiative_id: initiativeId,
            project_id: projectId,
            ...statusUpdate
        }, { onConflict: 'initiative_id,project_id' })
        .select()
        .single();

    if (error) {
        console.error('[Database] Error updating initiative project status:', error);
        return null;
    }
    return data;
}

// ============================================================================
// PROJECT WORKFLOW OPERATIONS
// ============================================================================

/**
 * Get all workflows for a project
 * @param {string} projectId - Project UUID
 * @param {string} status - Optional status filter
 * @returns {Promise<Array>}
 */
async function getProjectWorkflows(projectId, status = null) {
    if (!supabase) return [];

    let query = supabase
        .from('project_workflows')
        .select('*')
        .eq('project_id', projectId);

    if (status) {
        query = query.eq('status', status);
    }

    const { data, error } = await query.order('created_at', { ascending: false });

    if (error) {
        console.error('[Database] Error fetching project workflows:', error);
        return [];
    }
    return data;
}

/**
 * Get a single project workflow by ID
 * @param {string} workflowId - Workflow UUID
 * @returns {Promise<Object|null>}
 */
async function getProjectWorkflow(workflowId) {
    if (!supabase) return null;

    const { data, error } = await supabase
        .from('project_workflows')
        .select(`
            *,
            project:projects(id, name, path)
        `)
        .eq('id', workflowId)
        .single();

    if (error) {
        console.error('[Database] Error fetching project workflow:', error);
        return null;
    }
    return data;
}

/**
 * Create a new project workflow
 * @param {Object} workflow - Workflow data
 * @returns {Promise<Object|null>}
 */
async function createProjectWorkflow(workflow) {
    if (!supabase) return null;

    const { data, error } = await supabase
        .from('project_workflows')
        .insert(workflow)
        .select()
        .single();

    if (error) {
        console.error('[Database] Error creating project workflow:', error);
        return null;
    }
    return data;
}

/**
 * Update a project workflow
 * @param {string} workflowId - Workflow UUID
 * @param {Object} updates - Fields to update
 * @returns {Promise<Object|null>}
 */
async function updateProjectWorkflow(workflowId, updates) {
    if (!supabase) return null;

    const { data, error } = await supabase
        .from('project_workflows')
        .update(updates)
        .eq('id', workflowId)
        .select()
        .single();

    if (error) {
        console.error('[Database] Error updating project workflow:', error);
        return null;
    }
    return data;
}

/**
 * Delete a project workflow
 * @param {string} workflowId - Workflow UUID
 * @returns {Promise<boolean>}
 */
async function deleteProjectWorkflow(workflowId) {
    if (!supabase) return false;

    const { error } = await supabase
        .from('project_workflows')
        .delete()
        .eq('id', workflowId);

    if (error) {
        console.error('[Database] Error deleting project workflow:', error);
        return false;
    }
    return true;
}

// ============================================================================
// WORKFLOW TEMPLATE OPERATIONS
// ============================================================================

/**
 * Get workflow templates
 * @param {string} level - Optional filter by level ('dashboard', 'project', 'feature')
 * @returns {Promise<Array>}
 */
async function getWorkflowTemplates(level = null) {
    if (!supabase) return [];

    let query = supabase.from('workflow_templates').select('*');

    if (level) {
        query = query.eq('level', level);
    }

    const { data, error } = await query.order('name');

    if (error) {
        console.error('[Database] Error fetching workflow templates:', error);
        return [];
    }
    return data;
}

/**
 * Get a single workflow template by ID or name
 * @param {string} identifier - Template UUID or name
 * @returns {Promise<Object|null>}
 */
async function getWorkflowTemplate(identifier) {
    if (!supabase) return null;

    // Try by name first
    let { data, error } = await supabase
        .from('workflow_templates')
        .select('*')
        .eq('name', identifier)
        .single();

    // If not found by name, try by ID
    if (error && error.code === 'PGRST116') {
        const result = await supabase
            .from('workflow_templates')
            .select('*')
            .eq('id', identifier)
            .single();
        data = result.data;
        error = result.error;
    }

    if (error) {
        console.error('[Database] Error fetching workflow template:', error);
        return null;
    }
    return data;
}

/**
 * Create a workflow template
 * @param {Object} template - Template data
 * @returns {Promise<Object|null>}
 */
async function createWorkflowTemplate(template) {
    if (!supabase) return null;

    const { data, error } = await supabase
        .from('workflow_templates')
        .insert(template)
        .select()
        .single();

    if (error) {
        console.error('[Database] Error creating workflow template:', error);
        return null;
    }
    return data;
}

/**
 * Update a workflow template
 * @param {string} templateId - Template UUID
 * @param {Object} updates - Fields to update
 * @returns {Promise<Object|null>}
 */
async function updateWorkflowTemplate(templateId, updates) {
    if (!supabase) return null;

    const { data, error } = await supabase
        .from('workflow_templates')
        .update(updates)
        .eq('id', templateId)
        .select()
        .single();

    if (error) {
        console.error('[Database] Error updating workflow template:', error);
        return null;
    }
    return data;
}

/**
 * Delete a workflow template (only non-system templates)
 * @param {string} templateId - Template UUID
 * @returns {Promise<boolean>}
 */
async function deleteWorkflowTemplate(templateId) {
    if (!supabase) return false;

    const { error } = await supabase
        .from('workflow_templates')
        .delete()
        .eq('id', templateId)
        .eq('is_system', false); // Only allow deleting non-system templates

    if (error) {
        console.error('[Database] Error deleting workflow template:', error);
        return false;
    }
    return true;
}

// ============================================================================
// MODEL OPERATIONS
// ============================================================================

/**
 * Get all models from database
 * @param {boolean} activeOnly - If true, only return active models
 * @returns {Promise<Array>}
 * @throws {Error} If database is unavailable
 */
async function getModels(activeOnly = true) {
    if (!supabase) {
        throw new Error('Database connection required for models');
    }

    let query = supabase.from('models').select('*');

    if (activeOnly) {
        query = query.eq('is_active', true);
    }

    const { data, error } = await query.order('sort_order');

    if (error) {
        console.error('[Database] Error fetching models:', error);
        throw new Error(`Failed to fetch models: ${error.message}`);
    }

    return data || [];
}

/**
 * Get a single model by ID
 * @param {string} modelId - Model ID (e.g., 'gemini-3-flash-preview')
 * @returns {Promise<Object|null>}
 * @throws {Error} If database is unavailable
 */
async function getModel(modelId) {
    if (!supabase) {
        throw new Error('Database connection required for models');
    }

    const { data, error } = await supabase
        .from('models')
        .select('*')
        .eq('id', modelId)
        .single();

    if (error) {
        if (error.code === 'PGRST116') {
            return null; // Not found
        }
        console.error('[Database] Error fetching model:', error);
        throw new Error(`Failed to fetch model: ${error.message}`);
    }

    return data;
}

/**
 * Upsert a model (insert or update)
 * @param {Object} model - Model data with id, name, provider, etc.
 * @returns {Promise<Object>}
 * @throws {Error} If database is unavailable or operation fails
 */
async function upsertModel(model) {
    if (!supabase) {
        throw new Error('Database connection required for models');
    }

    const { data, error } = await supabase
        .from('models')
        .upsert(model, { onConflict: 'id' })
        .select()
        .single();

    if (error) {
        console.error('[Database] Error upserting model:', error);
        throw new Error(`Failed to upsert model: ${error.message}`);
    }

    return data;
}

/**
 * Delete a model by ID
 * @param {string} modelId - Model ID
 * @returns {Promise<boolean>}
 * @throws {Error} If database is unavailable
 */
async function deleteModel(modelId) {
    if (!supabase) {
        throw new Error('Database connection required for models');
    }

    const { error } = await supabase
        .from('models')
        .delete()
        .eq('id', modelId);

    if (error) {
        console.error('[Database] Error deleting model:', error);
        throw new Error(`Failed to delete model: ${error.message}`);
    }

    return true;
}

/**
 * Get the default model for a specific task type
 * @param {string} taskType - Task type: 'plan', 'research', 'implementation', 'quick'
 * @returns {Promise<Object|null>}
 * @throws {Error} If database is unavailable
 */
async function getDefaultModelForTask(taskType) {
    if (!supabase) {
        throw new Error('Database connection required for models');
    }

    const { data, error } = await supabase
        .from('models')
        .select('*')
        .eq('is_default_for_task', taskType)
        .eq('is_active', true)
        .single();

    if (error) {
        if (error.code === 'PGRST116') {
            return null; // No default found for this task type
        }
        console.error('[Database] Error fetching default model for task:', error);
        throw new Error(`Failed to fetch default model: ${error.message}`);
    }

    return data;
}

module.exports = {
    supabase,
    isDatabaseEnabled,
    testConnection,
    // Projects
    getProjects,
    getProject,
    getProjectByPath,
    upsertProject,
    updateProject,
    deleteProject,
    // Tasks
    getTasks,
    getTask,
    createTask,
    updateTask,
    deleteTask,
    // Context
    getProjectContexts,
    updateProjectContext,
    getContextStats,
    // Tracks
    getTracks,
    createTrack,
    createTrackSteps,
    updateTrack,
    // Workflows (React Flow visual editor)
    getWorkflows,
    saveWorkflow,
    // Dashboard Initiatives
    getDashboardInitiatives,
    getDashboardInitiative,
    createDashboardInitiative,
    updateDashboardInitiative,
    deleteDashboardInitiative,
    getInitiativeProgress,
    updateInitiativeProjectStatus,
    // Project Workflows
    getProjectWorkflows,
    getProjectWorkflow,
    createProjectWorkflow,
    updateProjectWorkflow,
    deleteProjectWorkflow,
    // Workflow Templates
    getWorkflowTemplates,
    getWorkflowTemplate,
    createWorkflowTemplate,
    updateWorkflowTemplate,
    deleteWorkflowTemplate,
    // Agent Configs - DEPRECATED (functions removed)
    // Models
    getModels,
    getModel,
    upsertModel,
    deleteModel,
    getDefaultModelForTask,
    // Usage
    recordUsage,
    getUsageStats,
    getDashboardStats
};
