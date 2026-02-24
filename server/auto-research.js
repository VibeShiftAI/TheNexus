// ============================================================================
// AUTOMATED FEATURE RESEARCH
// This module handles background AI-powered feature research
// ============================================================================

const path = require('path');
const fs = require('fs');
const { callAI } = require('./services/ai-service');

/**
 * Background function to research project features using Gemini
 * This runs asynchronously - does not block the HTTP response
 */
const db = require('../db');

const { createClient } = require('@supabase/supabase-js');
// No need to re-import createClient if we use the db module.

/**
 * Background function to research project features using Gemini
 * DB-based implementation
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

async function researchProjectTasks(projectPath, projectId, getProjectContext) {
    const db = require('../db');
    console.log(`[AutoResearch] Starting task research for project: ${projectId}`);

    if (!db.isDatabaseEnabled()) {
        console.warn('[AutoResearch] Database not enabled. Skipping research.');
        return;
    }

    try {
        console.log(`[AutoResearch] Calling Gemini for project: ${projectId}`);

        // Get project context
        const context = getProjectContext(projectPath);

        // Fetch existing tasks from DB for context
        const existingTasks = await db.getTasks(projectId);
        const plannedTasks = existingTasks.filter(f => ['planned', 'planning', 'implementing'].includes(f.status));
        const completedTasks = existingTasks.filter(f => ['complete'].includes(f.status));
        const rejectedTasks = existingTasks.filter(f => ['rejected', 'cancelled'].includes(f.status));

        // Build the prompt
        // Re-using logic but mapped to DB objects
        const prompt = buildAutoResearchPrompt(context, {
            existingTasks: existingTasks.map(f => f.name),
            plannedTasks,
            rejectedTasks,
            completedTasks,
            projectName: context.metadata.name || projectId,
            projectDescription: context.metadata.description || '',
            projectType: context.metadata.type || 'unknown'
        });

        // Call AI Service (using 'quick' profile which defaults to Flash model)
        const responseText = await callAI(
            'quick', 
            prompt, 
            null, 
            [], 
            { generationConfig: { responseMimeType: 'application/json' } }
        );

        // Parse JSON
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
            return;
        }

        if (!Array.isArray(suggestedTasks)) suggestedTasks = [suggestedTasks];

        // Save to DB
        console.log(`[AutoResearch] Generated ${suggestedTasks.length} new tasks for ${projectId}`);

        for (const task of suggestedTasks.slice(0, 3)) {
            await db.createTask({
                project_id: projectId,
                title: task.title || task.name || 'New Task',
                description: task.description || '',
                status: 'idea',
                priority: 0,
                // store origin info in metadata if needed
                metadata: { source: 'auto-research' }
            });
        }

        console.log(`[AutoResearch] Successfully saved tasks to DB`);

    } catch (error) {
        console.error(`[AutoResearch] Error researching tasks for ${projectId}:`, error);
        // We don't have a place to store "research error" on the project anymore without modifying schema further.
        // Logging is sufficient for background tasks.
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
        // Since we don't track ephemeral research status in DB, just return 'idle' 
        // or check if 'idea' tasks were recently created?
        // Simpler to just say idle so UI doesn't block.
        res.json({ status: 'idle' });
    });
}

module.exports = { setupResearchRoutes, researchProjectTasks };
