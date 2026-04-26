// Suppress dotenv verbose logging to stdout which breaks MCP protocol (JSON-RPC)
// dotenv 17.x logs to stdout directly, so we must set DOTENV_CONFIG_QUIET before requiring
process.env.DOTENV_CONFIG_QUIET = 'true';
const path = require('path');
// Use explicit path to .env so it loads correctly regardless of working directory
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { z } = require("zod");
const fs = require('fs');
const db = require('../db');

// Initialize MCP Server
const server = new McpServer({
    name: "Local Nexus",
    version: "1.0.0"
});

// Default project root (same as server.js)
const PROJECT_ROOT = process.env.PROJECT_ROOT || path.resolve(process.env.USERPROFILE || process.env.HOME, 'Projects');

// --- RESOURCES ---

// List all projects
server.resource(
    "projects",
    "projects://list",
    async (uri) => {
        const projects = await db.getProjects();
        return {
            contents: [{
                uri: uri.href,
                text: JSON.stringify(projects, null, 2),
                mimeType: "application/json"
            }]
        };
    }
);

// --- TOOLS ---

// Scaffold a new project
server.tool(
    "scaffold_new_vibe",
    {
        name: z.string().describe("The name of the project (e.g. 'SpaceHopper')"),
        type: z.enum(["web-app", "game", "tool"]).describe("The type of project to create")
    },
    async ({ name, type }) => {
        // 1. Validate inputs
        if (!name || !name.match(/^[a-zA-Z0-9-_]+$/)) {
            return {
                content: [{ type: "text", text: "Error: Invalid project name. Use only letters, numbers, dashes, and underscores." }],
                isError: true
            };
        }

        const projectPath = path.join(PROJECT_ROOT, name);

        // 2. Check if exists
        if (fs.existsSync(projectPath)) {
            return {
                content: [{ type: "text", text: `Error: Project '${name}' already exists at ${projectPath}` }],
                isError: true
            };
        }

        // 3. Create directory
        try {
            fs.mkdirSync(projectPath, { recursive: true });

            // 4. Initialize Metadata (Sync to DB)
            if (db.isDatabaseEnabled()) {
                await db.upsertProject({
                    name: name,
                    path: projectPath,
                    type: type,
                    description: "",
                    vibe: "immaculate"
                });
            }

            // 5. Initialize npm and git
            const { execSync } = require('child_process');
            execSync('npm init -y', { cwd: projectPath, stdio: 'ignore' });

            const simpleGit = require('simple-git');
            const git = simpleGit(projectPath);
            await git.init();

            return {
                content: [{
                    type: "text",
                    text: `Successfully created project '${name}' (${type}) at ${projectPath}.\nInitialized git and npm.`
                }]
            };

        } catch (error) {
            return {
                content: [{ type: "text", text: `Failed to create project: ${error.message}` }],
                isError: true
            };
        }
    }
);

// Initialize git in an existing project
server.tool(
    "init_git",
    {
        project_name: z.string().describe("The name or ID of the existing project to initialize git in")
    },
    async ({ project_name }) => {
        const project = await db.getProject(project_name);

        if (!project) {
            return {
                content: [{ type: "text", text: `Error: Project '${project_name}' not found.` }],
                isError: true
            };
        }

        const gitPath = path.join(project.path, '.git');
        if (fs.existsSync(gitPath)) {
            return {
                content: [{ type: "text", text: `Git already initialized in '${project.name}'.` }],
                isError: false
            };
        }

        try {
            const simpleGit = require('simple-git');
            const git = simpleGit(project.path);
            await git.init();

            return {
                content: [{
                    type: "text",
                    text: `Successfully initialized git in '${project.name}' at ${project.path}.`
                }]
            };
        } catch (error) {
            return {
                content: [{ type: "text", text: `Failed to initialize git: ${error.message}` }],
                isError: true
            };
        }
    }
);

