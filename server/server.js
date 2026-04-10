/**
 * The Nexus — API Server
 *
 * Slim orchestrator: imports, middleware, route mounting, startup.
 * All domain logic lives in ./routes/ and ./services/.
 */
require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');

// ─── Core Dependencies ──────────────────────────────────────────────────────
const { scanProjects, getAllProjects, getProjectById } = require('./utils/project-manager');
const { setupResearchRoutes } = require('./auto-research');
const systemMonitor = require('./services/system-monitor');
const tokenTracker = require('./utils/token-tracker');
const { isCriticEnabled, setCriticEnabled } = require('./services/critic');
const contextSync = require('./services/context-sync');
const pushService = require('./push-service');
const { runAgent } = require('./agent');
const { discoverModels, getModels } = require('./services/model-discovery');
const { getDefaultMemoryManager } = require('./memory');
const db = require('../db');
const { callAI } = require('./services/ai-service');
const { validateInitiativeRequest } = require('./services/initiative-router');

// ─── Crash Handlers ─────────────────────────────────────────────────────────
process.on('uncaughtException', (err) => console.error('!!! UNCAUGHT EXCEPTION !!!', err));
process.on('unhandledRejection', (reason) => console.error('!!! UNHANDLED REJECTION !!!', reason));

// ─── Express + Socket.io Setup ──────────────────────────────────────────────
const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);

const ALLOWED_ORIGINS = [
    'http://localhost:3000', 'http://localhost:4000',
    'http://localhost:8000', 'https://nexus.vibeshiftai.com'
];
const io = new Server(server, { cors: { origin: ALLOWED_ORIGINS } });
const PORT = process.env.PORT || 4000;
const PROJECT_ROOT = process.env.PROJECT_ROOT || path.resolve(process.env.USERPROFILE || process.env.HOME, 'Projects');

// WebSocket
io.on('connection', (socket) => { socket.on('disconnect', () => {}); });

// ─── Initialize Socket.io Singleton ─────────────────────────────────────────
const ioHolder = require('./shared/io');
ioHolder.set(io);

// ─── Middleware ──────────────────────────────────────────────────────────────
app.use(helmet());
app.use(cors({ origin: ALLOWED_ORIGINS }));
app.use(express.json({ limit: '50mb' }));

const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, max: 1000,
    standardHeaders: true, legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.' }
});
app.use('/api', apiLimiter);

// ─── Root & Public Routes ───────────────────────────────────────────────────
app.get('/', (_req, res) => {
    res.json({ name: 'The Nexus API', version: '2.0.0', status: 'running',
        endpoints: { projects: '/api/projects', activity: '/api/activity', agents: '/api/agents', health: '/api/health' }
    });
});

// ─── Authentication ─────────────────────────────────────────────────────────
function authenticate(req, res, next) {
    const publicRoutes = ['/api/ai/usage', '/api/system/status'];
    if (publicRoutes.some(route => req.originalUrl.startsWith(route))) return next();
    req.user = { id: 'local_user', role: 'admin', is_service: false };
    return next();
}

// Apply auth to protected route prefixes
['/api/projects', '/api/tasks', '/api/ai', '/api/pins', '/api/models',
 '/api/activity', '/api/dashboard', '/api/mcp', '/api/initiatives'
].forEach(prefix => app.use(prefix, authenticate));

// ─── Shared Dependencies (injected into route factories) ────────────────────
const deps = { db, io, PROJECT_ROOT, getProjectById, getAllProjects, scanProjects, callAI, contextSync, pushService, runAgent };

// ─── Route Modules — Pre-existing (already extracted) ───────────────────────
const mcpRouter = require('./routes/mcp-inline');
const mcpScopesRouter = require('./routes/mcp-scopes');
app.use('/api/mcp', mcpRouter);
app.use('/api/mcp', mcpScopesRouter);

const createToolsRouter     = require('./routes/tools');
const createMemoryRouter    = require('./routes/memory');
const createLangGraphRouter = require('./routes/langgraph');
const createInitiativesRouter = require('./routes/initiatives');
const createWorkflowsRouter = require('./routes/workflows');

app.use('/api/tools',       createToolsRouter({ db, PROJECT_ROOT, getProjectById, getAllProjects }));
app.use('/api/memory',      createMemoryRouter({ scanProjects, PROJECT_ROOT, getDefaultMemoryManager }));
app.use('/api/langgraph',   createLangGraphRouter({ db, PROJECT_ROOT, getProjectById, contextSync, runAgent }));
app.use('/api/initiatives', createInitiativesRouter({ db }));
app.use('/api/workflows',   createWorkflowsRouter({ db, PROJECT_ROOT, getProjectById }));

// ─── Route Modules — Newly Extracted ────────────────────────────────────────
const createHealthRouter    = require('./routes/health');
const createModelsRouter    = require('./routes/models');
const createSettingsRouter  = require('./routes/settings');
const createDashboardRouter = require('./routes/dashboard');
const createSystemRouter    = require('./routes/system');
const createUsageRouter     = require('./routes/usage');
const createProjectsRouter  = require('./routes/projects');
const createTasksRouter     = require('./routes/tasks');
const createAIChatRouter    = require('./routes/ai-chat');
const createIngestRouter    = require('./routes/ingest');
const createAgentsRouter    = require('./routes/agents');
const createNotesRouter     = require('./routes/notes');
const createChatHistoryRouter = require('./routes/chat-history');
const createChatFilesRouter   = require('./routes/chat-files');
const createPushRouter      = require('./routes/push');
const createProjectWorkflowsRouter = require('./routes/project-workflows');
const createAgEventsRouter  = require('./routes/ag-events');
const createBroadcastRouter = require('./routes/broadcast');

