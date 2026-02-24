/**
 * Auto-Documentation Service
 * 
 * Automatically updates project documentation (README, maps, schemas) when tasks are completed.
 * Triggers when a task status changes to 'complete'.
 */

const fs = require('fs');
const path = require('path');
const { GoogleGenAI } = require('@google/genai');
const db = require('../../db');

/**
 * Get agent configuration from environment (no longer uses database)
 */
function getDocAgentConfig() {
    return {
        defaultModel: process.env.DOC_AGENT_MODEL || 'gemini-2.5-flash',
        systemPrompt: null // Use built-in prompt
    };
}

/**
 * Update project documentation for a completed task
 * @param {string} projectPath - Path to the project
 * @param {object} task - Completed task object
 * @param {object} project - Project info
 */
async function updateDocumentationForTask(projectPath, task, project) {
    console.log(`[AutoDoc] Starting documentation update for task: ${task.title || task.name}`);

    if (!db.isDatabaseEnabled()) {
        console.warn('[AutoDoc] Database not enabled. specialized doc updates requiring DB are skipped.');
        // Fallback to legacy README update if needed, but for now we assume DB is primary
        return { success: false, reason: 'Database required for enhanced docs' };
    }

    try {
        // 1. Fetch all existing project contexts (maps, schemas, etc.)
        const contexts = await db.getProjectContexts(project.id);

        // Convert to map for easy access
        const contextMap = {};
        contexts.forEach(ctx => {
            contextMap[ctx.context_type] = ctx.content;
        });

        // Ensure we have at least a README key if it exists on disk but not DB (migration support)
        const readmePath = path.join(projectPath, 'README.md');
        if (fs.existsSync(readmePath) && !contextMap['README.md']) {
            contextMap['README.md'] = fs.readFileSync(readmePath, 'utf-8');
        }

        // 2. Generate updates using Gemini
        const updates = await generateDocumentationUpdates(task, project, contextMap);

        if (!updates || Object.keys(updates).length === 0) {
            console.log('[AutoDoc] No documentation updates generated.');
            return { success: true, updates: 0 };
        }

        // 3. Apply updates
        let updateCount = 0;
        for (const [docType, content] of Object.entries(updates)) {
            if (!content) continue;

            console.log(`[AutoDoc] Updating ${docType}...`);

            // Special handling for README.md -> Write to disk AND DB
            if (docType === 'README.md') {
                fs.writeFileSync(readmePath, content, 'utf-8');
            }

            // Update DB (implicitly handles maps, schemas, and creates new ones if needed)
            // Set status to 'review_pending' so humans know to check it
            await db.updateProjectContext(project.id, docType, content, 'review_pending');
            updateCount++;
        }

        console.log(`[AutoDoc] Successfully updated ${updateCount} documents.`);
        return { success: true, updates: updateCount };

    } catch (error) {
        console.error(`[AutoDoc] Error updating documentation:`, error);
        throw error;
    }
}

/**
 * Generate documentation updates using Gemini
 * Returns a dictionary of { "docType": "new content" }
 */
async function generateDocumentationUpdates(task, project, contextMap) {
    const apiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
    if (!apiKey) {
        console.warn('[AutoDoc] No API key found.');
        return {};
    }

    const agentConfig = getDocAgentConfig();
    const model = agentConfig.defaultModel;
    // System prompt focused on multi-file updates
    const systemPrompt = agentConfig.systemPrompt || `
You are a Lead Technical Writer and System Architect. 
Your goal is to keep ALL project documentation synchronized with the latest code changes.
When a task is completed, you must update the relevant documentation files.
    `.trim();

    console.log(`[AutoDoc] Using model: ${model}`);

    try {
        const genAI = new GoogleGenAI({ apiKey });

        // Prepare context summary for prompt
        const docsObj = {};
        for (const [k, v] of Object.entries(contextMap)) {
            // Truncate very long files to fit context window if needed, 
            // but Gemini 2.0 has 1M context so we are likely fine.
            docsObj[k] = v;
        }

        const prompt = `${systemPrompt}

PROJECT: ${project.name}
DESCRIPTION: ${project.description}

COMPLETED TASK:
Title: ${task.title || task.name}
Description: ${task.description || ''}
Implementation Details:
${task.walkthrough ? (typeof task.walkthrough === 'string' ? task.walkthrough : JSON.stringify(task.walkthrough)) : 'No walkthrough provided'}

CURRENT DOCUMENTATION:
${JSON.stringify(docsObj, null, 2)}

INSTRUCTIONS:
1. Analyze the completed task and how it affects the system.
2. Determine which documents need updating (e.g., README.md, context_map, database-schema).
3. If new components were added, update 'context_map' (Mermaid diagram).
4. If DB tables were changed, update 'database-schema'.
5. Always check if 'README.md' needs a new feature bullet point.
6. Return the FULL CONTENT of the updated files. Do not return partial diffs. Return the complete file content.

OUTPUT FORMAT:
Return ONLY a valid JSON object where keys are the document types (e.g., "README.md", "context_map") and values are the new full string content.
Example:
{
  "README.md": "# Project...",
  "context_map": "graph TD..."
}
`;

        let responseText = '';
        try {
            const response = await genAI.models.generateContent({
                model: model,
                contents: prompt,
                config: { responseMimeType: 'application/json' }
            });
            responseText = getResponseText(response);
        } catch (err) {
            console.error(`[AutoDoc] Gemini generation failed with model ${model}:`, err.message);
            throw err; // Fail loudly as requested
        }

        // Parse response
        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            return JSON.parse(jsonMatch[0]);
        }
        return JSON.parse(responseText);

    } catch (error) {
        console.error('[AutoDoc] Documentation update failed:', error);
        throw error;
    }
}

function getResponseText(response) {
    let text = '';
    if (response.candidates && response.candidates[0]) {
        const parts = response.candidates[0].content?.parts || [];
        parts.forEach(p => { if (p.text) text += p.text; });
    }
    return text;
}

module.exports = {
    updateDocumentationForTask
};
