/**
 * Attribution source-marker consistency (task 50e55c47).
 *
 * Every token or cost figure the cockpit's attribution surfaces return must
 * say where it came from: measured, estimated, unavailable, or (a count whose
 * row never recorded its provenance) unknown. This boots each surface that
 * serves those figures against one temp board seeded with a measured run, an
 * estimated run, a run with no usage record and a run with no provenance
 * flag, then walks every response and fails on any figure without a marker:
 *
 *   /api/activity                       Recent Activity Feed (+ run-trace)
 *   /api/dispatches/active              Now strip
 *   /api/dispatches?task_id=            task detail dispatch rows
 *   /api/dispatch-insight/task/:id      task detail tokens, cost, roll-up, run-trace
 *   /api/routing-economics              Measured routing economics panel
 *   /api/projects/pulse, /:id/pulse     Mission brief token readout + ops log
 *
 * The convention the walker enforces: an object holding a figure key also
 * holds `<key>Source`, `<snake_key>_source` or `source`, and a null figure is
 * always 'unavailable' (and an 'unavailable' figure is always null, never 0).
 */
const express = require('express');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const Database = require('better-sqlite3');

const createDispatchesRouter = require('../routes/dispatches');
const createDispatchInsightRouter = require('../routes/dispatch-insight');
const createRoutingEconomicsRouter = require('../routes/routing-economics');
const createProjectPulseRouter = require('../routes/project-pulse');
const createProjectsRouter = require('../routes/projects');
const { USAGE_SOURCES, tokenSource, aggregateTokenSource, costSource } = require('../services/usage-source');

// Keys that carry a token or $ figure. `total` counts only under a `tokens`
// object (routing economics), where it is the token sum.
const FIGURE_KEYS = new Set(['tokens', 'tokens7d', 'tokens24h', 'tokensTotal', 'usd', 'estimatedUsd']);
const snake = key => key.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`);

/**
 * Walk a payload and return every figure that breaks the marker contract,
 * plus every figure seen (so a surface cannot pass by returning nothing).
 */
function auditFigures(payload) {
    const problems = [];
    const figures = [];
    (function walk(node, pathParts, parentKey) {
        if (Array.isArray(node)) { node.forEach((v, i) => walk(v, [...pathParts, i], parentKey)); return; }
        if (!node || typeof node !== 'object') return;
        for (const [key, value] of Object.entries(node)) {
            const isFigureKey = FIGURE_KEYS.has(key) || (key === 'total' && parentKey === 'tokens');
            if (isFigureKey && (value === null || typeof value === 'number')) {
                const where = [...pathParts, key].join('.');
                const marker = node[`${key}Source`] ?? node[`${snake(key)}_source`] ?? node.source;
                figures.push({ where, value, marker });
                if (!USAGE_SOURCES.includes(marker)) problems.push(`${where}=${value} has no source marker (got ${JSON.stringify(marker)})`);
                else if (value === null && marker !== 'unavailable') problems.push(`${where} is null but marked ${marker}`);
                else if (value !== null && marker === 'unavailable') problems.push(`${where}=${value} is marked unavailable but carries a number`);
            }
            if (value && typeof value === 'object') walk(value, [...pathParts, key], key);
        }
    })(payload, [], null);
    return { problems, figures };
}

function listen(app) {
    const server = http.createServer(app);
    const sockets = new Set();
    server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve({ server, sockets, baseUrl: `http://127.0.0.1:${server.address().port}` }));
    });
}
function close(handle) {
    if (!handle) return Promise.resolve();
    for (const s of handle.sockets) s.destroy();
    return new Promise((resolve) => handle.server.close(resolve));
}
async function getJson(url) {
    const res = await fetch(url);
    return { status: res.status, body: await res.json() };
}

describe('usage-source helpers', () => {
    test('tokenSource separates measured, estimated, unavailable and unknown', () => {
        expect(tokenSource(1200, 0)).toBe('measured');
        expect(tokenSource(1200, false)).toBe('measured');
        expect(tokenSource(0, 0)).toBe('measured'); // a recorded zero is a measurement
        expect(tokenSource(900, 1)).toBe('estimated');
        expect(tokenSource(900, true)).toBe('estimated');
        expect(tokenSource(null, 0)).toBe('unavailable');
        expect(tokenSource(undefined, 1)).toBe('unavailable');
        expect(tokenSource(300, null)).toBe('unknown');
        expect(tokenSource(300, undefined)).toBe('unknown');
    });

    test('aggregates take the weakest contributing source and never call nothing zero', () => {
        expect(aggregateTokenSource({ counted: 0 })).toBe('unavailable');
        expect(aggregateTokenSource({ counted: 3 })).toBe('measured');
        expect(aggregateTokenSource({ counted: 3, estimated: 1 })).toBe('estimated');
        expect(aggregateTokenSource({ counted: 3, unknown: 1 })).toBe('unknown');
        expect(costSource(0.42)).toBe('estimated');
        expect(costSource(null)).toBe('unavailable');
    });
});

