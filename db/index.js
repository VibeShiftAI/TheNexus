/**
 * SQLite Database Client for TheNexus
 * 
 * Local SQLite database via better-sqlite3.
 * Replaces the previous Supabase (PostgreSQL) client.
 * All operations are synchronous under the hood but wrapped
 * in async functions to preserve the existing API contract.
 */

const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

// ---------------------------------------------------------------------------
// Database initialisation
// ---------------------------------------------------------------------------

const DB_PATH = process.env.NEXUS_DB_PATH
    || path.resolve(__dirname, '../nexus.db');

let db;
try {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    // Auto-create tables if the DB is brand new
    const schemaPath = path.resolve(__dirname, 'schema-sqlite.sql');
    if (fs.existsSync(schemaPath)) {
        db.exec(fs.readFileSync(schemaPath, 'utf8'));
    }

    // Migration: add 'source' column to usage_stats for per-caller tracking
    try {
        const cols = db.prepare("PRAGMA table_info(usage_stats)").all();
        if (cols.length > 0 && !cols.find(c => c.name === 'source')) {
            db.exec("ALTER TABLE usage_stats ADD COLUMN source TEXT DEFAULT 'unknown'");
            // Drop old unique constraint and create new one including source
            // SQLite can't drop constraints, so we need to recreate the index
            try { db.exec("DROP INDEX IF EXISTS idx_usage_stats_date_model_source"); } catch {}
            db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_stats_date_model_source ON usage_stats(date, model, source)");
            console.log('[Database] Migration: added source column to usage_stats');
        }
    } catch (err) {
        console.warn('[Database] usage_stats source migration skipped:', err.message);
    }

    console.log(`[Database] Connected to SQLite: ${DB_PATH}`);
} catch (err) {
    console.error('[Database] Failed to open SQLite database:', err.message);
    db = null;
}

// Auth removed — single-user local app. No Supabase dependency at runtime.

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function uuid() { return crypto.randomUUID(); }
function now() { return new Date().toISOString(); }

/** Serialise a value for SQLite TEXT column (JSON objects/arrays → string) */
function ser(val) {
    if (val === undefined) return null;
    if (val === null) return null;
    if (typeof val === 'boolean') return val ? 1 : 0;
    if (typeof val === 'object') return JSON.stringify(val);
    return val;
}

/** Deserialise a JSON TEXT column back to JS */
function deser(val) {
    if (val === null || val === undefined) return val;
    if (typeof val !== 'string') return val;
    const t = val.trim();
    if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
        try { return JSON.parse(val); } catch { return val; }
    }
    return val;
}

/** Deserialise known JSON columns on a row */
const JSON_COLS = new Set([
    'stack', 'urls', 'tasks_list', 'task_ledger', 'supervisor_details',
    'graph_config', 'context', 'checkpoint', 'metadata',
    'agent_configuration', 'parameters', 'capabilities', 'config',
    'trigger_config', 'configuration', 'target_projects', 'progress',
    'allowed_tools', 'denied_tools', 'details', 'data',
    'stages', 'outputs',
    'antigravity_payload', 'dependencies'
]);

function deserRow(row) {
    if (!row) return row;
    for (const key of Object.keys(row)) {
        if (JSON_COLS.has(key)) {
            row[key] = deser(row[key]);
        }
        // SQLite booleans back to JS booleans
        if (key === 'is_template' || key === 'is_active' || key === 'is_enabled' || key === 'resolved' || key === 'pinned') {
            row[key] = row[key] === 1 || row[key] === true;
        }
    }
    return row;
}

function deserRows(rows) { return (rows || []).map(deserRow); }

/**
 * Build an INSERT or INSERT OR REPLACE from an object.
 * Returns { sql, params }.
 */
function buildInsert(table, obj, upsertConflict) {
    const keys = Object.keys(obj);
    const cols = keys.map(k => `"${k}"`).join(', ');
    const placeholders = keys.map(() => '?').join(', ');
    const values = keys.map(k => ser(obj[k]));

    let sql;
    if (upsertConflict) {
        const setClauses = keys
            .filter(k => !upsertConflict.split(',').map(c => c.trim()).includes(k))
            .map(k => `"${k}" = excluded."${k}"`)
            .join(', ');
        sql = `INSERT INTO "${table}" (${cols}) VALUES (${placeholders})
               ON CONFLICT(${upsertConflict}) DO UPDATE SET ${setClauses}`;
    } else {
        sql = `INSERT INTO "${table}" (${cols}) VALUES (${placeholders})`;
    }

    return { sql, values };
}

/**
 * Build an UPDATE from an object.
 * Returns { sql, params }.
 */
function buildUpdate(table, updates, whereCol, whereVal) {
    const keys = Object.keys(updates);
    if (!keys.includes('updated_at')) keys.push('updated_at');
    if (!updates.updated_at) updates.updated_at = now();

    const setClauses = keys.map(k => `"${k}" = ?`).join(', ');
    const values = keys.map(k => ser(updates[k]));
    values.push(whereVal);

    return {
        sql: `UPDATE "${table}" SET ${setClauses} WHERE "${whereCol}" = ?`,
        values
    };
}

// ============================================================================
// CORE
// ============================================================================

function isDatabaseEnabled() { return db !== null; }

async function testConnection() {
    if (!db) return { success: false, error: 'Database not configured' };
    try {
        db.prepare('SELECT 1').get();
        return { success: true };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

// ============================================================================
// PROJECT OPERATIONS
// ============================================================================

async function getProjects() {
    if (!db) return [];
    try {
        return deserRows(db.prepare('SELECT * FROM projects ORDER BY name').all());
    } catch (err) {
        console.error('[Database] Error fetching projects:', err.message);
        return [];
    }
}

async function getProject(identifier) {
    if (!db) return null;
    try {
        const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier);
        let row = db.prepare('SELECT * FROM projects WHERE name = ?').get(identifier);
        if (!row && isUuid) {
            row = db.prepare('SELECT * FROM projects WHERE id = ?').get(identifier);
        }
        return deserRow(row) || null;
    } catch (err) {
        console.error('[Database] Error fetching project:', err.message);
        return null;
    }
}

async function getProjectByPath(projectPath) {
    if (!db) return null;
    try {
        const row = db.prepare('SELECT * FROM projects WHERE path = ?').get(projectPath);
        return deserRow(row) || null;
    } catch (err) {
        console.error('[Database] Error fetching project by path:', err.message);
        return null;
    }
}

async function upsertProject(project) {
    if (!db) return null;
    try {
        if (!project.id) project.id = uuid();
        project.updated_at = now();
        if (!project.created_at) project.created_at = now();
        const { sql, values } = buildInsert('projects', project, 'name');
        db.prepare(sql).run(...values);
        return deserRow(db.prepare('SELECT * FROM projects WHERE name = ?').get(project.name));
    } catch (err) {
        console.error('[Database] Error upserting project:', err.message);
        return null;
    }
}

async function updateProject(projectId, updates) {
    if (!db) return null;
    try {
        const { sql, values } = buildUpdate('projects', { ...updates }, 'id', projectId);
        db.prepare(sql).run(...values);
        return deserRow(db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId));
    } catch (err) {
        console.error('[Database] Error updating project:', err.message);
        return null;
    }
}

async function deleteProject(projectId) {
    if (!db) return false;
    try {
        db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);
        return true;
    } catch (err) {
        console.error('[Database] Error deleting project:', err.message);
        return false;
    }
}

// ============================================================================
// CONTEXT OPERATIONS
// ============================================================================

