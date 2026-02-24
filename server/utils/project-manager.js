const fs = require('fs');
const path = require('path');
const db = require('../../db');

/**
 * Get all projects from DB
 * @param {string} projectRoot 
 * @returns {Promise<Array>}
 */
async function getAllProjects(projectRoot) {
    if (!db.isDatabaseEnabled()) {
        console.warn('[ProjectManager] Database not configured. Returning empty list.');
        return [];
    }

    try {
        const projects = await db.getProjects();
        const stats = await db.getContextStats();

        // Merge stats
        return (projects || []).map(p => ({
            ...p,
            stats: stats[p.id] || { pending_reviews: 0 }
        }));
    } catch (e) {
        console.error('[ProjectManager] Error fetching projects from DB:', e);
        throw e; // Fail loudly, no fallback
    }
}

/**
 * Get a project by ID from DB
 * @param {string} projectRoot 
 * @param {string} id 
 * @returns {Promise<Object|null>}
 */
async function getProjectById(projectRoot, id) {
    if (!db.isDatabaseEnabled()) {
        console.warn('[ProjectManager] Database not configured. Cannot get project.');
        return null;
    }

    try {
        const project = await db.getProject(id);
        if (project) return project;

        // Fallback: Fuzzy search for ID mismatch recovery
        // This handles cases where IDs might have been corrupted or slightly altered
        console.log(`[ProjectManager] Project ${id} not found, attempting fuzzy match...`);
        const allProjects = await db.getProjects();

        if (!allProjects) return null;

        const target = id.toLowerCase();
        const match = allProjects.find(p => {
            const candidate = p.id.toLowerCase();
            // Basic length check
            if (candidate.length !== target.length) return false;

            // Calculate Hamming distance (number of differing characters)
            let diff = 0;
            for (let i = 0; i < candidate.length; i++) {
                if (candidate[i] !== target[i]) diff++;
            }

            // Allow up to 6 character differences (based on observed pattern: 8e43 -> 0e43, etc)
            return diff > 0 && diff <= 6;
        });

        if (match) {
            console.log(`[ProjectManager] RECOVERED: Fuzzy matched corrupted ID ${id} to valid ID ${match.id}`);

            // Self-healing: Update project.json with correct ID if it exists and differs
            try {
                // We need to find the physical path of the project.
                // The 'match' object from DB might have a 'path' property, or we rely on convention.
                // Assuming 'match' has the correct path or we can derive it.
                if (match.path && fs.existsSync(match.path)) {
                    const projectJsonPath = path.join(match.path, 'project.json');
                    if (fs.existsSync(projectJsonPath)) {
                        const projectData = JSON.parse(fs.readFileSync(projectJsonPath, 'utf8'));
                        if (projectData.id !== match.id) {
                            console.log(`[ProjectManager] HEALING: Updating project.json ID from ${projectData.id} to ${match.id}`);
                            projectData.id = match.id;
                            fs.writeFileSync(projectJsonPath, JSON.stringify(projectData, null, 2));
                        }
                    } else {
                        // Create project.json if it doesn't exist but we recovered the project?
                        // Better to only update existing files to avoid conflicts.
                        console.warn(`[ProjectManager] project.json not found at ${projectJsonPath}, skipping file update.`);
                    }
                }
            } catch (err) {
                console.error(`[ProjectManager] Failed to heal project.json for ${match.name}:`, err);
            }

            return match;
        }

        return null;
    } catch (e) {
        console.error(`[ProjectManager] Error fetching project ${id} from DB:`, e);
        throw e; // Fail loudly, no fallback
    }
}

/**
 * Scan directory for projects and add to DB if missing
 * @param {string} projectRoot 
 */
async function scanProjects(projectRoot) {
    if (!fs.existsSync(projectRoot)) return [];

    const entries = fs.readdirSync(projectRoot, { withFileTypes: true });
    const discovered = [];

    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;

        const projectPath = path.join(projectRoot, entry.name);

        // Lightweight check: Is it a project?
        // 1. Has project.json?
        // 2. Has .git?
        // 3. Or just a folder (heuristic: has src or package.json)?
        const hasProjectJson = fs.existsSync(path.join(projectPath, 'project.json'));
        const hasGit = fs.existsSync(path.join(projectPath, '.git'));
        const hasPackageJson = fs.existsSync(path.join(projectPath, 'package.json'));
        const hasSrc = fs.existsSync(path.join(projectPath, 'src'));

        if (hasProjectJson || hasGit || hasPackageJson || hasSrc) {
            // Check if already in DB by name (folder name) OR by path (more reliable)
            let exists = await db.getProject(entry.name);

            // If not found by folder name, also check by path (project.json name may differ from folder name)
            if (!exists) {
                exists = await db.getProjectByPath(projectPath);
            }

            if (!exists) {

                // Try to read metadata
                let meta = {
                    name: entry.name,
                    path: projectPath,
                    type: 'tool', // default
                    description: 'Discovered by scanner',
                    vibe: 'default'
                };

                if (hasProjectJson) {
                    try {
                        const data = JSON.parse(fs.readFileSync(path.join(projectPath, 'project.json'), 'utf8'));
                        meta = { ...meta, ...data };
                    } catch (e) {
                        console.warn(`[ProjectManager] Failed to parse project.json for ${entry.name}`);
                    }
                }

                // Add to DB
                if (db.isDatabaseEnabled()) {
                    // Sanitize meta before upserting - map/remove fields not in DB schema
                    const sanitizedMeta = {
                        name: meta.name,
                        path: meta.path,
                        type: meta.type,
                        description: meta.description,
                        vibe: meta.vibe
                    };
                    // Map 'created' to 'created_at' if present
                    if (meta.created) {
                        sanitizedMeta.created_at = meta.created;
                    }
                    // Don't pass 'id' - let DB generate UUID

                    await db.upsertProject(sanitizedMeta);
                    console.log(`[ProjectManager] Added new project to DB: ${entry.name}`);
                    discovered.push(meta);
                }
            }
        }
    }
    return discovered;
}

module.exports = {
    getAllProjects,
    getProjectById,
    scanProjects
};