// Health & system
app.use('/api/health',    createHealthRouter());
app.use('/api/models',    createModelsRouter({ db, getModels }));
app.use('/api/settings',  createSettingsRouter());
app.use('/api/dashboard', createDashboardRouter({ db }));
app.use('/api',        createSystemRouter({ db, systemMonitor, tokenTracker, isCriticEnabled, setCriticEnabled }));
app.use('/api/ai/usage',  createUsageRouter({ db, tokenTracker }));

// Projects & tasks
const projectsRouter = createProjectsRouter({ db, PROJECT_ROOT, getProjectById, getAllProjects, scanProjects, callAI, contextSync });
app.use('/api/projects', projectsRouter);
// Mount non-prefix routes from projects
app.get('/api/activity', projectsRouter.getActivityHandler);
app.get('/api/pins', projectsRouter.getPinsHandler);

const tasksRouter = createTasksRouter({ db, PROJECT_ROOT, getProjectById, callAI, validateInitiativeRequest, pushService });
app.use('/api/tasks', tasksRouter);      // top-level: POST /, PATCH /:taskId, POST /batch, PATCH /reorder
app.use('/api/projects', tasksRouter);   // project-scoped: GET /:id/tasks, POST /:id/tasks/:taskId/..., etc.
app.use('/api/projects', createProjectWorkflowsRouter({ db, getProjectById, PROJECT_ROOT }));

// ─── Board State (Praxis executive planning) ───────────────────────────
// Returns projects annotated with tasks + summary counts.
// Praxis uses this for autonomous planning and prioritization.
app.get('/api/board-state', authenticate, async (req, res) => {
    const { project_id } = req.query;
    try {
        const projects = await getAllProjects(PROJECT_ROOT);
        const filtered = project_id
            ? projects.filter(p => p.id === project_id)
            : projects;

        const result = await Promise.all(filtered.map(async (project) => {
            const tasks = await db.getTasks(project.id);
            const complete = tasks.filter(t => t.status === 'completed' || t.status === 'done').length;
            // A task is "unblocked" if it has no unfinished dependencies
            const unblocked = tasks.filter(t => {
                if (t.status === 'completed' || t.status === 'done') return false;
                const deps = t.dependencies || [];
                if (deps.length === 0) return true;
                return deps.every(depId => {
                    const dep = tasks.find(d => d.id === depId);
                    return dep && (dep.status === 'completed' || dep.status === 'done');
                });
            }).length;

            return {
                id: project.id,
                name: project.name,
                description: project.description,
                status: project.status,
                priority: project.priority,
                end_state: project.end_state,
                tasks: tasks.map(t => ({ ...t, title: t.name, createdAt: t.created_at, updatedAt: t.updated_at, is_unblocked: true })),
                task_summary: { total: tasks.length, unblocked, complete },
            };
        }));

        res.json(result);
    } catch (err) {
        console.error('[Board State] Error:', err);
        res.status(500).json({ error: 'Failed to compute board state' });
    }
});

// AI & chat
app.use('/api/ai/chat',  createAIChatRouter({ db, callAI, pushService, io }));
app.use('/api/ingest',   createIngestRouter({ db }));
app.use('/api/agents',   createAgentsRouter({ db }));
app.use('/api/notes',    createNotesRouter({ db }));
app.use('/api/chat',     createChatHistoryRouter({ db, io }));
app.use('/api/chat/files', createChatFilesRouter());

// Push & events
app.use('/api/push',      createPushRouter({ db, pushService }));
app.use('/api/ag',        createAgEventsRouter({ db, io, pushService }));
app.use('/api/broadcast', createBroadcastRouter({ io }));

// ─── Legacy Research Routes (uses app.post directly) ────────────────────────
setupResearchRoutes(app, getProjectById, PROJECT_ROOT);

// ─── Server Startup ─────────────────────────────────────────────────────────
server.listen(PORT, async () => {
    console.log(`Local Nexus running on http://localhost:${PORT}`);
    console.log(`Scanning directory: ${PROJECT_ROOT}`);

    const criticEnabled = await isCriticEnabled();
    console.log(`Critic code review: ${criticEnabled ? 'ENABLED' : 'DISABLED'}`);
    console.log(`Reasoning level: STANDARD`);

    // Database check + push service init
    if (db.isDatabaseEnabled()) {
        const dbResult = await db.testConnection();
        if (dbResult.success) {
            console.log(`Database: CONNECTED (SQLite)`);
            pushService.init(db);
            console.log('[Push] Token storage ready');
        } else {
            console.warn(`Database: CONFIGURED but connection failed - ${dbResult.error}`);
        }
    } else {
        console.log(`Database: NOT CONFIGURED (using file-based storage)`);
    }

    // Model discovery (non-blocking)
    discoverModels().then(models => {
        console.log(`Model Discovery: ${models.length} latest models ready`);
    }).catch(err => {
        console.warn(`Model Discovery: failed (using fallbacks) - ${err.message}`);
    });
});