async function getProjectContexts(projectId) {
    if (!db) return [];
    try {
        return deserRows(db.prepare('SELECT * FROM project_contexts WHERE project_id = ?').all(projectId));
    } catch (err) {
        console.error('[Database] Error fetching project contexts:', err.message);
        return [];
    }
}

async function updateProjectContext(projectId, type, content, status) {
    if (!db) return null;

    // Write to local file for git backup
    try {
        const project = await getProject(projectId);
        if (project?.path) {
            const contextDir = path.join(project.path, '.context');
            if (!fs.existsSync(contextDir)) fs.mkdirSync(contextDir, { recursive: true });
            const typeToFile = {
                'product': 'product.md', 'tech-stack': 'tech-stack.md',
                'product-guidelines': 'product-guidelines.md', 'workflow': 'workflow.md',
                'database-schema': 'database-schema.md', 'context_map': 'context_map.md',
                'project-workflow-map': 'project-workflow-map.md',
                'task-pipeline-map': 'task-pipeline-map.md', 'function_map': 'function_map.md'
            };
            const filename = typeToFile[type] || `${type}.md`;
            const filepath = path.join(contextDir, filename);
            const fileContent = [
                '---', `context_type: ${type}`, `status: ${status || 'draft'}`,
                `updated_at: ${now()}`, '---', '', content || ''
            ].join('\n');
            fs.writeFileSync(filepath, fileContent, 'utf-8');
            console.log(`[Database] Wrote context to ${filepath}`);
        }
    } catch (fileErr) {
        console.warn('[Database] Could not write context file:', fileErr.message);
    }

    try {
        const row = {
            id: uuid(), project_id: projectId, context_type: type,
            content, status: status || 'draft', updated_at: now()
        };
        const { sql, values } = buildInsert('project_contexts', row, 'project_id,context_type');
        db.prepare(sql).run(...values);
        return deserRow(
            db.prepare('SELECT * FROM project_contexts WHERE project_id = ? AND context_type = ?')
                .get(projectId, type)
        );
    } catch (err) {
        console.error('[Database] Error updating project context:', err.message);
        return null;
    }
}

async function getContextStats() {
    if (!db) return {};
    try {
        const rows = db.prepare(
            "SELECT project_id, COUNT(*) as cnt FROM project_contexts WHERE status = 'review_pending' GROUP BY project_id"
        ).all();
        const stats = {};
        rows.forEach(r => { stats[r.project_id] = { pending_reviews: r.cnt }; });
        return stats;
    } catch (err) {
        console.error('[Database] Error fetching context stats:', err.message);
        return {};
    }
}

// ============================================================================
// TASK HELPERS
// ============================================================================

function parseTaskFields(task) {
    if (!task) return null;

    // Deserialise JSON columns
    task = deserRow(task);

    // Parse walkthrough if it's a string
    if (task.walkthrough && typeof task.walkthrough === 'string') {
        try { task.walkthrough = JSON.parse(task.walkthrough); }
        catch (e) {
            task.walkthrough = { content: task.walkthrough, error: 'Failed to parse JSON content' };
        }
    }

    // 1. Implementation Plan — merge plan_metadata + plan_output
    let plan = (typeof task.plan_metadata === 'string' ? deser(task.plan_metadata) : task.plan_metadata) || {};
    if (task.plan_output) {
        if (typeof task.plan_output === 'string') {
            if (task.plan_output.trim().startsWith('{')) {
                try { plan = { ...JSON.parse(task.plan_output), ...plan }; }
                catch { plan.content = task.plan_output; }
            } else { plan.content = task.plan_output; }
        } else { plan = { ...task.plan_output, ...plan }; }
    }
    if (Object.keys(plan).length > 0) {
        if (!plan.generatedAt) plan.generatedAt = task.updated_at;
        task.implementationPlan = plan;
    } else { task.implementationPlan = null; }

    // 2. Research Report — merge research_metadata + research_output
    let research = (typeof task.research_metadata === 'string' ? deser(task.research_metadata) : task.research_metadata) || {};
    if (task.research_output) {
        if (typeof task.research_output === 'string') {
            if (task.research_output.trim().startsWith('{')) {
                try { research = { ...JSON.parse(task.research_output), ...research }; }
                catch { research.content = task.research_output; }
            } else { research.content = task.research_output; }
        } else { research = { ...task.research_output, ...research }; }
    }
    if (Object.keys(research).length > 0) {
        if (!research.generatedAt) research.generatedAt = task.created_at;
        task.researchReport = research;
    } else { task.researchReport = null; }

    // 3. Metadata mapping
    task.metadata = task.metadata || {};
    if (task.initiative_validation) task.initiativeValidation = task.initiative_validation;
    if (task.supervisor_status) task.supervisorStatus = task.supervisor_status;
    if (task.supervisor_details) task.supervisorDetails = task.supervisor_details;

    return task;
}

// ============================================================================
// TASK OPERATIONS
// ============================================================================

async function getTasks(projectId) {
    if (!db) return [];
    try {
        const rows = db.prepare(
            'SELECT * FROM tasks WHERE project_id = ? ORDER BY priority DESC, created_at DESC'
        ).all(projectId);
        return rows.map(parseTaskFields);
    } catch (err) {
        console.error('[Database] Error fetching tasks:', err.message);
        return [];
    }
}

async function getTask(taskId) {
    if (!db) return null;
    try {
        return parseTaskFields(db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId));
    } catch (err) {
        console.error('[Database] Error fetching task:', err.message);
        return null;
    }
}

async function createTask(task) {
    if (!db) return null;
    try {
        if (!task.id) task.id = uuid();
        if (!task.created_at) task.created_at = now();
        task.updated_at = now();
        const { sql, values } = buildInsert('tasks', task);
        db.prepare(sql).run(...values);
        return deserRow(db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id));
    } catch (err) {
        console.error('[Database] Error creating task:', err.message);
        return null;
    }
}

async function updateTask(taskId, updates) {
    if (!db) return null;
    try {
        const { sql, values } = buildUpdate('tasks', { ...updates }, 'id', taskId);
        db.prepare(sql).run(...values);
        return deserRow(db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId));
    } catch (err) {
        console.error('[Database] Error updating task:', err.message);
        return null;
    }
}

async function deleteTask(taskId) {
    if (!db) return false;
    try {
        db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
        return true;
    } catch (err) {
        console.error('[Database] Error deleting task:', err.message);
        return false;
    }
}

// ============================================================================
// DUAL-PAYLOAD TASK OPERATIONS (Executive Planning)
// ============================================================================

/**
 * Batch-create tasks in a single SQLite transaction.
 * Each task supports the dual-payload structure:
 *   - human layer: name, description, status, priority
 *   - machine layer: antigravity_payload (JSON), dependencies (JSON array)
 *
 * @param {Array} tasks - Array of task objects
 * @returns {Array} Created tasks with IDs
 */
async function batchCreateTasks(tasks) {
    if (!db) return [];
    try {
        const insertMany = db.transaction((items) => {
            const results = [];
            for (const task of items) {
                if (!task.id) task.id = uuid();
                if (!task.created_at) task.created_at = now();
                task.updated_at = now();

                // Serialize JSON fields for storage
                if (task.antigravity_payload && typeof task.antigravity_payload === 'object') {
                    task.antigravity_payload = JSON.stringify(task.antigravity_payload);
                }
                if (task.dependencies && Array.isArray(task.dependencies)) {
                    task.dependencies = JSON.stringify(task.dependencies);
                }

                const { sql, values } = buildInsert('tasks', task);
                db.prepare(sql).run(...values);
                results.push(deserRow(db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id)));
            }
            return results;
        });
        return insertMany(tasks);
    } catch (err) {
        console.error('[Database] Error batch-creating tasks:', err.message);
        return [];
    }
}

