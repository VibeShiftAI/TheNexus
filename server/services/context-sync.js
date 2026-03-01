/**
 * Context Sync Service
 * 
 * Handles synchronization between local .context/ files and the database.
 * Git is the source of truth - always pull from git before syncing to DB.
 */

const path = require('path');
const fs = require('fs');
const simpleGit = require('simple-git');

// Context type to filename mapping
const CONTEXT_TYPE_FILES = {
    'product': 'product.md',
    'tech-stack': 'tech-stack.md',
    'product-guidelines': 'product-guidelines.md',
    'workflow': 'workflow.md',
    'database-schema': 'database-schema.md',
    'context_map': 'context_map.md',
    'project-workflow-map': 'project-workflow-map.md',
    'task-pipeline-map': 'task-pipeline-map.md',
    'function_map': 'function_map.md'
};

// Reverse mapping: filename to context type
const FILE_TO_CONTEXT_TYPE = Object.fromEntries(
    Object.entries(CONTEXT_TYPE_FILES).map(([type, file]) => [file, type])
);

const CONTEXT_DIR = '.context';

/**
 * Get the .context directory path for a project
 */
function getContextDirectory(projectPath) {
    return path.join(projectPath, CONTEXT_DIR);
}

/**
 * Write a context file to the local .context folder
 * @param {string} projectPath - Absolute path to project
 * @param {string} contextType - Context type (e.g., 'product', 'tech-stack')
 * @param {string} content - Markdown content to write
 * @param {string} status - Optional status for frontmatter
 */
async function writeContextFile(projectPath, contextType, content, status = 'draft') {
    const contextDir = getContextDirectory(projectPath);

    // Create directory if needed
    if (!fs.existsSync(contextDir)) {
        fs.mkdirSync(contextDir, { recursive: true });
    }

    const filename = CONTEXT_TYPE_FILES[contextType] || `${contextType}.md`;
    const filepath = path.join(contextDir, filename);

    // Format with frontmatter
    const formattedContent = formatWithFrontmatter(content, contextType, status);

    fs.writeFileSync(filepath, formattedContent, 'utf-8');
    console.log(`[ContextSync] Wrote ${filename}`);

    return filepath;
}

/**
 * Format content with YAML frontmatter at the BOTTOM of the file.
 * Strips any existing frontmatter blocks from the content to prevent duplication.
 */
function formatWithFrontmatter(content, contextType, status) {
    // Strip any existing frontmatter blocks (top or bottom) from the content
    let cleaned = (content || '').replace(/---\r?\n[\s\S]*?\r?\n---\r?\n?/g, '').trim();

    const footer = [
        '',
        '---',
        `context_type: ${contextType}`,
        `status: ${status}`,
        `updated_at: ${new Date().toISOString()}`,
        '---',
        ''
    ];
    return cleaned + '\n' + footer.join('\n');
}

/**
 * Parse frontmatter from a context file.
 * Looks for the LAST frontmatter block (at the bottom of the file).
 * @returns {{ content: string, metadata: object }}
 */
function parseFrontmatter(fileContent) {
    // Match the last --- block in the file
    const allBlocks = [...fileContent.matchAll(/---\r?\n([\s\S]*?)\r?\n---/g)];

    if (allBlocks.length === 0) {
        return { content: fileContent.trim(), metadata: {} };
    }

    // Use the last block as the metadata
    const lastBlock = allBlocks[allBlocks.length - 1];
    const frontmatter = lastBlock[1];

    // Remove ALL frontmatter blocks from the content
    const content = fileContent.replace(/---\r?\n[\s\S]*?\r?\n---\r?\n?/g, '').trim();

    // Parse YAML-like frontmatter
    const metadata = {};
    frontmatter.split('\n').forEach(line => {
        const colonIndex = line.indexOf(':');
        if (colonIndex > 0) {
            const key = line.slice(0, colonIndex).trim();
            const value = line.slice(colonIndex + 1).trim();
            metadata[key] = value;
        }
    });

    return { content, metadata };
}

/**
 * Read all context files from the .context folder
 * @param {string} projectPath - Absolute path to project
 * @returns {Array<{ type: string, content: string, status: string }>}
 */
