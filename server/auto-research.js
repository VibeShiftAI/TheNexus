// ============================================================================
// AUTOMATED FEATURE RESEARCH
// This module handles background AI-powered task suggestion via LLM analysis
// ============================================================================

const path = require('path');
const fs = require('fs');
const { callAI } = require('./services/ai-service');
const db = require('../db');

// In-memory status tracking for active research sessions
const researchStatus = new Map();

/**
 * Build the prompt for auto-research task suggestion
 */
function buildAutoResearchPrompt(context, taskInfo) {
    const contextText = typeof context === 'object' ? JSON.stringify(context, null, 2) : context;

    return `You are an expert product manager and software architect.
Your goal is to suggest 3 high-impact tasks for the following project.

PROJECT CONTEXT:
${contextText}

PROJECT METADATA:
Name: ${taskInfo.projectName}
Type: ${taskInfo.projectType}
Description: ${taskInfo.projectDescription}

EXISTING TASKS:
${taskInfo.existingTasks.join(', ') || 'None'}

IN PROGRESS / PLANNED:
${taskInfo.plannedTasks.map(f => f.name).join(', ') || 'None'}

INSTRUCTIONS:
1. Analyze the project codebase and existing tasks.
2. Identify 3 logical next tasks that would improve the product.
3. Suggest tasks that are feasible given the current codebase.
4. Avoid duplicating existing or planned tasks.

OUTPUT FORMAT:
Return a JSON array of objects with the following structure:
[
  {
    "title": "Task Name",
    "description": "Detailed description of the task and why it is valuable."
  }
]
`;
}

/**
 * Background function to research and suggest tasks for a project
 * Runs asynchronously — does not block the HTTP response
 */
async function researchProjectTasks(projectPath, projectId, getProjectContext) {
    console.log(`[AutoResearch] Starting task research for project: ${projectId}`);

    if (!db.isDatabaseEnabled()) {
        console.warn('[AutoResearch] Database not enabled. Skipping research.');
        researchStatus.set(projectId, { status: 'error', error: 'Database not enabled' });
        return;
    }

    researchStatus.set(projectId, { status: 'researching', startedAt: new Date().toISOString() });

    try {
        console.log(`[AutoResearch] Calling AI for project: ${projectId}`);

        // Get project context (returns object with fileTree, metadata, sourceCode)
        const context = getProjectContext(projectPath);

        // Parse project metadata from the raw JSON string
        let projectMeta = {};
        if (context.metadata?.projectJson) {
            try {
                projectMeta = JSON.parse(context.metadata.projectJson);
            } catch (e) {
                console.warn('[AutoResearch] Failed to parse project.json:', e.message);
            }
        }

        // Also check package.json as fallback for name/description
        let packageMeta = {};
        if (context.metadata?.packageJson) {
            try {
                packageMeta = JSON.parse(context.metadata.packageJson);
            } catch (e) {
                // Ignore parse errors
            }
        }

        // Fetch existing tasks from DB for context
        const existingTasks = await db.getTasks(projectId);
        const plannedTasks = existingTasks.filter(f => ['planned', 'planning', 'implementing'].includes(f.status));
        const completedTasks = existingTasks.filter(f => ['complete'].includes(f.status));
        const rejectedTasks = existingTasks.filter(f => ['rejected', 'cancelled'].includes(f.status));

        // Build the prompt with properly extracted metadata
        const prompt = buildAutoResearchPrompt(context, {
            existingTasks: existingTasks.map(f => f.name),
            plannedTasks,
            rejectedTasks,
            completedTasks,
            projectName: projectMeta.name || packageMeta.name || projectId,
            projectDescription: projectMeta.description || packageMeta.description || '',
            projectType: projectMeta.type || 'unknown'
        });

        // Call AI Service (using 'quick' profile which defaults to Flash model)
        const responseText = await callAI('quick', prompt);

        // Parse JSON response
        let suggestedTasks = [];
        try {
            const jsonMatch = responseText.match(/\[[\s\S]*\]/);
            if (jsonMatch) {
                suggestedTasks = JSON.parse(jsonMatch[0]);
            } else {
                suggestedTasks = JSON.parse(responseText);
            }
        } catch (e) {
            console.error('[AutoResearch] Failed to parse JSON:', e);
            console.log('[AutoResearch] Raw response:', responseText);
            researchStatus.set(projectId, { status: 'error', error: 'Failed to parse AI response' });
            return;
        }

        if (!Array.isArray(suggestedTasks)) suggestedTasks = [suggestedTasks];

        // Save to DB — use `name` (the actual DB column), not `title`
        console.log(`[AutoResearch] Generated ${suggestedTasks.length} new tasks for ${projectId}`);

        for (const task of suggestedTasks.slice(0, 3)) {
            await db.createTask({
                project_id: projectId,
                name: task.title || task.name || 'New Task',
                description: task.description || '',
                status: 'idea',
                priority: 0,
                metadata: { source: 'auto-research' }
            });
        }

        console.log(`[AutoResearch] Successfully saved ${suggestedTasks.length} tasks to DB`);
        researchStatus.set(projectId, { status: 'completed', completedAt: new Date().toISOString() });

        // Clear status after 60 seconds so it doesn't persist forever
        setTimeout(() => researchStatus.delete(projectId), 60000);

    } catch (error) {
        console.error(`[AutoResearch] Error researching tasks for ${projectId}:`, error);
        researchStatus.set(projectId, { status: 'error', error: error.message });
    }
}

/**
 * Setup the research routes
 */
function setupResearchRoutes(app, getProjectById, PROJECT_ROOT, getProjectContext) {
    // POST /api/projects/:id/tasks/research - Trigger automated task research
    app.post('/api/projects/:id/tasks/research', async (req, res) => {
        const { id } = req.params;

        console.log(`[AutoResearch] Received request for ${id}`);

        const project = await getProjectById(PROJECT_ROOT, id);
        if (!project) return res.status(404).json({ error: 'Project not found' });

        // Trigger background research
        researchProjectTasks(project.path, id, getProjectContext)
            .catch(err => console.error(`[AutoResearch] Background error:`, err));

        // Return immediately
        res.status(202).json({
            success: true,
            message: 'Task research started',
            status: 'researching'
        });
    });

    // GET /api/projects/:id/tasks/research/status - Check research status
    app.get('/api/projects/:id/tasks/research/status', async (req, res) => {
        const { id } = req.params;
        const entry = researchStatus.get(id);

        if (entry) {
            res.json({
                status: entry.status,
                error: entry.error || null,
                lastResearchDate: entry.completedAt || entry.startedAt || null
            });
        } else {
            res.json({ status: 'idle', error: null, lastResearchDate: null });
        }
    });
}

module.exports = { setupResearchRoutes, researchProjectTasks };