describe('auditFigures (the consistency check itself)', () => {
    test('fails a figure returned without a source marker', () => {
        const { problems } = auditFigures({ runs: [{ tokens: 1200, tokensSource: 'measured' }, { tokens: 900 }] });
        expect(problems).toEqual(['runs.1.tokens=900 has no source marker (got undefined)']);
    });

    test('fails a missing figure dressed up as zero or as a source other than unavailable', () => {
        expect(auditFigures({ tokens: 0, tokensSource: 'unavailable' }).problems).toHaveLength(1);
        expect(auditFigures({ tokens: null, tokensSource: 'measured' }).problems).toHaveLength(1);
        expect(auditFigures({ cost: { usd: 1.5, source: 'guessed' } }).problems).toHaveLength(1);
    });

    test('reads raw-row, nested and token-sum markers', () => {
        const { problems, figures } = auditFigures({
            row: { tokens: 5, tokens_source: 'estimated' },
            lane: { tokens: { total: null, source: 'unavailable' }, cost: { usd: 0, source: 'measured' } },
        });
        expect(problems).toEqual([]);
        expect(figures.map(f => f.where)).toEqual(['row.tokens', 'lane.tokens.total', 'lane.cost.usd']);
    });
});

describe('every attribution surface marks every figure', () => {
    let tmpDir;
    let handle;
    let repoDir;

    beforeAll(async () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-attr-source-'));
        const dbPath = path.join(tmpDir, 'nexus.db');
        repoDir = path.join(tmpDir, 'repo');

        // The dispatches router owns the task_dispatches schema.
        const dispatchesRouter = createDispatchesRouter({ dbPath });

        const now = Date.now();
        const iso = (msAgo) => new Date(now - msAgo).toISOString();
        const db = new Database(dbPath);
        db.exec(`
            CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT, status TEXT);
            CREATE TABLE IF NOT EXISTS tasks (
                id TEXT PRIMARY KEY, project_id TEXT, name TEXT, status TEXT,
                priority INTEGER DEFAULT 0, dependencies TEXT DEFAULT '[]',
                default_executor TEXT, metadata TEXT DEFAULT '{}', archived_at TEXT,
                updated_at TEXT, last_activity_at TEXT
            );
        `);
        db.prepare('INSERT INTO projects VALUES (?, ?, ?)').run('proj-1', 'Attribution', 'active');
        db.prepare(`INSERT INTO tasks (id, project_id, name, status, updated_at) VALUES ('task-1', 'proj-1', 'Mixed usage task', 'in_progress', ?)`).run(iso(0));
        const ins = db.prepare(`
            INSERT INTO task_dispatches (id, task_id, project_id, executor, model, tokens, tokens_estimated, outcome, started_at, completed_at)
            VALUES (@id, 'task-1', 'proj-1', @executor, @model, @tokens, @flag, @outcome, @started, @completed)
        `);
        const H = 3600_000;
        // Old enough that the activity feed's commits (made "now") match none
        // of the completed rows except through the open one below.
        ins.run({ id: 'd-measured', executor: 'claude-code', model: 'claude-opus-5', tokens: 120000, flag: 0, outcome: 'success', started: iso(30 * H), completed: iso(29 * H) });
        ins.run({ id: 'd-estimated', executor: 'antigravity', model: null, tokens: 9000, flag: 1, outcome: 'success', started: iso(28 * H), completed: iso(27 * H) });
        ins.run({ id: 'd-missing', executor: 'codex', model: 'gpt-5.5', tokens: null, flag: 0, outcome: 'failure', started: iso(26 * H), completed: iso(25 * H) });
        ins.run({ id: 'd-unflagged', executor: 'codex', model: 'gpt-5.5', tokens: 300, flag: null, outcome: 'success', started: iso(5 * H), completed: iso(4 * H) });
        ins.run({ id: 'd-running', executor: 'claude-code', model: 'claude-opus-5', tokens: null, flag: 0, outcome: 'running', started: iso(60_000), completed: null });
        db.close();

        // A real repo for the activity feed: one estimated trailer, one
        // measured trailer, and plain commits that fall back to the dispatch
        // correlation (the running row claims them: tokens unavailable).
        fs.mkdirSync(repoDir);
        const git = (...args) => execFileSync('git', args, {
            cwd: repoDir,
            env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.com' },
        });
        git('init', '-q');
        git('commit', '-q', '--allow-empty', '-m', 'plain commit, no trailers');
        git('commit', '-q', '--allow-empty', '-m', 'estimated work', '-m', 'Model: claude-opus-5\nTokens: ~9,000');
        git('commit', '-q', '--allow-empty', '-m', 'measured work', '-m', 'Model: claude-opus-5\nTokens: 12,345');

        const project = { id: 'proj-1', name: 'Attribution', path: repoDir, status: 'active' };
        const getAllProjects = async () => [project];
        const getProjectById = async (_root, id) => (id === project.id ? project : null);

        const projectsRouter = createProjectsRouter({
            db: {}, PROJECT_ROOT: tmpDir, getAllProjects, getProjectById,
            getRecentDispatches: (n) => dispatchesRouter.listRecentDispatches(n),
        });

        const app = express();
        app.use(express.json());
        app.use('/api/dispatches', dispatchesRouter);
        app.use('/api/dispatch-insight', createDispatchInsightRouter({
            dbPath,
            spineDbPath: path.join(tmpDir, 'no-spine.db'),
            detachedRunsDir: path.join(tmpDir, 'detached'),
            councilSessionsDir: path.join(tmpDir, 'council'),
            praxisUrl: 'http://127.0.0.1:9',
        }));
        app.use('/api/routing-economics', createRoutingEconomicsRouter({ dbPath }));
        app.use('/api/projects', createProjectPulseRouter({ PROJECT_ROOT: tmpDir, getAllProjects, getProjectById, dbPath }));
        app.get('/api/activity', projectsRouter.getActivityHandler);
        handle = await listen(app);
    });

    afterAll(async () => {
        await close(handle);
        if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    const SURFACES = [
        ['Recent Activity Feed', '/api/activity'],
        ['Now strip', '/api/dispatches/active'],
        ['task detail dispatch rows', '/api/dispatches?task_id=task-1'],
        ['task detail insight', '/api/dispatch-insight/task/task-1'],
        ['routing economics', '/api/routing-economics'],
        ['project pulse (all)', '/api/projects/pulse'],
        ['project pulse (detail)', '/api/projects/proj-1/pulse'],
    ];
    const seenSources = new Set();

    test.each(SURFACES)('%s (%s) returns no figure without a source marker', async (_name, route) => {
        const { status, body } = await getJson(`${handle.baseUrl}${route}`);
        expect(status).toBe(200);
        const { problems, figures } = auditFigures(body);
        expect(problems).toEqual([]);
        expect(figures.length).toBeGreaterThan(0);
        for (const f of figures) seenSources.add(f.marker);
    });

    test('the seeded runs exercise every source the marker can take', () => {
        expect([...seenSources].sort()).toEqual([...USAGE_SOURCES].sort());
    });

    test('per-run markers land on the right runs', async () => {
        const { body } = await getJson(`${handle.baseUrl}/api/dispatch-insight/task/task-1`);
        const byId = Object.fromEntries(body.runs.map(r => [r.dispatchId, r]));
        expect(byId['d-measured'].tokensSource).toBe('measured');
        expect(byId['d-estimated'].tokensSource).toBe('estimated');
        expect(byId['d-missing'].tokensSource).toBe('unavailable');
        expect(byId['d-missing'].tokens).toBeNull();
        expect(byId['d-unflagged'].tokensSource).toBe('unknown');
        expect(byId['d-missing'].costSource).toBe('unavailable');
        expect(byId['d-measured'].costSource).toBe('estimated');
        expect(byId['d-measured'].runTrace.fields.modelCalls.evidence.tokensTotalSource).toBe('measured');

        const activity = (await getJson(`${handle.baseUrl}/api/activity`)).body;
        const bySubject = Object.fromEntries(activity.map(a => [a.message, a]));
        expect(bySubject['measured work'].tokensSource).toBe('measured');
        expect(bySubject['estimated work'].tokensSource).toBe('estimated');
        expect(bySubject['plain commit, no trailers'].tokens).toBeNull();
        expect(bySubject['plain commit, no trailers'].tokensSource).toBe('unavailable');
    });
});
