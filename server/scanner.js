const fs = require('fs');
const path = require('path');

function scanProjects(rootDir) {
    if (!fs.existsSync(rootDir)) {
        return [];
    }

    const projects = [];
    const entries = fs.readdirSync(rootDir, { withFileTypes: true });

    for (const entry of entries) {
        if (entry.isDirectory()) {
            const projectPath = path.join(rootDir, entry.name);
            const projectInfo = detectProject(projectPath);

            if (projectInfo) {
                projects.push(projectInfo);
            }
        }
    }

    return projects;
}

function detectProject(projectPath) {
    const projectJsonPath = path.join(projectPath, 'project.json');
    const packageJsonPath = path.join(projectPath, 'package.json');
    const gitPath = path.join(projectPath, '.git');
    const requirementsTxtPath = path.join(projectPath, 'requirements.txt');

    if (fs.existsSync(projectJsonPath)) {
        try {
            const data = fs.readFileSync(projectJsonPath, 'utf8');
            return {
                id: path.basename(projectPath), // Fallback ID
                path: projectPath,
                type: 'configured',
                ...JSON.parse(data)
            };
        } catch (e) {
            console.error(`Error parsing project.json in ${projectPath}`, e);
        }
    }

    if (fs.existsSync(packageJsonPath) || fs.existsSync(gitPath) || fs.existsSync(requirementsTxtPath)) {
        return {
            id: path.basename(projectPath),
            name: path.basename(projectPath),
            path: projectPath,
            type: 'unconfigured',
            description: 'Auto-detected project'
        };
    }

    return null;
}

/**
 * Gathers project context for LLM analysis
 * @param {string} projectPath - Absolute path to the project
 * @returns {Object} Context object with fileTree, metadata, and sourceCode
 */
function getProjectContext(projectPath) {
    const IGNORED_DIRS = ['node_modules', '.git', '.next', 'dist', 'build', '.cache', 'coverage', '__pycache__', 'venv', '.venv'];
    const IGNORED_FILES = ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', '.DS_Store', 'Thumbs.db'];
    const MAX_FILE_SIZE = 50000; // 50KB per file
    const MAX_TOTAL_SOURCE = 500000; // 500KB total source code
    const SOURCE_EXTENSIONS = ['.js', '.ts', '.jsx', '.tsx', '.py', '.json', '.md', '.css', '.scss'];

    const context = {
        fileTree: [],
        metadata: {
            projectJson: null,
            packageJson: null,
            readme: null
        },
        sourceCode: [],
        totalSourceSize: 0
    };

    // Recursive file tree builder
    function buildFileTree(dir, prefix = '') {
        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });

            for (const entry of entries) {
                if (IGNORED_DIRS.includes(entry.name) || IGNORED_FILES.includes(entry.name)) {
                    continue;
                }

                const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;

                if (entry.isDirectory()) {
                    context.fileTree.push(`📁 ${relativePath}/`);
                    buildFileTree(path.join(dir, entry.name), relativePath);
                } else {
                    const stats = fs.statSync(path.join(dir, entry.name));
                    context.fileTree.push(`📄 ${relativePath} (${Math.round(stats.size / 1024)}KB)`);
                }
            }
        } catch (err) {
            console.warn('Error building file tree:', err.message);
        }
    }

    // Build file tree
    try {
        buildFileTree(projectPath);
    } catch (err) {
        console.warn('Error building file tree:', err.message);
    }

    // Read key metadata files
    const metadataFiles = {
        'project.json': 'projectJson',
        'package.json': 'packageJson',
        'README.md': 'readme',
        'readme.md': 'readme'
    };

    for (const [filename, key] of Object.entries(metadataFiles)) {
        const filePath = path.join(projectPath, filename);
        if (fs.existsSync(filePath)) {
            try {
                const content = fs.readFileSync(filePath, 'utf-8');
                context.metadata[key] = content.slice(0, MAX_FILE_SIZE);
            } catch (err) {
                console.warn(`Error reading ${filename}:`, err.message);
            }
        }
    }

    // Read source code files (prioritize src/ directory)
    function readSourceFiles(dir, depth = 0) {
        if (depth > 5 || context.totalSourceSize > MAX_TOTAL_SOURCE) return;

        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });

            for (const entry of entries) {
                if (context.totalSourceSize > MAX_TOTAL_SOURCE) break;
                if (IGNORED_DIRS.includes(entry.name)) continue;

                const fullPath = path.join(dir, entry.name);
                const relativePath = path.relative(projectPath, fullPath);

                if (entry.isDirectory()) {
                    readSourceFiles(fullPath, depth + 1);
                } else {
                    const ext = path.extname(entry.name).toLowerCase();
                    if (!SOURCE_EXTENSIONS.includes(ext)) continue;

                    try {
                        const stats = fs.statSync(fullPath);
                        if (stats.size > MAX_FILE_SIZE) continue;

                        const content = fs.readFileSync(fullPath, 'utf-8');
                        context.sourceCode.push({
                            path: relativePath,
                            content: content.slice(0, MAX_FILE_SIZE)
                        });
                        context.totalSourceSize += content.length;
                    } catch (err) {
                        console.warn(`Error reading ${relativePath}:`, err.message);
                    }
                }
            }
        } catch (err) {
            console.warn(`Error reading directory ${dir}:`, err.message);
        }
    }

    // Prioritize src/ directory if it exists
    const srcPath = path.join(projectPath, 'src');
    if (fs.existsSync(srcPath)) {
        readSourceFiles(srcPath);
    }

    // Also check dashboard/src for Next.js projects
    const dashboardSrcPath = path.join(projectPath, 'dashboard', 'src');
    if (fs.existsSync(dashboardSrcPath)) {
        readSourceFiles(dashboardSrcPath);
    }

    // Check root level for key files
    try {
        const rootFiles = fs.readdirSync(projectPath, { withFileTypes: true });
        for (const entry of rootFiles) {
            if (context.totalSourceSize > MAX_TOTAL_SOURCE) break;
            if (!entry.isFile()) continue;

            const ext = path.extname(entry.name).toLowerCase();
            if (!SOURCE_EXTENSIONS.includes(ext)) continue;
            if (entry.name === 'package.json' || entry.name === 'project.json') continue; // Already captured

            const fullPath = path.join(projectPath, entry.name);
            try {
                const stats = fs.statSync(fullPath);
                if (stats.size > MAX_FILE_SIZE) continue;

                const content = fs.readFileSync(fullPath, 'utf-8');
                context.sourceCode.push({
                    path: entry.name,
                    content: content.slice(0, MAX_FILE_SIZE)
                });
                context.totalSourceSize += content.length;
            } catch (err) {
                // Skip
            }
        }
    } catch (err) {
        console.warn('Error reading root files:', err.message);
    }

    return context;
}

module.exports = { scanProjects, getProjectContext };