/**
 * Get the "board state" — active projects with their tasks and unblocked status.
 * A task is "unblocked" if all task IDs in its `dependencies` array have status='complete'.
 *
 * @param {string} [projectId] - Optional filter by project ID
 * @returns {Array} Projects with tasks annotated with `is_unblocked` flag
 */
async function getBoardState(projectId) {
    if (!db) return [];
    try {
        // Get projects
        let projects;
        if (projectId) {
            const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
            projects = p ? [deserRow(p)] : [];
        } else {
            projects = deserRows(
                db.prepare("SELECT * FROM projects WHERE status != 'archived' ORDER BY updated_at DESC").all()
            );
        }

        // Get all tasks for these projects in one query
        const projectIds = projects.map(p => p.id);
        if (projectIds.length === 0) return [];

        const placeholders = projectIds.map(() => '?').join(',');
        const allTasks = deserRows(
            db.prepare(`SELECT * FROM tasks WHERE project_id IN (${placeholders}) ORDER BY priority DESC, created_at ASC`).all(...projectIds)
        );

        // Build a status lookup map for dependency resolution
        const taskStatusMap = new Map();
        for (const task of allTasks) {
            taskStatusMap.set(task.id, task.status);
        }

        // Annotate each task with is_unblocked
        for (const task of allTasks) {
            const deps = task.dependencies || [];
            if (deps.length === 0) {
                task.is_unblocked = true;
            } else {
                task.is_unblocked = deps.every(depId => {
                    const depStatus = taskStatusMap.get(depId);
                    return depStatus === 'complete' || depStatus === 'done';
                });
            }
        }

        // Group tasks by project
        const tasksByProject = new Map();
        for (const task of allTasks) {
            if (!tasksByProject.has(task.project_id)) {
                tasksByProject.set(task.project_id, []);
            }
            tasksByProject.get(task.project_id).push(task);
        }

        // Assemble result
        return projects.map(project => ({
            ...project,
            tasks: tasksByProject.get(project.id) || [],
            task_summary: {
                total: (tasksByProject.get(project.id) || []).length,
                unblocked: (tasksByProject.get(project.id) || []).filter(t => t.is_unblocked && t.status !== 'complete' && t.status !== 'done').length,
                complete: (tasksByProject.get(project.id) || []).filter(t => t.status === 'complete' || t.status === 'done').length,
            }
        }));
    } catch (err) {
        console.error('[Database] Error getting board state:', err.message);
        return [];
    }
}

/**
 * Reorder tasks within a project by updating sort_order values.
 * Accepts an array of { id, sort_order } pairs and updates them atomically.
 *
 * @param {Array} ordering - Array of { id: string, sort_order: number }
 * @returns {boolean} true if reorder succeeded
 */
async function reorderTasks(ordering) {
    if (!db) return false;
    try {
        const reorder = db.transaction((items) => {
            const stmt = db.prepare('UPDATE tasks SET sort_order = ?, updated_at = ? WHERE id = ?');
            const timestamp = now();
            for (const item of items) {
                stmt.run(item.sort_order, timestamp, item.id);
            }
        });
        reorder(ordering);
        return true;
    } catch (err) {
        console.error('[Database] Error reordering tasks:', err.message);
        return false;
    }
}

// ============================================================================
// TRACK OPERATIONS
// ============================================================================

async function getTracks(taskId) {
    if (!db) return [];
    try {
        const tracks = deserRows(
            db.prepare('SELECT * FROM tracks WHERE task_id = ? ORDER BY created_at').all(taskId)
        );
        for (const track of tracks) {
            track.steps = deserRows(
                db.prepare('SELECT * FROM track_steps WHERE track_id = ? ORDER BY step_order').all(track.id)
            );
        }
        return tracks;
    } catch (err) {
        console.error('[Database] Error fetching tracks:', err.message);
        return [];
    }
}

async function createTrack(track) {
    if (!db) return null;
    try {
        if (!track.id) track.id = uuid();
        if (!track.created_at) track.created_at = now();
        track.updated_at = now();
        const { sql, values } = buildInsert('tracks', track);
        db.prepare(sql).run(...values);
        return deserRow(db.prepare('SELECT * FROM tracks WHERE id = ?').get(track.id));
    } catch (err) {
        console.error('[Database] Error creating track:', err.message);
        return null;
    }
}

async function createTrackSteps(steps) {
    if (!db) return null;
    try {
        const insertMany = db.transaction((items) => {
            const results = [];
            for (const step of items) {
                if (!step.id) step.id = uuid();
                if (!step.created_at) step.created_at = now();
                step.updated_at = now();
                const { sql, values } = buildInsert('track_steps', step);
                db.prepare(sql).run(...values);
                results.push(deserRow(db.prepare('SELECT * FROM track_steps WHERE id = ?').get(step.id)));
            }
            return results;
        });
        return insertMany(steps);
    } catch (err) {
        console.error('[Database] Error creating track steps:', err.message);
        return null;
    }
}

async function updateTrack(trackId, updates) {
    if (!db) return null;
    try {
        const { sql, values } = buildUpdate('tracks', { ...updates }, 'id', trackId);
        db.prepare(sql).run(...values);
        return deserRow(db.prepare('SELECT * FROM tracks WHERE id = ?').get(trackId));
    } catch (err) {
        console.error('[Database] Error updating track:', err.message);
        return null;
    }
}

// ============================================================================
// WORKFLOW OPERATIONS (React Flow visual editor)
// ============================================================================

async function getWorkflows(templatesOnly = false) {
    if (!db) return [];
    try {
        const sql = templatesOnly
            ? 'SELECT * FROM workflows WHERE is_template = 1 ORDER BY name'
            : 'SELECT * FROM workflows ORDER BY name';
        return deserRows(db.prepare(sql).all());
    } catch (err) {
        console.error('[Database] Error fetching workflows:', err.message);
        return [];
    }
}

async function saveWorkflow(workflow) {
    if (!db) return null;
    try {
        if (!workflow.id) workflow.id = uuid();
        workflow.updated_at = now();
        if (!workflow.created_at) workflow.created_at = now();
        const { sql, values } = buildInsert('workflows', workflow, 'id');
        db.prepare(sql).run(...values);
        return deserRow(db.prepare('SELECT * FROM workflows WHERE id = ?').get(workflow.id));
    } catch (err) {
        console.error('[Database] Error saving workflow:', err.message);
        return null;
    }
}

// ============================================================================
// DASHBOARD STATISTICS
// ============================================================================