// Add remote to an existing project
server.tool(
    "add_remote",
    {
        project_name: z.string().describe("The name or ID of the project to add a remote to"),
        remote_url: z.string().describe("The git remote URL (e.g., git@github.com:user/repo.git)")
    },
    async ({ project_name, remote_url }) => {
        // Validate URL format
        const validUrlPattern = /^(https?:\/\/|git@|ssh:\/\/)/;
        if (!validUrlPattern.test(remote_url)) {
            return {
                content: [{ type: "text", text: `Error: Invalid remote URL. Must start with https://, git@, or ssh://.` }],
                isError: true
            };
        }

        const project = await db.getProject(project_name);

        if (!project) {
            return {
                content: [{ type: "text", text: `Error: Project '${project_name}' not found.` }],
                isError: true
            };
        }

        const gitPath = path.join(project.path, '.git');
        if (!fs.existsSync(gitPath)) {
            return {
                content: [{ type: "text", text: `Error: Git is not initialized in '${project.name}'. Run init_git first.` }],
                isError: true
            };
        }

        try {
            const simpleGit = require('simple-git');
            const git = simpleGit(project.path);

            // Check if 'origin' remote already exists
            const remotes = await git.getRemotes(true);
            const existingOrigin = remotes.find(r => r.name === 'origin');

            if (existingOrigin) {
                // Update the existing remote URL instead of failing
                await git.remote(['set-url', 'origin', remote_url]);
                return {
                    content: [{
                        type: "text",
                        text: `Remote 'origin' already existed in '${project.name}'. Updated URL from '${existingOrigin.refs.push}' to '${remote_url}'.`
                    }]
                };
            }

            await git.addRemote('origin', remote_url);

            return {
                content: [{
                    type: "text",
                    text: `Successfully added remote 'origin' (${remote_url}) to '${project.name}'.`
                }]
            };
        } catch (error) {
            return {
                content: [{ type: "text", text: `Failed to add remote: ${error.message}` }],
                isError: true
            };
        }
    }
);

// Commit and push changes
server.tool(
    "commit_and_push",
    {
        project_name: z.string().describe("The name or ID of the project to commit and push"),
        message: z.string().describe("The commit message").default("Auto-commit from Nexus dashboard"),
        force: z.boolean().describe("Force commit even if walkthroughs are missing (for infrastructure commits)").default(false)
    },
    async ({ project_name, message, force }) => {
        const project = await db.getProject(project_name);

        if (!project) {
            return {
                content: [{ type: "text", text: `Error: Project '${project_name}' not found.` }],
                isError: true
            };
        }

        // Walkthrough gate: Refuse commit if active tasks lack walkthroughs
        if (!force) {
            try {
                const tasks = await db.getTasks(project.id);
                const activeTasks = (tasks || []).filter(t =>
                    ['building', 'testing', 'ready_for_review', 'complete'].includes(t.status)
                );
                const missingWalkthrough = activeTasks.filter(t => !t.walkthrough);

                if (missingWalkthrough.length > 0) {
                    const taskList = missingWalkthrough
                        .map(t => `  - "${t.title}" (status: ${t.status})`)
                        .join('\n');
                    return {
                        content: [{
                            type: "text",
                            text: `⚠️ WALKTHROUGH GATE: Cannot commit. The following tasks have no walkthrough:\n${taskList}\n\nA walkthrough is required before committing. Use force=true to bypass (for infrastructure commits only).`
                        }],
                        isError: true
                    };
                }
            } catch (err) {
                // Don't block on DB errors, just warn
                console.error(`[MCP] Walkthrough gate check failed: ${err.message}`);
            }
        }

        const gitPath = path.join(project.path, '.git');
        if (!fs.existsSync(gitPath)) {
            return {
                content: [{ type: "text", text: `Error: No git repository in '${project.name}'.` }],
                isError: true
            };
        }

        try {
            const simpleGit = require('simple-git');
            const git = simpleGit(project.path);

            // Stage all changes
            await git.add('.');

            // Get status to see what's being committed
            const status = await git.status();
            if (status.files.length === 0) {
                return {
                    content: [{ type: "text", text: `No changes to commit in '${project.name}'.` }],
                    isError: false
                };
            }

            // Commit
            await git.commit(message);

            // Check if remote exists
            const remotes = await git.getRemotes();
            if (remotes.length === 0) {
                return {
                    content: [{
                        type: "text",
                        text: `Committed ${status.files.length} file(s) in '${project.name}', but no remote configured. Push skipped.`
                    }],
                    isError: false
                };
            }

            // Push
            await git.push('origin', status.current);

            return {
                content: [{
                    type: "text",
                    text: `Successfully committed and pushed ${status.files.length} file(s) in '${project.name}'.\nMessage: "${message}"`
                }]
            };
        } catch (error) {
            return {
                content: [{ type: "text", text: `Failed to commit/push: ${error.message}` }],
                isError: true
            };
        }
    }
);

