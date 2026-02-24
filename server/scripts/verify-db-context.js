const db = require('../../db');

(async () => {
    try {
        console.log('Verifying Project Contexts...');

        if (!db.isDatabaseEnabled()) {
            console.error('Database not enabled.');
            process.exit(1);
        }

        const projects = await db.getProjects();
        const targetProject = projects.find(p => p.path.toLowerCase().endsWith('thenexus'));

        if (!targetProject) {
            console.error('Project TheNexus not found.');
            process.exit(1);
        }

        console.log(`Checking contexts for: ${targetProject.name}`);

        const contexts = await db.getProjectContexts(targetProject.id);

        if (contexts.length === 0) {
            console.log('No contexts found.');
        } else {
            console.log(`Found ${contexts.length} context documents:`);
            console.table(contexts.map(c => ({
                id: c.id.substring(0, 8) + '...',
                type: c.context_type,
                status: c.status,
                size: c.content?.length || 0,
                updated: c.updated_at
            })));
        }

    } catch (e) {
        console.error('Verification Error:', e);
    }
})();