async function getDashboardStats() {
    if (!db) return {
        tasksByStatus: {}, activeProjectWorkflows: 0,
        artifactsInReview: { total: 0, project: 0, task: 0, items: [] }
    };

    try {
        // 1. Tasks
        const tasks = db.prepare(`
            SELECT id, project_id, name, status, research_output, plan_output,
                   walkthrough, research_metadata, plan_metadata, supervisor_status
            FROM tasks
        `).all();

        const tasksByStatus = {};
        const reviewItems = [];

        tasks.forEach(task => {
            tasksByStatus[task.status] = (tasksByStatus[task.status] || 0) + 1;
            if (task.status === 'cancelled' || task.status === 'complete') return;

            const parsed = parseTaskFields({ ...task });
            if (parsed.researchReport?.content && !parsed.researchReport.approvedAt && !parsed.researchReport.rejectedAt) {
                reviewItems.push({ type: 'task-research', id: task.id, projectId: task.project_id, name: `Research: ${task.name}`, level: 'Task' });
            }
            if (parsed.implementationPlan?.content && !parsed.implementationPlan.approvedAt && !parsed.implementationPlan.rejectedAt) {
                reviewItems.push({ type: 'task-plan', id: task.id, projectId: task.project_id, name: `Plan: ${task.name}`, level: 'Task' });
            }
            if (parsed.walkthrough?.content && !parsed.walkthrough.approvedAt && !parsed.walkthrough.rejectedAt) {
                reviewItems.push({ type: 'task-walkthrough', id: task.id, projectId: task.project_id, name: `Walkthrough: ${task.name}`, level: 'Task' });
            }
        });

        // 2. Project Workflows
        const workflows = db.prepare('SELECT id, project_id, name, status, current_stage FROM project_workflows').all();
        let activeWorkflows = 0;
        workflows.forEach(wf => {
            if (wf.status === 'in_progress') activeWorkflows++;
            if (wf.status === 'review') {
                reviewItems.push({ type: 'project-workflow', id: wf.id, projectId: wf.project_id, name: `Workflow: ${wf.name}`, level: 'Project' });
            }
        });

        // 3. Context reviews
        const contexts = db.prepare("SELECT project_id, context_type, status FROM project_contexts WHERE status = 'review_pending'").all();
        contexts.forEach(ctx => {
            reviewItems.push({ type: 'project-context', id: `${ctx.project_id}-${ctx.context_type}`, projectId: ctx.project_id, name: `Context: ${ctx.context_type}`, level: 'Project' });
        });

        return {
            tasksByStatus, activeProjectWorkflows: activeWorkflows,
            artifactsInReview: {
                total: reviewItems.length,
                project: reviewItems.filter(i => i.level === 'Project').length,
                task: reviewItems.filter(i => i.level === 'Task').length,
                items: reviewItems
            }
        };
    } catch (error) {
        console.error('[Database] Error fetching dashboard stats:', error.message);
        return { tasksByStatus: {}, activeProjectWorkflows: 0, artifactsInReview: { total: 0, project: 0, task: 0, items: [] } };
    }
}

// ============================================================================
// USAGE TRACKING
// ============================================================================

async function recordUsage(model, inputTokens, outputTokens, source = 'unknown') {
    if (!db) return;
    try {
        const today = new Date().toISOString().split('T')[0];
        const existing = db.prepare('SELECT * FROM usage_stats WHERE date = ? AND model = ? AND source = ?').get(today, model, source);
        if (existing) {
            db.prepare(`
                UPDATE usage_stats SET
                    input_tokens = input_tokens + ?,
                    output_tokens = output_tokens + ?,
                    total_tokens = total_tokens + ?,
                    request_count = request_count + 1
                WHERE date = ? AND model = ? AND source = ?
            `).run(inputTokens, outputTokens, inputTokens + outputTokens, today, model, source);
        } else {
            db.prepare(`
                INSERT INTO usage_stats (id, date, model, input_tokens, output_tokens, total_tokens, request_count, source)
                VALUES (?, ?, ?, ?, ?, ?, 1, ?)
            `).run(uuid(), today, model, inputTokens, outputTokens, inputTokens + outputTokens, source);
        }
    } catch (err) {
        console.error('[Database] Error recording usage:', err.message);
    }
}

function normalizeNumber(value) {
    if (typeof value === 'string') {
        const parsed = parseInt(value, 10);
        return Number.isFinite(parsed) ? parsed : 0;
    }
    return Number.isFinite(value) ? value : 0;
}

async function getUsageStats(startDate, endDate) {
    if (!db) return [];
    try {
        const rows = db.prepare(
            'SELECT * FROM usage_stats WHERE date >= ? AND date <= ? ORDER BY date DESC LIMIT 100'
        ).all(startDate, endDate);
        return rows.map(row => ({
            ...row,
            input_tokens: normalizeNumber(row.input_tokens),
            output_tokens: normalizeNumber(row.output_tokens),
            total_tokens: normalizeNumber(row.total_tokens),
            request_count: normalizeNumber(row.request_count)
        }));
    } catch (err) {
        console.error('[Database] Error fetching usage stats:', err.message);
        return [];
    }
}

// ============================================================================
// DASHBOARD INITIATIVE OPERATIONS
// ============================================================================

async function getDashboardInitiatives(status = null) {
    if (!db) return [];
    try {
        const sql = status
            ? 'SELECT * FROM dashboard_initiatives WHERE status = ? ORDER BY created_at DESC'
            : 'SELECT * FROM dashboard_initiatives ORDER BY created_at DESC';
        return deserRows(status ? db.prepare(sql).all(status) : db.prepare(sql).all());
    } catch (err) {
        console.error('[Database] Error fetching dashboard initiatives:', err.message);
        return [];
    }
}

async function getDashboardInitiative(initiativeId) {
    if (!db) return null;
    try {
        return deserRow(db.prepare('SELECT * FROM dashboard_initiatives WHERE id = ?').get(initiativeId)) || null;
    } catch (err) {
        console.error('[Database] Error fetching dashboard initiative:', err.message);
        return null;
    }
}

async function createDashboardInitiative(initiative) {
    if (!db) return null;
    try {
        if (!initiative.id) initiative.id = uuid();
        if (!initiative.created_at) initiative.created_at = now();
        initiative.updated_at = now();
        const { sql, values } = buildInsert('dashboard_initiatives', initiative);
        db.prepare(sql).run(...values);
        return deserRow(db.prepare('SELECT * FROM dashboard_initiatives WHERE id = ?').get(initiative.id));
    } catch (err) {
        console.error('[Database] Error creating dashboard initiative:', err.message);
        return null;
    }
}

async function updateDashboardInitiative(initiativeId, updates) {
    if (!db) return null;
    try {
        const { sql, values } = buildUpdate('dashboard_initiatives', { ...updates }, 'id', initiativeId);
        db.prepare(sql).run(...values);
        return deserRow(db.prepare('SELECT * FROM dashboard_initiatives WHERE id = ?').get(initiativeId));
    } catch (err) {
        console.error('[Database] Error updating dashboard initiative:', err.message);
        return null;
    }
}

async function deleteDashboardInitiative(initiativeId) {
    if (!db) return false;
    try {
        db.prepare('DELETE FROM dashboard_initiatives WHERE id = ?').run(initiativeId);
        return true;
    } catch (err) {
        console.error('[Database] Error deleting dashboard initiative:', err.message);
        return false;
    }
}

async function getInitiativeProgress(initiativeId) {
    if (!db) return [];
    try {
        // Manual join: initiative_project_status + projects
        const rows = db.prepare(`
            SELECT ips.*, p.id as p_id, p.name as p_name, p.path as p_path
            FROM initiative_project_status ips
            LEFT JOIN projects p ON ips.project_id = p.id
            WHERE ips.initiative_id = ?
            ORDER BY ips.started_at DESC
        `).all(initiativeId);

        return deserRows(rows).map(row => ({
            ...row,
            project: row.p_id ? { id: row.p_id, name: row.p_name, path: row.p_path } : null,
            p_id: undefined, p_name: undefined, p_path: undefined
        }));
    } catch (err) {
        console.error('[Database] Error fetching initiative progress:', err.message);
        return [];
    }
}