// ============================================================================
// EXECUTIVE PLANNING TOOLS (Phase 1: Dual-Payload Task Management)
// ============================================================================

// Standard task statuses — any string is accepted, but these are the defaults
const STANDARD_TASK_STATUSES = [
    'idea', 'todo', 'planning', 'building', 'testing', 'ready_for_review', 'complete', 'rejected', 'cancelled'
];

/**
 * nexus_get_board_state — Read project/task state with dependency resolution.
 * Returns active projects with their tasks annotated with `is_unblocked` status.
 */
server.tool(
    "nexus_get_board_state",
    {
        project_id: z.string().optional().describe(
            "Optional project ID to filter. Omit to get all active projects."
        )
    },
    async ({ project_id }) => {
        try {
            const boardState = await db.getBoardState(project_id || undefined);

            if (boardState.length === 0) {
                return {
                    content: [{
                        type: "text",
                        text: project_id
                            ? `No project found with ID '${project_id}'.`
                            : "No active projects found."
                    }],
                    isError: false
                };
            }

            return {
                content: [{
                    type: "text",
                    text: JSON.stringify(boardState, null, 2)
                }]
            };
        } catch (error) {
            return {
                content: [{ type: "text", text: `Failed to get board state: ${error.message}` }],
                isError: true
            };
        }
    }
);

/**
 * nexus_batch_create_tasks — Create multiple tasks in a single atomic transaction.
 * Supports dual-payload: human layer (title/description) + machine layer (antigravity_payload).
 */
server.tool(
    "nexus_batch_create_tasks",
    {
        project_id: z.string().describe("The project ID to create tasks in."),
        tasks: z.array(z.object({
            name: z.string().describe("Human-readable task title."),
            description: z.string().optional().describe("Human-readable task description."),
            status: z.string().optional().default("planning").describe(
                "Initial status. Default: 'planning'."
            ),
            priority: z.number().optional().default(1).describe(
                "Priority (1=normal, 2=high, 3=critical). Default: 1."
            ),
            antigravity_payload: z.object({
                prompt: z.string().describe("The exact, hyper-specific prompt for AntiGravity."),
                workspace: z.string().optional().describe("Target workspace path."),
                target_files: z.array(z.string()).optional().describe("Files to create/modify."),
                context_files: z.array(z.string()).optional().describe("Files to read for context."),
                commands: z.array(z.string()).optional().describe("CLI commands to run (build, test, etc.)."),
                acceptance_criteria: z.array(z.string()).optional().describe("How to verify success.")
            }).optional().describe("Machine-layer execution instructions for AntiGravity."),
            dependencies: z.array(z.string()).optional().default([]).describe(
                "Array of task IDs (from this batch or existing) that must complete first. " +
                "Use stable placeholder IDs like 'task-1', 'task-2' for within-batch references."
            ),
            stable_id: z.string().optional().describe(
                "Optional stable ID for within-batch dependency references. " +
                "Other tasks in this batch can reference this ID in their dependencies array."
            )
        })).describe("Array of tasks to create (max 50 per batch).")
    },
    async ({ project_id, tasks }) => {
        try {
            // Validate project exists
            const project = await db.getProject(project_id);
            if (!project) {
                return {
                    content: [{ type: "text", text: `Project '${project_id}' not found.` }],
                    isError: true
                };
            }

            // Cap batch size
            if (tasks.length > 50) {
                return {
                    content: [{ type: "text", text: `Batch too large (${tasks.length}). Max 50 tasks per batch.` }],
                    isError: true
                };
            }

            // Resolve stable_id references to real UUIDs
            const { v4: uuidv4 } = require('uuid');
            const stableIdToRealId = new Map();

            // Pre-assign real IDs for tasks with stable_id
            const preparedTasks = tasks.map(task => {
                const realId = uuidv4();
                if (task.stable_id) {
                    stableIdToRealId.set(task.stable_id, realId);
                }
                return { ...task, id: realId, project_id };
            });

            // Resolve dependency references
            for (const task of preparedTasks) {
                if (task.dependencies && task.dependencies.length > 0) {
                    task.dependencies = task.dependencies.map(depId =>
                        stableIdToRealId.get(depId) || depId  // Resolve or keep as-is (existing task ID)
                    );
                }
                // Remove stable_id before DB insert (not a real column)
                delete task.stable_id;
            }

            // Batch insert
            const created = await db.batchCreateTasks(preparedTasks);

            return {
                content: [{
                    type: "text",
                    text: JSON.stringify({
                        success: true,
                        project: project.name,
                        created_count: created.length,
                        tasks: created.map(t => ({
                            id: t.id,
                            name: t.name,
                            status: t.status,
                            has_payload: !!t.antigravity_payload,
                            dependencies: t.dependencies || []
                        }))
                    }, null, 2)
                }]
            };
        } catch (error) {
            return {
                content: [{ type: "text", text: `Failed to batch-create tasks: ${error.message}` }],
                isError: true
            };
        }
    }
);

