require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const simpleGit = require('simple-git');
const { GoogleGenAI } = require('@google/genai');
const path = require('path');
const fs = require('fs');
const { scanProjects, getAllProjects, getProjectById } = require('./utils/project-manager');
const { setupResearchRoutes } = require('./auto-research');
const systemMonitor = require('./services/system-monitor');
const tokenTracker = require('./utils/token-tracker');
const { isCriticEnabled, setCriticEnabled } = require('./services/critic');
const { updateDocumentationForFeature } = require('./services/auto-documentation');
const supervisorSync = require('./services/supervisor-sync');
const contextSync = require('./services/context-sync');
const { runAgent } = require('./agent');
const { discoverModels, getModels } = require('./services/model-discovery');

const { getDefaultMemoryManager } = require('./memory');
const os = require('os');

// Database client (SQLite)
const db = require('../db');
const { callAI, getAIModelConfig, runDeepResearch } = require('./services/ai-service');
const { validateInitiativeRequest } = require('./services/initiative-router');
const { runDashboardInitiativeSupervisor, getInitiativeProgress } = require('./services/dashboard-initiative-supervisor');

// Crash handlers - keep server running and log errors
process.on('uncaughtException', (err) => {
    console.error('!!! UNCAUGHT EXCEPTION !!!', err);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('!!! UNHANDLED REJECTION !!!', reason);
});

const app = express();
app.set('trust proxy', 1); // Trust first proxy hop (fixes express-rate-limit X-Forwarded-For validation)
const server = http.createServer(app);

// CORS: restrict to known origins (add production domain when deployed)
const ALLOWED_ORIGINS = [
    'http://localhost:3000',
    'http://localhost:4000',
    'http://localhost:8000'
];
const io = new Server(server, { cors: { origin: ALLOWED_ORIGINS } });
const PORT = process.env.PORT || 4000;

// WebSocket connection handler
io.on('connection', (socket) => {
    socket.on('disconnect', () => { });
});
// Default project root - in a real scenario this might be configurable via .env
const PROJECT_ROOT = process.env.PROJECT_ROOT || path.resolve(process.env.USERPROFILE || process.env.HOME, 'Projects');

// Scan cache to prevent redundant filesystem scans from parallel requests
let scanCache = null;
let scanCacheTime = 0;
let scanInProgress = null; // Promise-based lock to prevent parallel scans
const SCAN_CACHE_TTL = 5000; // 5 seconds - enough to dedupe parallel requests

// Models are now fetched from database - cached for performance
let modelsCache = null;
let modelsCacheTime = 0;
const MODELS_CACHE_TTL = 60000; // 1 minute

/**
 * Get available models from database with caching
 * @returns {Promise<Array>} List of available models
 * @throws {Error} If database is unavailable
 */
async function getAvailableModels() {
    const now = Date.now();

    // Return cached models if still valid
    if (modelsCache && (now - modelsCacheTime) < MODELS_CACHE_TTL) {
        return modelsCache;
    }

    // Fetch from database (throws if unavailable)
    const models = await db.getModels(true); // activeOnly = true

    // Update cache
    modelsCache = models;
    modelsCacheTime = now;

    console.log(`[Models] Loaded ${models.length} models from database`);
    return models;
}


// Security middleware
app.use(helmet());
app.use(cors({ origin: ALLOWED_ORIGINS }));
app.use(express.json({ limit: '10mb' }));

// Rate limiting: 1000 requests per 15 minutes per IP
// Dashboard loads fire 10+ API calls per page view (projects, pins, activity,
// stats, initiatives, sidebar, AI terminal) plus polling intervals.
// 100 was too low and caused 429 errors during normal navigation.
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 1000,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.' }
});
app.use('/api', apiLimiter);

// Root route - API info
app.get('/', (req, res) => {
    res.json({
        name: 'The Nexus API',
        version: '1.0.0',
        status: 'running',
        endpoints: {
            projects: '/api/projects',
            activity: '/api/activity',
            agents: '/api/agents',
            health: '/api/health'
        }
    });
});

// Health check endpoint (public, no auth)
app.get('/api/health', (req, res) => {
    res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// ============================================================================
// MODELS ENDPOINTS
// ============================================================================

// GET /api/models - List all available models (from discovery service)
app.get('/api/models', (req, res) => {
    const models = getModels();
    res.json({ models });
});

// POST /api/models - Create or update a model (authenticated)
app.post('/api/models', async (req, res) => {
    try {
        const model = req.body;

        if (!model.id || !model.name || !model.provider) {
            return res.status(400).json({ error: 'id, name, and provider are required' });
        }

        const result = await db.upsertModel(model);

        // Invalidate cache
        modelsCache = null;
        modelsCacheTime = 0;

        res.json(result);
    } catch (error) {
        console.error('[Models] Error upserting model:', error);
        res.status(500).json({ error: 'Failed to save model: ' + error.message });
    }
});

// DELETE /api/models/:id - Delete a model (authenticated)
app.delete('/api/models/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await db.deleteModel(id);

        // Invalidate cache
        modelsCache = null;
        modelsCacheTime = 0;

        res.json({ success: true });
    } catch (error) {
        console.error('[Models] Error deleting model:', error);
        res.status(500).json({ error: 'Failed to delete model: ' + error.message });
    }
});

// Authentication Middleware
async function authenticate(req, res, next) {
    // Skip auth for local requests (optional, but safer to enforce everywhere)
    // or skip for specific routes like /api/health
    const publicRoutes = [
        '/api/ai/usage',
        '/api/system/status'
    ];

    if (publicRoutes.some(route => req.originalUrl.startsWith(route))) {
        console.log(`[Auth] Bypassing auth for: ${req.originalUrl}`);
        return next();
    }

    // Single-user local app — no auth required.
    // Attach a default local user to every request.
    req.user = {
        id: 'local_user',
        role: 'admin',
        is_service: false
    };
    return next();
}

// Apply auth to all /api routes except explicitly public ones
// Public routes are whitelisted inside the authenticate function itself
app.use('/api/projects', authenticate);
app.use('/api/tasks', authenticate);
app.use('/api/ai', authenticate);
app.use('/api/pins', authenticate);
app.use('/api/models', authenticate);
app.use('/api/activity', authenticate);
app.use('/api/dashboard', authenticate);
app.use('/api/mcp', authenticate);
app.use('/api/initiatives', authenticate);

// === MCP Tool Dock Routes ===
// These power the drag-and-drop tool binding in the Agent Designer
const mcpRouter = require('./routes/mcp-inline');
app.use('/api/mcp', mcpRouter);

// === MCP Server Scopes Routes ===
// OAuth-style scope configuration for MCP servers
const mcpScopesRouter = require('./routes/mcp-scopes');
app.use('/api/mcp', mcpScopesRouter);

// === Extracted Route Modules ===
const createToolsRouter = require('./routes/tools');
const createMemoryRouter = require('./routes/memory');
const createLangGraphRouter = require('./routes/langgraph');
const createInitiativesRouter = require('./routes/initiatives');
const createWorkflowsRouter = require('./routes/workflows');

app.use('/api/tools', createToolsRouter({ db, PROJECT_ROOT, getProjectById, getAllProjects }));
app.use('/api/memory', createMemoryRouter({ scanProjects, PROJECT_ROOT, getDefaultMemoryManager }));
app.use('/api/langgraph', createLangGraphRouter({ db, PROJECT_ROOT, getProjectById, contextSync, runAgent }));
app.use('/api/initiatives', createInitiativesRouter({ db }));
app.use('/api/workflows', createWorkflowsRouter({ db, PROJECT_ROOT, getProjectById }));

// ============================================================================
// SETTINGS / ENV EDITOR ENDPOINTS
// ============================================================================
app.use('/api/settings', authenticate);

/**
 * Parse a .env file into a key→value map (ignores comments and blank lines)
 */
function parseEnvFile(filePath) {
    const result = {};
    if (!fs.existsSync(filePath)) return result;
    const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) continue;
        const key = trimmed.substring(0, eqIdx).trim();
        const value = trimmed.substring(eqIdx + 1).trim();
        result[key] = value;
    }
    return result;
}

/**
 * Write key→value pairs to a .env file, preserving comments and structure
 * from a template, or creating a clean file if no template exists.
 */
/**
 * Write key→value updates to a .env file, preserving ALL existing content.
 * Only modifies lines whose keys appear in `updates`. All other lines
 * (comments, blanks, unknown keys) are kept exactly as they were.
 * Falls back to the template only if the file doesn't exist yet.
 */
function writeEnvFile(filePath, updates, templatePath) {
    // If the file doesn't exist yet, bootstrap from the template
    if (!fs.existsSync(filePath)) {
        if (templatePath && fs.existsSync(templatePath)) {
            fs.copyFileSync(templatePath, filePath);
        } else {
            // No file and no template — write only the updates
            const lines = Object.entries(updates).map(([k, v]) => `${k}=${v}`);
            fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8');
            return;
        }
    }

    // Read the EXISTING file (not the template) — this preserves all user-added keys
    const existingLines = fs.readFileSync(filePath, 'utf-8').split('\n');
    const updatedKeys = new Set();
    const outputLines = [];

    for (const line of existingLines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) {
            outputLines.push(line);
            continue;
        }
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) { outputLines.push(line); continue; }
        const key = trimmed.substring(0, eqIdx).trim();
        if (key in updates) {
            outputLines.push(`${key}=${updates[key]}`);
            updatedKeys.add(key);
        } else {
            outputLines.push(line);  // preserve as-is
        }
    }

    // Append any new keys that weren't already in the file
    for (const [key, value] of Object.entries(updates)) {
        if (!updatedKeys.has(key)) {
            outputLines.push(`${key}=${value}`);
        }
    }

    fs.writeFileSync(filePath, outputLines.join('\n'), 'utf-8');
}

// Whitelist of keys the dashboard is allowed to read/write
const ENV_EDITABLE_KEYS = [
    'PROJECT_ROOT',
    'GOOGLE_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'XAI_API_KEY',
    'NEXUS_SERVICE_KEY'
];

// Auto-generate NEXUS_SERVICE_KEY if missing from .env
// This is a local shared secret between the Python cortex and Express API.
(function ensureServiceKey() {
    const rootEnvPath = path.resolve(__dirname, '..', '.env');
    if (!fs.existsSync(rootEnvPath)) return;
    const existing = parseEnvFile(rootEnvPath);
    if (!existing.NEXUS_SERVICE_KEY || existing.NEXUS_SERVICE_KEY.startsWith('your-')) {
        const generated = 'nxs_' + crypto.randomBytes(24).toString('hex');
        writeEnvFile(rootEnvPath, { NEXUS_SERVICE_KEY: generated });
        // Also write to nexus-builder .env
        const pyEnvPath = path.resolve(__dirname, '..', 'nexus-builder', '.env');
        writeEnvFile(pyEnvPath, { NEXUS_SERVICE_KEY: generated });
        process.env.NEXUS_SERVICE_KEY = generated;
        console.log('[Settings] 🔑 Auto-generated NEXUS_SERVICE_KEY');
    }
})();

// GET /api/settings/env — Read current env values (only editable keys)
app.get('/api/settings/env', (req, res) => {
    try {
        const rootEnvPath = path.resolve(__dirname, '..', '.env');
        const rootValues = parseEnvFile(rootEnvPath);

        const result = {};
        for (const key of ENV_EDITABLE_KEYS) {
            result[key] = rootValues[key] || '';
        }
        res.json(result);
    } catch (error) {
        console.error('[Settings] Error reading .env:', error);
        res.status(500).json({ error: 'Failed to read environment configuration' });
    }
});