async function updateInitiativeProjectStatus(initiativeId, projectId, statusUpdate) {
    if (!db) return null;
    try {
        const row = {
            id: uuid(),
            initiative_id: initiativeId,
            project_id: projectId,
            ...statusUpdate,
            updated_at: now()
        };
        const { sql, values } = buildInsert('initiative_project_status', row, 'initiative_id,project_id');
        db.prepare(sql).run(...values);
        return deserRow(
            db.prepare('SELECT * FROM initiative_project_status WHERE initiative_id = ? AND project_id = ?')
                .get(initiativeId, projectId)
        );
    } catch (err) {
        console.error('[Database] Error updating initiative project status:', err.message);
        return null;
    }
}

// ============================================================================
// PROJECT WORKFLOW OPERATIONS
// ============================================================================

async function getProjectWorkflows(projectId, status = null) {
    if (!db) return [];
    try {
        let sql = 'SELECT * FROM project_workflows WHERE project_id = ?';
        const params = [projectId];
        if (status) { sql += ' AND status = ?'; params.push(status); }
        sql += ' ORDER BY created_at DESC';
        return deserRows(db.prepare(sql).all(...params));
    } catch (err) {
        console.error('[Database] Error fetching project workflows:', err.message);
        return [];
    }
}

async function getProjectWorkflow(workflowId) {
    if (!db) return null;
    try {
        const row = db.prepare(`
            SELECT pw.*, p.id as p_id, p.name as p_name, p.path as p_path
            FROM project_workflows pw
            LEFT JOIN projects p ON pw.project_id = p.id
            WHERE pw.id = ?
        `).get(workflowId);
        if (!row) return null;
        const result = deserRow(row);
        result.project = row.p_id ? { id: row.p_id, name: row.p_name, path: row.p_path } : null;
        delete result.p_id; delete result.p_name; delete result.p_path;
        return result;
    } catch (err) {
        console.error('[Database] Error fetching project workflow:', err.message);
        return null;
    }
}

async function createProjectWorkflow(workflow) {
    if (!db) return null;
    try {
        if (!workflow.id) workflow.id = uuid();
        if (!workflow.created_at) workflow.created_at = now();
        workflow.updated_at = now();
        const { sql, values } = buildInsert('project_workflows', workflow);
        db.prepare(sql).run(...values);
        return deserRow(db.prepare('SELECT * FROM project_workflows WHERE id = ?').get(workflow.id));
    } catch (err) {
        console.error('[Database] Error creating project workflow:', err.message);
        return null;
    }
}

async function updateProjectWorkflow(workflowId, updates) {
    if (!db) return null;
    try {
        const { sql, values } = buildUpdate('project_workflows', { ...updates }, 'id', workflowId);
        db.prepare(sql).run(...values);
        return deserRow(db.prepare('SELECT * FROM project_workflows WHERE id = ?').get(workflowId));
    } catch (err) {
        console.error('[Database] Error updating project workflow:', err.message);
        return null;
    }
}

async function deleteProjectWorkflow(workflowId) {
    if (!db) return false;
    try {
        db.prepare('DELETE FROM project_workflows WHERE id = ?').run(workflowId);
        return true;
    } catch (err) {
        console.error('[Database] Error deleting project workflow:', err.message);
        return false;
    }
}

// ============================================================================
// MODEL OPERATIONS
// ============================================================================

async function getModels(activeOnly = true) {
    if (!db) throw new Error('Database connection required for models');
    try {
        const sql = activeOnly
            ? 'SELECT * FROM models WHERE is_active = 1 ORDER BY sort_order'
            : 'SELECT * FROM models ORDER BY sort_order';
        return deserRows(db.prepare(sql).all());
    } catch (err) {
        console.error('[Database] Error fetching models:', err.message);
        throw new Error(`Failed to fetch models: ${err.message}`);
    }
}

async function getModel(modelId) {
    if (!db) throw new Error('Database connection required for models');
    try {
        const row = db.prepare('SELECT * FROM models WHERE id = ?').get(modelId);
        return deserRow(row) || null;
    } catch (err) {
        console.error('[Database] Error fetching model:', err.message);
        throw new Error(`Failed to fetch model: ${err.message}`);
    }
}

async function upsertModel(model) {
    if (!db) throw new Error('Database connection required for models');
    try {
        model.updated_at = now();
        if (!model.created_at) model.created_at = now();
        const { sql, values } = buildInsert('models', model, 'id');
        db.prepare(sql).run(...values);
        return deserRow(db.prepare('SELECT * FROM models WHERE id = ?').get(model.id));
    } catch (err) {
        console.error('[Database] Error upserting model:', err.message);
        throw new Error(`Failed to upsert model: ${err.message}`);
    }
}

async function deleteModel(modelId) {
    if (!db) throw new Error('Database connection required for models');
    try {
        db.prepare('DELETE FROM models WHERE id = ?').run(modelId);
        return true;
    } catch (err) {
        console.error('[Database] Error deleting model:', err.message);
        throw new Error(`Failed to delete model: ${err.message}`);
    }
}

async function getDefaultModelForTask(taskType) {
    if (!db) throw new Error('Database connection required for models');
    try {
        const row = db.prepare(
            'SELECT * FROM models WHERE is_default_for_task = ? AND is_active = 1'
        ).get(taskType);
        return deserRow(row) || null;
    } catch (err) {
        console.error('[Database] Error fetching default model for task:', err.message);
        throw new Error(`Failed to fetch default model: ${err.message}`);
    }
}

// ============================================================================
// NEW WRAPPER FUNCTIONS (for server consumers that used db.supabase directly)
// ============================================================================

// --- Audit Log ---
async function insertAuditLog(entry) {
    if (!db) return null;
    try {
        if (!entry.id) entry.id = uuid();
        if (!entry.created_at) entry.created_at = now();
        const { sql, values } = buildInsert('agent_audit_log', entry);
        db.prepare(sql).run(...values);
        return deserRow(db.prepare('SELECT * FROM agent_audit_log WHERE id = ?').get(entry.id));
    } catch (err) {
        console.error('[Database] Error inserting audit log:', err.message);
        return null;
    }
}

async function getAuditLogs(filters = {}) {
    if (!db) return [];
    try {
        let sql = 'SELECT * FROM agent_audit_log WHERE 1=1';
        const params = [];
        if (filters.action) { sql += ' AND action = ?'; params.push(filters.action); }
        if (filters.actor) { sql += ' AND actor = ?'; params.push(filters.actor); }
        if (filters.target_type) { sql += ' AND target_type = ?'; params.push(filters.target_type); }
        if (filters.target_id) { sql += ' AND target_id = ?'; params.push(filters.target_id); }
        sql += ' ORDER BY created_at DESC LIMIT ?';
        params.push(filters.limit || 100);
        return deserRows(db.prepare(sql).all(...params));
    } catch (err) {
        console.error('[Database] Error fetching audit logs:', err.message);
        return [];
    }
}

async function getAuditLogEntry(id) {
    if (!db) return null;
    try {
        return deserRow(db.prepare('SELECT * FROM agent_audit_log WHERE id = ?').get(id)) || null;
    } catch (err) {
        console.error('[Database] Error fetching audit log entry:', err.message);
        return null;
    }
}

// --- API Quotas ---
async function getQuota(endpoint, period = 'daily') {
    if (!db) return null;
    try {
        return deserRow(db.prepare('SELECT * FROM usage_quotas WHERE endpoint = ? AND period = ?').get(endpoint, period)) || null;
    } catch (err) {
        console.error('[Database] Error fetching quota:', err.message);
        return null;
    }
}

