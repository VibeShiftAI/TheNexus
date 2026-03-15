/**
 * Tools Routes — File I/O, shell commands, search, task creation
 * Extracted from server.js for modularity
 */

const express = require('express');
const path = require('path');
const fs = require('fs');

module.exports = function createToolsRouter({ db, PROJECT_ROOT, getProjectById, getAllProjects }) {
    const router = express.Router();

    // Read a file
    router.get('/read-file', async (req, res) => {
        const { path: filePath } = req.query;

        if (!filePath) {
            return res.status(400).json({ error: 'path query parameter required' });
        }

        try {
            const absolutePath = path.resolve(filePath);

            if (!fs.existsSync(absolutePath)) {
                return res.status(404).json({ error: 'File not found', path: absolutePath });
            }

            const content = fs.readFileSync(absolutePath, 'utf-8');
            res.json({
                success: true,
                path: absolutePath,
                content,
                size: content.length
            });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // Write a file
    router.post('/write-file', async (req, res) => {
        const { path: filePath, content, createDirs = true } = req.body;

        if (!filePath || content === undefined) {
            return res.status(400).json({ error: 'path and content required' });
        }

        try {
            const absolutePath = path.resolve(filePath);

            // Create parent directories if needed
            if (createDirs) {
                const dir = path.dirname(absolutePath);
                if (!fs.existsSync(dir)) {
                    fs.mkdirSync(dir, { recursive: true });
                }
            }

            fs.writeFileSync(absolutePath, content, 'utf-8');
            res.json({
                success: true,
                path: absolutePath,
                size: content.length
            });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // List directory contents
    router.get('/list-dir', async (req, res) => {
        const { path: dirPath, recursive = false, maxDepth = 3 } = req.query;

        if (!dirPath) {
            return res.status(400).json({ error: 'path query parameter required' });
        }

        try {
            const absolutePath = path.resolve(dirPath);

            if (!fs.existsSync(absolutePath)) {
                return res.status(404).json({ error: 'Directory not found', path: absolutePath });
            }

            const stats = fs.statSync(absolutePath);
            if (!stats.isDirectory()) {
                return res.status(400).json({ error: 'Path is not a directory' });
            }

            // Get directory tree
            const entries = fs.readdirSync(absolutePath, { withFileTypes: true });
            const items = entries.map(entry => ({
                name: entry.name,
                type: entry.isDirectory() ? 'directory' : 'file',
                path: path.join(absolutePath, entry.name)
            }));

            res.json({
                success: true,
                path: absolutePath,
                items
            });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // Run a shell command
    router.post('/run-command', async (req, res) => {
        const { command, cwd, timeout = 30000 } = req.body;

        if (!command) {
            return res.status(400).json({ error: 'command required' });
        }

        const workingDir = cwd ? path.resolve(cwd) : process.cwd();

        try {
            const { execSync } = require('child_process');
            const output = execSync(command, {
                cwd: workingDir,
                timeout,
                encoding: 'utf-8',
                stdio: ['pipe', 'pipe', 'pipe']
            });

            res.json({
                success: true,
                command,
                cwd: workingDir,
                output: output.trim()
            });
        } catch (error) {
            res.json({
                success: false,
                command,
                cwd: workingDir,
                error: error.message,
                output: error.stdout?.toString() || '',
                stderr: error.stderr?.toString() || ''
            });
        }
    });

    // Search in files (grep)
    router.post('/search', async (req, res) => {
        const { pattern, directory, filePattern = '*', caseSensitive = false } = req.body;

        if (!pattern || !directory) {
            return res.status(400).json({ error: 'pattern and directory required' });
        }

        try {
            const absolutePath = path.resolve(directory);
            const results = [];

            function searchInFile(filePath) {
                try {
                    const content = fs.readFileSync(filePath, 'utf-8');
                    const lines = content.split('\n');
                    const regex = new RegExp(pattern, caseSensitive ? 'g' : 'gi');

                    lines.forEach((line, index) => {
                        if (regex.test(line)) {
                            results.push({
                                file: filePath,
                                line: index + 1,
                                content: line.trim()
                            });
                        }
                    });
                } catch (e) {
                    // Skip unreadable files
                }
            }

            function walkDir(dir) {
                const entries = fs.readdirSync(dir, { withFileTypes: true });
                for (const entry of entries) {
                    const fullPath = path.join(dir, entry.name);
                    if (entry.isDirectory() && !['node_modules', '.git', '.next', 'dist'].includes(entry.name)) {
                        walkDir(fullPath);
                    } else if (entry.isFile()) {
                        searchInFile(fullPath);
                    }
                }
            }

            walkDir(absolutePath);

            res.json({
                success: true,
                pattern,
                directory: absolutePath,
                matches: results.slice(0, 100)  // Limit results
            });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // POST /api/tools/create-task - Internal endpoint for Python agents to create tasks
    router.post('/create-task', async (req, res) => {
        try {
            const { project_id, title, description, status, source, priority, templateId } = req.body;

            if (!project_id || !title) {
                return res.status(400).json({ error: 'project_id and title are required' });
            }

            const project = await getProjectById(PROJECT_ROOT, project_id);
            if (!project) {
                return res.status(404).json({ error: 'Project not found' });
            }

            const newTask = {
                project_id: project.id,
                name: title.trim(),
                description: description?.trim() || '',
                status: status || 'idea',
                priority: priority || 0,
                source: source || 'workflow:documentation',
                langgraph_template: templateId || null,
                metadata: {
                    classifiedAt: new Date().toISOString(),
                    createdBy: 'langgraph-agent'
                }
            };

            const created = await db.createTask(newTask);
            console.log(`[Tools] Created task: "${title}" for project ${project_id}`);

            res.json({
                success: true,
                task: {
                    id: created.id,
                    name: created.name,
                    status: created.status,
                    project_id: created.project_id
                }
            });
        } catch (error) {
            console.error('[Tools] Create task error:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // GET /api/tools/project-context - Tool endpoint for Python agents
    router.get('/project-context', async (req, res) => {
        try {
            const { projectPath } = req.query;
            if (!projectPath) return res.status(400).json({ error: 'projectPath required' });

            // Find project by path
            const projects = await getAllProjects(PROJECT_ROOT);
            const project = projects.find(p => p.path === projectPath || p.path.toLowerCase() === projectPath.toLowerCase());

            if (!project) return res.status(404).json({ error: 'Project not found' });

            // Get context from DB
            const contexts = await db.getProjectContexts(project.id);

            // Format for AI
            const result = {
                techStack: [],
                framework: 'Unknown',
                structure: {},
                maps: {}
            };

            contexts.forEach(ctx => {
                if (ctx.context_type === 'tech-stack') {
                    result.techStack = ctx.content.split('\n')
                        .map(l => l.trim())
                        .filter(l => l.startsWith('-'))
                        .map(l => l.substring(1).trim());
                } else if (['context_map', 'database-schema', 'project-workflow-map', 'task-pipeline-map'].includes(ctx.context_type)) {
                    result.maps[ctx.context_type] = ctx.content;
                }
            });

            res.json({ success: true, context: result });

        } catch (error) {
            console.error('[Tools API] Error getting project context:', error);
            res.status(500).json({ error: 'Failed to get project context' });
        }
    });

    return router;
};