// POST /api/settings/env — Write env values to both root and Python .env
app.post('/api/settings/env', (req, res) => {
    try {
        const updates = req.body;

        // Only allow whitelisted keys
        const filtered = {};
        for (const key of ENV_EDITABLE_KEYS) {
            if (key in updates) filtered[key] = updates[key];
        }

        if (Object.keys(filtered).length === 0) {
            return res.status(400).json({ error: 'No valid keys provided' });
        }

        // --- Update root .env (in-place, preserves all existing keys) ---
        const rootEnvPath = path.resolve(__dirname, '..', '.env');
        const rootTemplatePath = path.resolve(__dirname, '..', '.env.example');
        writeEnvFile(rootEnvPath, filtered, rootTemplatePath);

        // --- Update nexus-builder .env (shared keys only, in-place) ---
        const pyEnvPath = path.resolve(__dirname, '..', 'nexus-builder', '.env');
        const pyTemplatePath = path.resolve(__dirname, '..', 'nexus-builder', '.env.example');
        const pySharedKeys = ['GOOGLE_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'XAI_API_KEY', 'NEXUS_SERVICE_KEY'];
        const pyFiltered = {};
        for (const key of pySharedKeys) {
            if (key in filtered) pyFiltered[key] = filtered[key];
        }
        writeEnvFile(pyEnvPath, pyFiltered, pyTemplatePath);

        console.log(`[Settings] Updated .env files (keys: ${Object.keys(filtered).join(', ')})`);
        res.json({ success: true, updated: Object.keys(filtered) });
    } catch (error) {
        console.error('[Settings] Error writing .env:', error);
        res.status(500).json({ error: 'Failed to save environment configuration' });
    }
});


// Ensure the root directory exists for testing purposes, or warn
if (!fs.existsSync(PROJECT_ROOT)) {
    console.warn(`Warning: Project root ${PROJECT_ROOT} does not exist.`);
}

// Start Supervisor Sync
supervisorSync.start(PROJECT_ROOT);

app.get('/api/dashboard/stats', async (req, res) => {
    try {
        const stats = await db.getDashboardStats();
        res.json(stats);
    } catch (error) {
        console.error('Error getting dashboard stats:', error);
        res.status(500).json({ error: 'Failed to get dashboard stats' });
    }
});

app.get('/api/projects', async (req, res) => {
    try {
        const now = Date.now();

        // Only scan if cache is stale
        if (!scanCache || (now - scanCacheTime) > SCAN_CACHE_TTL) {
            // If a scan is already in progress, wait for it instead of starting a new one
            if (scanInProgress) {
                await scanInProgress;
            } else {
                // Start new scan and store the promise so parallel requests can wait
                scanInProgress = (async () => {
                    console.log(`[Projects] Scanning for new projects (Root: ${PROJECT_ROOT})...`);
                    await scanProjects(PROJECT_ROOT);
                    scanCacheTime = Date.now();
                    scanCache = true;
                })();

                try {
                    await scanInProgress;
                } finally {
                    scanInProgress = null; // Clear the lock after completion
                }
            }
        }

        const projects = await getAllProjects(PROJECT_ROOT);
        res.json(projects);
    } catch (error) {
        console.error('[Projects] Error getting projects:', error);
        res.status(500).json({ error: 'Failed to get projects' });
    }
});

// [NEW] Create Project (Cortex Integration)
app.post('/api/projects', async (req, res) => {
    const { name, description, type, goal } = req.body;

    if (!name) {
        return res.status(400).json({ error: 'Project name is required' });
    }

    try {
        // use upsertProject from db
        const newProject = {
            name,
            description: description || goal || '',
            type: type || 'tool',
            // path is required by schema, mock it or use name
            path: path.join(PROJECT_ROOT, name),
            tasks_list: []
        };

        const result = await db.upsertProject(newProject);

        // Also ensure directory exists?
        const projectPath = path.join(PROJECT_ROOT, name);
        if (!fs.existsSync(projectPath)) {
            fs.mkdirSync(projectPath, { recursive: true });
        }

        res.status(201).json(result);
    } catch (error) {
        console.error('Error creating project:', error);
        res.status(500).json({ error: 'Failed to create project: ' + error.message });
    }
});

// [NEW] Create Task (Cortex Integration)
app.post('/api/tasks', async (req, res) => {
    const { project_id, title, status, priority, description, templateId } = req.body;

    if (!project_id || !title) {
        return res.status(400).json({ error: 'project_id and title are required' });
    }

    try {
        const newTask = {
            project_id,
            name: title,
            status: status || 'planning',
            priority: priority === 'high' ? 2 : 1,
            description: description || '',
            langgraph_template: templateId || null
        };

        const result = await db.createTask(newTask);
        res.status(201).json(result);
    } catch (error) {
        console.error('Error creating task:', error);
        res.status(500).json({ error: 'Failed to create task: ' + error.message });
    }
});

app.get('/api/projects/:id/status', async (req, res) => {
    const { id } = req.params;
    const project = await getProjectById(PROJECT_ROOT, id);

    if (!project) {
        return res.status(404).json({ error: 'Project not found' });
    }

    // Check if .git folder exists
    const gitPath = path.join(project.path, '.git');
    const hasGit = fs.existsSync(gitPath);

    if (!hasGit) {
        return res.json({
            hasGit: false,
            hasRemote: false,
            remoteUrl: null,
            current: null,
            latest_commit: null,
            files: [],
            error: null
        });
    }

    try {
        const git = simpleGit(project.path);
        const status = await git.status();

        // Check for remote
        let remoteUrl = null;
        let hasRemote = false;
        try {
            const remotes = await git.getRemotes(true);
            const origin = remotes.find(r => r.name === 'origin');
            if (origin && origin.refs && origin.refs.push) {
                hasRemote = true;
                // Convert SSH URL to HTTPS for display
                let url = origin.refs.push;
                if (url.startsWith('git@github.com:')) {
                    url = url.replace('git@github.com:', 'https://github.com/').replace(/\.git$/, '');
                }
                remoteUrl = url;
            }
        } catch (remoteError) {
            console.warn(`Could not get remotes for ${id}:`, remoteError);
        }

        // Get latest commit
        let latest_commit = null;
        let daysSinceCommit = null;
        let hasCommits = false;
        try {
            const log = await git.log({ maxCount: 1 });
            latest_commit = log.latest;
            hasCommits = !!latest_commit;
            if (latest_commit && latest_commit.date) {
                const commitDate = new Date(latest_commit.date);
                const now = new Date();
                daysSinceCommit = Math.floor((now - commitDate) / (1000 * 60 * 60 * 24));
            }
        } catch (logError) {
            // Suppress verbose logging for expected "no commits" scenario
            if (logError.message && logError.message.includes('does not have any commits')) {
                // No-op: this is expected for new repos, hasCommits remains false
            } else {
                console.warn(`[Git] Could not get log for ${id}: ${logError.message}`);
            }
        }

        // Count uncommitted changes
        const uncommittedCount = status.files ? status.files.length : 0;

        res.json({
            hasGit: true,
            hasRemote,
            hasCommits,
            remoteUrl,
            current: status.current,
            tracking: status.tracking,
            ahead: status.ahead,
            behind: status.behind,
            files: status.files,
            modified: status.modified,
            not_added: status.not_added,
            created: status.created,
            deleted: status.deleted,
            staged: status.staged,
            latest_commit,
            daysSinceCommit,
            uncommittedCount,
            error: null
        });
    } catch (error) {
        console.error(`Error getting git status for ${id}:`, error);
        res.json({
            hasGit: true,
            hasRemote: false,
            remoteUrl: null,
            current: null,
            latest_commit: null,
            files: [],
            error: error.message
        });
    }
});

// Initialize git in a project
app.post('/api/projects/:id/git/init', async (req, res) => {
    const { id } = req.params;
    const project = await getProjectById(PROJECT_ROOT, id);

    if (!project) {
        return res.status(404).json({ error: 'Project not found' });
    }

    const gitPath = path.join(project.path, '.git');
    if (fs.existsSync(gitPath)) {
        return res.status(400).json({ error: 'Git already initialized' });
    }

    try {
        const git = simpleGit(project.path);
        await git.init();
        res.json({ success: true, message: 'Git initialized successfully' });
    } catch (error) {
        console.error(`Error initializing git for ${id}:`, error);
        res.status(500).json({ error: 'Failed to initialize git' });
    }
});

// Add remote to a project
app.post('/api/projects/:id/git/remote', async (req, res) => {
    const { id } = req.params;
    const { url } = req.body;

    if (!url) {
        return res.status(400).json({ error: 'Remote URL is required' });
    }

    const project = await getProjectById(PROJECT_ROOT, id);

    if (!project) {
        return res.status(404).json({ error: 'Project not found' });
    }

    try {
        const git = simpleGit(project.path);
        await git.addRemote('origin', url);
        res.json({ success: true, message: 'Remote added successfully' });
    } catch (error) {
        console.error(`Error adding remote for ${id}:`, error);
        res.status(500).json({ error: 'Failed to add remote: ' + error.message });
    }
});

// Scaffold a new project
app.post('/api/projects/scaffold', async (req, res) => {
    const { name, type, description, supervisor } = req.body;

    if (!name || !name.match(/^[a-zA-Z0-9-_\s]+$/)) {
        return res.status(400).json({ error: 'Invalid project name. Use only letters, numbers, dashes, underscores, and spaces.' });
    }

    const projectPath = path.join(PROJECT_ROOT, name);

    if (fs.existsSync(projectPath)) {
        return res.status(400).json({ error: `Project '${name}' already exists.` });
    }

    try {
        // Create directory
        fs.mkdirSync(projectPath, { recursive: true });

        // Create project.json
        const projectMeta = {
            name: name,
            type: type || 'web-app',
            description: description || '',
            created: new Date().toISOString(),
            vibe: supervisor ? 'immaculate' : 'default',
            tasks: supervisor?.tasks || [],
            stack: {},
            urls: {
                production: '',
                repo: ''
            }
        };
        fs.writeFileSync(path.join(projectPath, 'project.json'), JSON.stringify(projectMeta, null, 4));

        // Initialize git
        const git = simpleGit(projectPath);
        await git.init();

        // If Supervisor config is present, generate the documentation
        if (supervisor) {
            const supervisorPath = path.join(projectPath, 'supervisor');
            fs.mkdirSync(supervisorPath, { recursive: true });

            // 1. product.md
            const productMd = `# Product Guide: ${name}

## 1. Initial Concept
${supervisor.concept}

## 2. Target Audience
${supervisor.audience.map(a => `*   **${a}**`).join('\n')}

## 3. Core Value Proposition
*   **Primary Goal:** ${supervisor.goals.join(', ')}
*   **Type:** ${type}

## 4. Key Tasks & Capabilities
${supervisor.tasks.map(f => `*   **${f}**`).join('\n')}

## 5. Design Philosophy
*   **Aesthetic:** ${supervisor.aesthetic}
*   **Tone:** ${supervisor.tone}
*   **Interaction:** ${supervisor.aiInteraction}
`;
            fs.writeFileSync(path.join(supervisorPath, 'product.md'), productMd);

            // 2. product-guidelines.md
            const guidelinesMd = `# Product Guidelines: ${name}

## 1. Brand Identity & Voice
*   **Tone:** ${supervisor.tone}
*   **AI Persona:** ${supervisor.aiInteraction}

## 2. Visual Design System
*   **Aesthetic:** ${supervisor.aesthetic}

## 3. User Experience (UX) Principles
*   **Interaction Model:** ${supervisor.aiInteraction}
`;
            fs.writeFileSync(path.join(supervisorPath, 'product-guidelines.md'), guidelinesMd);

            // 3. tech-stack.md
            const techStackMd = `# Technology Stack: ${name}

## 1. Project Type
${type}

## 2. Core Technologies (Default)
*   **Frontend:** Next.js, Tailwind CSS (inferred from defaults)
*   **Backend:** Node.js / Python (inferred from defaults)
*   **Database:** SQLite (local)
`;
            fs.writeFileSync(path.join(supervisorPath, 'tech-stack.md'), techStackMd);

            // 4. workflow.md (Copy template or use default)
            const workflowMd = `# Project Workflow

## Guiding Principles
1. **The Plan is the Source of Truth**
2. **Test-Driven Development**
3. **High Code Coverage (>90%)**

## Workflow
1. Select Task
2. Write Failing Tests
3. Implement
4. Refactor
5. Verify
6. Commit
`;
            fs.writeFileSync(path.join(supervisorPath, 'workflow.md'), workflowMd);

            // 5. tracks.md
            fs.writeFileSync(path.join(supervisorPath, 'tracks.md'), '# Project Tracks\n\n## [ ] Track: Initial Setup\n');

            // 6. setup_state.json
            fs.writeFileSync(path.join(supervisorPath, 'setup_state.json'), JSON.stringify({
                last_successful_step: "scaffold_complete",
                created_at: new Date().toISOString()
            }, null, 2));
        }

        // Sync to DB if enabled
        let projectId = null;
        if (db.isDatabaseEnabled()) {
            const result = await db.upsertProject({
                name: projectMeta.name,
                path: projectPath,
                type: projectMeta.type,
                description: projectMeta.description,
                tasks_list: [],
                vibe: projectMeta.vibe,
                stack: projectMeta.stack,
                urls: projectMeta.urls
            });
            projectId = result?.id;
        }

        res.json({
            success: true,
            message: `Project '${name}' initialized${supervisor ? ' with Supervisor setup' : ''}.`,
            path: projectPath,
            id: projectId
        });
    } catch (error) {
        console.error(`Error scaffolding project:`, error);
        res.status(500).json({ error: 'Failed to scaffold project: ' + error.message });
    }
});

// Ping a project's production URL
// SSRF Protection: only allow HTTPS URLs to public domains
app.get('/api/projects/:id/ping', async (req, res) => {
    const { id } = req.params;
    const project = await getProjectById(PROJECT_ROOT, id);

    if (!project) {
        return res.status(404).json({ error: 'Project not found' });
    }

    const productionUrl = project.urls?.production;
    if (!productionUrl) {
        return res.json({ hasUrl: false, isUp: null, url: null });
    }

    // SSRF protection: validate URL before fetching
    try {
        const parsed = new URL(productionUrl);
        if (!['http:', 'https:'].includes(parsed.protocol)) {
            return res.status(400).json({ error: 'Only HTTP/HTTPS URLs are allowed' });
        }
        // Block private/internal IPs
        const blockedPatterns = /^(localhost|127\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|169\.254\.|0\.0\.0\.0|\[::1\])/i;
        if (blockedPatterns.test(parsed.hostname)) {
            return res.status(400).json({ error: 'Internal URLs are not allowed' });
        }
    } catch (urlError) {
        return res.status(400).json({ error: 'Invalid URL format' });
    }

    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);

        const response = await fetch(productionUrl, {
            method: 'HEAD',
            signal: controller.signal,
            redirect: 'manual' // Don't follow redirects (prevents redirect-based SSRF)
        });

        clearTimeout(timeout);
        res.json({ hasUrl: true, isUp: response.ok || response.status === 301 || response.status === 302, url: productionUrl, status: response.status });
    } catch (error) {
        res.json({ hasUrl: true, isUp: false, url: productionUrl, error: error.message });
    }
});