async function upsertQuota(quota) {
    if (!db) return null;
    try {
        if (!quota.id) quota.id = uuid();
        quota.updated_at = now();
        const { sql, values } = buildInsert('usage_quotas', quota, 'endpoint,period');
        db.prepare(sql).run(...values);
        return deserRow(
            db.prepare('SELECT * FROM usage_quotas WHERE endpoint = ? AND period = ?')
                .get(quota.endpoint, quota.period)
        );
    } catch (err) {
        console.error('[Database] Error upserting quota:', err.message);
        return null;
    }
}

async function updateQuota(id, updates) {
    if (!db) return null;
    try {
        const { sql, values } = buildUpdate('usage_quotas', { ...updates }, 'id', id);
        db.prepare(sql).run(...values);
        return deserRow(db.prepare('SELECT * FROM usage_quotas WHERE id = ?').get(id));
    } catch (err) {
        console.error('[Database] Error updating quota:', err.message);
        return null;
    }
}

// --- MCP Scopes ---
async function getMcpScopes() {
    if (!db) return [];
    try {
        return deserRows(db.prepare('SELECT * FROM mcp_server_scopes ORDER BY server_name').all());
    } catch (err) {
        console.error('[Database] Error fetching MCP scopes:', err.message);
        return [];
    }
}

async function upsertMcpScope(scope) {
    if (!db) return null;
    try {
        if (!scope.id) scope.id = uuid();
        scope.updated_at = now();
        if (!scope.created_at) scope.created_at = now();
        const { sql, values } = buildInsert('mcp_server_scopes', scope, 'server_name');
        db.prepare(sql).run(...values);
        return deserRow(
            db.prepare('SELECT * FROM mcp_server_scopes WHERE server_name = ?').get(scope.server_name)
        );
    } catch (err) {
        console.error('[Database] Error upserting MCP scope:', err.message);
        return null;
    }
}

async function deleteMcpScope(serverName) {
    if (!db) return false;
    try {
        db.prepare('DELETE FROM mcp_server_scopes WHERE server_name = ?').run(serverName);
        return true;
    } catch (err) {
        console.error('[Database] Error deleting MCP scope:', err.message);
        return false;
    }
}

// --- Execution Steps ---
async function getExecutionSteps(projectId, featureId) {
    if (!db) return [];
    try {
        let sql = 'SELECT * FROM execution_steps WHERE project_id = ?';
        const params = [projectId];
        if (featureId) { sql += ' AND task_id = ?'; params.push(featureId); }
        sql += ' ORDER BY created_at ASC';
        return deserRows(db.prepare(sql).all(...params));
    } catch (err) {
        console.error('[Database] Error fetching execution steps:', err.message);
        return [];
    }
}

async function insertExecutionStep(step) {
    if (!db) return null;
    try {
        if (!step.id) step.id = uuid();
        if (!step.created_at) step.created_at = now();
        const { sql, values } = buildInsert('execution_steps', step);
        db.prepare(sql).run(...values);
        return deserRow(db.prepare('SELECT * FROM execution_steps WHERE id = ?').get(step.id));
    } catch (err) {
        console.error('[Database] Error inserting execution step:', err.message);
        return null;
    }
}

// --- Inline Comments ---
async function getInlineComments(projectId, featureId) {
    if (!db) return [];
    try {
        let sql = 'SELECT * FROM inline_comments WHERE project_id = ?';
        const params = [projectId];
        if (featureId) { sql += ' AND task_id = ?'; params.push(featureId); }
        sql += ' ORDER BY created_at ASC';
        return deserRows(db.prepare(sql).all(...params));
    } catch (err) {
        console.error('[Database] Error fetching inline comments:', err.message);
        return [];
    }
}

async function insertInlineComment(comment) {
    if (!db) return null;
    try {
        if (!comment.id) comment.id = uuid();
        if (!comment.created_at) comment.created_at = now();
        const { sql, values } = buildInsert('inline_comments', comment);
        db.prepare(sql).run(...values);
        return deserRow(db.prepare('SELECT * FROM inline_comments WHERE id = ?').get(comment.id));
    } catch (err) {
        console.error('[Database] Error inserting inline comment:', err.message);
        return null;
    }
}

async function updateInlineComment(commentId, updates) {
    if (!db) return null;
    try {
        const { sql, values } = buildUpdate('inline_comments', { ...updates }, 'id', commentId);
        db.prepare(sql).run(...values);
        return deserRow(db.prepare('SELECT * FROM inline_comments WHERE id = ?').get(commentId));
    } catch (err) {
        console.error('[Database] Error updating inline comment:', err.message);
        return null;
    }
}

// ============================================================================
// NOTES (Agent Scratchpad)
// ============================================================================

/**
 * Get notes, optionally filtered by project.
 * If projectId is null/undefined, returns global notes (project_id IS NULL).
 * If projectId is a string, returns notes for that project.
 * If projectId is '__all__', returns all notes.
 */
async function getNotes(projectId) {
    if (!db) return [];
    try {
        if (projectId === '__all__') {
            return deserRows(db.prepare('SELECT * FROM notes ORDER BY pinned DESC, created_at DESC').all());
        } else if (projectId) {
            return deserRows(db.prepare('SELECT * FROM notes WHERE project_id = ? ORDER BY pinned DESC, created_at DESC').all(projectId));
        } else {
            return deserRows(db.prepare('SELECT * FROM notes WHERE project_id IS NULL ORDER BY pinned DESC, created_at DESC').all());
        }
    } catch (err) {
        console.error('[Database] Error fetching notes:', err.message);
        return [];
    }
}

async function createNote({ project_id, content, category, source }) {
    if (!db) return null;
    try {
        const note = {
            id: crypto.randomUUID(),
            project_id: project_id || null,
            content,
            category: category || 'general',
            source: source || 'praxis',
            pinned: 0,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        };
        const { sql, values } = buildInsert('notes', note);
        db.prepare(sql).run(...values);
        return deserRow(db.prepare('SELECT * FROM notes WHERE id = ?').get(note.id));
    } catch (err) {
        console.error('[Database] Error creating note:', err.message);
        return null;
    }
}

async function updateNote(noteId, updates) {
    if (!db) return null;
    try {
        updates.updated_at = new Date().toISOString();
        const { sql, values } = buildUpdate('notes', { ...updates }, 'id', noteId);
        db.prepare(sql).run(...values);
        return deserRow(db.prepare('SELECT * FROM notes WHERE id = ?').get(noteId));
    } catch (err) {
        console.error('[Database] Error updating note:', err.message);
        return null;
    }
}

async function deleteNote(noteId) {
    if (!db) return false;
    try {
        db.prepare('DELETE FROM notes WHERE id = ?').run(noteId);
        return true;
    } catch (err) {
        console.error('[Database] Error deleting note:', err.message);
        return false;
    }
}

/**
 * Mark a note as ingested into The Cortex (Neo4j + Pinecone).
 * Stamps cortex_ingested_at with the current ISO timestamp.
 */
async function markNoteIngested(noteId) {
    if (!db) return null;
    try {
        db.prepare(
            'UPDATE notes SET cortex_ingested_at = ?, updated_at = ? WHERE id = ?'
        ).run(new Date().toISOString(), new Date().toISOString(), noteId);
        return deserRow(db.prepare('SELECT * FROM notes WHERE id = ?').get(noteId));
    } catch (err) {
        console.error('[Database] Error marking note ingested:', err.message);
        return null;
    }
}