/**
 * nexus_update_project — Update a project's metadata (status, priority, description, etc.)
 * Used by the chief-of-staff skill to manage daily focus rotation.
 */
const VALID_PROJECT_STATUSES = ['active', 'paused', 'archived'];

server.tool(
    "nexus_update_project",
    {
        project_id: z.string().describe("The project ID to update."),
        status: z.string().optional().describe(
            `Project status. Valid: ${VALID_PROJECT_STATUSES.join(', ')}`
        ),
        priority: z.number().optional().describe(
            "Numeric priority (higher = more important). Used for daily focus selection."
        ),
        description: z.string().optional().describe("Updated project description."),
        end_state: z.string().optional().describe("Desired end-state for goal-regression planning.")
    },
    async ({ project_id, status, priority, description, end_state }) => {
        try {
            // Validate project exists
            const existing = await db.getProject(project_id);
            if (!existing) {
                return {
                    content: [{ type: "text", text: `Project '${project_id}' not found.` }],
                    isError: true
                };
            }

            // Validate status if provided
            if (status && !VALID_PROJECT_STATUSES.includes(status)) {
                return {
                    content: [{
                        type: "text",
                        text: `Invalid status '${status}'. Valid: ${VALID_PROJECT_STATUSES.join(', ')}`
                    }],
                    isError: true
                };
            }

            // Build updates object
            const updates = {};
            if (status) updates.status = status;
            if (priority !== undefined) updates.priority = priority;
            if (description) updates.description = description;
            if (end_state) updates.end_state = end_state;

            if (Object.keys(updates).length === 0) {
                return {
                    content: [{ type: "text", text: "No updates provided. Specify at least one of: status, priority, description, end_state." }],
                    isError: true
                };
            }

            const updated = await db.updateProject(project_id, updates);
            if (!updated) {
                return {
                    content: [{ type: "text", text: `Failed to update project '${project_id}'.` }],
                    isError: true
                };
            }

            return {
                content: [{
                    type: "text",
                    text: JSON.stringify({
                        success: true,
                        project: {
                            id: updated.id,
                            name: updated.name,
                            status: updated.status,
                            priority: updated.priority,
                            end_state: updated.end_state,
                            updated_at: updated.updated_at
                        }
                    }, null, 2)
                }]
            };
        } catch (error) {
            return {
                content: [{ type: "text", text: `Failed to update project: ${error.message}` }],
                isError: true
            };
        }
    }
);

/**
 * nexus_update_task_status — Update a task's status with validation.
 * Free transitions allowed, but status must be a known value.
 */
server.tool(
    "nexus_update_task_status",
    {
        task_id: z.string().describe("The task ID to update."),
        status: z.string().describe(
            `New status. Standard stages: ${STANDARD_TASK_STATUSES.join(', ')}. Custom ad-hoc stages are also accepted.`
        ),
        note: z.string().optional().describe(
            "Optional note explaining the status change (stored in description append)."
        )
    },
    async ({ task_id, status, note }) => {
        try {
            // Log a warning for non-standard statuses, but allow them
            if (!STANDARD_TASK_STATUSES.includes(status)) {
                console.log(`[MCP] nexus_update_task_status: Using custom ad-hoc status '${status}' for task ${task_id}`);
            }

            // Check task exists
            const existing = await db.getTask(task_id);
            if (!existing) {
                return {
                    content: [{ type: "text", text: `Task '${task_id}' not found.` }],
                    isError: true
                };
            }

            const updates = { status };

            // Append note to description if provided
            if (note) {
                const timestamp = new Date().toISOString();
                const existingDesc = existing.description || '';
                updates.description = existingDesc +
                    `\n\n---\n**[${timestamp}]** Status → ${status}: ${note}`;
            }

            const updated = await db.updateTask(task_id, updates);

            return {
                content: [{
                    type: "text",
                    text: JSON.stringify({
                        success: true,
                        task_id: updated.id,
                        name: updated.name,
                        previous_status: existing.status,
                        new_status: updated.status,
                        project_id: updated.project_id
                    }, null, 2)
                }]
            };
        } catch (error) {
            return {
                content: [{ type: "text", text: `Failed to update task status: ${error.message}` }],
                isError: true
            };
        }
    }
);