// Get recent activity across all projects
app.get('/api/activity', async (req, res) => {
    const projects = await getAllProjects(PROJECT_ROOT);
    const activities = [];

    for (const project of projects) {
        const gitPath = path.join(project.path, '.git');
        if (!fs.existsSync(gitPath)) continue;

        try {
            const git = simpleGit(project.path);
            const log = await git.log({ maxCount: 5 });

            for (const commit of log.all) {
                activities.push({
                    projectId: project.id,
                    projectName: project.name,
                    type: 'commit',
                    hash: commit.hash,
                    message: commit.message,
                    author: commit.author_name,
                    date: commit.date,
                });
            }
        } catch (error) {
            // Suppress verbose logging for expected "no commits" scenario
            if (error.message && error.message.includes('does not have any commits')) {
                // Skip silently - no commits to show for activity feed
            } else {
                console.warn(`[Activity] Could not get log for ${project.name}: ${error.message}`);
            }
        }
    }

    // Sort by date descending
    activities.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    // Return top 20
    res.json(activities.slice(0, 20));
});

// Get single project details
app.get('/api/projects/:id', async (req, res) => {
    const { id } = req.params;

    try {
        const project = await getProjectById(PROJECT_ROOT, id);

        if (!project) {
            return res.status(404).json({ error: 'Project not found' });
        }

        res.json(project);
    } catch (e) {
        console.error(`Error getting project ${id}:`, e);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Update project details
app.patch('/api/projects/:id', async (req, res) => {
    const { id } = req.params;
    const updates = req.body;

    // Validate updates
    const allowedFields = ['name', 'description', 'type', 'vibe', 'stack', 'urls', 'path'];
    const filteredUpdates = {};

    for (const key of Object.keys(updates)) {
        if (allowedFields.includes(key)) {
            filteredUpdates[key] = updates[key];
        }
    }

    if (Object.keys(filteredUpdates).length === 0) {
        return res.status(400).json({ error: 'No valid fields to update' });
    }

    try {
        const updatedProject = await db.updateProject(id, filteredUpdates);

        if (!updatedProject) {
            return res.status(404).json({ error: 'Project not found or update failed' });
        }

        res.json(updatedProject);
    } catch (error) {
        console.error(`Error updating project ${id}:`, error);
        res.status(500).json({ error: 'Failed to update project' });
    }
});

// Delete a project (DB entry + optionally files)
app.delete('/api/projects/:id', async (req, res) => {
    const { id } = req.params;
    const { deleteFiles } = req.query; // ?deleteFiles=true to also delete directory

    try {
        const project = await getProjectById(PROJECT_ROOT, id);

        if (!project) {
            return res.status(404).json({ error: 'Project not found' });
        }

        // Delete from database first
        const dbDeleted = await db.deleteProject(id);
        if (!dbDeleted) {
            return res.status(500).json({ error: 'Failed to delete project from database' });
        }

        // Optionally delete files
        let filesDeleted = false;
        if (deleteFiles === 'true' && project.path && fs.existsSync(project.path)) {
            try {
                fs.rmSync(project.path, { recursive: true, force: true });
                filesDeleted = true;
                console.log(`[Projects] Deleted files for project ${id} at ${project.path}`);
            } catch (fsError) {
                console.error(`[Projects] Failed to delete files for ${id}:`, fsError);
                return res.json({
                    success: true,
                    dbDeleted: true,
                    filesDeleted: false,
                    error: 'Database entry deleted but failed to remove files: ' + fsError.message
                });
            }
        }

        res.json({
            success: true,
            dbDeleted: true,
            filesDeleted,
            message: filesDeleted ? 'Project and files deleted' : 'Project removed from database'
        });
    } catch (error) {
        console.error(`Error deleting project ${id}:`, error);
        res.status(500).json({ error: 'Failed to delete project: ' + error.message });
    }
});

// Get project context (Supervisor)
app.get('/api/projects/:id/context', async (req, res) => {
    const { id } = req.params;

    if (!db.isDatabaseEnabled()) {
        return res.json({ contexts: [] });
    }

    try {
        const contexts = await db.getProjectContexts(id);
        res.json({ contexts: contexts || [] });
    } catch (error) {
        console.error(`Error getting context for ${id}:`, error);
        res.status(500).json({ error: 'Failed to get project context' });
    }
});

// Update project context
app.post('/api/projects/:id/context', async (req, res) => {
    const { id } = req.params;
    const { type, content, status } = req.body;

    if (!type || !content) {
        return res.status(400).json({ error: 'type and content are required' });
    }

    if (!db.isDatabaseEnabled()) {
        return res.status(501).json({ error: 'Database not enabled' });
    }

    try {
        const result = await db.updateProjectContext(id, type, content, status);
        if (!result) {
            return res.status(500).json({ error: 'Failed to update context' });
        }
        res.json({ success: true, context: result });
    } catch (error) {
        console.error(`Error updating context for ${id}:`, error);
        res.status(500).json({ error: 'Failed to update context' });
    }
});

// Sync context from Git (Git pull ? read files ? upsert to DB)
app.post('/api/projects/:id/context/sync', async (req, res) => {
    const { id } = req.params;

    const project = await getProjectById(PROJECT_ROOT, id);
    if (!project) {
        return res.status(404).json({ error: 'Project not found' });
    }

    if (!db.isDatabaseEnabled()) {
        return res.status(501).json({ error: 'Database not enabled' });
    }

    try {
        console.log(`[ContextSync] Syncing context for project ${project.name}...`);
        const result = await contextSync.pullAndSyncFromGit(id, project.path, db);

        res.json({
            success: result.success,
            synced: result.synced,
            pulled: result.pulled,
            errors: result.errors
        });
    } catch (error) {
        console.error(`Error syncing context for ${id}:`, error);
        res.status(500).json({ error: 'Failed to sync context: ' + error.message });
    }
});

// Verify context sync status (compare DB vs local files)
app.get('/api/projects/:id/context/verify', async (req, res) => {
    const { id } = req.params;

    const project = await getProjectById(PROJECT_ROOT, id);
    if (!project) {
        return res.status(404).json({ error: 'Project not found' });
    }

    if (!db.isDatabaseEnabled()) {
        return res.status(501).json({ error: 'Database not enabled' });
    }

    try {
        const result = await contextSync.verifyContextSync(id, project.path, db);
        res.json(result);
    } catch (error) {
        console.error(`Error verifying context sync for ${id}:`, error);
        res.status(500).json({ error: 'Failed to verify context sync: ' + error.message });
    }
});

// Get project README
app.get('/api/projects/:id/readme', async (req, res) => {
    const { id } = req.params;
    const project = await getProjectById(PROJECT_ROOT, id);

    if (!project) {
        return res.status(404).json({ error: 'Project not found' });
    }

    // Try both README.md and readme.md
    const readmeNames = ['README.md', 'readme.md', 'Readme.md'];
    let content = null;
    let foundPath = null;

    for (const name of readmeNames) {
        const readmePath = path.join(project.path, name);
        if (fs.existsSync(readmePath)) {
            try {
                content = fs.readFileSync(readmePath, 'utf-8');
                foundPath = name;
                break;
            } catch (e) {
                // Continue to next option
            }
        }
    }

    if (!content) {
        return res.json({ exists: false, content: null });
    }

    res.json({ exists: true, content, filename: foundPath });
});

// Get project commit history
app.get('/api/projects/:id/commits', async (req, res) => {
    const { id } = req.params;
    const project = await getProjectById(PROJECT_ROOT, id);

    if (!project) {
        return res.status(404).json({ error: 'Project not found' });
    }

    const gitPath = path.join(project.path, '.git');
    if (!fs.existsSync(gitPath)) {
        return res.json({ commits: [], hasGit: false });
    }

    try {
        const git = simpleGit(project.path);
        const log = await git.log({ maxCount: 50 });

        const commits = log.all.map(c => ({
            hash: c.hash,
            message: c.message,
            author: c.author_name,
            email: c.author_email,
            date: c.date,
        }));

        res.json({ commits, hasGit: true });
    } catch (error) {
        // If no commits yet (freshly git-init'd), just return empty list silently
        const isEmptyRepo = error.message.includes('does not have any commits') || error.message.includes('fatal: bad default revision');
        if (!isEmptyRepo) console.warn(`Error getting commits for ${id}:`, error.message);
        if (error.message.includes('does not have any commits') || error.message.includes('fatal: bad default revision')) {
            return res.json({ commits: [], hasGit: true });
        }
        res.status(500).json({ error: 'Failed to get commit history' });
    }
});

// Pinned projects storage
const PINS_FILE = path.join(__dirname, '..', 'pinned.json');

function getPinnedProjects() {
    try {
        if (fs.existsSync(PINS_FILE)) {
            return JSON.parse(fs.readFileSync(PINS_FILE, 'utf8'));
        }
    } catch (e) {
        console.warn('Could not read pins file:', e);
    }
    return [];
}

function savePinnedProjects(pins) {
    fs.writeFileSync(PINS_FILE, JSON.stringify(pins, null, 2));
}

// Get pinned projects
app.get('/api/pins', (req, res) => {
    res.json(getPinnedProjects());
});

// Pin/unpin a project
app.post('/api/projects/:id/pin', (req, res) => {
    const { id } = req.params;
    const pins = getPinnedProjects();

    if (!pins.includes(id)) {
        pins.push(id);
        savePinnedProjects(pins);
    }

    res.json({ success: true, pinned: true });
});

app.delete('/api/projects/:id/pin', (req, res) => {
    const { id } = req.params;
    let pins = getPinnedProjects();
    pins = pins.filter(p => p !== id);
    savePinnedProjects(pins);

    res.json({ success: true, pinned: false });
});

// AI Chat endpoint
// Supports new modelConfig object with provider-specific thinking configurations
app.post('/api/ai/chat', async (req, res) => {
    const { message, modelConfig, model, mode, history, projectId, session_id, files } = req.body || {};

    console.log(`\n?? [AI Chat] Request Details:`);
    console.log(`   � Mode: ${mode}`);
    console.log(`   � Model: ${model || (modelConfig && modelConfig.id)}`);
    console.log(`   � Message: "${message ? message.substring(0, 50) : 'None'}..."`);
    console.log(`   � Files: ${files ? files.length : 0} attached`);

    if (!message) {
        return res.status(400).json({ error: 'Message is required' });
    }

    // ---------------------------------------------------------------
    // PROXY TO PYTHON CORTEX (for Agent/Tools)
    // ---------------------------------------------------------------
    // If mode is 'agent' or 'cortex', we proxy to the Python backend
    // which has access to the Cortex tools.
    if (mode === 'agent' || mode === 'cortex') {
        try {
            console.log(`[AI Chat] Proxying 'agent' request to Python Cortex (Port 8000)...`);
            if (files && files.length > 0) {
                console.log(`   � Forwarding ${files.length} file(s) to Python:`, files.map(f => f.name));
            }

            // Construct the payload expected by Python's /ai-builder/chat
            const pythonPayload = {
                user_request: message,
                // Fix: Generate unique session_id for each request to ensure new threads
                // Do NOT use projectId (would share state across all chats) or 'terminal-session' (hardcoded collision)
                session_id: session_id || require('crypto').randomUUID(),
                project_id: projectId,
                // Pass existing workflow context if available, otherwise null
                existing_workflow: null,
                // Forward file contents to Python
                files: files || null,
                // Enable full Cortex Brain (System 2 Orchestrator with Glass Box)
                use_cortex_brain: true
            };

            const pythonResponse = await fetch('http://localhost:8000/ai-builder/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(pythonPayload),
                signal: AbortSignal.timeout(300000), // 5 min — council reviews generate large parallel payloads
            });

            if (!pythonResponse.ok) {
                const errorText = await pythonResponse.text();
                throw new Error(`Python backend error: ${pythonResponse.status} ${errorText}`);
            }

            const data = await pythonResponse.json();

            // Check for Cortex Brain error (brain loaded but failed during processing)
            if (data.mode === 'cortex_brain_error') {
                console.error(`[AI Chat] Cortex Brain Error:`, data.response);
                return res.json({
                    response: data.response,
                    model: 'cortex-error',
                    provider: 'TheCortex',
                    mode: mode,
                    isThinking: false,
                    tokenUsage: { total: 0 },
                    artifacts: []
                });
            }

            // Append Debug Footer with mode info
            const modeInfo = data.mode === 'cortex_brain' ? 'System 2 Brain (Agora)' : 'Simple Responder';
            const debugFooter = `\n\n_�_\n*?? Debug: ${modeInfo}*`;

            // Transform back to the format Praxis Terminal expects
            // The Python aggregator returns { response, messages, artifacts, ... }
            return res.json({
                response: data.response + debugFooter,
                model: data.mode === 'cortex_brain' ? 'cortex-system2' : 'cortex-responder',
                provider: 'TheCortex',
                mode: mode,
                isThinking: false,
                tokenUsage: { total: 0 },
                artifacts: data.artifacts || []  // Glass Box artifacts from System 2
            });

        } catch (error) {
            console.error(`[AI Chat] Cortex Proxy Error:`, error);
            // Fallback to standard chat if proxy fails, or return error
            // Let's return a specific error so the user knows Cortex is down
            return res.json({
                response: `?? **Connection to The Cortex Failed**\n\nI couldn't reach the Python engine (Port 8000). Ensure \`launch_system.bat\` is running.\n\nError: ${error.message}`,
                model: 'system-error',
                provider: 'System',
                mode: mode
            });
        }
    }

    // ---------------------------------------------------------------
    // STANDARD LLM ROUTING (Chat/Code)
    // ---------------------------------------------------------------

    // Handle both new modelConfig format and legacy model string
    const config = modelConfig || {
        id: model || 'gemini-2.5-flash',
        apiModelId: model || 'gemini-2.5-flash',
        provider: 'Google', // Default to Google for legacy
        isThinking: false,
        parameters: {}
    };

    console.log(`[AI Chat] Provider: ${config.provider}, Model: ${config.apiModelId}, Thinking: ${config.isThinking}`);

    // Build system prompt based on mode
    let systemPrompt = 'You are a helpful AI assistant for a developer dashboard called The Nexus.';



    // Check for API keys per provider
    const apiKeys = {
        Google: process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY,
        OpenAI: process.env.OPENAI_API_KEY,
        Anthropic: process.env.ANTHROPIC_API_KEY,
        xAI: process.env.XAI_API_KEY,
    };

    const providerKey = apiKeys[config.provider];

    if (!providerKey) {
        return res.json({
            response: `Praxis Terminal is ready! To enable ${config.provider} models, add the appropriate API key to your .env file:\n\n` +
                `- GOOGLE_API_KEY or GEMINI_API_KEY for Gemini\n` +
                `- OPENAI_API_KEY for OpenAI/GPT\n` +
                `- ANTHROPIC_API_KEY for Claude\n\n` +
                `Your message was: "${message}"\n\n` +
                `Once configured, I'll be able to help you manage your projects!`,
            model: config.apiModelId,
            provider: config.provider,
            mode: mode,
        });
    }

    try {
        // Call unified AI router with direct config
        const aiResponse = await callAI(config, message, systemPrompt, history, { returnFullResult: true });

        // Debug Footer for Standard Chat
        let debugFooter = `\n\n_�_\n*?? Debug: Native Node.js Route (Chat Mode).*`;

        // Heuristic Hint
        if (message.toLowerCase().includes('autopilot') || message.toLowerCase().includes('cortex') || message.toLowerCase().includes('debate')) {
            debugFooter += `\n*?? Tip: Switch to "Agent" mode to access Cortex Tools (Autopilot, Debates).*`;
        }

        return res.json({
            response: aiResponse.text + debugFooter,
            model: config.apiModelId,
            provider: config.provider,
            mode: mode,
            isThinking: config.isThinking,
            tokenUsage: aiResponse.usage
        });

    } catch (error) {
        console.error(`[AI Chat] Error with ${config.provider}:`, error);

        return res.status(500).json({
            error: `Failed to get response from ${config.provider}: ${error.message}`,
            model: config.apiModelId
        });
    }

});

// ---------------------------------------------------------------
// SYSTEM MONITOR & AI USAGE ENDPOINTS
// ---------------------------------------------------------------

// Get system status (CPU, memory, ports)
app.get('/api/system/status', async (req, res) => {
    try {
        // Force refresh if requested
        const refresh = req.query.refresh === 'true';
        const status = await systemMonitor.getSystemStatus(refresh);
        res.json(status);
    } catch (error) {
        console.error('Error getting system status:', error);
        res.status(500).json({ error: 'Failed to get system status' });
    }
});

// Get AI token usage stats
app.get('/api/ai/usage', async (req, res) => {
    try {
        const stats = await tokenTracker.getUsageStats({
            projectId: req.query.projectId,
            provider: req.query.provider,
            days: req.query.days ? parseInt(req.query.days) : 30
        });
        res.json(stats);
    } catch (error) {
        console.error('Error getting usage stats:', error);
        res.status(500).json({ error: 'Failed to get usage stats' });
    }
});

// ═══════════════════════════════════════��������������������������������
// Google Gemini Handler moved to services/ai-service.js

// ═══��������������������������������������������������������������������������������
// OpenAI GPT Handler moved to services/ai-service.js

// ═����������������������������������������������������������������������������������
// Anthropic Claude Handler moved to services/ai-service.js

// Commit and push changes
app.post('/api/projects/:id/commit-push', async (req, res) => {
    const { id } = req.params;
    const { message } = req.body;

    if (!message || !message.trim()) {
        return res.status(400).json({ error: 'Commit message is required' });
    }

    const project = await getProjectById(PROJECT_ROOT, id);

    if (!project) {
        return res.status(404).json({ error: 'Project not found' });
    }

    const gitPath = path.join(project.path, '.git');
    if (!fs.existsSync(gitPath)) {
        return res.status(400).json({ error: 'No git repository in this project' });
    }

    try {
        const git = simpleGit(project.path);

        // Stage all changes
        await git.add('.');

        // Get status
        const status = await git.status();
        if (status.files.length === 0) {
            return res.json({ success: true, message: 'No changes to commit', filesCommitted: 0 });
        }

        // Commit
        await git.commit(message.trim());

        // Check for remote
        const remotes = await git.getRemotes();
        if (remotes.length === 0) {
            return res.json({
                success: true,
                message: `Committed ${status.files.length} file(s). No remote configured, push skipped.`,
                filesCommitted: status.files.length,
                pushed: false
            });
        }

        // Push
        await git.push('origin', status.current);

        res.json({
            success: true,
            message: `Committed and pushed ${status.files.length} file(s)`,
            filesCommitted: status.files.length,
            pushed: true
        });
    } catch (error) {
        console.error(`Error committing/pushing ${id}:`, error);
        res.status(500).json({ error: 'Failed to commit/push: ' + error.message });
    }
});

// Get git diff for a project
app.get('/api/projects/:id/diff', async (req, res) => {
    const { id } = req.params;
    const project = await getProjectById(PROJECT_ROOT, id);

    if (!project) {
        return res.status(404).json({ error: 'Project not found' });
    }

    const gitPath = path.join(project.path, '.git');
    if (!fs.existsSync(gitPath)) {
        return res.status(400).json({ error: 'No git repository' });
    }

    try {
        const git = simpleGit(project.path);

        // Get staged and unstaged diff
        const [diffSummary, diff] = await Promise.all([
            git.diffSummary(),
            git.diff()
        ]);

        // Also get status for new files
        const status = await git.status();

        res.json({
            summary: diffSummary,
            diff: diff.substring(0, 5000), // Limit diff size
            files: status.files.map(f => ({ path: f.path, status: f.index || f.working_dir })),
            truncated: diff.length > 5000
        });
    } catch (error) {
        console.warn(`Error getting diff for ${id}:`, error.message);
        // Handle empty repo
        if (error.message.includes('bad default revision') || error.message.includes('unknown revision')) {
            return res.json({
                summary: { changed: 0, insertions: 0, deletions: 0, files: [] },
                diff: '',
                files: [],
                truncated: false,
                note: 'No commits yet'
            });
        }
        res.status(500).json({ error: 'Failed to get diff: ' + error.message });
    }
});

// Generate AI commit message from diff
app.post('/api/projects/:id/generate-commit-message', async (req, res) => {
    const { id } = req.params;
    const { taskId } = req.body;  // Optional: include walkthrough context
    const project = await getProjectById(PROJECT_ROOT, id);

    if (!project) {
        return res.status(404).json({ error: 'Project not found' });
    }

    try {
        const git = simpleGit(project.path);
        const status = await git.status();
        let diff = '';
        try {
            diff = await git.diff();
        } catch (e) {
            // Ignore diff error on fresh repo
            console.warn(`Could not get diff for message gen (likely new repo): ${e.message}`);
        }

        if (status.files.length === 0) {
            return res.json({ message: 'No changes to commit' });
        }

        // Build a summary of changes
        const fileChanges = status.files.map(f => `${f.index || f.working_dir} ${f.path}`).join('\n');
        const diffPreview = diff.substring(0, 2000);

        // If taskId provided, fetch walkthrough for richer context
        let walkthroughContent = '';
        if (taskId) {
            try {
                const task = await db.getTask(taskId);
                if (task?.walkthrough) {
                    // Extract walkthrough content (may be a string or object)
                    const wt = typeof task.walkthrough === 'string'
                        ? task.walkthrough
                        : task.walkthrough.content || JSON.stringify(task.walkthrough);
                    walkthroughContent = wt.substring(0, 3000);
                    console.log(`[Commit Msg] Including walkthrough summary (${walkthroughContent.length} chars) for task ${taskId}`);
                }
            } catch (wtErr) {
                console.warn(`[Commit Msg] Could not fetch walkthrough for task ${taskId}:`, wtErr.message);
            }
        }

        // Check for API keys
        const apiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY ||
            process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY;

        if (!apiKey) {
            // Generate a simple auto-message without AI
            const types = new Set();
            status.files.forEach(f => {
                if (f.path.includes('component') || f.path.endsWith('.tsx')) types.add('component');
                if (f.path.includes('server') || f.path.endsWith('.js')) types.add('server');
                if (f.path.endsWith('.css')) types.add('style');
                if (f.path.endsWith('.md')) types.add('docs');
            });

            const typeStr = types.size > 0 ? Array.from(types).join(', ') : 'code';
            const message = `Update ${typeStr}: ${status.files.length} file(s) changed`;

            return res.json({
                message,
                generated: false,
                note: 'Add an AI API key for smarter commit messages'
            });
        }

        const prompt = `Generate a concise git commit message (max 72 chars for first line) for these changes:

Files changed:
${fileChanges}
${walkthroughContent ? `
Implementation Summary (from walkthrough):
${walkthroughContent}
` : ''}
Diff preview:
${diffPreview}

Follow conventional commits format (feat:, fix:, docs:, refactor:, etc). Return ONLY the commit message, nothing else.`;

        try {
            // Use unified AI service
            const aiMessage = await callAI('quick', prompt, 'You are a git commit message generator.');

            if (aiMessage) {
                return res.json({ message: aiMessage.trim(), generated: true });
            }
        } catch (aiError) {
            console.error('AI generation error:', aiError);
        }

        // Fallback
        res.json({
            message: `Update: ${status.files.length} file(s) changed`,
            generated: false
        });
    } catch (error) {
        console.error(`Error generating commit message for ${id}:`, error);
        res.status(500).json({ error: 'Failed to generate commit message' });
    }
});

// ════════════════════════════════════�═╕════════════════════════��
// PLANNED FEATURES API
// Manages feature ideas/roadmap for each project
// ════�══════════════════�═���������������������������������������������������


// ════�═══��═��════════���������������������������������������������������
// AI CONTEXT UTILITIES
// Builds rich context for AI feature research and implementation
// ════�═══�═��═�������═�����������������������������������������������������

// AI Model configuration moved to services/ai-service.js

// Get directory tree up to specified depth
function getDirectoryTree(dirPath, maxDepth = 3, currentDepth = 0, prefix = '') {
    if (currentDepth >= maxDepth) return '';

    const ignoreDirs = ['node_modules', '.git', '.next', 'dist', 'build', '__pycache__', '.venv', 'venv', '.cache'];
    const ignoreFiles = ['.DS_Store', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'];

    let tree = '';
    try {
        const items = fs.readdirSync(dirPath, { withFileTypes: true });
        const filtered = items.filter(item => {
            if (item.isDirectory() && ignoreDirs.includes(item.name)) return false;
            if (item.isFile() && ignoreFiles.includes(item.name)) return false;
            return !item.name.startsWith('.');
        });

        filtered.forEach((item, index) => {
            const isLast = index === filtered.length - 1;
            const connector = isLast ? '└── ' : '├── ';
            const extension = isLast ? '    ' : '│   ';

            tree += `${prefix}${connector}${item.name}${item.isDirectory() ? '/' : ''}\n`;

            if (item.isDirectory()) {
                tree += getDirectoryTree(
                    path.join(dirPath, item.name),
                    maxDepth,
                    currentDepth + 1,
                    prefix + extension
                );
            }
        });
    } catch (e) {
        // Ignore permission errors
    }
    return tree;
}

// Read key files for context
function readKeyFiles(projectPath) {
    const keyFiles = [
        'README.md',
        'readme.md',
        'project.json',
        'package.json',
        'tsconfig.json',
        'next.config.js',
        'next.config.ts',
        'vite.config.js',
        'vite.config.ts',
        'src/index.js',
        'src/index.ts',
        'src/main.js',
        'src/main.ts',
        'src/app.js',
        'src/app.ts',
        'src/server.js',
        'src/server.ts',
        'app/page.tsx',
        'app/layout.tsx',
        'pages/index.tsx',
        'pages/_app.tsx'
    ];

    const contents = {};
    const maxFileSize = 10000; // Limit file content to prevent token explosion

    for (const file of keyFiles) {
        const filePath = path.join(projectPath, file);
        if (fs.existsSync(filePath)) {
            try {
                let content = fs.readFileSync(filePath, 'utf8');
                if (content.length > maxFileSize) {
                    content = content.substring(0, maxFileSize) + '\n... [truncated]';
                }
                contents[file] = content;
            } catch (e) {
                // Ignore read errors
            }
        }
    }

    return contents;
}

// Build comprehensive project context for AI
function buildProjectContext(projectPath, projectData) {
    const tree = getDirectoryTree(projectPath, 4);
    const keyFiles = readKeyFiles(projectPath);

    let context = `# PROJECT CONTEXT\n\n`;
    context += `## Project Metadata (project.json)\n\`\`\`json\n${JSON.stringify(projectData, null, 2)}\n\`\`\`\n\n`;
    context += `## File Structure\n\`\`\`\n${tree}\n\`\`\`\n\n`;

    context += `## Key Files\n`;
    for (const [filename, content] of Object.entries(keyFiles)) {
        if (filename !== 'project.json') { // Already included above
            const lang = filename.endsWith('.json') ? 'json' :
                filename.endsWith('.md') ? 'markdown' :
                    filename.endsWith('.ts') || filename.endsWith('.tsx') ? 'typescript' : 'javascript';
            context += `### ${filename}\n\`\`\`${lang}\n${content}\n\`\`\`\n\n`;
        }
    }

    return context;
}

// Call Gemini API moved to services/ai-service.js
// Call Claude API moved to services/ai-service.js

// GET tasks for a project
app.get('/api/projects/:id/tasks', async (req, res) => {
    const { id } = req.params;

    const project = await getProjectById(PROJECT_ROOT, id);

    if (!project) {
        return res.status(404).json({ error: 'Project not found' });
    }

    try {
        const tasks = await db.getTasks(project.id);

        const mappedTasks = tasks.map(t => {
            return {
                ...t,
                title: t.name, // compatibility
                createdAt: t.created_at,
                updatedAt: t.updated_at
            };
        });

        res.json({ tasks: mappedTasks });
    } catch (err) {
        console.error('Error fetching tasks:', err);
        res.status(500).json({ error: 'Database error' });
    }
});

// POST add a new task
app.post('/api/projects/:id/tasks', async (req, res) => {
    const { id } = req.params;
    const { title, description, templateId } = req.body;

    if (!title || !title.trim()) {
        return res.status(400).json({ error: 'Task title is required' });
    }

    // Pre-flight Validation
    let validation = {};
    try {
        console.log(`[Task Pre-flight] Validating request: "${title}"`);
        validation = await validateInitiativeRequest({ title, description });
        console.log('[Task Pre-flight] Result:', validation);
    } catch (valErr) {
        console.warn('[Task Pre-flight] Validation failed, proceeding anyway:', valErr);
        validation = { error: valErr.message };
    }

    const project = await getProjectById(PROJECT_ROOT, id);

    if (!project) {
        return res.status(404).json({ error: 'Project not found' });
    }

    try {
        const newTask = {
            project_id: project.id,
            name: title.trim(),
            description: description?.trim() || '',
            status: 'idea',
            priority: 0,
            initiative_validation: validation,
            source: 'user', // Default source
            langgraph_template: templateId || null,
            metadata: {
                classifiedAt: new Date().toISOString()
            }
        };

        const created = await db.createTask(newTask);

        // Return with compatibility fields
        res.json({
            success: true,
            task: {
                ...created,
                title: created.name,
                createdAt: created.created_at
            }
        });
    } catch (error) {
        console.error('Error creating task:', error);
        res.status(500).json({ error: 'Failed to create task' });
    }
});

// =============================================================================
// DASHBOARD INITIATIVES API — Routes are defined later (~line 3780+)
// to use the correct schema (name, status: 'idea', background execution).
// =============================================================================

// DELETE a task
app.delete('/api/projects/:id/tasks/:taskId', async (req, res) => {
    const { id, taskId } = req.params;

    // Verify project exists (optional but good for validation)
    const project = await getProjectById(PROJECT_ROOT, id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    try {
        const success = await db.deleteTask(taskId);
        if (!success) {
            return res.status(404).json({ error: 'Task not found or failed to delete' });
        }
        res.json({ success: true, message: 'Task deleted' });
    } catch (err) {
        console.error('Error deleting task:', err);
        res.status(500).json({ error: 'Database error' });
    }
});

// PATCH update a task (status, title, description)
app.patch('/api/projects/:id/tasks/:taskId', async (req, res) => {
    const { id, taskId } = req.params;
    const { title, description, status } = req.body;

    const project = await getProjectById(PROJECT_ROOT, id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    try {
        const existing = await db.getTask(taskId);
        if (!existing) return res.status(404).json({ error: 'Task not found' });

        const updates = {
            updated_at: new Date().toISOString()
        };

        if (title !== undefined) updates.name = title.trim();
        if (description !== undefined) updates.description = description.trim();

        if (status !== undefined) {
            updates.status = status;

            // Handle resets via metadata clearing if needed
            if (status === 'idea') {
                // Clear columns
                updates.research_output = null;
                updates.plan_output = null;
                updates.walkthrough = null;
                updates.research_interaction_id = null;
                updates.supervisor_status = null;
                updates.task_ledger = [];
                // Clear metadata related fields
                updates.metadata = {};
                updates.initiative_validation = null;
                updates.research_metadata = null;
                updates.plan_metadata = null;
                // Clear LangGraph workflow fields
                updates.langgraph_run_id = null;
                updates.langgraph_status = null;
                updates.langgraph_template = null;
                updates.langgraph_started_at = null;
            }
        }

        const updated = await db.updateTask(taskId, updates);

        res.json({
            success: true,
            task: {
                ...updated,
                title: updated.name,
                createdAt: updated.created_at,
                updatedAt: updated.updated_at
            }
        });
    } catch (err) {
        console.error('Error updating task:', err);
        res.status(500).json({ error: 'Database error' });
    }
});

// ═══════════════════════════════════════════════════════════════
// PHASE 2: AI WORKFLOW ENDPOINTS
// ══════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════

// Helper to route AI calls based on task configuration
// callAI and runDeepResearch moved to services/ai-service.js

// PATCH update a task directly by ID (for LangGraph workflow sync)
// Used by Python approval gates to sync artifacts without needing project ID
app.patch('/api/tasks/:taskId', async (req, res) => {
    const { taskId } = req.params;
    const { status, research_output, plan_output, walkthrough, status_message } = req.body;

    try {
        const existing = await db.getTask(taskId);
        if (!existing) return res.status(404).json({ error: 'Task not found' });

        const updates = {
            updated_at: new Date().toISOString()
        };

        if (status !== undefined) updates.status = status;
        if (research_output !== undefined) updates.research_output = research_output;
        if (plan_output !== undefined) updates.plan_output = plan_output;
        if (walkthrough !== undefined) updates.walkthrough = walkthrough;
        if (status_message !== undefined) {
            updates.metadata = {
                ...(existing.metadata || {}),
                status_message: status_message
            };
        }

        console.log(`[Task Sync] Updating task ${taskId}: status=${status}, has_research=${!!research_output}, has_plan=${!!plan_output}`);

        const updated = await db.updateTask(taskId, updates);

        res.json({
            success: true,
            task: updated
        });
    } catch (err) {
        console.error('[Task Sync] Error updating task:', err);
        res.status(500).json({ error: 'Database error' });
    }
});

// Function to resume any in-progress research tasks on startup
async function resumeDeepResearch() {
    console.log('[Resume Research] Checking for in-progress research tasks...');

    if (!db.isDatabaseEnabled()) {
        console.warn('[Resume Research] Database not enabled. Skipping.');
        return;
    }

    const projects = await getAllProjects(PROJECT_ROOT);
    const apiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;

    if (!apiKey) {
        console.warn('[Resume Research] No Google API Key configured. Cannot resume research.');
        return;
    }

    for (const project of projects) {
        try {
            const tasks = await db.getTasks(project.id);
            for (const task of tasks) {
                // Check if researching and has interaction ID in metadata
                // Note: Schema has research_interaction_id column, so we check that directly if mapped, 
                // OR check the "status" column.

                if (task.status === 'researching' && task.research_interaction_id) {
                    console.log(`[Resume Research] Resuming research for project ${project.id}, task ${task.id}`);

                    // We need context to resume? The original code built context.
                    // But runDeepResearch just takes a prompt? 
                    // Actually original code rebuilt the prompt. 
                    // IF we can't rebuild the exact prompt easily without re-reading files, maybe we just fail/reset it?
                    // OR we assume the agent handles conversational resumption if we pass the ID.
                    // The original code passed the PROMPT again. 
                    // Let's try to rebuild context if possible, or gracefully fail/reset if too complex.
                    // For now, let's just RESET to 'idea' if we can't easily resume, OR try to resume with a simple prompt.

                    // Actually, simple-git scan is still used for context? 
                    // getProjectContext uses simple-git and fs scan. match that.

                    // But wait, getProjectContext was imported from utils/project-manager which now relies on scanner.
                    // Scanner might still work if it just reads files.

                    // Let's assume we can just reset it to 'idea' for safety if resumption is flaky, 
                    // BUT user asked to "fix" it.
                    // Let's try to replicate the logic:

                    const projectData = { name: project.name, description: project.description }; // Minimal mock
                    const projectContext = buildProjectContext(project.path, projectData);

                    const prompt = `
${projectContext}

---

# TASK RESEARCH REQUEST
**Task:** ${task.name}
**Context:** ${task.description || 'No description provided.'}

Please perform a deep research on how to implement this task in the current codebase.
Produce a "Research Report" in markdown format that covers:
1. Feasibility Analysis
2. Architectural Options (pros/cons)
3. Recommended Approach (referencing existing files)
4. List of files likely to be modified
5. Potential Risks

DO NOT generate the full step-by-step implementation plan yet. That will be done in the next phase.
`;

                    // Fire and forget
                    runDeepResearch(prompt, apiKey, {
                        onStart: (interactionId) => {
                            console.log(`[Resume Research] Polling started for ${interactionId}`);
                        },
                        onComplete: async (content) => {
                            await db.updateTask(task.id, {
                                status: 'researched',
                                research_output: content,
                                updated_at: new Date().toISOString(),
                                research_interaction_id: null // clear it
                                // researchStartedAt: null 
                            });
                            console.log(`[Resume Research] Completed research for task ${task.id}`);
                        },
                        onFail: async (error) => {
                            console.error(`[Resume Research] Failed for task ${task.id}:`, error);
                            await db.updateTask(task.id, {
                                status: 'idea',
                                // researchError: error.message // No column for this, maybe metadata?
                                metadata: { ...task.metadata, researchError: error.message }, // Keep custom error in metadata for now, or move to research_metadata if preferred
                                research_metadata: { ...task.research_metadata, error: error.message },
                                research_interaction_id: null
                            });
                        }
                    }, task.research_interaction_id).catch(err => {
                        console.error(`[Resume Research] Unhandled error during resumption for task ${task.id}:`, err);
                    });
                }
            }
        } catch (err) {
            console.error(`[Resume Research] Error processing project ${project.id}:`, err);
        }
    }
}

// Call resumeDeepResearch on application startup
// This should be called after all necessary initializations (like PROJECT_ROOT)
// and before the server starts listening for requests, or as a background task.
// For simplicity, we'll call it immediately after its definition.
resumeDeepResearch();

// Function to handle features stuck in 'implementing' status on server restart
// Function to handle tasks stuck in 'implementing' status on server restart
async function resumeImplementations() {
    console.log('[Resume Implementations] Checking for stuck implementations...');

    if (!db.isDatabaseEnabled()) return;

    const projects = await getAllProjects(PROJECT_ROOT);

    for (const project of projects) {
        try {
            const tasks = await db.getTasks(project.id);
            for (const task of tasks) {
                if (task.status === 'implementing') {
                    // Check metadata for session info
                    const metadata = task.metadata || {};
                    const session = metadata.implementationSession;

                    // Check how long it's been since last activity
                    const lastActivity = session?.lastActivityAt ? new Date(session.lastActivityAt) : null;
                    const timeSinceActivity = lastActivity ? (Date.now() - lastActivity.getTime()) : Infinity;
                    const staleThreshold = 5 * 60 * 1000; // 5 minutes

                    if (timeSinceActivity > staleThreshold) {
                        console.log(`[Resume Implementations] Found stuck task ${task.id} in project ${project.id}`);

                        // Mark as failed with recovery info
                        // Update metadata
                        const updatedMetadata = {
                            ...metadata,
                            implementationSession: {
                                ...session,
                                error: 'Implementation interrupted (server restart).',
                                failedAt: new Date().toISOString(),
                                interruptedByRestart: true
                            }
                        };

                        await db.updateTask(task.id, {
                            status: 'planned', // Revert so user can retry
                            updated_at: new Date().toISOString(),
                            metadata: updatedMetadata
                        });

                        console.log(`[Resume Implementations] Reset stuck task ${task.id} to planned`);
                    }
                }
            }
        } catch (err) {
            console.error(`[Resume Implementations] Error checking project ${project.id}:`, err);
        }
    }
}

// Call resumeImplementations on startup
resumeImplementations();


// Trigger AI research for a feature
// Supports mode: 'quick' (thinking model) or 'deep' (full research agent)
// Trigger AI research for a task
// Supports mode: 'quick' (thinking model) or 'deep' (full research agent)


// Add feedback to research
app.post('/api/projects/:id/tasks/:taskId/research-feedback', async (req, res) => {
    const { id, taskId } = req.params;
    const { feedback } = req.body;

    const project = await getProjectById(PROJECT_ROOT, id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const task = await db.getTask(taskId);
    if (!task) return res.status(404).json({ error: 'Task not found' });

    // Store feedback in JSONB column 'feedback' (array)
    const newFeedbackItem = {
        id: crypto.randomUUID(),
        content: feedback,
        createdAt: new Date().toISOString(),
        action: 'comment',
        stage: 'research'
    };

    // Append to existing array (handle null)
    const currentFeedback = task.feedback || [];
    const updatedFeedback = [...currentFeedback, newFeedbackItem];

    await db.updateTask(taskId, {
        feedback: updatedFeedback,
        updated_at: new Date().toISOString()
    });

    res.json({ success: true, task: { ...task, feedback: updatedFeedback } });
});

// Reject research
app.post('/api/projects/:id/tasks/:taskId/reject-research', async (req, res) => {
    const { id, taskId } = req.params;
    const { feedback } = req.body;

    const project = await getProjectById(PROJECT_ROOT, id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const task = await db.getTask(taskId);
    if (!task) return res.status(404).json({ error: 'Task not found' });

    // Update feedback if provided
    let updatedFeedback = task.feedback || [];
    if (feedback) {
        updatedFeedback.push({
            id: crypto.randomUUID(),
            content: feedback,
            createdAt: new Date().toISOString(),
            action: 'reject',
            stage: 'research'
        });
    }

    await db.updateTask(taskId, {
        status: 'rejected',
        updated_at: new Date().toISOString(),
        feedback: updatedFeedback,
        research_metadata: { ...task.research_metadata, rejectedAt: new Date().toISOString() }
    });

    res.json({ success: true, task: { ...task, status: 'rejected', feedback: updatedFeedback } });
});

// Approve research and generate implementation plan (Claude)
app.post('/api/projects/:id/tasks/:taskId/approve-research', async (req, res) => {
    const { id, taskId } = req.params;
    const { feedback } = req.body || {};

    const project = await getProjectById(PROJECT_ROOT, id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const task = await db.getTask(taskId);
    if (!task) return res.status(404).json({ error: 'Task not found' });

    // 1. Update status and add feedback
    let updatedFeedback = task.feedback || [];
    if (feedback) {
        updatedFeedback.push({
            id: crypto.randomUUID(),
            content: feedback,
            createdAt: new Date().toISOString(),
            action: 'approve',
            stage: 'research'
        });
    }

    // Check if this task is running on LangGraph (has a runId)
    // CRITICAL: Use langgraph_run_id (Python's actual run ID), NOT supervisor_details.runId (Node.js session ID)
    const runId = task.langgraph_run_id;

    if (runId) {
        // === LANGGRAPH PATH: Resume the paused workflow ===
        console.log(`[approve-research] Task ${taskId} using langgraph_run_id: ${runId}`);
        console.log(`[approve-research] Calling LangGraph resume endpoint...`);

        const langGraphUrl = process.env.LANGGRAPH_URL || 'http://localhost:8000';

        try {
            const resumeResponse = await fetch(`${langGraphUrl}/graph/nexus/${runId}/resume`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    approval_action: 'approve',
                    feedback: feedback || null
                })
            });

            if (!resumeResponse.ok) {
                const errorText = await resumeResponse.text();
                console.error(`[approve-research] LangGraph resume failed: ${errorText}`);
                return res.status(500).json({ error: `Failed to resume workflow: ${errorText}` });
            }

            const resumeResult = await resumeResponse.json();
            console.log(`[approve-research] LangGraph workflow resumed successfully`);

            // Update task metadata with approval
            await db.updateTask(taskId, {
                updated_at: new Date().toISOString(),
                feedback: updatedFeedback,
                research_metadata: { ...task.research_metadata, approvedAt: new Date().toISOString() }
            });

            return res.json({
                success: true,
                message: 'Research approved - LangGraph workflow resuming',
                runId: runId,
                resumeStatus: resumeResult.status,
                task: { ...task, feedback: updatedFeedback }
            });

        } catch (fetchError) {
            console.error(`[approve-research] Failed to call LangGraph resume:`, fetchError);
            return res.status(500).json({ error: `Failed to resume workflow: ${fetchError.message}` });
        }
    }

    // === LEGACY PATH REMOVED ===
    console.log(`[approve-research] No LangGraph runId for task ${taskId}. Legacy plan generation is disabled.`);
    return res.status(400).json({
        error: 'This task is not part of an active workflow. Please restart the task using a Workflow Template.'
    });
});

// Approve implementation plan
app.post('/api/projects/:id/tasks/:taskId/approve-plan', async (req, res) => {
    const { id, taskId } = req.params;
    const { feedback } = req.body || {};

    const project = await getProjectById(PROJECT_ROOT, id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    try {
        const task = await db.getTask(taskId);
        if (!task) return res.status(404).json({ error: 'Task not found' });

        const metadata = task.metadata || {};
        const planMeta = task.plan_metadata || {};

        // Add feedback to metadata
        if (feedback && feedback.trim()) {
            const currentFeedback = planMeta.feedback || [];
            planMeta.feedback = [...currentFeedback, {
                id: `fb-${Date.now()}`,
                content: feedback.trim(),
                createdAt: new Date().toISOString(),
                action: 'approve'
            }];
        }

        // Check if this task is running on LangGraph (has a runId)
        // CRITICAL: Use langgraph_run_id (Python's actual run ID), NOT supervisor_details.runId (Node.js session ID)
        const runId = task.langgraph_run_id;

        if (runId) {
            // === LANGGRAPH PATH: Resume the paused workflow ===
            console.log(`[approve-plan] Task ${taskId} using langgraph_run_id: ${runId}`);
            console.log(`[approve-plan] Calling LangGraph resume endpoint...`);

            const langGraphUrl = process.env.LANGGRAPH_URL || 'http://localhost:8000';

            try {
                const resumeResponse = await fetch(`${langGraphUrl}/graph/nexus/${runId}/resume`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        approval_action: 'approve',
                        feedback: feedback || null
                    })
                });

                if (!resumeResponse.ok) {
                    const errorText = await resumeResponse.text();
                    console.error(`[approve-plan] LangGraph resume failed: ${errorText}`);
                    return res.status(500).json({ error: `Failed to resume workflow: ${errorText}` });
                }

                const resumeResult = await resumeResponse.json();
                console.log(`[approve-plan] LangGraph workflow resumed successfully`);

                // Update task metadata with approval
                await db.updateTask(taskId, {
                    status: 'implementing', // LangGraph will now build
                    updated_at: new Date().toISOString(),
                    plan_metadata: {
                        ...planMeta,
                        approvedAt: new Date().toISOString()
                    }
                });

                const updated = await db.getTask(taskId);

                return res.json({
                    success: true,
                    message: 'Plan approved - LangGraph workflow resuming to builder phase',
                    runId: runId,
                    resumeStatus: resumeResult.status,
                    task: {
                        ...updated,
                        title: updated.name,
                        createdAt: updated.created_at
                    }
                });

            } catch (fetchError) {
                console.error(`[approve-plan] Failed to call LangGraph resume:`, fetchError);
                return res.status(500).json({ error: `Failed to resume workflow: ${fetchError.message}` });
            }
        }

        // === LEGACY PATH REMOVED ===
        console.log(`[approve-plan] No LangGraph runId for task ${taskId}. Legacy approval is disabled.`);
        return res.status(400).json({
            error: 'This task is not part of an active workflow. Please restart the task using a Workflow Template.'
        });
    } catch (err) {
        console.error('Error approving plan:', err);
        res.status(500).json({ error: 'Database error: ' + err.message });
    }
});

// Reject walkthrough (trigger iterative fix)
// LEGACY: Removed in favor of LangGraph retry loops.

// Add comment/feedback to plan (without approval/rejection)
// Add comment/feedback to walkthrough (without approval/rejection)



// ═══════════════════════════════════════╕═══════════════════════
// AGENT CONFIGURATION MANAGEMENT ENDPOINTS
// ---------------------------------------------------------------------
// ATOMIC NODES REGISTRY (READ-ONLY)
// User-defined agents deprecated in favor of adding new atomic node classes
// ---------------------------------------------------------------------

// GET all atomic nodes (read-only, from Python backend)
app.get('/api/agents', async (req, res) => {
    try {
        // Fetch atomic nodes from Python backend
        const PYTHON_URL = process.env.PYTHON_BACKEND_URL || 'http://localhost:8000';

        // Retry helper with exponential backoff
        const fetchWithRetry = async (url, retries = 3, delay = 1000) => {
            for (let attempt = 1; attempt <= retries; attempt++) {
                try {
                    const response = await fetch(url);
                    if (!response.ok) {
                        throw new Error(`Python backend returned ${response.status}`);
                    }
                    return await response.json();
                } catch (err) {
                    if (attempt === retries) throw err;
                    console.log(`[Agents] Python backend not ready, retry ${attempt}/${retries}...`);
                    await new Promise(r => setTimeout(r, delay));
                    delay *= 2;
                }
            }
        };

        const atomicData = await fetchWithRetry(`${PYTHON_URL}/node-types/atomic`);
        const atomicAgents = atomicData.node_types || [];

        // Category icons for frontend display
        const CATEGORY_ICONS = {
            research: '??',
            planning: '???',
            implementation: '??',
            review: '???',
            orchestration: '??',
            utility: '??',
            dashboard: '??',
            project: '??',
            memory: '??',
        };

        // Map to agent format for frontend
        const agents = {};
        for (const node of atomicAgents) {
            // Python returns: type, displayName, description, category, icon, version, levels
            const typeId = node.type || node.type_id || node.name;
            agents[typeId] = {
                id: typeId,
                name: node.displayName || node.display_name || node.name,
                description: node.description,
                category: node.category,
                icon: CATEGORY_ICONS[node.category] || node.icon || '??',
                levels: node.levels || [],
                isSystem: true,  // All built-in, read-only
                source: 'atomic',
                version: node.version,
            };
        }

        // Get available models from DB (optional, don't fail if unavailable)
        let availableModels = [];
        try {
            if (db.isDatabaseEnabled()) {
                availableModels = await db.getModels(true) || [];
            }
        } catch (dbErr) {
            console.warn('[Agents] Could not fetch models from DB:', dbErr.message);
        }

        res.json({ agents, availableModels });

    } catch (error) {
        console.error('[Agents] ERROR:', error.message);
        res.status(503).json({
            error: 'Python backend unavailable - atomic nodes not loaded',
            agents: {},
            availableModels: []
        });
    }
});

// NOTE: POST/PUT/DELETE endpoints removed - user-defined agents deprecated
// New agents should be added as AtomicNode classes via Praxis tasks

// ═══════════════════════════════════════════════════════════════
// SYSTEM MONITORING & USAGE TRACKING ENDPOINTS
// ═══════════════════════════════════════════════════════════════


// POST reset AI token usage stats
app.post('/api/ai/usage/reset', (req, res) => {
    try {
        tokenTracker.resetUsageStats();
        res.json({ success: true, message: 'Usage stats reset' });
    } catch (error) {
        console.error('[Token Tracker] Error resetting stats:', error);
        res.status(500).json({ error: 'Failed to reset usage stats' });
    }
});

// ═══════════════════════════════════════════════════════════════
// DATABASE STATUS ENDPOINT (SQLite)
// ═══════════════════════════════════════════════════════════════

// GET database connection status
app.get('/api/database/status', async (req, res) => {
    try {
        const isEnabled = db.isDatabaseEnabled();

        if (!isEnabled) {
            return res.json({
                enabled: false,
                connected: false,
                message: 'Database not configured. Check NEXUS_DB_PATH in .env',
                tables: []
            });
        }

        const connectionResult = await db.testConnection();

        if (!connectionResult.success) {
            return res.json({
                enabled: true,
                connected: false,
                error: connectionResult.error,
                tables: []
            });
        }

        // Health info — just confirm connection is good
        const tableCounts = {};

        res.json({
            enabled: true,
            connected: true,
            tables: tableCounts,
            message: 'Database connected successfully'
        });
    } catch (error) {
        console.error('[Database] Status check error:', error);
        res.status(500).json({
            enabled: db.isDatabaseEnabled(),
            connected: false,
            error: error.message
        });
    }
});

// ═══════════════════════════════════════════════════════════════
// LANGGRAPH ENGINE BRIDGE (Python Backend)
// ═══════════════════════════════════════════════════════════════



setupResearchRoutes(app, getProjectById, PROJECT_ROOT);


// ============================================================================
// TASK-LEVEL LANGGRAPH DISPATCH (Python Backend Bridge)
// ============================================================================

// POST /api/projects/:id/tasks/:taskId/langgraph/run
// Dispatches a LangGraph workflow for a specific task
app.post('/api/projects/:id/tasks/:taskId/langgraph/run', async (req, res) => {
    const { id: projectId, taskId } = req.params;
    const { templateId, graphConfig } = req.body;

    console.log(`[LangGraph] Received request for project=${projectId}, task=${taskId}, template=${templateId}`);

    try {
        const project = await getProjectById(PROJECT_ROOT, projectId);
        if (!project) {
            return res.status(404).json({ error: 'Project not found' });
        }
        console.log(`[LangGraph] Found project at: ${project.path}`);

        // Get task from database
        const task = await db.getTask(taskId);
        if (!task) {
            console.log(`[LangGraph] Task not found in database: ${taskId}`);
            return res.status(404).json({ error: 'Task not found' });
        }

        // Load LangGraph supervisor service
        console.log(`[LangGraph] Loading langgraph-supervisor service...`);
        const lgSupervisor = require('./services/langgraph-supervisor');

        const result = await lgSupervisor.runLangGraphWorkflow({
            projectPath: project.path,
            projectId,
            taskId,
            taskData: {
                title: task.name || task.title || 'Untitled',
                description: task.description || ''
            },
            templateId,
            graphConfig
        });

        if (result.success && result.run_id) {
            // Determine the initial status based on the workflow
            const newStatus = task.status === 'idea' ? 'researching' : task.status;

            // Persist run ID and status to the database
            await db.updateTask(taskId, {
                langgraph_run_id: result.run_id,
                langgraph_status: 'running',
                langgraph_template: templateId || null,
                langgraph_started_at: new Date().toISOString(),
                status: newStatus
            });
            console.log(`[LangGraph] Saved run_id ${result.run_id} to database`);
        }

        res.json(result);
    } catch (error) {
        console.error(`[LangGraph] Error running workflow for task ${taskId}:`, error.message);
        console.error('[LangGraph] Stack:', error.stack);
        res.status(500).json({ error: error.message });
    }
});

// GET /api/projects/:id/tasks/:taskId/langgraph/status
// Polls the status of a running LangGraph workflow
app.get('/api/projects/:id/tasks/:taskId/langgraph/status', async (req, res) => {
    const { taskId } = req.params;
    const { runId } = req.query;

    if (!runId) {
        return res.status(400).json({ error: 'runId query parameter required' });
    }

    try {
        const lgSupervisor = require('./services/langgraph-supervisor');
        const status = await lgSupervisor.getLangGraphRunStatus(runId);
        res.json(status);
    } catch (error) {
        console.error(`[LangGraph] Error getting status for run ${runId}:`, error.message);
        res.status(500).json({ error: error.message });
    }
});


// -----------------------------------------------------------------------------
// PROJECT WORKFLOWS API
// Project-level workflows for branding, documentation, releases, etc.
// -----------------------------------------------------------------------------

// GET all workflows for a project
app.get('/api/projects/:id/workflows', async (req, res) => {
    try {
        const project = await getProjectById(PROJECT_ROOT, req.params.id);
        if (!project) {
            return res.status(404).json({ error: 'Project not found' });
        }

        const { status } = req.query;
        const workflows = await db.getProjectWorkflows(project.id, status || null);

        res.json({ workflows });
    } catch (error) {
        console.error('[Project Workflows API] Error fetching workflows:', error);
        res.status(500).json({ error: 'Failed to fetch project workflows' });
    }
});

// GET a single project workflow
app.get('/api/projects/:id/workflows/:workflowId', async (req, res) => {
    try {
        const workflow = await db.getProjectWorkflow(req.params.workflowId);
        if (!workflow) {
            return res.status(404).json({ error: 'Workflow not found' });
        }

        res.json({ workflow });
    } catch (error) {
        console.error('[Project Workflows API] Error fetching workflow:', error);
        res.status(500).json({ error: 'Failed to fetch workflow' });
    }
});

// POST create a new project workflow
app.post('/api/projects/:id/workflows', async (req, res) => {
    try {
        const project = await getProjectById(PROJECT_ROOT, req.params.id);
        if (!project) {
            return res.status(404).json({ error: 'Project not found' });
        }

        const { name, description, workflow_type, template_id, configuration, parent_initiative_id } = req.body;

        if (!name || !workflow_type) {
            return res.status(400).json({ error: 'Name and workflow_type are required' });
        }

        // Load stages from local JSON template file (source of truth)
        let stages = [];
        if (template_id) {
            const fs = require('fs');
            const path = require('path');
            const templatePath = path.resolve(__dirname, '../config/templates/workflows', `${template_id}.json`);
            if (fs.existsSync(templatePath)) {
                const jsonTemplate = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
                stages = jsonTemplate.stages || [];
                console.log(`[Project Workflows API] Loaded stages from template: ${template_id}`);
            } else {
                return res.status(400).json({ error: `Template not found: ${template_id}` });
            }
        }

        const workflow = await db.createProjectWorkflow({
            project_id: project.id,
            name,
            description: description || '',
            workflow_type,
            template_id: null,
            stages,
            configuration: { ...(configuration || {}), template_name: template_id || null },
            parent_initiative_id: parent_initiative_id || null,
            status: 'idea',
            current_stage: stages.length > 0 ? stages[0].id : null
        });

        if (!workflow) {
            return res.status(500).json({ error: 'Failed to create workflow' });
        }

        res.json({ success: true, workflow });
    } catch (error) {
        console.error('[Project Workflows API] Error creating workflow:', error);
        res.status(500).json({ error: 'Failed to create workflow' });
    }
});

// PATCH update a project workflow
app.patch('/api/projects/:id/workflows/:workflowId', async (req, res) => {
    try {
        const { name, description, status, current_stage, stages, configuration, outputs } = req.body;

        const updates = {};
        if (name !== undefined) updates.name = name;
        if (description !== undefined) updates.description = description;
        if (status !== undefined) updates.status = status;
        if (current_stage !== undefined) updates.current_stage = current_stage;
        if (stages !== undefined) updates.stages = stages;
        if (configuration !== undefined) updates.configuration = configuration;
        if (outputs !== undefined) updates.outputs = outputs;

        const workflow = await db.updateProjectWorkflow(req.params.workflowId, updates);

        if (!workflow) {
            return res.status(404).json({ error: 'Workflow not found' });
        }

        res.json({ success: true, workflow });
    } catch (error) {
        console.error('[Project Workflows API] Error updating workflow:', error);
        res.status(500).json({ error: 'Failed to update workflow' });
    }
});

// DELETE a project workflow
app.delete('/api/projects/:id/workflows/:workflowId', async (req, res) => {
    try {
        const success = await db.deleteProjectWorkflow(req.params.workflowId);
        if (!success) {
            return res.status(404).json({ error: 'Workflow not found' });
        }
        res.json({ success: true, message: 'Workflow deleted' });
    } catch (error) {
        console.error('[Project Workflows API] Error deleting workflow:', error);
        res.status(500).json({ error: 'Failed to delete workflow' });
    }
});

// POST run/start a project workflow
app.post('/api/projects/:id/workflows/:workflowId/run', async (req, res) => {
    try {
        const workflow = await db.getProjectWorkflow(req.params.workflowId);
        if (!workflow) {
            return res.status(404).json({ error: 'Workflow not found' });
        }

        const { context } = req.body; // Optional context from workflow goal/description
        const { runProjectWorkflowSupervisor } = require('./services/project-workflow-supervisor');

        // Start the workflow supervisor
        const result = await runProjectWorkflowSupervisor({
            workflowId: req.params.workflowId,
            action: 'start',
            context: context || workflow.configuration?.goal || workflow.description || ''
        });

        if (!result.success) {
            return res.status(500).json({ error: result.error });
        }

        const updatedWorkflow = await db.getProjectWorkflow(req.params.workflowId);
        res.json({
            success: true,
            message: result.message,
            workflow: updatedWorkflow,
            featuresCreated: result.features?.length || 0
        });
    } catch (error) {
        console.error('[Project Workflows API] Error running workflow:', error);
        res.status(500).json({ error: 'Failed to run workflow' });
    }
});

// GET workflow progress
app.get('/api/projects/:id/workflows/:workflowId/progress', async (req, res) => {
    try {
        const { getWorkflowProgress } = require('./services/project-workflow-supervisor');
        const progress = await getWorkflowProgress(req.params.workflowId);

        if (!progress) {
            return res.status(404).json({ error: 'Workflow not found' });
        }

        res.json(progress);
    } catch (error) {
        console.error('[Project Workflows API] Error getting progress:', error);
        res.status(500).json({ error: 'Failed to get workflow progress' });
    }
});

// POST advance workflow to next stage (human-triggered)
app.post('/api/projects/:id/workflows/:workflowId/advance', async (req, res) => {
    try {
        const workflow = await db.getProjectWorkflow(req.params.workflowId);
        if (!workflow) {
            return res.status(404).json({ error: 'Workflow not found' });
        }

        const { runProjectWorkflowSupervisor } = require('./services/project-workflow-supervisor');

        const result = await runProjectWorkflowSupervisor({
            workflowId: req.params.workflowId,
            action: 'advance'
        });

        if (!result.success) {
            return res.status(500).json({ error: result.error });
        }

        const updatedWorkflow = await db.getProjectWorkflow(req.params.workflowId);
        res.json({
            success: true,
            message: result.message,
            workflow: updatedWorkflow,
            workflowComplete: result.workflowComplete || false,
            featuresCreated: result.features?.length || 0
        });
    } catch (error) {
        console.error('[Project Workflows API] Error advancing workflow:', error);
        res.status(500).json({ error: 'Failed to advance workflow' });
    }
});

// POST check workflow stage completion
app.post('/api/projects/:id/workflows/:workflowId/check', async (req, res) => {
    try {
        const { runProjectWorkflowSupervisor } = require('./services/project-workflow-supervisor');

        const result = await runProjectWorkflowSupervisor({
            workflowId: req.params.workflowId,
            action: 'check'
        });

        if (!result.success) {
            return res.status(500).json({ error: result.error });
        }

        res.json(result);
    } catch (error) {
        console.error('[Project Workflows API] Error checking workflow:', error);
        res.status(500).json({ error: 'Failed to check workflow' });
    }
});



// -----------------------------------------------------------------------------
// WORKFLOW TEMPLATES API G�� REMOVED
// Templates are now served exclusively from the Python LangGraph backend
// via /api/langgraph/templates (JSON files on disk).
// The Supabase workflow_templates table is no longer used.

// ============================================================================

// ============================================================================
// RESTORED ROUTES — Accidentally removed during refactoring
// ============================================================================

// --- Nexus Workflow Resume (requires proxyToLangGraph helper) ---

const LANGGRAPH_URL = process.env.PYTHON_BACKEND_URL || 'http://localhost:8000';

async function proxyToLangGraph(urlPath, options = {}) {
    const url = `${LANGGRAPH_URL}${urlPath}`;
    const response = await fetch(url, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            ...options.headers
        }
    });
    return response.json();
}

// POST /api/graph/nexus/:runId/resume — Resume a paused Nexus Prime workflow
app.post('/api/graph/nexus/:runId/resume', async (req, res) => {
    const { runId } = req.params;
    const { approval_action, feedback } = req.body;

    console.log(`[Resume Workflow] runId: ${runId}, action: ${approval_action}, feedback: ${feedback?.substring(0, 100)}...`);

    try {
        const result = await proxyToLangGraph(`/graph/nexus/${runId}/resume`, {
            method: 'POST',
            body: JSON.stringify({ approval_action, feedback })
        });
        console.log(`[Resume Workflow] Result:`, result);
        res.json(result);
    } catch (error) {
        console.error(`[Resume Workflow] Error:`, error);
        res.status(503).json({ error: 'LangGraph engine unavailable' });
    }
});

// --- Critic Routes ---

// GET /api/critic/status - Check if Critic is enabled
app.get('/api/critic/status', async (req, res) => {
    const enabled = await isCriticEnabled();
    res.json({ enabled, message: enabled ? 'Critic is active - code will be reviewed before writes' : 'Critic disabled - code writes will not be reviewed' });
});

// POST /api/critic/toggle - Enable or disable Critic
app.post('/api/critic/toggle', async (req, res) => {
    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') {
        return res.status(400).json({ error: 'enabled must be a boolean' });
    }
    const success = await setCriticEnabled(enabled);
    res.json({
        success: true,
        enabled,
        message: enabled
            ? 'Critic enabled - all code writes will be reviewed before writes'
            : 'Critic disabled - code writes will not be reviewed'
    });
});

