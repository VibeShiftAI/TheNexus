#!/usr/bin/env node
/**
 * Throwaway API for the Groundrules blind-labeling browser check (task
 * "Build a guided blind-labeling interface for Groundrules in Nexus",
 * 2026-10-09). Nothing here touches the live Nexus API (:4000), the live
 * nexus.db, the live Praxis, or the real Groundrules gold set.
 *
 *   - A fresh SQLite board in a temp dir with one synthetic project and one
 *     synthetic task, linked to the labeling packet through
 *     GROUNDRULES_LABELING_TASK_IDS (no real task ids).
 *   - The SYNTHETIC packet fixture from server/__tests__/helpers
 *     (an invented library act: three rows, two control fixtures, one pair),
 *     written to a temp gold dir, so exports land there and never in
 *     /Volumes/Projects/Groundrules.club.
 *   - The REAL routers: server/routes/tasks.js (the task page reads
 *     /api/tasks/:id) and server/routes/groundrules-labeling.js with the
 *     real write authority. There is no Access session in this process, so
 *     writes need the synthetic operator key printed below, exactly as the
 *     Mac app on localhost does with the real key.
 *   - GET /__log lists every request; POST /__packet/:variant rewrites the
 *     fixture packet (the stale-hash step), DELETE /__log clears the log.
 *
 *   node dashboard/scripts/groundrules-labeling-check-api.cjs
 *     prints CHECK_DIR, CHECK_API, CHECK_TASK, CHECK_KEY and READY, then
 *     serves until SIGTERM/SIGINT.
 *
 * Env: CHECK_API_PORT (4299), CHECK_DIR (fresh temp dir by default).
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');

const ROOT = path.resolve(__dirname, '..', '..');
const API_PORT = Number(process.env.CHECK_API_PORT || 4299);
const DIR = process.env.CHECK_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-groundrules-check-'));
fs.mkdirSync(DIR, { recursive: true });
const DB_PATH = path.join(DIR, 'nexus-check.db');
const TASK_ID = 'task-check-groundrules-labeling-0001';
const PROJECT_ID = 'proj-check-groundrules';
const OPERATOR_KEY = 'synthetic-operator-key-for-browser-check-0123456789';

process.env.NEXUS_DB_PATH = DB_PATH;
process.env.GROUNDRULES_LABELING_TASK_IDS = TASK_ID;
process.env.NEXUS_OPERATOR_APPROVAL_KEY = OPERATOR_KEY;
delete process.env.NEXUS_DOCUMENT_APPROVAL_KEY;
delete process.env.PRAXIS_RUNTIME_KEY;

const express = require(path.join(ROOT, 'node_modules', 'express'));
const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
const db = require(path.join(ROOT, 'db'));
const createTasksRouter = require(path.join(ROOT, 'server', 'routes', 'tasks.js'));
const createLabelingRouter = require(path.join(ROOT, 'server', 'routes', 'groundrules-labeling.js'));
const { createPacketSource } = require(path.join(ROOT, 'server', 'services', 'groundrules-labeling', 'packet.js'));
const { createLabelingWriteAuthority } = require(path.join(ROOT, 'server', 'services', 'groundrules-labeling', 'authority.js'));
const { writePacketFixture } = require(path.join(ROOT, 'server', '__tests__', 'helpers', 'groundrules-packet-fixture.js'));

// ── Synthetic packet in a temp gold dir ─────────────────────────────────────
const fixture = writePacketFixture();
const packetSource = createPacketSource({ packetDir: fixture.packetDir, goldDir: fixture.goldDir });
const packet = packetSource.load();

// ── Seed the board ───────────────────────────────────────────────────────────
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
{
    const raw = new Database(DB_PATH);
    raw.pragma('journal_mode = WAL');
    raw.prepare('INSERT INTO projects (id, name, path, description) VALUES (?, ?, ?, ?)')
        .run(PROJECT_ID, 'Groundrules (check)', DIR, 'synthetic project for the labeling browser check');
    raw.prepare(`INSERT INTO tasks (id, project_id, name, status, priority, dependencies, metadata, description, created_at, updated_at)
        VALUES (?, ?, ?, 'in_progress', 'high', '[]', '{}', ?, ?, ?)`)
        .run(TASK_ID, PROJECT_ID, 'Synthetic: label the library-act packet blind',
            ['Synthetic task for the browser check.', '', '## Source inventory', '', ...Array.from({ length: 40 }, (_, i) => `- Source ${i + 1}: synthetic library act section ${i + 1} (inventory filler so the page is long)`)].join('\n'),
            iso(now - 3 * 3600_000), iso(now - 600_000));
    raw.close();
}

// ── Throwaway Nexus API ─────────────────────────────────────────────────────
const api = express();
api.use(express.json({ limit: '2mb' }));
const log = [];
api.use((req, _res, next) => { log.push(`${req.method} ${req.path}`); next(); });
api.use((req, _res, next) => { req.user = { id: 'local_user', role: 'admin', is_service: false }; next(); });
api.get('/__log', (_req, res) => res.json({ log }));
api.delete('/__log', (_req, res) => { log.length = 0; res.json({ ok: true }); });
api.post('/__packet/:variant', (req, res) => {
    const written = fixture.write(req.params.variant);
    res.json({ variant: req.params.variant, sha256: packetSource.load().sha256, rows: written.partA.rowCount });
});
api.get('/__exports', (_req, res) => {
    const list = [];
    const walk = (dir, rel = '') => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(p, path.join(rel, entry.name));
            else list.push(path.join(rel, entry.name));
        }
    };
    walk(fixture.goldDir);
    res.json({ goldDir: fixture.goldDir, files: list.sort() });
});
const noAccess = async () => ({ operator: false, identity: null, reason: 'no Access session in the check stack' });
api.use('/api/tasks', createTasksRouter({ db, PROJECT_ROOT: DIR, getProjectById: (id) => db.getProject(id), callAI: async () => { throw new Error('not part of the check'); }, validateInitiativeRequest: () => ({ ok: false }), pushService: null }));
api.use('/api/groundrules-labeling', createLabelingRouter({
    db, dbPath: DB_PATH, packetSource,
    authorizeWrite: createLabelingWriteAuthority({ authenticateOperator: { inspect: noAccess } }),
    operatorInspect: noAccess,
}));
api.use((_req, res) => res.status(404).json({ error: 'not part of the check' }));

const server = http.createServer(api).listen(API_PORT, '127.0.0.1');
server.once('listening', () => {
    fs.writeFileSync(path.join(DIR, 'check.json'), JSON.stringify({ taskId: TASK_ID, projectId: PROJECT_ID, goldDir: fixture.goldDir, packetDir: fixture.packetDir, packetSha256: packet.sha256, rows: fixture.rows }, null, 2));
    console.log(`CHECK_DIR=${DIR}`);
    console.log(`CHECK_API=http://127.0.0.1:${API_PORT}`);
    console.log(`CHECK_TASK=${TASK_ID}`);
    console.log(`CHECK_KEY=${OPERATOR_KEY}`);
    console.log(`CHECK_GOLD=${fixture.goldDir}`);
    console.log(`CHECK_PACKET_SHA=${packet.sha256}`);
    console.log('READY');
});
const stop = () => { server.close(); setTimeout(() => process.exit(0), 100); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