// ============================================================================
// QA INSPECTION TOOLS (Phase 2: CEO Review Loop)
// ============================================================================

/**
 * nexus_get_task — Retrieve a single task by ID.
 * Used by the QA reviewer to read acceptance_criteria without pulling full board state.
 */
server.tool(
    "nexus_get_task",
    {
        task_id: z.string().describe("The task ID (UUID) to retrieve.")
    },
    async ({ task_id }) => {
        try {
            const task = await db.getTask(task_id);
            if (!task) {
                return {
                    content: [{ type: "text", text: `Task '${task_id}' not found.` }],
                    isError: true
                };
            }

            return {
                content: [{
                    type: "text",
                    text: JSON.stringify(task, null, 2)
                }]
            };
        } catch (error) {
            return {
                content: [{ type: "text", text: `Failed to get task: ${error.message}` }],
                isError: true
            };
        }
    }
);

/**
 * git_get_diff — Read uncommitted code changes in a workspace.
 * Runs `git diff HEAD` for modifications and `git ls-files --others --exclude-standard`
 * for new untracked files. Output is truncated to ~10,000 chars to protect LLM context.
 */
server.tool(
    "git_get_diff",
    {
        project_path: z.string().describe(
            "Absolute path to the workspace/project directory (e.g., '/Volumes/Projects/TheNexus')."
        )
    },
    async ({ project_path }) => {
        const { execSync } = require('child_process');
        const MAX_CHARS = 10000;

        // Validate the path exists and has a .git directory
        const gitDir = path.join(project_path, '.git');
        if (!fs.existsSync(gitDir)) {
            return {
                content: [{ type: "text", text: `No git repository found at '${project_path}'.` }],
                isError: true
            };
        }

        try {
            // Get staged + unstaged modifications
            let diff = '';
            try {
                diff = execSync('git diff HEAD', {
                    cwd: project_path,
                    encoding: 'utf-8',
                    maxBuffer: 1024 * 1024, // 1MB buffer
                    timeout: 15000
                });
            } catch (e) {
                // git diff HEAD fails on repos with no commits yet — try git diff --cached
                diff = execSync('git diff --cached', {
                    cwd: project_path,
                    encoding: 'utf-8',
                    maxBuffer: 1024 * 1024,
                    timeout: 15000
                });
            }

            // Get new untracked files
            const untracked = execSync('git ls-files --others --exclude-standard', {
                cwd: project_path,
                encoding: 'utf-8',
                maxBuffer: 512 * 1024,
                timeout: 10000
            }).trim();

            // Build combined output
            let output = '';

            if (diff) {
                output += `=== MODIFIED FILES (git diff HEAD) ===\n\n${diff}`;
            }

            if (untracked) {
                const files = untracked.split('\n').filter(Boolean);
                output += `\n\n=== NEW UNTRACKED FILES (${files.length}) ===\n`;
                output += files.map(f => `  + ${f}`).join('\n');
            }

            if (!output.trim()) {
                return {
                    content: [{ type: "text", text: "No uncommitted changes found in this workspace." }]
                };
            }

            // Truncation safeguard
            let truncated = false;
            if (output.length > MAX_CHARS) {
                output = output.substring(0, MAX_CHARS);
                output += '\n\n--- [TRUNCATED: Output exceeded 10,000 characters] ---';
                truncated = true;
            }

            return {
                content: [{
                    type: "text",
                    text: truncated
                        ? `⚠️ Output truncated to ${MAX_CHARS} chars. Full diff is larger.\n\n${output}`
                        : output
                }]
            };
        } catch (error) {
            return {
                content: [{ type: "text", text: `Failed to get git diff: ${error.message}` }],
                isError: true
            };
        }
    }
);

// ============================================================================
// RESOURCE TELEMETRY (Phase 3: Dynamic Calendar)
// ============================================================================

