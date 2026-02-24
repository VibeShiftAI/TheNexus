const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const db = require('../../db');

const FILES_TO_SYNC = [
    { filename: 'context_map.md', type: 'context_map' },
    { filename: 'database-schema.md', type: 'database-schema' },
    { filename: 'dashboard-workflow-map.md', type: 'dashboard-workflow-map' },
    { filename: 'project-workflow-map.md', type: 'project-workflow-map' },
    { filename: 'task-pipeline-map.md', type: 'task-pipeline-map' },
    { filename: 'function_map.md', type: 'function_map' },
    // Also include standard types to be safe if they act as overrides
    { filename: 'product.md', type: 'product' },
    { filename: 'tech-stack.md', type: 'tech-stack' },
    { filename: 'workflow.md', type: 'workflow' }
];

(async () => {
    try {
        console.log('Seeding Context Documents...');

        if (!db.isDatabaseEnabled()) {
            console.error('Database not enabled.');
            process.exit(1);
        }

        // We target the current project root, which we assume is the parent of 'supervisor'
        // But we need the projectId.
        // Let's look up 'TheNexus' project by path or name.
        const projects = await db.getProjects();
        // Assuming current directory structure: c:\Projects\TheNexus
        // The supervisor folder is c:\Projects\TheNexus\supervisor
        // We want to update the project that corresponds to this folder.

        // Find project where path ends with 'TheNexus' (case insensitive)
        const targetProject = projects.find(p => p.path.toLowerCase().endsWith('thenexus'));

        if (!targetProject) {
            console.error('Could not find project "TheNexus" in database.');
            console.log('Available projects:', projects.map(p => p.name));
            process.exit(1);
        }

        console.log(`Syncing docs for project: ${targetProject.name} (${targetProject.id})`);

        const supervisorDir = path.join(__dirname, '..', '..', 'supervisor');

        for (const fileInfo of FILES_TO_SYNC) {
            const filePath = path.join(supervisorDir, fileInfo.filename);

            if (fs.existsSync(filePath)) {
                console.log(`Reading ${fileInfo.filename}...`);
                const content = fs.readFileSync(filePath, 'utf-8');

                console.log(`Updating ${fileInfo.type}...`);
                await db.updateProjectContext(
                    targetProject.id,
                    fileInfo.type,
                    content,
                    'draft' // Use 'draft' or 'approved'? Let's use 'approved' or 'draft'. 
                    // Since these are existing established docs, let's treat them as current/approved base.
                    // But schema column default was 'draft'. Let's stick with that or maybe 'synced'.
                    // Actually, let's use 'approved' so they don't show up as 'Review Pending' immediately.
                );
            } else {
                console.warn(`File not found: ${filePath}`);
            }
        }

        console.log('Sync complete.');

    } catch (e) {
        console.error('Script Error:', e);
    }
})();