// --- Reasoning Routes (Stubbed) ---

// GET /api/reasoning/config - Get reasoning configuration
app.get('/api/reasoning/config', (req, res) => {
    // Stubbed until DB table is created
    const reasoningConfig = {
        currentLevel: 'standard',
        levels: {}
    };
    res.json(reasoningConfig);
});

// POST /api/reasoning/level - Set reasoning level
app.post('/api/reasoning/level', (req, res) => {
    const { level } = req.body;
    console.log(`[Reasoning] Level set to: ${level}`);
    res.json({ success: true, level });
});

// --- Execution Timeline Routes ---

// GET /api/projects/:id/features/:featureId/timeline - Get execution timeline
app.get('/api/projects/:id/features/:featureId/timeline', async (req, res) => {
    try {
        const timeline = await db.getExecutionTimeline(req.params.featureId);
        res.json({ timeline: timeline || [] });
    } catch (error) {
        console.error('[Timeline] Error:', error);
        res.status(500).json({ error: 'Failed to get timeline' });
    }
});

// POST /api/projects/:id/features/:featureId/timeline - Add execution step
app.post('/api/projects/:id/features/:featureId/timeline', async (req, res) => {
    try {
        const { stage, action, node_id, details, next_stage } = req.body;
        const step = await db.addExecutionStep(req.params.featureId, {
            stage: stage || 'unknown',
            action: action || 'step',
            node_id,
            details,
            next_stage
        });
        res.json({ success: true, step });
    } catch (error) {
        console.error('[Timeline] Error adding step:', error);
        res.status(500).json({ error: 'Failed to add timeline step' });
    }
});

