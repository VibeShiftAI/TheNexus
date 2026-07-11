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
const { discoverModels, discoverModelRegistry, getModels } = require('./services/model-discovery');
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
const { configureLongRunningRequestTimeouts } = require('./utils/http-timeouts');
const PRAXIS_CHAT_TIMEOUT_MS = Number.parseInt(process.env.PRAXIS_CHAT_TIMEOUT_MS || '', 10) || 20 * 60 * 1000;
configureLongRunningRequestTimeouts(server, { praxisChatTimeoutMs: PRAXIS_CHAT_TIMEOUT_MS });

const ALLOWED_ORIGINS = [
    'http://localhost:3000', 'http://localhost:4000',
    'https://nexus.vibeshiftai.com'
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

// Sized for the bridge dashboard: one open deck tab polls ~25 req/min across
// its live panels, so 1000/15min browned out with two viewers (2026-07-11).
// This is a local-operator DoS guard, not a quota — keep it generous.
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, max: 6000,
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
['/api/projects', '/api/tasks', '/api/ai', '/api/pins', '/api/models', '/api/model-control',
 '/api/activity', '/api/dashboard', '/api/mcp', '/api/initiatives', '/api/local-queue',
 '/api/skill-candidates'
].forEach(prefix => app.use(prefix, authenticate));

// ─── Shared Dependencies (injected into route factories) ────────────────────
const deps = { db, io, PROJECT_ROOT, getProjectById, getAllProjects, scanProjects, callAI, contextSync, pushService };

// ─── Route Modules — Pre-existing (already extracted) ───────────────────────
const mcpRouter = require('./routes/mcp-inline');
const mcpScopesRouter = require('./routes/mcp-scopes');
app.use('/api/mcp', mcpRouter);
app.use('/api/mcp', mcpScopesRouter);

const createToolsRouter     = require('./routes/tools');
const createInitiativesRouter = require('./routes/initiatives');

app.use('/api/tools',       createToolsRouter({ db, PROJECT_ROOT, getProjectById, getAllProjects }));
app.use('/api/initiatives', createInitiativesRouter({ db }));

// ─── Route Modules — Newly Extracted ────────────────────────────────────────
const createHealthRouter    = require('./routes/health');
const createModelsRouter    = require('./routes/models');
const createModelControlRouter = require('./routes/model-control');
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
const createBroadcastRouter = require('./routes/broadcast');
const createCalendarRouter  = require('./routes/calendar');
const createPraxisStreamRouter = require('./routes/praxis-stream');
const createLocalQueueRouter = require('./routes/local-queue');
const createIngestionControlRouter = require('./routes/ingestion-control');
const createStudioRouter = require('./routes/studio');
const createDispatchesRouter = require('./routes/dispatches');

// Health & system
app.use('/api/health',    createHealthRouter());
app.use('/api/models',    createModelsRouter({ db, getModels }));
app.use('/api/model-control', createModelControlRouter({ db, io, discoverModelRegistry, callAI }));
app.use('/api/settings',  createSettingsRouter());
app.use('/api/dashboard', createDashboardRouter({ db }));
app.use('/api',        createSystemRouter({ db, systemMonitor, tokenTracker, isCriticEnabled, setCriticEnabled }));
app.use('/api/ai/usage',  createUsageRouter({ db, tokenTracker }));
app.use('/api/calendar',  createCalendarRouter({ db }));
app.use('/api/praxis',    createPraxisStreamRouter({ io, pushService }));
// Tunnel sends all /api/* here, but token-usage is computed by the Next.js
// dashboard — forward so remote viewers get the same numbers as localhost.
app.use('/api/token-usage', require('./routes/token-usage')());
// Self-update feed for the Windows travel shell (served through the tunnel).
app.use('/api/updates', require('./routes/updates')());
app.use('/api/local-queue', createLocalQueueRouter());
app.use('/api/skill-candidates', require('./routes/skill-candidates')());
app.use('/api/ingestion-control', createIngestionControlRouter());
app.use('/api/studio',    createStudioRouter({ db, callAI }));
const dispatchesRouter = createDispatchesRouter();
app.use('/api/dispatches', dispatchesRouter);

// Projects & tasks
const projectsRouter = createProjectsRouter({ db, PROJECT_ROOT, getProjectById, getAllProjects, scanProjects, callAI, contextSync, getRecentDispatches: dispatchesRouter.listRecentDispatches });
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
        const boardState = await db.getBoardState(project_id || undefined);
        const compatResult = boardState.map(project => ({
            ...project,
            tasks: (project.tasks || []).map(t => ({
                ...t,
                title: t.name,
                createdAt: t.created_at,
                updatedAt: t.updated_at
            }))
        }));
        res.json(compatResult);
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

    // Calendar firing moved to Praxis (calendar-dispatch.ts poller,
    // 2026-07-06 consolidation) — calendar_events is viewport data here.

    // Model discovery (non-blocking)
    discoverModels({ db }).then(models => {
        console.log(`Model Discovery: ${models.length} latest models ready`);
    }).catch(err => {
        console.warn(`Model Discovery: failed (using fallbacks) - ${err.message}`);
    });
});
