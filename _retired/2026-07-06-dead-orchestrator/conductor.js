const db = require('../../db');

/**
 * Conductor Service
 * 
 * Aggregates project context (Product, Tech Stack, Guidelines, etc.)
 * from the database to inject into Agent system prompts.
 */
class ConductorService {

    /**
     * Get the full "Conductor" context for a project
     * @param {string} projectId 
     * @returns {Promise<string>} Markdown formatted context
     */
    async getAgentContext(projectId) {
        if (!db.isDatabaseEnabled()) {
            return '';
        }

        const contexts = await db.getProjectContexts(projectId);
        if (!contexts || contexts.length === 0) {
            return '';
        }

        // Order of precedence / display
        const order = ['product', 'product-guidelines', 'tech-stack', 'workflow'];
        const contextMap = contexts.reduce((acc, ctx) => {
            acc[ctx.context_type] = ctx.content;
            return acc;
        }, {});

        let fullContext = '# Project Context (Conductor)\n\n';

        order.forEach(type => {
            if (contextMap[type]) {
                const title = type.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
                fullContext += `## ${title}\n\n${contextMap[type]}\n\n---\n\n`;
            }
        });

        // Add any others not in the standard order
        Object.keys(contextMap).forEach(type => {
            if (!order.includes(type)) {
                fullContext += `## ${type}\n\n${contextMap[type]}\n\n---\n\n`;
            }
        });

        return fullContext;
    }

    /**
     * Get active track for a task
     * @param {string} taskId 
     * @returns {Promise<string>}
     */
    async getActiveTrackContext(taskId) {
        if (!db.isDatabaseEnabled() || !taskId) return '';

        const tracks = await db.getTracks(taskId);
        // Assuming one active track per task for now, or just taking the latest/first
        const activeTrack = tracks.find(t => t.status !== 'completed' && t.status !== 'cancelled') || tracks[0];

        if (!activeTrack) return '';

        let trackContext = `# Active Track: ${activeTrack.name}\n\n`;
        trackContext += `${activeTrack.description || ''}\n\n`;

        if (activeTrack.steps && activeTrack.steps.length > 0) {
            trackContext += `## Execution Plan\n`;
            activeTrack.steps.forEach(step => {
                const mark = step.status === 'completed' ? '[x]' : (step.status === 'in_progress' ? '[/]' : '[ ]');
                trackContext += `- ${mark} ${step.step_order}. ${step.title}\n`;
                if (step.description && step.description !== step.title) {
                    trackContext += `  ${step.description}\n`;
                }
            });
        }

        return trackContext;
    }
}

module.exports = new ConductorService();