/**
 * nexus_get_system_resources — Token budget dashboard.
 * Queries usage_stats (today's burn), usage_quotas (daily limits/resets),
 * and models (available routing options). Returns a budget summary.
 * Budget % is based on PRAXIS-ONLY usage.
 */
server.tool(
    "nexus_get_system_resources",
    "Get token budget, quota resets, and available models for resource-aware scheduling.",
    {},
    async () => {
        try {
            // 1. Today's token burn — aggregate across all models and sources
            const today = new Date().toISOString().split('T')[0];
            const usageRows = await db.getUsageStats(today, today);
            let tokensUsedToday = 0;
            let inputTokensToday = 0;
            let outputTokensToday = 0;
            let requestCountToday = 0;
            const breakdownByModel = {};

            let praxisTokensToday = 0;
            let praxisInputToday = 0;
            let praxisOutputToday = 0;
            let praxisRequestsToday = 0;
            const breakdownBySource = {};

            for (const row of usageRows) {
                const total = Number(row.total_tokens) || 0;
                const input = Number(row.input_tokens) || 0;
                const output = Number(row.output_tokens) || 0;
                const requests = Number(row.request_count) || 0;
                const source = row.source || 'unknown';

                tokensUsedToday += total;
                inputTokensToday += input;
                outputTokensToday += output;
                requestCountToday += requests;
                if (row.model) {
                    breakdownByModel[row.model] = (breakdownByModel[row.model] || 0) + total;
                }

                if (!breakdownBySource[source]) {
                    breakdownBySource[source] = { tokens: 0, input: 0, output: 0, requests: 0 };
                }
                breakdownBySource[source].tokens += total;
                breakdownBySource[source].input += input;
                breakdownBySource[source].output += output;
                breakdownBySource[source].requests += requests;

                if (source === 'praxis') {
                    praxisTokensToday += total;
                    praxisInputToday += input;
                    praxisOutputToday += output;
                    praxisRequestsToday += requests;
                }
            }

            // 2. Quota data — check for daily limits
            let dailyLimit = 4_000_000; // default fallback
            let quotaSource = 'default';

            const quotaEndpoints = ['anthropic', 'google', 'openai', 'default'];
            for (const endpoint of quotaEndpoints) {
                const quota = await db.getQuota(endpoint, 'daily');
                if (quota) {
                    dailyLimit = Number(quota.max_requests) || dailyLimit;
                    quotaSource = endpoint;
                    break;
                }
            }

            // Always compute fresh reset time (tomorrow midnight UTC)
            const tomorrow = new Date();
            tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
            tomorrow.setUTCHours(0, 0, 0, 0);
            const nextResetTimestamp = tomorrow.toISOString();

            // 3. Available models
            let availableModels = [];
            try {
                const models = await db.getModels(true);
                availableModels = models.map(m => ({
                    id: m.id,
                    name: m.name || m.id,
                    provider: m.provider || 'unknown',
                    is_default: !!m.is_default
                }));
            } catch {
                // Models table might not have data
            }

            // 4. Budget based on PRAXIS-ONLY usage
            const budgetPercentage = Math.round((praxisTokensToday / dailyLimit) * 1000) / 10;
            const budgetStatus = budgetPercentage >= 80 ? 'critical' : 'safe';

            const result = {
                praxis_tokens_today: praxisTokensToday,
                praxis_input_today: praxisInputToday,
                praxis_output_today: praxisOutputToday,
                praxis_requests_today: praxisRequestsToday,
                tokens_used_today: tokensUsedToday,
                input_tokens_today: inputTokensToday,
                output_tokens_today: outputTokensToday,
                request_count_today: requestCountToday,
                daily_limit: dailyLimit,
                budget_percentage: budgetPercentage,
                budget_status: budgetStatus,
                quota_source: quotaSource,
                next_reset_timestamp: nextResetTimestamp,
                available_models: availableModels,
                breakdown_by_model: breakdownByModel,
                breakdown_by_source: breakdownBySource,
                assessed_at: new Date().toISOString()
            };

            return {
                content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
            };
        } catch (error) {
            return {
                content: [{ type: "text", text: `Failed to get system resources: ${error.message}` }],
                isError: true
            };
        }
    }
);

// Start the server
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Local Nexus MCP Server running on stdio");
}

main().catch((error) => {
    console.error("Fatal error in main():", error);
    process.exit(1);
});