/**
 * Get notes that have NOT been ingested into The Cortex.
 * Optionally filter by category (e.g., 'ingested', 'daily-log', 'revenue-ideas').
 */
async function getUningestedNotes(category = null) {
    if (!db) return [];
    try {
        if (category) {
            return deserRows(
                db.prepare(
                    'SELECT * FROM notes WHERE cortex_ingested_at IS NULL AND category = ? ORDER BY created_at DESC'
                ).all(category)
            );
        }
        return deserRows(
            db.prepare(
                'SELECT * FROM notes WHERE cortex_ingested_at IS NULL ORDER BY created_at DESC'
            ).all()
        );
    } catch (err) {
        console.error('[Database] Error fetching uningested notes:', err.message);
        return [];
    }
}

// ============================================================================
// CHAT CONVERSATIONS & MESSAGES (persistent Praxis / terminal chat history)
// ============================================================================

// No artificial message cap — we'll compress data as needed

/**
 * Get all conversations for a mode, newest first.
 */
async function getChatConversations(mode = 'praxis') {
    if (!db) return [];
    try {
        const rows = db.prepare(
            `SELECT c.*, 
                    (SELECT COUNT(*) FROM chat_messages WHERE conversation_id = c.id) as message_count,
                    (SELECT content FROM chat_messages WHERE conversation_id = c.id AND role = 'user' ORDER BY created_at ASC LIMIT 1) as first_message
             FROM chat_conversations c
             WHERE c.mode = ?
             ORDER BY c.updated_at DESC`
        ).all(mode);
        return rows.map(row => {
            row.is_active = row.is_active === 1 || row.is_active === true;
            return row;
        });
    } catch (err) {
        console.error('[Database] Error fetching conversations:', err.message);
        return [];
    }
}

/**
 * Get or create the active conversation for a mode.
 * If none exists, creates one automatically.
 */
async function getActiveConversation(mode = 'praxis') {
    if (!db) return null;
    try {
        let row = db.prepare(
            'SELECT * FROM chat_conversations WHERE mode = ? AND is_active = 1 ORDER BY updated_at DESC LIMIT 1'
        ).get(mode);
        if (!row) {
            // Auto-create first conversation
            row = await createConversation(mode);
        }
        if (row) row.is_active = row.is_active === 1 || row.is_active === true;
        return row;
    } catch (err) {
        console.error('[Database] Error getting active conversation:', err.message);
        return null;
    }
}

/**
 * Create a new conversation and mark it as active.
 * Deactivates any previously active conversation for the same mode.
 */
async function createConversation(mode = 'praxis', title = 'New Conversation') {
    if (!db) return null;
    try {
        // Deactivate all other conversations for this mode
        db.prepare('UPDATE chat_conversations SET is_active = 0 WHERE mode = ?').run(mode);

        const id = uuid();
        const timestamp = now();
        db.prepare(
            `INSERT INTO chat_conversations (id, title, mode, is_active, created_at, updated_at)
             VALUES (?, ?, ?, 1, ?, ?)`
        ).run(id, title, mode, timestamp, timestamp);

        return db.prepare('SELECT * FROM chat_conversations WHERE id = ?').get(id);
    } catch (err) {
        console.error('[Database] Error creating conversation:', err.message);
        return null;
    }
}

/**
 * Switch active conversation — deactivate all, activate the target.
 */
async function switchConversation(conversationId) {
    if (!db) return null;
    try {
        const conv = db.prepare('SELECT * FROM chat_conversations WHERE id = ?').get(conversationId);
        if (!conv) return null;

        // Deactivate all for this mode, activate the target
        db.prepare('UPDATE chat_conversations SET is_active = 0 WHERE mode = ?').run(conv.mode);
        db.prepare('UPDATE chat_conversations SET is_active = 1, updated_at = ? WHERE id = ?').run(now(), conversationId);

        return db.prepare('SELECT * FROM chat_conversations WHERE id = ?').get(conversationId);
    } catch (err) {
        console.error('[Database] Error switching conversation:', err.message);
        return null;
    }
}

/**
 * Update conversation title.
 */
async function updateConversationTitle(conversationId, title) {
    if (!db) return null;
    try {
        db.prepare('UPDATE chat_conversations SET title = ?, updated_at = ? WHERE id = ?').run(title, now(), conversationId);
        return db.prepare('SELECT * FROM chat_conversations WHERE id = ?').get(conversationId);
    } catch (err) {
        console.error('[Database] Error updating conversation title:', err.message);
        return null;
    }
}

/**
 * Delete a conversation and all its messages (CASCADE).
 */
async function deleteConversation(conversationId) {
    if (!db) return false;
    try {
        db.prepare('DELETE FROM chat_conversations WHERE id = ?').run(conversationId);
        return true;
    } catch (err) {
        console.error('[Database] Error deleting conversation:', err.message);
        return false;
    }
}

/**
 * Get messages for a specific conversation.
 * Supports pagination: options.limit and options.before (timestamp)
 * Returns messages in chronological (ASC) order, but fetches newest first.
 */
async function getChatMessages(conversationId, options = {}) {
    if (!db) return [];
    
    // Handle legacy call signature: getChatMessages(id, limit)
    let limit = 200;
    let before = null;
    
    if (typeof options === 'number') {
        limit = options;
    } else {
        limit = options.limit || 200;
        before = options.before || null;
    }

    try {
        let sql = 'SELECT * FROM chat_messages WHERE conversation_id = ?';
        const params = [conversationId];
        
        if (before) {
            sql += ' AND created_at < ?';
            params.push(before);
        }
        
        sql += ' ORDER BY created_at DESC LIMIT ?';
        params.push(limit);
        
        const rows = db.prepare(sql).all(...params);
        
        // Reverse to return in chronological order (ASC)
        return rows.reverse().map(row => {
            row.metadata = deser(row.metadata);
            return row;
        });
    } catch (err) {
        console.error('[Database] Error fetching chat messages:', err.message);
        return [];
    }
}

/**
 * Save a message to a conversation.
 * Auto-generates title from first user message.
 */
async function saveChatMessage(msg) {
    if (!db) return null;
    try {
        if (!msg.id) msg.id = uuid();
        if (!msg.created_at) msg.created_at = now();
        const conversationId = msg.conversation_id;
        if (!conversationId) {
            console.error('[Database] saveChatMessage: conversation_id is required');
            return null;
        }

        const row = {
            id: msg.id,
            conversation_id: conversationId,
            role: msg.role,
            content: msg.content,
            mode: msg.mode || 'praxis',
            metadata: ser(msg.metadata || {}),
            created_at: msg.created_at
        };

        const { sql, values } = buildInsert('chat_messages', row);
        db.prepare(sql).run(...values);

        // Auto-title: if this is the first user message, derive title from it
        if (msg.role === 'user') {
            const conv = db.prepare('SELECT title FROM chat_conversations WHERE id = ?').get(conversationId);
            if (conv && conv.title === 'New Conversation') {
                const autoTitle = msg.content.substring(0, 60) + (msg.content.length > 60 ? '...' : '');
                db.prepare('UPDATE chat_conversations SET title = ?, updated_at = ? WHERE id = ?')
                    .run(autoTitle, now(), conversationId);
            }
        }

        // Touch conversation updated_at
        db.prepare('UPDATE chat_conversations SET updated_at = ? WHERE id = ?').run(now(), conversationId);



        return row;
    } catch (err) {
        console.error('[Database] Error saving chat message:', err.message);
        return null;
    }
}

/**
 * Clear all messages in a conversation (but keep the conversation record).
 */
