/**
 * Context Management Tools
 * Provides the checkpoint_memory tool for consolidating conversation history
 */

const fs = require('fs');
const path = require('path');
const { z } = require('zod');

// Archive directory for checkpoint logs
const ARCHIVE_DIR = path.join(__dirname, '..', '..', 'checkpoint_archives');

// Tool definition schema (using Zod for consistency with other tools)
const checkpointMemorySchema = z.object({
    summary: z.string().describe(
        'A detailed technical summary of everything learned, decided, and achieved so far. Must include: file paths, key code findings, errors encountered, decisions made.'
    ),
    next_steps: z.string().describe(
        'The immediate next actions to take after this checkpoint. Be specific.'
    ),
    preserved_files: z.array(z.string()).optional().describe(
        'Optional: List of file paths whose contents should be preserved verbatim in the new context (for files you need to reference immediately).'
    )
});

// Tool definition object
const checkpointMemoryTool = {
    name: 'checkpoint_memory',
    description: `Consolidates the current conversation history into a compact summary to save tokens and prevent rate limits.

USE THIS TOOL WHEN:
- You have completed a distinct phase of work (e.g., finished reading files, completed research)
- The conversation is getting long and you want to "clean up" before the next phase
- You're about to start a new task and don't need the raw details of previous tool calls

WARNING: This will WIPE all previous message history. Your summary becomes the ONLY record of what happened.

REQUIREMENTS FOR YOUR SUMMARY:
- Include ALL file paths you've read or modified
- Include ALL key decisions and findings
- Include ANY error messages or issues encountered
- Include the current state of your work
- Be detailed and technical - this is your only memory`,
    schema: checkpointMemorySchema
};

/**
 * Archives the full conversation history before a checkpoint
 * @param {string} projectId - The project being worked on
 * @param {Array} history - The full message history
 * @param {Object} checkpointData - The summary and next_steps from the agent
 * @returns {string|null} Path to archive file or null if failed
 */
function archiveHistory(projectId, history, checkpointData) {
    try {
        // Ensure archive directory exists
        if (!fs.existsSync(ARCHIVE_DIR)) {
            fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
        }

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `checkpoint_${projectId || 'unknown'}_${timestamp}.json`;
        const archivePath = path.join(ARCHIVE_DIR, filename);

        const archive = {
            timestamp: new Date().toISOString(),
            projectId,
            checkpointSummary: checkpointData.summary,
            nextSteps: checkpointData.next_steps,
            preservedFiles: checkpointData.preserved_files || [],
            messageCount: history.length,
            fullHistory: history
        };

        fs.writeFileSync(archivePath, JSON.stringify(archive, null, 2));
        console.log(`[Checkpoint] Archived ${history.length} messages to ${filename}`);
        return archivePath;
    } catch (error) {
        console.error('[Checkpoint] Failed to archive history:', error);
        return null;
    }
}

/**
 * Execution handler - returns metadata for the agent loop to process
 * The actual history manipulation happens in the agent loop
 * @param {Object} args - Tool arguments
 * @param {Object} context - Execution context containing history and project info
 * @returns {Object} Result with checkpoint data or error
 */
async function execute(args, context = {}) {
    const { summary, next_steps, preserved_files = [] } = args;
    
    // Validate inputs
    if (!summary || summary.length < 50) {
        return {
            isError: true,
            content: 'Summary is too short. Provide a detailed summary of at least 50 characters.',
            isCheckpoint: true,
            success: false
        };
    }

    if (!next_steps || next_steps.length < 10) {
        return {
            isError: true,
            content: 'Next steps are too vague. Be specific about what you will do next.',
            isCheckpoint: true,
            success: false
        };
    }

    // Archive history if available in context
    let archivePath = null;
    if (context.history && context.projectId) {
        archivePath = archiveHistory(context.projectId, context.history, args);
    }

    // Return checkpoint data for the agent loop to handle
    return {
        isError: false,
        isCheckpoint: true,
        success: true,
        checkpointData: {
            summary,
            next_steps,
            preserved_files,
            archivePath
        },
        content: `Checkpoint created. Context has been consolidated. Archived ${context.history?.length || 0} messages.`
    };
}

module.exports = {
    checkpointMemoryTool,
    checkpointMemorySchema,
    execute,
    archiveHistory,
    ARCHIVE_DIR
};