function readAllContextFiles(projectPath) {
    const contextDir = getContextDirectory(projectPath);
    const results = [];

    if (!fs.existsSync(contextDir)) {
        return results;
    }

    const files = fs.readdirSync(contextDir);

    for (const file of files) {
        if (!file.endsWith('.md')) continue;

        const filepath = path.join(contextDir, file);
        const contextType = FILE_TO_CONTEXT_TYPE[file] || file.replace('.md', '');

        try {
            const rawContent = fs.readFileSync(filepath, 'utf-8');
            const { content, metadata } = parseFrontmatter(rawContent);

            results.push({
                type: contextType,
                content: content,
                status: metadata.status || 'draft',
                updatedAt: metadata.updated_at
            });
        } catch (err) {
            console.error(`[ContextSync] Error reading ${file}:`, err.message);
        }
    }

    return results;
}

/**
 * Pull from git and sync .context files to database
 * Git is the source of truth - always pulls latest before syncing
 * 
 * @param {string} projectId - Database project ID
 * @param {string} projectPath - Absolute path to project
 * @param {object} db - Database module reference
 * @returns {{ success: boolean, synced: number, pulled: boolean, errors: string[] }}
 */
async function pullAndSyncFromGit(projectId, projectPath, db) {
    const errors = [];
    let synced = 0;
    let pulled = false;

    // Check if it's a git repo
    const gitDir = path.join(projectPath, '.git');
    if (fs.existsSync(gitDir)) {
        try {
            const git = simpleGit(projectPath);

            // Check if there's a remote
            const remotes = await git.getRemotes();
            if (remotes.length > 0) {
                console.log(`[ContextSync] Pulling latest from git...`);
                await git.pull();
                pulled = true;
                console.log(`[ContextSync] Git pull complete`);
            }
        } catch (err) {
            // Git pull failed - might be offline or no remote
            console.warn(`[ContextSync] Git pull skipped: ${err.message}`);
            errors.push(`Git pull failed: ${err.message}`);
        }
    }

    // Read all .context files
    const contextFiles = readAllContextFiles(projectPath);

    if (contextFiles.length === 0) {
        console.log(`[ContextSync] No context files found in ${projectPath}`);
        return { success: true, synced: 0, pulled, errors };
    }

    console.log(`[ContextSync] Found ${contextFiles.length} context files to sync`);

    // Sync each file to database
    for (const ctx of contextFiles) {
        try {
            await db.updateProjectContext(projectId, ctx.type, ctx.content, ctx.status);
            synced++;
            console.log(`[ContextSync] Synced ${ctx.type} to DB`);
        } catch (err) {
            errors.push(`Failed to sync ${ctx.type}: ${err.message}`);
            console.error(`[ContextSync] Error syncing ${ctx.type}:`, err.message);
        }
    }

    return {
        success: errors.length === 0,
        synced,
        pulled,
        errors
    };
}

/**
 * Verify sync status between DB and local files
 * @returns {{ inSync: boolean, differences: Array<{ type: string, issue: string }> }}
 */
async function verifyContextSync(projectId, projectPath, db) {
    const differences = [];

    // Get DB contexts
    const dbContexts = await db.getProjectContexts(projectId);
    const dbMap = new Map(dbContexts.map(c => [c.context_type, c]));

    // Get file contexts
    const fileContexts = readAllContextFiles(projectPath);
    const fileMap = new Map(fileContexts.map(c => [c.type, c]));

    // Check files that exist but differ from DB
    for (const [type, fileCtx] of fileMap) {
        const dbCtx = dbMap.get(type);

        if (!dbCtx) {
            differences.push({ type, issue: 'In files but not in DB' });
        } else if (normalizeContent(dbCtx.content) !== normalizeContent(fileCtx.content)) {
            differences.push({ type, issue: 'Content differs' });
        }
    }

    // Check DB entries that don't have files
    for (const [type, dbCtx] of dbMap) {
        if (!fileMap.has(type) && dbCtx.content) {
            differences.push({ type, issue: 'In DB but not in files' });
        }
    }

    return {
        inSync: differences.length === 0,
        differences
    };
}

/**
 * Normalize content for comparison (trim whitespace, normalize line endings)
 */
function normalizeContent(content) {
    if (!content) return '';
    return content.trim().replace(/\r\n/g, '\n');
}

module.exports = {
    CONTEXT_DIR,
    CONTEXT_TYPE_FILES,
    getContextDirectory,
    writeContextFile,
    readAllContextFiles,
    pullAndSyncFromGit,
    verifyContextSync,
    parseFrontmatter
};