// --- Inline Comments Routes ---

// GET /api/projects/:id/features/:featureId/comments - Get inline comments
app.get('/api/projects/:id/features/:featureId/comments', async (req, res) => {
    try {
        const { stage } = req.query;
        const comments = await db.getInlineComments(req.params.featureId, stage || null);
        res.json({ comments: comments || [] });
    } catch (error) {
        console.error('[Comments] Error:', error);
        res.status(500).json({ error: 'Failed to get comments' });
    }
});

// POST /api/projects/:id/features/:featureId/comments - Add inline comment
app.post('/api/projects/:id/features/:featureId/comments', async (req, res) => {
    try {
        const { stage, section_id, content, line_start, line_end, author } = req.body;
        if (!stage || !content) {
            return res.status(400).json({ error: 'stage and content are required' });
        }
        const comment = await db.addInlineComment(req.params.featureId, {
            stage,
            section_id: section_id || null,
            content,
            line_start: line_start || null,
            line_end: line_end || null,
            author: author || 'user'
        });
        res.json({ success: true, comment });
    } catch (error) {
        console.error('[Comments] Error adding comment:', error);
        res.status(500).json({ error: 'Failed to add comment' });
    }
});

// PATCH /api/projects/:id/features/:featureId/comments/:commentId - Resolve/unresolve comment
app.patch('/api/projects/:id/features/:featureId/comments/:commentId', async (req, res) => {
    try {
        const { resolved } = req.body;
        const comment = await db.updateInlineComment(req.params.commentId, { resolved });
        if (!comment) {
            return res.status(404).json({ error: 'Comment not found' });
        }
        res.json({ success: true, comment });
    } catch (error) {
        console.error('[Comments] Error updating comment:', error);
        res.status(500).json({ error: 'Failed to update comment' });
    }
});

