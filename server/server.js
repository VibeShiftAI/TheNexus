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

// ─── Project Hub (THE LAB) ──────────────────────────────────────────────────
// lab.vibeshiftai.com serves the hub at its root — that's the travel
// shell's THE LAB tab plus the /p/<slug> spaces for projects without a web
// UI of their own. Registered ahead of the root JSON route so the lab
// hostname can own '/'; /hub/ keeps it reachable on localhost for dev.
const projectHub = require('./routes/project-hub')({ db });
app.use((req, res, next) => (
    (req.hostname || '').startsWith('lab.') ? projectHub(req, res, next) : next()
));
// Non-strict routing matches /hub/ here too — only bounce the bare /hub so
// relative links resolve under /hub/, and let the router take /hub/ itself.
app.get('/hub', (req, res, next) => (
    req.originalUrl.split('?')[0] === '/hub' ? res.redirect('/hub/') : next()
));
app.use('/hub', projectHub);

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
const { guardDispatchPayload } = require('./lib/provenance');
const createSystemRouter    = require('./routes/system');
const createUsageRouter     = require('./routes/usage');
const createProjectsRouter  = require('./routes/projects');
const createTasksRouter     = require('./routes/tasks');
const createAIChatRouter    = require('./routes/ai-chat');
const createIngestRouter    = require('./routes/ingest');
const createAgentsRouter    = require('./routes/agents');
const createNotesRouter     = require('./routes/notes');
const createContactsRouter  = require('./routes/contacts');
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
const createFleetRouter     = require('./routes/fleet');

// Health & system
app.use('/api/health',    createHealthRouter());
app.use('/api/fleet',     createFleetRouter());
app.use('/api/models',    createModelsRouter({ db, getModels }));
app.use('/api/model-control', createModelControlRouter({ db, io, discoverModelRegistry, callAI }));
app.use('/api/settings',  createSettingsRouter());
app.use('/api/dashboard', createDashboardRouter({ db }));
app.use('/api',        createSystemRouter({ db, systemMonitor, tokenTracker, isCriticEnabled, setCriticEnabled }));
app.use('/api/ai/usage',  createUsageRouter({ db, tokenTracker }));
app.use('/api/calendar',  createCalendarRouter({ db }));
app.use('/api/praxis',    createPraxisStreamRouter({ io, pushService, db }));
// Tunnel sends all /api/* here, but token-usage is computed by the Next.js
// dashboard — forward so remote viewers get the same numbers as localhost.
app.use('/api/token-usage', require('./routes/token-usage')());
// Usage windows / reset timing / routing decisions — proxied from Praxis.
app.use('/api/usage-monitor', require('./routes/usage-monitor')());
app.use('/api/presence', require('./routes/presence')());
// Operational event log behind the Recent Activity feed. Praxis relays every
// operational event here; only the ones that need Robert also reach the chat.
app.use('/api/ag', require('./routes/activity-events')({ db, io }));
// Self-update feed for the Windows travel shell (served through the tunnel).
app.use('/api/updates', require('./routes/updates')());
// Travel-shell tab roster — the shell pulls this at launch; the dashboard
// settings modal edits it. Tab changes need no rebuild.
app.use('/api/tabs', require('./routes/tabs')());
app.use('/api/local-queue', createLocalQueueRouter());
app.use('/api/skill-candidates', require('./routes/skill-candidates')());
// Read-only skill-wiki browser over the shared-mind vault (manifests,
// telemetry, knowledge pages, backlink graph). No write path by design.
app.use('/api/skill-wiki', require('./routes/skill-wiki')());
app.use('/api/ingestion-control', createIngestionControlRouter());
app.use('/api/studio',    createStudioRouter({ db, callAI }));
const dispatchesRouter = createDispatchesRouter();
app.use('/api/dispatches', dispatchesRouter);
// Eligibility + containment: why waiting tasks aren't running, per-run
// ceilings/cost/verdicts, and the kill relay. Mounted after dispatches so the
// task_dispatches table exists by the time this router reads it.
app.use('/api/dispatch-insight', require('./routes/dispatch-insight')());

// Projects & tasks
// Pulse first: the projects router's GET /:id would otherwise swallow /pulse.
const createProjectPulseRouter = require('./routes/project-pulse');
app.use('/api/projects', createProjectPulseRouter({ PROJECT_ROOT, getAllProjects, getProjectById }));
const projectsRouter = createProjectsRouter({ db, PROJECT_ROOT, getProjectById, getAllProjects, scanProjects, callAI, contextSync, getRecentDispatches: dispatchesRouter.listRecentDispatches });
app.use('/api/projects', projectsRouter);
// Mount non-prefix routes from projects
app.get('/api/activity', projectsRouter.getActivityHandler);
app.get('/api/pins', projectsRouter.getPinsHandler);

const tasksRouter = createTasksRouter({ db, PROJECT_ROOT, getProjectById, callAI, validateInitiativeRequest, pushService });
app.use('/api/tasks', tasksRouter);      // top-level: POST /, PATCH /:taskId, POST /batch, PATCH /reorder
app.use('/api/projects', tasksRouter);   // project-scoped: GET /:id/tasks, POST /:id/tasks/:taskId/..., etc.
// Stakeholder governance (2026-08-22): PDMs, the request approval queue, and
// the single decision endpoint every caller (dashboard, Praxis, mobile) uses.
const stakeholderRouters = require('./routes/stakeholders')({ db });
app.use('/api/projects', stakeholderRouters.projects); // GET /:id/stakeholders, GET /:id/requests
app.use('/api/tasks', stakeholderRouters.tasks);       // POST /:taskId/stakeholder-decision
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
                updatedAt: t.updated_at,
                // Board state is a read seam that carries antigravity_payload —
                // gate external-tier payloads like every other read path
                // (server/lib/provenance.js guardDispatchPayload).
                ...(t.antigravity_payload ? { antigravity_payload: guardDispatchPayload(t) } : {})
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
// Members — the unified people directory (2026-07-16). /api/members is the
// canonical mount; /api/contacts stays as the legacy alias (same router).
app.use('/api/members',  createContactsRouter({ db }));
app.use('/api/contacts', createContactsRouter({ db }));
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