async function clearChatMessages(conversationId) {
    if (!db) return false;
    try {
        db.prepare('DELETE FROM chat_messages WHERE conversation_id = ?').run(conversationId);
        return true;
    } catch (err) {
        console.error('[Database] Error clearing chat messages:', err.message);
        return false;
    }
}

// ============================================================================
// ANTIGRAVITY EVENT STREAM
// ============================================================================

const AG_EVENTS_MAX_ROWS = 500; // Ring buffer — prune beyond this

/**
 * Record a new Antigravity event.
 * Auto-prunes old events beyond AG_EVENTS_MAX_ROWS.
 */
async function recordAgEvent({ event_type, severity, title, message, task_id, source, metadata, requires_action }) {
    if (!db) return null;
    try {
        const stmt = db.prepare(`
            INSERT INTO ag_events (event_type, severity, title, message, task_id, source, metadata, requires_action)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const info = stmt.run(
            event_type,
            severity || 'info',
            title,
            message || null,
            task_id || null,
            source || 'extension',
            ser(metadata || {}),
            requires_action ? 1 : 0
        );

        // Auto-prune: keep only the most recent AG_EVENTS_MAX_ROWS
        const count = db.prepare('SELECT COUNT(*) as cnt FROM ag_events').get().cnt;
        if (count > AG_EVENTS_MAX_ROWS) {
            db.prepare(`
                DELETE FROM ag_events WHERE id NOT IN (
                    SELECT id FROM ag_events ORDER BY id DESC LIMIT ?
                )
            `).run(AG_EVENTS_MAX_ROWS);
        }

        // Return the inserted row
        const row = db.prepare('SELECT * FROM ag_events WHERE id = ?').get(info.lastInsertRowid);
        return row ? deserRow(row) : { id: info.lastInsertRowid };
    } catch (err) {
        console.error('[Database] Error recording ag_event:', err.message);
        return null;
    }
}

/**
 * Get recent Antigravity events (for dashboard hydration).
 */
async function getRecentAgEvents(limit = 50) {
    if (!db) return [];
    try {
        const rows = db.prepare('SELECT * FROM ag_events ORDER BY id DESC LIMIT ?').all(limit);
        return deserRows(rows).reverse(); // Chronological order
    } catch (err) {
        console.error('[Database] Error fetching ag_events:', err.message);
        return [];
    }
}

/**
 * Mark an Antigravity event as actioned (user dismissed the alert).
 */
async function markAgEventActioned(id) {
    if (!db) return false;
    try {
        db.prepare('UPDATE ag_events SET action_taken = 1 WHERE id = ?').run(id);
        return true;
    } catch (err) {
        console.error('[Database] Error marking ag_event actioned:', err.message);
        return false;
    }
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
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
    // Models
    getModels,
    getModel,
    upsertModel,
    deleteModel,
    getDefaultModelForTask,
    // Usage
    recordUsage,
    getUsageStats,
    getDashboardStats,
    // NEW: Wrapper functions for audit-log, quotas, scopes, timeline, comments
    insertAuditLog,
    getAuditLogs,
    getAuditLogEntry,
    getQuota,
    upsertQuota,
    updateQuota,
    getMcpScopes,
    upsertMcpScope,
    deleteMcpScope,
    getExecutionSteps,
    insertExecutionStep,
    getInlineComments,
    insertInlineComment,
    updateInlineComment,
    // Dual-Payload Task Operations (Phase 1: Executive Planning)
    batchCreateTasks,
    getBoardState,
    reorderTasks,
    // Notes (Agent Scratchpad)
    getNotes,
    createNote,
    updateNote,
    deleteNote,
    markNoteIngested,
    getUningestedNotes,
    // Chat Conversations & Messages (persistent Praxis chat history)
    getChatConversations,
    getActiveConversation,
    createConversation,
    switchConversation,
    updateConversationTitle,
    deleteConversation,
    getChatMessages,
    saveChatMessage,
    clearChatMessages,
    // Antigravity Event Stream
    recordAgEvent,
    getRecentAgEvents,
    markAgEventActioned,
    // Push Notification Tokens
    registerPushToken,
    unregisterPushToken,
    getActivePushTokens,
    getAllPushTokens,
    markPushTokenSuccess,
    markPushTokenError
};

// ---------------------------------------------------------------------------
// Push Notification Tokens
// ---------------------------------------------------------------------------

async function registerPushToken({ token, deviceId, platform, label }) {
    if (!db) return null;
    try {
        // Upsert: if token exists, update metadata; otherwise insert
        const existing = db.prepare('SELECT id FROM push_tokens WHERE token = ?').get(token);
        if (existing) {
            db.prepare(`
                UPDATE push_tokens 
                SET device_id = COALESCE(?, device_id),
                    platform = COALESCE(?, platform),
                    label = COALESCE(?, label),
                    enabled = 1,
                    error_count = 0,
                    last_error = NULL,
                    updated_at = datetime('now')
                WHERE token = ?
            `).run(deviceId || null, platform || null, label || null, token);
            return { id: existing.id, token, updated: true };
        } else {
            const result = db.prepare(`
                INSERT INTO push_tokens (token, device_id, platform, label)
                VALUES (?, ?, ?, ?)
            `).run(token, deviceId || null, platform || 'android', label || null);
            return { id: result.lastInsertRowid, token, created: true };
        }
    } catch (err) {
        console.error('[Database] registerPushToken error:', err.message);
        return null;
    }
}

async function unregisterPushToken(token) {
    if (!db) return false;
    try {
        db.prepare('DELETE FROM push_tokens WHERE token = ?').run(token);
        return true;
    } catch (err) {
        console.error('[Database] unregisterPushToken error:', err.message);
        return false;
    }
}

async function getActivePushTokens() {
    if (!db) return [];
    try {
        return db.prepare('SELECT * FROM push_tokens WHERE enabled = 1').all();
    } catch (err) {
        console.error('[Database] getActivePushTokens error:', err.message);
        return [];
    }
}

async function markPushTokenSuccess(token) {
    if (!db) return;
    try {
        db.prepare(`
            UPDATE push_tokens 
            SET last_success_at = datetime('now'), error_count = 0, last_error = NULL, updated_at = datetime('now')
            WHERE token = ?
        `).run(token);
    } catch (err) {
        // Non-critical, just log
        console.warn('[Database] markPushTokenSuccess error:', err.message);
    }
}

async function markPushTokenError(token, errorMessage) {
    if (!db) return;
    try {
        const row = db.prepare('SELECT error_count FROM push_tokens WHERE token = ?').get(token);
        const newCount = (row?.error_count || 0) + 1;
        
        // Auto-disable after 10 consecutive failures
        const shouldDisable = newCount >= 10;
        
        db.prepare(`
            UPDATE push_tokens 
            SET last_error = ?, error_count = ?, enabled = ?, updated_at = datetime('now')
            WHERE token = ?
        `).run(errorMessage, newCount, shouldDisable ? 0 : 1, token);
        
        if (shouldDisable) {
            console.warn(`[Database] Push token auto-disabled after ${newCount} failures:`, token.substring(0, 30) + '...');
        }
    } catch (err) {
        console.warn('[Database] markPushTokenError error:', err.message);
    }
}

async function getAllPushTokens() {
    if (!db) return [];
    try {
        return db.prepare('SELECT * FROM push_tokens ORDER BY created_at DESC').all();
    } catch (err) {
        console.error('[Database] getAllPushTokens error:', err.message);
        return [];
    }
}
