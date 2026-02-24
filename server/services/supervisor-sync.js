/**
 * Supervisor Context Sync Service
 * 
 * Watches the `supervisor/` directory for changes to markdown artifacts
 * and synchronizes them to the `project_contexts` database table.
 * 
 * This ensures that the filesystem remains the specific "Source of Truth"
 * for the Agent, while the Database reflects this truth for the Dashboard.
 */

const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');
const db = require('../../db');

// Map filenames to context types
const FILE_MAP = {
    'product.md': 'product',
    'tech-stack.md': 'tech-stack',
    'product-guidelines.md': 'product-guidelines',
    'workflow.md': 'workflow',
    'context_map.md': 'context-map'
};

let watcher = null;

/**
 * Start the sync watcher
 * @param {string} projectRoot - Root directory of the project
 */
function start(projectRoot = process.env.PROJECT_ROOT || path.resolve(process.env.USERPROFILE || process.env.HOME, 'Projects')) {
    if (!db.isDatabaseEnabled()) {
        console.warn('[SupervisorSync] Database disabled, sync skipped.');
        return;
    }

    console.log(`[SupervisorSync] Starting watcher on ${projectRoot}/**/supervisor/*.md`);

    // Watch all supervisor directories in the workspace
    // Note: This pattern assumes projects are direct children of projectRoot
    const watchPattern = path.join(projectRoot, '*', 'supervisor', '*.md');

    watcher = chokidar.watch(watchPattern, {
        persistent: true,
        ignoreInitial: true, // Don't sync everything on startup, only changes
        awaitWriteFinish: {
            stabilityThreshold: 1000,
            pollInterval: 100
        }
    });

    watcher
        .on('add', handleFileChange)
        .on('change', handleFileChange)
        .on('error', error => console.error(`[SupervisorSync] Watcher error: ${error}`));
}

/**
 * Handle file change event
 * @param {string} filePath - Absolute path to the changed file
 */
async function handleFileChange(filePath) {
    const filename = path.basename(filePath);
    const type = FILE_MAP[filename];

    if (!type) return; // Ignore unknown files

    try {
        // Extract project name from path (assumes .../ProjectName/supervisor/file.md)
        // Split path parts
        const parts = filePath.split(path.sep);
        const supervisorIndex = parts.indexOf('supervisor');

        if (supervisorIndex < 1) {
            console.warn(`[SupervisorSync] Could not determine project from path: ${filePath}`);
            return;
        }

        const projectName = parts[supervisorIndex - 1]; // Parent of 'supervisor'

        // Resolve project ID from DB
        const project = await db.getProject(projectName);
        if (!project) {
            console.warn(`[SupervisorSync] Project '${projectName}' not found in DB.`);
            return;
        }

        console.log(`[SupervisorSync] Syncing ${filename} string to DB for project ${projectName}...`);

        const content = fs.readFileSync(filePath, 'utf-8');
        await db.updateProjectContext(project.id, type, content);

        console.log(`[SupervisorSync] Synced ${filename} for ${projectName}.`);

    } catch (err) {
        console.error(`[SupervisorSync] Error syncing ${filename}:`, err);
    }
}

function stop() {
    if (watcher) watcher.close();
}

module.exports = { start, stop };