// CORTEX BROADCAST ENDPOINT
// Receives artifact pushes from Cortex and would emit to connected clients
// ============================================================================
app.post('/api/broadcast', (req, res) => {
    const { type, payload } = req.body;

    if (!type || !payload) {
        return res.status(400).json({ error: 'type and payload are required' });
    }

    console.log(`[Cortex] Received broadcast: ${type}`);
    console.log(`[Cortex] Payload:`, JSON.stringify(payload, null, 2).slice(0, 500));

    // Emit to all connected WebSocket clients
    const artifact = {
        type: payload.artifact_type,
        data: payload.content
    };

    // DEBUG: Log exactly what we're emitting
    console.log(`[WS DEBUG] Emitting artifact:`, JSON.stringify(artifact, null, 2));
    console.log(`[WS DEBUG] Connected clients: ${io.engine.clientsCount}`);

    io.emit('cortex-artifact', artifact);
    console.log(`[WS] Emitted cortex-artifact: ${artifact.type} to ${io.engine.clientsCount} clients`);

    res.json({
        success: true,
        received: type,
        artifact_type: payload.artifact_type,
        clients: io.engine.clientsCount,
        timestamp: new Date().toISOString()
    });
});


server.listen(PORT, async () => {
    // Reasoning level was previously in config, defaulting to standard log for now
    const reasoningLevel = 'standard';

    console.log(`Local Nexus running on http://localhost:${PORT}`);
    console.log(`Scanning directory: ${PROJECT_ROOT}`);

    const criticEnabled = await isCriticEnabled();
    console.log(`Critic code review: ${criticEnabled ? 'ENABLED' : 'DISABLED'}`);
    console.log(`Reasoning level: ${reasoningLevel.toUpperCase()}`);

    // Check database connection
    if (db.isDatabaseEnabled()) {
        const dbResult = await db.testConnection();
        if (dbResult.success) {
            console.log(`Database: CONNECTED (SQLite)`);
        } else {
            console.warn(`Database: CONFIGURED but connection failed - ${dbResult.error}`);
        }
    } else {
        console.log(`Database: NOT CONFIGURED (using file-based storage)`);
    }

    // Run model discovery in background (non-blocking)
    discoverModels().then(models => {
        console.log(`Model Discovery: ${models.length} latest models ready`);
    }).catch(err => {
        console.warn(`Model Discovery: failed (using fallbacks) - ${err.message}`);
    });

});
